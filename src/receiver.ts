// Receiver: join a share, browse its folder tree, preview and download.
// The sender on the other end of the data channel is untrusted — every
// message is shape-validated and transfers are size-capped (against the
// manifest the user was shown) before buffering.
//
// The experience is optimistic: a priority transfer queue feeds a blob cache,
// and the cache is filled speculatively (idle scan of the open folder, hover
// intent, viewer neighbors) so that most clicks open instantly. User-initiated
// requests always jump ahead of speculative ones; the wire still carries one
// transfer at a time.

import { el, fmtSize } from "./dom";
import { warpBurst } from "./fx/starfield";
import { icon, kindIcon } from "./icons";
import { basename, crumbs, listDir, type Row } from "./manifest";
import {
  CHUNK_SIZE,
  LEVEL_BLURB,
  LEVEL_LABEL,
  LEVELS,
  MAX_MANIFEST_ENTRIES,
  PREVIEWABLE,
  levelAllows,
  type FileEntry,
  type FileKind,
  type Level,
  type SenderToReceiver,
} from "./protocol";
import { answerPeer } from "./rtc";
import { Signal } from "./signaling";
import { renderPreview, releasePreviewResources } from "./viewers";

const KNOWN_KINDS = new Set(["text", "code", "pdf", "sheet", "doc", "image", "media", "other"]);
const MAX_PATH_LENGTH = 1024;

/** Validate an untrusted manifest from the sender; null = protocol violation. */
function sanitizeManifest(value: unknown): FileEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_MANIFEST_ENTRIES) return null;
  const out: FileEntry[] = [];
  for (const entry of value as FileEntry[]) {
    if (
      typeof entry?.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.length > MAX_PATH_LENGTH ||
      // Reject empty segments (leading/trailing/double slash) and ".." — the
      // honest sender already does, and they derive nameless dirs/breadcrumbs.
      entry.path.split("/").some((seg) => seg === "" || seg === "..") ||
      entry.path.includes("\0") ||
      !Number.isFinite(entry.size) ||
      entry.size < 0 ||
      !KNOWN_KINDS.has(entry.kind)
    ) {
      return null;
    }
    out.push({ path: entry.path, size: entry.size, kind: entry.kind });
  }
  return out;
}

interface Transfer {
  id: number;
  path: string;
  expected: number;
  mime: string;
  chunks: ArrayBuffer[];
  received: number;
  onProgress: (received: number, expected: number) => void;
  resolve: (result: FetchResult) => void;
  reject: (err: Error) => void;
}

interface FetchResult {
  blob: Blob;
  mime: string;
}

type Priority = "user" | "idle";

interface QueueItem {
  path: string;
  intent: "preview" | "download";
  priority: Priority;
  onProgress: Transfer["onProgress"];
  resolve: (result: FetchResult) => void;
  reject: (err: Error) => void;
}

// Cache and speculation budgets. Speculative pulls are size-capped so an
// in-flight prefetch never makes a real click wait long (the protocol has no
// cancel; a queued user request runs as soon as the current transfer ends).
const CACHE_MAX_BYTES = 48 * 1024 * 1024;
const CACHE_ITEM_MAX = 8 * 1024 * 1024;
const PREFETCH_SCAN_MAX = 768 * 1024; // idle folder scan
const PREFETCH_SCAN_COUNT = 24;

const idle: (cb: () => void) => void =
  typeof window.requestIdleCallback === "function"
    ? (cb) => window.requestIdleCallback(cb, { timeout: 800 })
    : (cb) => window.setTimeout(cb, 180);

const noProgress: Transfer["onProgress"] = () => {};

