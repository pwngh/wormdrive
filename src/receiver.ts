/**
 * @pwngh/wormdrive
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

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

import { el, fmtSize, staggerDelay } from "./dom";
import { warpBurst } from "./fx/starfield";
import { icon, kindIcon } from "./icons";
import { basename, crumbs, listDir, type Row } from "./manifest";
import {
  ACK_INTERVAL,
  CHUNK_SIZE,
  FLOW_STALL_MS,
  LEVEL_BLURB,
  LEVEL_LABEL,
  LEVELS,
  PREVIEWABLE,
  levelAllows,
  sanitizeManifest,
  validFileHeadSize,
  type FileEntry,
  type FileKind,
  type Level,
  type SenderToReceiver,
} from "./protocol";
import { answerPeer } from "./rtc";
import { Signal } from "./signaling";
import { renderPreview, releasePreviewResources } from "./viewers";
import { createZip, ZipStream, type ZipEntry, type ZipWrite } from "./zip";

interface Transfer {
  id: number;
  path: string;
  expected: number;
  mime: string;
  chunks: ArrayBuffer[];
  /** When set, byte chunks are written here (streamed to disk) instead of being
   *  buffered in `chunks`. The transfer `id` is passed through so the sink can ack. */
  sink?: (chunk: ArrayBuffer, id: number) => void;
  received: number;
  // Bytes consumed and the high-water mark already acked to the sender (buffered
  // path only; the streaming sink tracks its own). See ACK_INTERVAL / sendAck.
  consumed: number;
  lastAck: number;
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
  /** Streaming sink; when present the bytes go here instead of a buffered Blob. */
  sink?: (chunk: ArrayBuffer, id: number) => void;
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

// Timings (ms).
const STALL_TIMEOUT_MS = 20_000; // drop the "connecting…" state after this with NAT advice
// In-transfer liveness watchdog. Longer than the sender's FLOW_STALL_MS so a
// healthy slow-disk download (which legitimately pauses the sender for credit) is
// never aborted — bytes resume and re-arm this, or the sender's own stall fires
// first and sends file-err. Only a sender that goes silent without closing the
// channel (a suspended tab, a half-open path) trips it.
const TRANSFER_STALL_MS = FLOW_STALL_MS + 15_000;
const HOVER_PREFETCH_MS = 120; // hover dwell before speculatively warming a file
const IDLE_CALLBACK_TIMEOUT_MS = 800; // requestIdleCallback deadline for prefetch work
const IDLE_FALLBACK_MS = 180; // setTimeout fallback where requestIdleCallback is absent

const idle: (cb: () => void) => void =
  typeof window.requestIdleCallback === "function"
    ? (cb) => window.requestIdleCallback(cb, { timeout: IDLE_CALLBACK_TIMEOUT_MS })
    : (cb) => window.setTimeout(cb, IDLE_FALLBACK_MS);

const noProgress: Transfer["onProgress"] = () => {};

/**
 * Mount the receiver UI into `root` for a given share: connect over the
 * signaling relay, answer the sender's offer, then drive the file browser,
 * preview overlay, and the optimistic transfer engine.
 *
 * Everything lives in this one closure rather than a class so the per-share
 * state (data channel, manifest, queue, blob cache, viewer token) is captured
 * by reference and torn down together when the tab navigates away — there is
 * exactly one receiver per page and no need to instantiate more. `token` is the
 * bearer secret from the share URL fragment; it is sent only over the
 * established data channel (in `hello`), never to the relay.
 */
export function mountReceiver(root: HTMLElement, shareId: string, token: string): void {
  // ----- state -------------------------------------------------------------
  let dc: RTCDataChannel | null = null;
  let level: Level | null = null;
  let manifest: FileEntry[] = [];
  let cwd = "";
  let nextId = 1;
  let inflight: Transfer | null = null;
  let xferTimer = 0; // in-transfer liveness watchdog; armed only while a transfer is inflight
  // Streamed eofs resolve with a value their resolver ignores (the bytes are on
  // disk); reuse one empty result instead of allocating a Blob per eof.
  const EMPTY_RESULT: FetchResult = { blob: new Blob([]), mime: "" };
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
  let downloading = false;

  // ----- skeleton ----------------------------------------------------------
  const ring = el("span", { class: "ring connecting", title: "connection state" });
  const title = el("h1", { class: "share-title" }, ["Connecting…"]);
  const chipSlot = el("span");
  const destroySlot = el("span");
  const header = el("header", { class: "share-head" }, [
    el("div", { class: "minw" }, [
      el("p", { class: "brandline mono" }, ["wormdrive"]),
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
  const sortNameBtn = el("button", { class: "sortbtn mono", "aria-label": "Sort by name" }, ["name"]);
  const sortSizeBtn = el("button", { class: "sortbtn mono", "aria-label": "Sort by size" }, ["size"]);
  const countLabel = el("span", { class: "mono dim count" });
  // Bulk download (download/manage links only): the whole current folder as a zip,
  // or a lone file directly. Revealed and labelled in renderBrowser once a grant lands.
  const downloadAllBtn = el("button", { class: "btn small", hidden: true });
  const toolbar = el("div", { class: "toolbar", hidden: true }, [
    el("div", { class: "searchwrap" }, [icon("search"), searchInput]),
    el("div", { class: "row gap center" }, [sortNameBtn, sortSizeBtn, countLabel, downloadAllBtn]),
  ]);

  const crumbBar = el("nav", { class: "crumbs mono", "aria-label": "Breadcrumb" });
  const table = el("div", { class: "filetable" });
  // role="status" => polite live region: connection progress and end-of-share
  // messages are announced to screen readers as the text changes.
  const message = el("p", { class: "dim centered", role: "status" }, ["Knocking on the sender's tab…"]);
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

  const overlay = el("div", {
    class: "overlay",
    hidden: true,
    tabindex: "-1",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "ov-name",
  });

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
  }, STALL_TIMEOUT_MS);

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
      channel.send(JSON.stringify({ t: "hello", token, flow: true }));
    })
    .catch(() => fail("Peer connection failed."));

  function fail(text: string, terminal = true): void {
    if (ended) return;
    if (terminal) {
      ended = true;
      ring.className = "ring ended";
      title.textContent = "Share ended";
      dc = null;
      peer.close();
      signal.close();
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
      inflight.received += raw.byteLength;
      // Hard ceiling: never accept past the declared size (+ one chunk of
      // slack). Catches both lying file-heads and chunks sent with no head
      // at all (expected is still 0 then). Checked before the chunk is kept,
      // so nothing over-limit is buffered or written to disk.
      if (inflight.received > inflight.expected + CHUNK_SIZE) {
        violation("transfer exceeded its declared size.");
        return;
      }
      if (inflight.sink) {
        inflight.sink(raw, inflight.id);
      } else {
        inflight.chunks.push(raw);
        // Buffered chunks count as consumed the instant they land in memory (no
        // disk to wait on), so acks keep pace with arrival and the sender never
        // throttles this path (it's holding the whole file anyway). The streaming
        // sink instead advances consumed only after each disk write resolves, so
        // its acks lag a slow disk — and that lag is what paces the download. Both
        // paths ack every ACK_INTERVAL; only when a byte counts as consumed differs.
        inflight.consumed += raw.byteLength;
        if (inflight.consumed - inflight.lastAck >= ACK_INTERVAL) {
          inflight.lastAck = inflight.consumed;
          sendAck(inflight.id, inflight.consumed);
        }
      }
      inflight.onProgress(inflight.received, inflight.expected);
      armXferTimer(); // bytes arrived: the transfer is alive, restart the watchdog
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
          const cur = inflight; // narrowed const keeps its non-null type inside find()
          armXferTimer(); // the sender responded; the transfer is alive
          // The declared size is attacker-controlled and gates how much we
          // buffer (see the ArrayBuffer ceiling), so it must not exceed what
          // the validated manifest promised for this path — otherwise a tiny
          // manifest entry could stream gigabytes and OOM the tab.
          const entry = manifest.find((e) => e.path === cur.path);
          if (!entry || !validFileHeadSize(msg.size, entry.size)) {
            violation("file-head disagrees with the manifest.");
            return;
          }
          cur.expected = msg.size;
          cur.mime = typeof msg.mime === "string" ? msg.mime.slice(0, 200) : "";
        }
        break;
      case "file-eof":
        if (inflight && inflight.id === msg.id) {
          const done = inflight;
          inflight = null;
          clearXferTimer();
          if (done.sink) {
            // Streamed straight to the sink — nothing buffered to wrap or cache,
            // and a streamed transfer is never tracked in `pending`. The resolver
            // ignores the value (bytes are on disk), so reuse EMPTY_RESULT.
            done.resolve(EMPTY_RESULT);
          } else {
            const result = { blob: new Blob(done.chunks, { type: done.mime }), mime: done.mime };
            cacheResult(done.path, result);
            pending.delete(done.path);
            done.resolve(result);
          }
          drain();
        }
        break;
      case "file-err":
        if (inflight && inflight.id === msg.id) {
          const dead = inflight;
          inflight = null;
          clearXferTimer();
          if (!dead.sink) pending.delete(dead.path); // streamed transfers aren't in `pending`
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
      sink: item.sink,
      received: 0,
      consumed: 0,
      lastAck: 0,
      onProgress: item.onProgress,
      resolve: item.resolve,
      reject: item.reject,
    };
    dc.send(JSON.stringify({ t: "get", id, path: item.path, intent: item.intent }));
    armXferTimer();
  }

  // Fail an in-flight transfer whose sender has gone quiet — no bytes, no file-eof,
  // no file-err, no channel close — so it can't pin `inflight` and wedge the queue.
  // Armed when a transfer starts, re-armed on each byte, cleared on settlement.
  function armXferTimer(): void {
    window.clearTimeout(xferTimer);
    xferTimer = window.setTimeout(() => {
      if (!inflight) return;
      const dead = inflight;
      inflight = null;
      if (!dead.sink) pending.delete(dead.path);
      dead.reject(new Error("Transfer stalled — the sender stopped responding."));
      drain();
    }, TRANSFER_STALL_MS);
  }

  function clearXferTimer(): void {
    window.clearTimeout(xferTimer);
    xferTimer = 0;
  }

  // Tell the sender how many bytes we've consumed for transfer `id` — its credit
  // to send more (see FLOW_WINDOW). Best-effort: a closed channel needs no ack.
  function sendAck(id: number, bytes: number): void {
    if (dc && dc.readyState === "open") dc.send(JSON.stringify({ t: "ack", id, bytes }));
  }

  /**
   * Stream a file's bytes straight to `write` (e.g. a disk writable) instead of
   * buffering them into a Blob, so a large file passes through rather than being
   * held whole. We ack progress as chunks land on disk (roughly every ACK_INTERVAL,
   * not per chunk), and the sender will not run more than FLOW_WINDOW ahead of those
   * acks, so the bytes waiting here stay bounded even when the disk is slower than
   * the link. Goes through the same queue
   * and the same sender-side permission gate as a buffered download — only the
   * destination differs. Not cached (a streamed file may dwarf the cache budget).
   * Resolves once the last byte has been written.
   */
  function streamFile(path: string, write: ZipWrite): Promise<void> {
    if (!dc || dc.readyState !== "open" || ended) {
      return Promise.reject(new Error("Not connected."));
    }
    return new Promise<void>((resolve, reject) => {
      // Chunks arrive in order; the disk write is async, so we feed them to disk
      // one at a time down a promise chain (each waits for the one before it). Once
      // a chunk lands we tell the sender how far we've gotten — an ack every
      // ACK_INTERVAL — which frees it to send more. That ack is the brake: without
      // it the sender would outrun a slow disk and the unwritten chunks would pile
      // up here. eof resolves once the chain drains (the last byte is on disk).
      let chain: Promise<void> = Promise.resolve();
      let consumed = 0;
      let lastAck = 0;
      const sink = (chunk: ArrayBuffer, id: number): void => {
        const len = chunk.byteLength;
        chain = chain
          .then(() => write(new Uint8Array(chunk)))
          .then(() => {
            consumed += len;
            if (consumed - lastAck >= ACK_INTERVAL) {
              lastAck = consumed;
              sendAck(id, consumed);
            }
          });
        // If a disk write fails (quota, the device removed, an I/O error), surface
        // it: tear this transfer down so the outer promise rejects, inflight clears,
        // and drain() resumes the queue — otherwise acks would freeze, the sender
        // would stall, and the whole transfer engine would wedge. Guard on still
        // being the active transfer so a write that rejects after an unrelated
        // teardown can't fail a later one. (This also consumes the trailing
        // rejection, which is why a bare .catch was here before.)
        chain.catch((err) => {
          if (inflight && inflight.id === id) {
            const dead = inflight;
            inflight = null;
            clearXferTimer();
            dead.reject(err instanceof Error ? err : new Error("Disk write failed."));
            drain();
          }
        });
      };
      const item: QueueItem = {
        path,
        intent: "download",
        priority: "user",
        onProgress: noProgress,
        sink,
        resolve: () => {
          void chain.then(() => resolve(), reject);
        },
        reject,
      };
      // User priority: ahead of speculative pulls, behind earlier user requests.
      const at = queue.findIndex((q) => q.priority === "idle");
      if (at === -1) queue.push(item);
      else queue.splice(at, 0, item);
      drain();
    });
  }

  function rejectAll(reason: string): void {
    const err = new Error(reason);
    clearXferTimer();
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
    // No refreshCacheDots() here: cacheResult refreshes once after its eviction
    // loop, and the manifest handler refreshes via renderBrowser — a per-drop
    // refresh was a redundant pass over cacheDots.
  }

  function refreshCacheDots(): void {
    for (const [path, dot] of cacheDots) dot.hidden = !blobCache.has(path);
  }

  /** Idle scan: warm the cache with small previewable files in view. */
  function schedulePrefetch(): void {
    const token = ++prefetchToken;
    idle(() => {
      // Skip while a bulk download runs: a streamed transfer isn't tracked in
      // `pending`, so a speculative pull for the same path wouldn't dedupe.
      if (token !== prefetchToken || ended || !level || downloading) return;
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
      if (index > 0) crumbBar.append(el("span", { class: "sep", "aria-hidden": "true" }, ["›"]));
      if (index === trail.length - 1) {
        crumbBar.append(el("span", { class: "here", "aria-current": "page" }, [crumb.name]));
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
    updateDownloadAll();

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
      node.style.animationDelay = staggerDelay(i++);
      table.append(node);
      rowNodes.push(node);
    }

    // Keep the selection on the same item across re-renders when possible.
    selected = selectedKey ? currentRows.findIndex((r) => rowKey(r) === selectedKey) : -1;
    applySelection(false);
    schedulePrefetch();
  }

  // ----- bulk download -----------------------------------------------------
  // What the download button acts on: the filtered matches when a filter is
  // active, otherwise every file under the current folder (recursively). The
  // prefix is stripped from zip entry names so the archive is rooted at the
  // folder you're in (full paths at root, full paths for cross-folder matches).
  function downloadScope(): { files: FileEntry[]; prefix: string; filtered: boolean } {
    if (filterText) {
      return { files: currentRows.flatMap((r) => (r.type === "file" ? [r.entry] : [])), prefix: "", filtered: true };
    }
    const files = manifest.filter((e) => cwd === "" || e.path.startsWith(`${cwd}/`));
    return { files, prefix: cwd === "" ? "" : `${cwd}/`, filtered: false };
  }

  function updateDownloadAll(): void {
    if (!level || !levelAllows(level, "download")) {
      downloadAllBtn.hidden = true;
      return;
    }
    const { files, filtered } = downloadScope();
    downloadAllBtn.hidden = files.length === 0;
    if (files.length === 0) return;
    downloadAllBtn.disabled = downloading;
    // While a download runs, runDownload's setLabel owns the button text (the live
    // progress). Don't overwrite it with the idle/new-scope label; runDownload's
    // finally repaints this once downloading clears.
    if (downloading) return;
    const total = files.reduce((sum, e) => sum + e.size, 0);
    downloadAllBtn.replaceChildren(
      icon("download"),
      files.length === 1
        ? `Download ${basename(files[0]!.path)}`
        : `Download ${filtered ? "matches" : "all"} (${files.length}) · ${fmtSize(total)}`,
    );
  }

  // The download button streams straight to disk when the browser has the File
  // System Access API (so a multi-gigabyte folder uses ~one chunk of memory while
  // the disk keeps pace with the wire), and otherwise assembles the download in
  // memory and saves it (fine for the everyday case, bounded by the tab's memory).
  // Either way every file is fetched through the same sender-side permission gate
  // as a single download.

  // Minimal slice of the File System Access API we use (absent from some TS DOM libs).
  interface DiskWritable {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }
  type SaveFilePicker = (opts: { suggestedName?: string }) => Promise<{ createWritable(): Promise<DiskWritable> }>;

  function savePicker(): SaveFilePicker | undefined {
    return (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  }

  /** Archive name for a folder/filtered download (a lone file keeps its own name). */
  function zipStem(filtered: boolean): string {
    if (filtered) return "wormdrive-files";
    if (cwd === "") return title.textContent || "wormdrive";
    return basename(cwd);
  }

  async function runDownload(): Promise<void> {
    if (downloading || !level || !levelAllows(level, "download")) return;
    const { files, prefix, filtered } = downloadScope();
    if (files.length === 0) return;
    downloading = true;
    downloadAllBtn.disabled = true;
    const setLabel = (text: string): void => {
      downloadAllBtn.replaceChildren(text);
    };
    const picker = savePicker();
    try {
      if (picker) await streamToDisk(picker, files, prefix, filtered, setLabel);
      else await bundleInMemory(files, prefix, filtered, setLabel);
    } catch (err) {
      // A dismissed save dialog isn't a failure; anything else is worth showing
      // (unless a disconnect already replaced the message).
      if ((err as DOMException).name !== "AbortError" && !ended) {
        message.hidden = false;
        message.textContent = `Download failed: ${(err as Error).message}`;
      }
    } finally {
      downloading = false;
      if (!ended) updateDownloadAll();
    }
  }

  // Stream to disk: a lone file goes byte-for-byte to the chosen file; a folder is
  // streamed into a zip on the fly. Peak memory is ~one chunk while the disk keeps
  // pace with the wire, not the whole set.
  async function streamToDisk(
    picker: SaveFilePicker,
    files: FileEntry[],
    prefix: string,
    filtered: boolean,
    setLabel: (text: string) => void,
  ): Promise<void> {
    const single = files.length === 1;
    const suggestedName = single ? safeName(basename(files[0]!.path)) : safeName(`${zipStem(filtered)}.zip`);
    const handle = await picker({ suggestedName });
    const writable = await handle.createWritable();
    try {
      if (single) {
        setLabel("Downloading…");
        await streamFile(files[0]!.path, (chunk) => writable.write(chunk));
      } else {
        const zip = new ZipStream((chunk) => writable.write(chunk));
        for (let i = 0; i < files.length; i += 1) {
          setLabel(`Downloading ${i + 1}/${files.length}…`);
          const file = files[i]!;
          await zip.addFile(file.path.slice(prefix.length), file.size);
          await streamFile(file.path, (chunk) => zip.writeChunk(chunk));
          await zip.closeFile();
        }
        await zip.finish();
      }
      await writable.close();
    } catch (err) {
      await writable.abort().catch(() => undefined); // discard the partial file
      throw err;
    }
  }

  // In-memory fallback (no File System Access API): a lone file downloads directly;
  // a folder is bundled into one store-only zip and saved.
  async function bundleInMemory(
    files: FileEntry[],
    prefix: string,
    filtered: boolean,
    setLabel: (text: string) => void,
  ): Promise<void> {
    if (files.length === 1) {
      setLabel("Downloading…");
      const { blob } = await requestFile(files[0]!.path, "download", "user");
      saveBlob(blob, basename(files[0]!.path));
      return;
    }
    const entries: ZipEntry[] = [];
    for (let i = 0; i < files.length; i += 1) {
      setLabel(`Zipping ${i + 1}/${files.length}…`);
      const file = files[i]!;
      const { blob } = await requestFile(file.path, "download", "user");
      entries.push({ name: file.path.slice(prefix.length), data: new Uint8Array(await blob.arrayBuffer()) });
    }
    saveBlob(new Blob([createZip(entries)], { type: "application/zip" }), `${zipStem(filtered)}.zip`);
  }

  downloadAllBtn.addEventListener("click", () => void runDownload());

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
    // A bulk download owns the channel; opening a preview now would re-fetch a path
    // it may be streaming (streamed transfers aren't in `pending`, so the request
    // wouldn't dedupe). Folder navigation above stays available.
    if (downloading) return;
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
      // Decorative speed hint; the file opens the same either way. Hiding it
      // keeps the row's accessible name to the filename, not a changing dot.
      "aria-hidden": "true",
    });
    cacheDots.set(entry.path, dot);
    const node = el(
      "div",
      {
        class: `filerow clickable${lockedOut ? " locked" : ""}`,
        tabindex: "0",
        role: "button",
        "aria-disabled": lockedOut ? "true" : undefined,
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
          if (ended || downloading || !PREVIEWABLE.has(entry.kind) || entry.size > CACHE_ITEM_MAX) return;
          requestFile(entry.path, "preview", "idle").catch(() => {});
        }, HOVER_PREFETCH_MS);
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
      // role="button" must fire on Enter and Space; Space would scroll otherwise.
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        act();
      }
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
    const nameLabel = el("span", { id: "ov-name", class: "mono path ellipsis ovname" });
    const sizeLabel = el("span", { class: "mono dim ovpos" });
    const posLabel = el("span", { class: "mono dim ovpos" });
    const prevButton = el("button", { class: "iconbtn ovnav", title: "Previous (←)", "aria-label": "Previous file" }, [icon("chev-l")]);
    const nextButton = el("button", { class: "iconbtn ovnav", title: "Next (→)", "aria-label": "Next file" }, [icon("chev-r")]);
    const closeButton = el("button", { class: "iconbtn ovnav ovclose", title: "Close (Esc)", "aria-label": "Close preview" }, [icon("x")]);
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
    // Make the modal real: the background can't be tabbed into or read by AT
    // while the viewer is open (inert also handles the focus trap).
    header.inert = true;
    browser.inert = true;
    overlay.focus();

    closeViewer = () => {
      overlay.hidden = true;
      overlayOpen = false;
      document.body.classList.remove("noscroll");
      header.inert = false;
      browser.inert = false;
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
            if (!downloading && near && PREVIEWABLE.has(near.kind) && near.size <= CACHE_ITEM_MAX) {
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

// Strip path separators and control bytes from a download filename. Both save
// paths rely on it: a synthetic <a download> must not be steered to a path, and
// showSaveFilePicker rejects a suggestedName with a separator (a TypeError, not
// an AbortError). The control-char range is intentional.
// eslint-disable-next-line no-control-regex
const safeName = (name: string): string => name.replace(/[/\\\x00-\x1f]/g, "_");

// Trigger a browser download of `blob` without ever exposing it as a navigable
// resource: a synthetic <a download> click is the only cross-browser way to
// save a Blob to disk with a chosen filename. The object URL is revoked on a
// delay rather than immediately because some browsers begin the download
// asynchronously after the click and would abort if the URL vanished first.
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = el("a", { href: url, download: safeName(name) });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