export function mountReceiver(root: HTMLElement, shareId: string, token: string): void {
  // ----- state -------------------------------------------------------------
  let dc: RTCDataChannel | null = null;
  let level: Level | null = null;
  let manifest: FileEntry[] = [];
  let cwd = "";
  let nextId = 1;
  let inflight: Transfer | null = null;
  let ended = false;

  // explorer state
  let filterText = "";
  let sortKey: "name" | "size" = "name";
  let sortAsc = true;
  let currentRows: Row[] = [];
  let rowNodes: HTMLElement[] = [];
  let selected = -1;
  let selectedKey: string | null = null;

  // transfer queue + cache
  let queue: QueueItem[] = [];
  const pending = new Map<string, Promise<FetchResult>>();
  const blobCache = new Map<string, FetchResult>();
  let cacheBytes = 0;
  const cacheDots = new Map<string, HTMLElement>();
  let prefetchToken = 0;

  // viewer state
  let overlayOpen = false;

  // ----- skeleton ----------------------------------------------------------
  const ring = el("span", { class: "ring connecting", title: "connection state" });
  const title = el("h1", { class: "share-title" }, ["Connecting…"]);
  const chipSlot = el("span");
  const destroySlot = el("span");
  const header = el("header", { class: "share-head" }, [
    el("div", { class: "minw" }, [
      el("p", { class: "brandline mono" }, ["worm", el("span", { class: "tick" }, ["·"]), "drive"]),
      el("div", { class: "row gap" }, [ring, title, chipSlot]),
    ]),
    destroySlot,
  ]);

  const searchInput = el("input", {
    class: "field search mono",
    type: "search",
    placeholder: "Filter this share — press /",
    "aria-label": "Filter files",
  }) as HTMLInputElement;
  const sortNameBtn = el("button", { class: "sortbtn mono" }, ["name"]);
  const sortSizeBtn = el("button", { class: "sortbtn mono" }, ["size"]);
  const countLabel = el("span", { class: "mono dim count" });
  const toolbar = el("div", { class: "toolbar", hidden: true }, [
    el("div", { class: "searchwrap" }, [icon("search"), searchInput]),
    el("div", { class: "row gap center" }, [sortNameBtn, sortSizeBtn, countLabel]),
  ]);

  const crumbBar = el("nav", { class: "crumbs mono" });
  const table = el("div", { class: "filetable" });
  const message = el("p", { class: "dim centered" }, ["Knocking on the sender's tab…"]);
  const hint = (keys: string[], what: string) =>
    el("span", { class: "hint" }, [...keys.map((k) => el("kbd", {}, [k])), ` ${what}`]);
  const hints = el("div", { class: "hints", hidden: true }, [
    hint(["↑", "↓"], "navigate"),
    hint(["↵"], "open"),
    hint(["/"], "filter"),
    hint(["⌫"], "up a folder"),
    hint(["←", "→"], "between previews"),
  ]);
  const browser = el("section", { class: "panel" }, [toolbar, crumbBar, table, message, hints]);

  const overlay = el("div", { class: "overlay", hidden: true, tabindex: "-1" });

  root.append(header, browser, overlay);

  // ----- connection --------------------------------------------------------
  const signal = new Signal();
  const peer = answerPeer(signal, "host");

  const stallTimer = window.setTimeout(() => {
    if (!level && !ended) {
      fail(
        "Still trying to reach the sender. If this never connects, both ends may be behind strict NAT — see README › Networking (TURN).",
        false,
      );
    }
  }, 20_000);

  signal.on("error", (msg) => {
    fail(
      msg.reason === "no-such-share"
        ? "This share doesn't exist — it may have been destroyed, or the sender's tab is closed."
        : `Signaling error: ${msg.reason}`,
    );
  });
  signal.on("gone", () => {
    if (!level) fail("The sender closed this share before you connected.");
  });
  signal.on("signal", (msg) => peer.handleSignal(msg.data));

  void signal
    .connect()
    .then(() => signal.send({ t: "join", shareId }))
    .catch(() => fail("Could not reach the signaling server."));

  void peer.channel
    .then((channel) => {
      dc = channel;
      channel.onmessage = (event) => handleMessage(event.data);
      channel.onclose = () => {
        if (!ended) fail("The sender went offline. This share has ended.");
      };
      channel.send(JSON.stringify({ t: "hello", token }));
    })
    .catch(() => fail("Peer connection failed."));

  function fail(text: string, terminal = true): void {
    if (ended) return;
    if (terminal) {
      ended = true;
      ring.className = "ring ended";
      title.textContent = "Share ended";
      dc = null;
      rejectAll(text);
      closeViewer();
      toolbar.hidden = true;
      hints.hidden = true;
      table.replaceChildren();
      crumbBar.replaceChildren();
    }
    message.hidden = false;
    message.textContent = text;
  }

  // ----- data channel ------------------------------------------------------
  // The sender is untrusted: a hostile share link must not be able to OOM
  // this tab or feed garbage into the UI. Shape violations are treated as
  // hostile and end the session.
  const MAX_CONTROL_BYTES = 1024 * 1024;

  function violation(why: string): void {
    rejectAll(why);
    dc?.close();
    fail(`Disconnected: ${why}`);
  }

  function handleMessage(raw: unknown): void {
    if (typeof raw === "string") {
      if (raw.length > MAX_CONTROL_BYTES) {
        violation("oversized control message.");
        return;
      }
      let msg: SenderToReceiver;
      try {
        msg = JSON.parse(raw) as SenderToReceiver;
      } catch {
        return;
      }
      handleControl(msg);
      return;
    }
    if (raw instanceof ArrayBuffer && inflight) {
      inflight.chunks.push(raw);
      inflight.received += raw.byteLength;
      // Hard ceiling: never buffer past the declared size (+ one chunk of
      // slack). Catches both lying file-heads and chunks sent with no head
      // at all (expected is still 0 then).
      if (inflight.received > inflight.expected + CHUNK_SIZE) {
        violation("transfer exceeded its declared size.");
        return;
      }
      inflight.onProgress(inflight.received, inflight.expected);
    }
  }

  function handleControl(msg: SenderToReceiver): void {
    switch (msg.t) {
      case "grant": {
        const clean = sanitizeManifest(msg.manifest);
        if (!clean || !(LEVELS as readonly string[]).includes(msg.level) || typeof msg.name !== "string") {
          violation("malformed grant.");
          return;
        }
        window.clearTimeout(stallTimer);
        level = msg.level;
        manifest = clean;
        ring.className = "ring live";
        title.textContent = msg.name.slice(0, 200);
        chipSlot.replaceChildren(
          el("span", { class: `chip chip-${msg.level}`, title: LEVEL_BLURB[msg.level] }, [
            LEVEL_LABEL[msg.level],
          ]),
        );
        if (levelAllows(msg.level, "destroy")) {
          const destroyButton = el("button", { class: "btn danger small" }, ["Destroy share"]);
          destroyButton.addEventListener("click", () => {
            if (window.confirm("Destroy this share for everyone? This cannot be undone.")) {
              // Optimistic: reflect the destruction immediately; the sender's
              // `destroyed` (or the channel closing) finalizes it.
              destroyButton.disabled = true;
              destroyButton.textContent = "Destroying…";
              ring.className = "ring ended";
              dc?.send(JSON.stringify({ t: "destroy" }));
            }
          });
          destroySlot.replaceChildren(destroyButton);
        }
        toolbar.hidden = false;
        hints.hidden = false;
        renderBrowser();
        break;
      }
      case "deny":
        fail(msg.reason);
        break;
      case "manifest": {
        const clean = sanitizeManifest(msg.manifest);
        if (!clean) {
          violation("malformed manifest.");
          return;
        }
        manifest = clean;
        // Drop cached blobs for files that no longer exist.
        for (const path of [...blobCache.keys()]) {
          if (!manifest.some((entry) => entry.path === path)) dropCached(path);
        }
        if (cwd !== "" && !manifest.some((entry) => entry.path.startsWith(`${cwd}/`))) cwd = "";
        renderBrowser();
        break;
      }
      case "file-head":
        if (inflight && inflight.id === msg.id) {
          // The declared size is attacker-controlled and gates how much we
          // buffer (see the ArrayBuffer ceiling), so it must not exceed what
          // the validated manifest promised for this path — otherwise a tiny
          // manifest entry could stream gigabytes and OOM the tab.
          const entry = manifest.find((e) => e.path === inflight!.path);
          if (!entry || !Number.isFinite(msg.size) || msg.size < 0 || msg.size > entry.size) {
            violation("file-head disagrees with the manifest.");
            return;
          }
          inflight.expected = msg.size;
          inflight.mime = typeof msg.mime === "string" ? msg.mime.slice(0, 200) : "";
        }
        break;
      case "file-eof":
        if (inflight && inflight.id === msg.id) {
          const done = inflight;
          inflight = null;
          const result = { blob: new Blob(done.chunks, { type: done.mime }), mime: done.mime };
          cacheResult(done.path, result);
          pending.delete(done.path);
          done.resolve(result);
          drain();
        }
        break;
      case "file-err":
        if (inflight && inflight.id === msg.id) {
          const dead = inflight;
          inflight = null;
          pending.delete(dead.path);
          dead.reject(new Error(msg.reason));
          drain();
        }
        break;
      case "destroyed":
        fail("This share was destroyed. Files are gone.");
        break;
    }
  }

  // ----- transfer queue + cache (the optimistic engine) ---------------------
  function requestFile(
    path: string,
    intent: "preview" | "download",
    priority: Priority,
    onProgress: Transfer["onProgress"] = noProgress,
  ): Promise<FetchResult> {
    const hit = blobCache.get(path);
    if (hit) return Promise.resolve(hit);

    const open = pending.get(path);
    if (open) {
      if (priority === "user") promote(path, intent, onProgress);
      return open;
    }

    if (!dc || dc.readyState !== "open" || ended) {
      return Promise.reject(new Error("Not connected."));
    }

    const promise = new Promise<FetchResult>((resolve, reject) => {
      const item: QueueItem = { path, intent, priority, onProgress, resolve, reject };
      if (priority === "user") {
        // Ahead of every speculative pull, behind earlier user requests.
        const at = queue.findIndex((q) => q.priority === "idle");
        if (at === -1) queue.push(item);
        else queue.splice(at, 0, item);
      } else {
        queue.push(item);
      }
    });
    pending.set(path, promise);
    drain();
    return promise;
  }

  /** A click on something already speculatively queued/in-flight adopts it. */
  function promote(path: string, intent: QueueItem["intent"], onProgress: Transfer["onProgress"]): void {
    if (inflight?.path === path) {
      // Already on the wire — the intent was sent with the original "get" and
      // can't be changed now, but adopt the live progress callback.
      inflight.onProgress = onProgress;
      return;
    }
    const at = queue.findIndex((q) => q.path === path);
    if (at === -1) return;
    const item = queue.splice(at, 1)[0];
    if (!item) return;
    item.priority = "user";
    item.intent = intent;
    item.onProgress = onProgress;
    const slot = queue.findIndex((q) => q.priority === "idle");
    if (slot === -1) queue.push(item);
    else queue.splice(slot, 0, item);
  }

  function drain(): void {
    if (inflight || ended || !dc || dc.readyState !== "open") return;
    const item = queue.shift();
    if (!item) return;
    const id = nextId++;
    if (item.priority === "user") warpBurst();
    inflight = {
      id,
      path: item.path,
      expected: 0,
      mime: "",
      chunks: [],
      received: 0,
      onProgress: item.onProgress,
      resolve: item.resolve,
      reject: item.reject,
    };
    dc.send(JSON.stringify({ t: "get", id, path: item.path, intent: item.intent }));
  }

  function rejectAll(reason: string): void {
    const err = new Error(reason);
    inflight?.reject(err);
    inflight = null;
    for (const item of queue) item.reject(err);
    queue = [];
    pending.clear();
  }

  function cacheResult(path: string, result: FetchResult): void {
    if (result.blob.size > CACHE_ITEM_MAX) return;
    dropCached(path);
    blobCache.set(path, result);
    cacheBytes += result.blob.size;
    // Map iteration order is insertion order: evict oldest first.
    for (const key of blobCache.keys()) {
      if (cacheBytes <= CACHE_MAX_BYTES) break;
      dropCached(key);
    }
    refreshCacheDots();
  }

  function dropCached(path: string): void {
    const old = blobCache.get(path);
    if (!old) return;
    blobCache.delete(path);
    cacheBytes -= old.blob.size;
    refreshCacheDots();
  }

  function refreshCacheDots(): void {
    for (const [path, dot] of cacheDots) dot.hidden = !blobCache.has(path);
  }

  /** Idle scan: warm the cache with small previewable files in view. */
  function schedulePrefetch(): void {
    const token = ++prefetchToken;
    idle(() => {
      if (token !== prefetchToken || ended || !level) return;
      let budget = PREFETCH_SCAN_COUNT;
      for (const row of currentRows) {
        if (budget === 0) break;
        if (row.type !== "file") continue;
        const { entry } = row;
        if (!PREVIEWABLE.has(entry.kind)) continue;
        if (entry.size > PREFETCH_SCAN_MAX) continue;
        if (blobCache.has(entry.path) || pending.has(entry.path)) continue;
        budget--;
        requestFile(entry.path, "preview", "idle").catch(() => {});
      }
    });
  }

  // ----- browser -----------------------------------------------------------
  function visibleRows(): Row[] {
    if (filterText) {
      const q = filterText.toLowerCase();
      return manifest
        .filter((entry) => entry.path.toLowerCase().includes(q))
        .map((entry) => ({ type: "file" as const, name: entry.path, entry }));
    }
    return listDir(manifest, cwd);
  }

  function sortRows(rows: Row[]): Row[] {
    const dirFirst = (r: Row) => (r.type === "dir" ? 0 : 1);
    const size = (r: Row) => (r.type === "dir" ? r.size : r.entry.size);
    return [...rows].sort((a, b) => {
      if (dirFirst(a) !== dirFirst(b)) return dirFirst(a) - dirFirst(b);
      const cmp = sortKey === "name" ? a.name.localeCompare(b.name) : size(a) - size(b);
      return sortAsc ? cmp : -cmp;
    });
  }

  function rowKey(row: Row): string {
    return row.type === "dir" ? `d:${row.path}` : `f:${row.entry.path}`;
  }

  function renderBrowser(): void {
    if (ended) return;
    message.hidden = true;

    crumbBar.replaceChildren();
    crumbBar.hidden = filterText !== "";
    const trail = crumbs(cwd);
    trail.forEach((crumb, index) => {
      if (index > 0) crumbBar.append(el("span", { class: "sep" }, ["›"]));
      if (index === trail.length - 1) {
        crumbBar.append(el("span", { class: "here" }, [crumb.name]));
      } else {
        const link = el("button", { class: "linkbtn mono" }, [crumb.name]);
        link.addEventListener("click", () => {
          cwd = crumb.path;
          selectedKey = null;
          renderBrowser();
        });
        crumbBar.append(link);
      }
    });

    sortNameBtn.textContent = sortKey === "name" ? (sortAsc ? "name ↑" : "name ↓") : "name";
    sortSizeBtn.textContent = sortKey === "size" ? (sortAsc ? "size ↑" : "size ↓") : "size";
    sortNameBtn.classList.toggle("active", sortKey === "name");
    sortSizeBtn.classList.toggle("active", sortKey === "size");

    currentRows = sortRows(visibleRows());

    if (filterText) {
      countLabel.textContent = `${currentRows.length} match${currentRows.length === 1 ? "" : "es"}`;
    } else {
      const dirs = currentRows.filter((r) => r.type === "dir").length;
      const files = currentRows.length - dirs;
      const bytes = currentRows.reduce((n, r) => n + (r.type === "dir" ? r.size : r.entry.size), 0);
      countLabel.textContent = `${dirs} dir · ${files} file${files === 1 ? "" : "s"} · ${fmtSize(bytes)}`;
    }

    table.replaceChildren();
    cacheDots.clear();
    rowNodes = [];

    if (currentRows.length === 0) {
      message.hidden = false;
      message.textContent = filterText
        ? `Nothing matches “${filterText}”. Clear the filter to browse.`
        : "Nothing here — the sender hasn't added files, or they were destroyed.";
      selected = -1;
      return;
    }

    let i = 0;
    for (const row of currentRows) {
      const node = renderRow(row);
      node.style.animationDelay = `${Math.min(i++, 12) * 22}ms`;
      table.append(node);
      rowNodes.push(node);
    }

    // Keep the selection on the same item across re-renders when possible.
    selected = selectedKey ? currentRows.findIndex((r) => rowKey(r) === selectedKey) : -1;
    applySelection(false);
    schedulePrefetch();
  }

  function applySelection(scroll = true): void {
    rowNodes.forEach((node, i) => node.classList.toggle("selected", i === selected));
    const row = selected >= 0 ? currentRows[selected] : undefined;
    selectedKey = row ? rowKey(row) : null;
    if (scroll) rowNodes[selected]?.scrollIntoView({ block: "nearest" });
  }

  function activate(row: Row): void {
    if (row.type === "dir") {
      cwd = row.path;
      filterText = "";
      searchInput.value = "";
      selectedKey = null;
      renderBrowser();
      return;
    }
    const previewable = PREVIEWABLE.has(row.entry.kind);
    if (level === "view" && !previewable) return;
    const list = currentRows
      .filter((r): r is Extract<Row, { type: "file" }> => r.type === "file")
      .filter((r) => level !== "view" || PREVIEWABLE.has(r.entry.kind))
      .map((r) => r.entry);
    openViewer(list, list.indexOf(row.entry));
  }

  function renderRow(row: Row): HTMLElement {
    if (row.type === "dir") {
      const node = el("div", { class: "filerow clickable", tabindex: "0", role: "button" }, [
        kindIcon("dir"),
        el("span", { class: "mono path ellipsis" }, [`${row.name}/`]),
        el("span", { class: "mono meta" }, [
          `${row.files} file${row.files === 1 ? "" : "s"} · ${fmtSize(row.size)}`,
        ]),
      ]);
      wireRow(node, row);
      return node;
    }

    const { entry } = row;
    const previewable = PREVIEWABLE.has(entry.kind);
    const lockedOut = level === "view" && !previewable;
    const dot = el("span", {
      class: "cachedot",
      hidden: !blobCache.has(entry.path),
      title: "Ready — opens instantly",
    });
    cacheDots.set(entry.path, dot);
    const node = el(
      "div",
      {
        class: `filerow clickable${lockedOut ? " locked" : ""}`,
        tabindex: "0",
        role: "button",
        title: lockedOut ? "This preview-only link can't open this file type" : undefined,
      },
      [
        kindIcon(entry.kind),
        el("span", { class: "mono path ellipsis" }, [row.name]),
        dot,
        el("span", { class: "mono dim size" }, [fmtSize(entry.size)]),
      ],
    );
    wireRow(node, row);
    if (!lockedOut) {
      let hover = 0;
      node.addEventListener("mouseenter", () => {
        hover = window.setTimeout(() => {
          if (ended || !PREVIEWABLE.has(entry.kind) || entry.size > CACHE_ITEM_MAX) return;
          requestFile(entry.path, "preview", "idle").catch(() => {});
        }, 120);
      });
      node.addEventListener("mouseleave", () => window.clearTimeout(hover));
    }
    return node;
  }

  function wireRow(node: HTMLElement, row: Row): void {
    const act = () => {
      selected = currentRows.indexOf(row);
      applySelection(false);
      activate(row);
    };
    node.addEventListener("click", act);
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter") act();
    });
  }

  // ----- keyboard ----------------------------------------------------------
  searchInput.addEventListener("input", () => {
    filterText = searchInput.value.trim();
    selectedKey = null;
    renderBrowser();
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      searchInput.value = "";
      filterText = "";
      searchInput.blur();
      renderBrowser();
    } else if (e.key === "Enter" && currentRows[0]) {
      selected = 0;
      applySelection();
      activate(currentRows[0]);
    } else if (e.key === "ArrowDown" && currentRows.length > 0) {
      e.preventDefault();
      searchInput.blur();
      selected = 0;
      applySelection();
    }
  });
  sortNameBtn.addEventListener("click", () => {
    sortAsc = sortKey === "name" ? !sortAsc : true;
    sortKey = "name";
    renderBrowser();
  });
  sortSizeBtn.addEventListener("click", () => {
    sortAsc = sortKey === "size" ? !sortAsc : true;
    sortKey = "size";
    renderBrowser();
  });

  document.addEventListener("keydown", (e) => {
    if (ended || !level || overlayOpen) return;
    const target = e.target as HTMLElement | null;
    if (target === searchInput) return;
    if (target && (target.tagName === "INPUT" || target.tagName === "SELECT")) return;

    if (e.key === "/") {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (currentRows.length === 0) return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      selected = Math.min(currentRows.length - 1, Math.max(0, selected + step));
      applySelection();
    } else if (e.key === "Home" && currentRows.length > 0) {
      e.preventDefault();
      selected = 0;
      applySelection();
    } else if (e.key === "End" && currentRows.length > 0) {
      e.preventDefault();
      selected = currentRows.length - 1;
      applySelection();
    } else if (e.key === "Enter" && selected >= 0) {
      const row = currentRows[selected];
      if (row) activate(row);
    } else if (e.key === "Backspace" && !filterText && cwd !== "") {
      e.preventDefault();
      cwd = cwd.includes("/") ? cwd.slice(0, cwd.lastIndexOf("/")) : "";
      selectedKey = null;
      renderBrowser();
    }
  });

  // ----- viewer ------------------------------------------------------------
  let closeViewer: () => void = () => {};

  function skeletonFor(kind: FileKind): HTMLElement {
    if (kind === "image" || kind === "media") return el("div", { class: "skel skel-box" });
    if (kind === "pdf") return el("div", { class: "skel skel-page" });
    const lines = el("div", { class: "skel-lines" });
    for (const width of [94, 100, 78, 96, 62]) {
      lines.append(el("div", { class: "skel skel-line", style: `width: ${width}%` }));
    }
    return lines;
  }

  function openViewer(list: FileEntry[], start: number): void {
    if (!level || list.length === 0 || start < 0) return;
    let index = start;
    let token = 0;
    const restoreFocus = rowNodes[selected] ?? null;

    const kindChip = el("span", { class: "kind" });
    const nameLabel = el("span", { class: "mono path ellipsis ovname" });
    const sizeLabel = el("span", { class: "mono dim ovpos" });
    const posLabel = el("span", { class: "mono dim ovpos" });
    const prevButton = el("button", { class: "iconbtn ovnav", title: "Previous (←)" }, [icon("chev-l")]);
    const nextButton = el("button", { class: "iconbtn ovnav", title: "Next (→)" }, [icon("chev-r")]);
    const closeButton = el("button", { class: "iconbtn ovnav ovclose", title: "Close (Esc)" }, [icon("x")]);
    const downloadButton = levelAllows(level, "download")
      ? el("button", { class: "btn small" }, [icon("download"), "Download"])
      : null;

    const body = el("div", { class: "overlay-body" });
    const bar = el("div", { class: "bar" });
    const progress = el("div", { class: "progress", hidden: true }, [bar]);
    const note = el("p", { class: "dim centered" });

    overlay.replaceChildren();
    overlay.append(
      el("div", { class: "overlay-head" }, [
        el("div", { class: "row gap center minw" }, [kindChip, nameLabel, sizeLabel]),
        el(
          "div",
          { class: "row gap center" },
          [posLabel, prevButton, nextButton, downloadButton, closeButton].filter(Boolean) as Node[],
        ),
      ]),
      progress,
      note,
      body,
    );
    overlay.hidden = false;
    overlayOpen = true;
    document.body.classList.add("noscroll");
    overlay.focus();

    closeViewer = () => {
      overlay.hidden = true;
      overlayOpen = false;
      document.body.classList.remove("noscroll");
      // Invalidate any in-flight preview load so its .then() can't render into
      // the now-detached body or create object URLs after the release below.
      token++;
      body.replaceChildren();
      releasePreviewResources();
      document.removeEventListener("keydown", onKeys);
      closeViewer = () => {};
      restoreFocus?.focus();
    };
    closeButton.addEventListener("click", () => closeViewer());
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeViewer();
    });

    // Listen on document, not the overlay: focus can land on <body> (tab
    // switch, backdrop click) and the viewer keys must keep working.
    const onKeys = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeViewer();
      else if (e.key === "ArrowLeft") show(index - 1);
      else if (e.key === "ArrowRight") show(index + 1);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKeys);
    prevButton.addEventListener("click", () => show(index - 1));
    nextButton.addEventListener("click", () => show(index + 1));

    const onProgress = (received: number, expected: number) => {
      const pct = expected > 0 ? Math.min(100, (received / expected) * 100) : 0;
      bar.style.width = `${pct.toFixed(1)}%`;
    };

    if (downloadButton) {
      downloadButton.addEventListener("click", () => {
        const entry = list[index];
        if (!entry) return;
        downloadButton.disabled = true;
        requestFile(entry.path, "download", "user", onProgress)
          .then(({ blob }) => {
            saveBlob(blob, basename(entry.path));
            progress.hidden = true;
            downloadButton.disabled = false;
          })
          .catch((err: Error) => {
            note.textContent = err.message;
            progress.hidden = true;
            downloadButton.disabled = false;
          });
      });
    }

    function show(next: number): void {
      const entry = list[next];
      if (!entry) return;
      index = next;
      const name = basename(entry.path);
      const mine = ++token;

      releasePreviewResources();
      body.replaceChildren();
      note.textContent = "";
      bar.style.width = "0%";
      kindChip.className = `kind kind-${entry.kind}`;
      kindChip.textContent = entry.kind;
      nameLabel.textContent = name;
      sizeLabel.textContent = fmtSize(entry.size);
      posLabel.textContent = `${index + 1} / ${list.length}`;
      prevButton.disabled = index === 0;
      nextButton.disabled = index === list.length - 1;

      if (!PREVIEWABLE.has(entry.kind)) {
        progress.hidden = true;
        note.textContent =
          level === "view"
            ? "This link is preview-only and this file type has no inline preview."
            : "No inline preview for this file type — download it instead.";
        return;
      }

      const instant = blobCache.has(entry.path);
      progress.hidden = instant;
      if (!instant) body.append(skeletonFor(entry.kind));

      requestFile(entry.path, "preview", "user", onProgress)
        .then((result) => {
          if (mine !== token) return; // user already moved on
          progress.hidden = true;
          body.replaceChildren();
          return renderPreview(body, entry.kind, name, result.blob);
        })
        .then(() => {
          if (mine !== token) return;
          // Optimistically warm the neighbors so ←/→ feel instant.
          for (const near of [list[index + 1], list[index - 1]]) {
            if (near && PREVIEWABLE.has(near.kind) && near.size <= CACHE_ITEM_MAX) {
              requestFile(near.path, "preview", "idle").catch(() => {});
            }
          }
        })
        .catch((err: Error) => {
          if (mine !== token) return;
          progress.hidden = true;
          body.replaceChildren();
          note.textContent = err.message;
        });
    }

    show(index);
  }
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = el("a", { href: url, download: name.replace(/[/\\\x00-\x1f]/g, "_") });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
