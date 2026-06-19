// Sender: stage files in this tab, mint the three permission links, and act
// as the file server for connected peers over WebRTC data channels. All
// permission and destruction decisions are made (and enforced) here.

import { copyText, el, flash, fmtSize, randomId, safeEqual } from "./dom";
import { warpBurst } from "./fx/starfield";
import { icon, kindIcon } from "./icons";
import { classify, toManifest } from "./manifest";
import {
  CHUNK_SIZE,
  LEVELS,
  LEVEL_BLURB,
  LEVEL_LABEL,
  MAX_MANIFEST_ENTRIES,
  PREVIEWABLE,
  levelAllows,
  type Level,
  type ReceiverToSender,
  type SenderToReceiver,
} from "./protocol";
import { offerPeer, sendWithBackpressure, type Peer } from "./rtc";
import { Signal } from "./signaling";

interface PeerCtx {
  id: string;
  peer: Peer;
  dc: RTCDataChannel | null;
  level: Level | null;
  busy: boolean;
}

interface Staged {
  path: string;
  file: File;
}

export function mountSender(root: HTMLElement): void {
  // ----- state -------------------------------------------------------------
  const staged = new Map<string, File>();
  const peers = new Map<string, PeerCtx>();
  let signal: Signal | null = null;
  let shareId = "";
  let tokens: Record<Level, string> | null = null;
  let live = false;
  let destructAt = 0;
  let destructTimer = 0;
  let countdownTimer = 0;

  // ----- skeleton ----------------------------------------------------------
  const notice = el("p", { class: "notice", hidden: true });
  const nameInput = el("input", {
    class: "field",
    type: "text",
    placeholder: "Share name",
    value: "Shared files",
    maxlength: "80",
  });
  const destructSelect = el("select", { class: "field" }, []);
  for (const [label, minutes] of [
    ["No timer", 0],
    ["After 5 minutes", 5],
    ["After 30 minutes", 30],
    ["After 1 hour", 60],
    ["After 6 hours", 360],
  ] as const) {
    destructSelect.append(el("option", { value: String(minutes) }, [label]));
  }

  const fileInput = el("input", { type: "file", multiple: true, hidden: true });
  const dirInput = el("input", { type: "file", hidden: true });
  dirInput.setAttribute("webkitdirectory", "");

  const dropZone = el(
    "div",
    { class: "dropzone portal", tabindex: "0", role: "button", "aria-label": "Add files to the share" },
    [
      el("div", { class: "portal-ring", "aria-hidden": "true" }),
      el("div", { class: "portal-core" }, [
        el("p", { class: "dropzone-title" }, ["Drop files into the drive"]),
        el("p", { class: "dropzone-sub" }, ["or"]),
        el("div", { class: "row gap center" }, [
          el("button", { class: "btn ghost", onclick: () => fileInput.click() }, ["Choose files"]),
          el("button", { class: "btn ghost", onclick: () => dirInput.click() }, ["Choose folder"]),
        ]),
      ]),
    ],
  );
  // The whole aperture is a giant target: any click that isn't on one of the
  // explicit buttons opens the file picker (the only sane tap target on touch).
  dropZone.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("button")) return;
    fileInput.click();
  });
  const portalNote = el("p", { class: "portal-note dim" }, [
    "Nothing uploads anywhere — files stream from this tab, peer to peer.",
  ]);

  const stagedTable = el("div", { class: "filetable" });
  const totalLine = el("span", { class: "mono dim total" });
  const openButton = el("button", { class: "btn primary", disabled: true }, ["Open share"]);

  const stagePanel = el("section", { class: "panel", hidden: true }, [
    el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title" }, ["Staged files"]),
      totalLine,
    ]),
    stagedTable,
    el("div", { class: "controls" }, [
      el("label", { class: "fgroup" }, [
        el("span", { class: "flabel" }, ["Share name"]),
        nameInput,
      ]),
      el("label", { class: "fgroup" }, [
        el("span", { class: "flabel" }, ["Self-destruct"]),
        destructSelect,
      ]),
      openButton,
    ]),
  ]);

  const linksBox = el("div", { class: "tickets" });
  const peersBox = el("div", { class: "peers" });
  const statusLine = el("p", { class: "mono dim status" });
  const destroyButton = el("button", { class: "btn danger small" }, [icon("trash"), "Destroy share"]);
  const livePanel = el("section", { class: "panel", hidden: true }, [
    el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title" }, [el("span", { class: "dot live" }), "Share is live"]),
      destroyButton,
    ]),
    linksBox,
    peersBox,
    statusLine,
  ]);

  root.classList.add("wide");
  root.append(
    el("header", { class: "hero" }, [
      el("h1", { class: "wordmark" }, ["worm", el("span", { class: "tick" }, ["·"]), "drive"]),
      el("p", { class: "tagline" }, [
        "Share a folder straight from your browser. Three links, three permission levels, gone when you say so.",
      ]),
    ]),
    notice,
    el("div", { class: "workbench" }, [
      el("div", { class: "wb-left" }, [dropZone, portalNote, fileInput, dirInput]),
      el("div", { class: "wb-right" }, [stagePanel, livePanel]),
    ]),
  );

  // ----- staging -----------------------------------------------------------
  function addStaged(items: Staged[]): void {
    if (items.length === 0) return;
    let dropped = 0;
    for (const { path, file } of items) {
      const clean = path.replace(/^\/+/, "");
      // Mirror the receiver's manifest validation exactly, or an honest large
      // folder would build a manifest the receiver rejects and disconnects on.
      if (clean.length === 0 || clean.split("/").some((seg) => seg === "" || seg === "..")) continue;
      if (!staged.has(clean) && staged.size >= MAX_MANIFEST_ENTRIES) {
        dropped += 1;
        continue;
      }
      staged.set(clean, file);
    }
    if (dropped > 0) {
      showNotice(`A share is capped at ${MAX_MANIFEST_ENTRIES} files — ${dropped} were not added.`);
    }
    const first = items[0];
    if (first && nameInput.value === "Shared files") {
      const top = first.path.split("/")[0];
      if (top && first.path.includes("/")) nameInput.value = top;
    }
    renderStaged();
    if (live) broadcastManifest();
  }

  function removeStaged(path: string): void {
    staged.delete(path);
    renderStaged();
    if (live) broadcastManifest();
  }

  function renderStaged(): void {
    stagedTable.replaceChildren();
    stagePanel.hidden = staged.size === 0;
    if (staged.size === 0) {
      totalLine.textContent = "";
      openButton.disabled = true;
      return;
    }
    const manifest = toManifest(staged);
    let total = 0;
    let i = 0;
    for (const entry of manifest) {
      total += entry.size;
      const delay = `${Math.min(i++, 12) * 22}ms`;
      stagedTable.append(
        el("div", { class: "filerow", style: `animation-delay: ${delay}` }, [
          kindIcon(entry.kind),
          el("span", { class: "mono path ellipsis", title: entry.path }, [entry.path]),
          el("span", { class: "mono dim size" }, [fmtSize(entry.size)]),
          el(
            "button",
            {
              class: "iconbtn rowdel",
              title: `Remove ${entry.path}`,
              "aria-label": `Remove ${entry.path}`,
              onclick: () => removeStaged(entry.path),
            },
            [icon("x")],
          ),
        ]),
      );
    }
    totalLine.textContent = `${manifest.length} file${manifest.length === 1 ? "" : "s"} · ${fmtSize(total)}`;
    openButton.disabled = false;
  }

  fileInput.addEventListener("change", () => {
    const files = fileInput.files ? [...fileInput.files] : [];
    addStaged(files.map((file) => ({ path: file.name, file })));
    fileInput.value = "";
  });

  dirInput.addEventListener("change", () => {
    const files = dirInput.files ? [...dirInput.files] : [];
    addStaged(files.map((file) => ({ path: file.webkitRelativePath || file.name, file })));
    dirInput.value = "";
  });

  // The whole page is the drop target — the aperture lights up as the cue.
  window.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (!dropZone.classList.contains("over")) warpBurst();
    dropZone.classList.add("over");
  });
  window.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget) dropZone.classList.remove("over"); // left the window
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("over");
    if (!event.dataTransfer) return;
    void collectDrop(event.dataTransfer).then(addStaged);
  });
  dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") fileInput.click();
  });

  // ----- share lifecycle ---------------------------------------------------
  openButton.addEventListener("click", () => {
    void openShare();
  });

  // The share lives in this tab; an accidental close destroys it. Browsers
  // show a generic "leave site?" prompt while a share is live.
  const unloadGuard = (e: BeforeUnloadEvent): void => {
    if (live) e.preventDefault();
  };
  window.addEventListener("beforeunload", unloadGuard);

  async function openShare(): Promise<void> {
    openButton.disabled = true;
    shareId = randomId(9);
    tokens = {
      view: randomId(16),
      download: randomId(16),
      manage: randomId(16),
    };

    signal = new Signal();
    signal.on("created", () => {
      // The keepAlive replay re-sends `create` on reconnect, so the server
      // re-acks `created`. Don't re-run setup or re-arm the self-destruct.
      if (live) return;
      live = true;
      renderLinks();
      renderPeers();
      setStatus("Listening for peers.");
      livePanel.hidden = false;
      dropZone.querySelector(".dropzone-title")!.textContent = "Drop more files to add them";
      armDestruct();
    });
    signal.on("error", (msg) => {
      showNotice(`Signaling error: ${msg.reason}`);
      teardown(false);
    });
    signal.on("peer", (msg) => acceptPeer(msg.peerId));
    signal.on("signal", (msg) => peers.get(msg.from)?.peer.handleSignal(msg.data));
    signal.on("peer-gone", (msg) => dropPeer(msg.peerId));
    signal.onDisconnect = () =>
      setStatus("Signaling lost — connected peers keep working, reconnecting for new ones…");
    signal.onReconnect = () => setStatus("Signaling restored.");
    signal.keepAlive(() => ({ t: "create", shareId }));

    try {
      await signal.connect();
    } catch {
      showNotice("Could not reach the signaling server. Is it running? (npm run dev)");
      openButton.disabled = false;
      signal = null;
      return;
    }
    signal.send({ t: "create", shareId });
  }

  function linkFor(level: Level): string {
    const token = tokens ? tokens[level] : "";
    return `${location.origin}${location.pathname}#r=${shareId}&t=${token}`;
  }

  function renderLinks(): void {
    linksBox.replaceChildren();
    for (const level of LEVELS) {
      const url = linkFor(level);
      const copyButton = el("button", { class: "btn small" }, ["Copy link"]);
      copyButton.addEventListener("click", () => {
        warpBurst();
        void copyText(url).then((ok) => flash(copyButton, ok ? "Copied" : "Copy failed"));
      });
      linksBox.append(
        el("div", { class: `ticket ticket-${level}` }, [
          el("div", { class: "ticket-head" }, [
            el("span", { class: `chip chip-${level}` }, [LEVEL_LABEL[level]]),
            el("span", { class: "dim" }, [LEVEL_BLURB[level]]),
          ]),
          el("div", { class: "ticket-link-row" }, [
            el("code", { class: "mono link", title: url }, [url]),
            copyButton,
          ]),
        ]),
      );
    }
  }

  function renderPeers(): void {
    peersBox.replaceChildren();
    const granted = [...peers.values()].filter((ctx) => ctx.dc);
    if (granted.length === 0) {
      peersBox.append(el("p", { class: "dim" }, ["No one connected yet."]));
      return;
    }
    for (const ctx of granted) {
      peersBox.append(
        el("div", { class: "peerrow" }, [
          el("span", { class: "dot live" }),
          el("span", { class: "mono" }, [`peer ${ctx.id.slice(0, 6)}`]),
          ctx.level
            ? el("span", { class: `chip chip-${ctx.level}` }, [LEVEL_LABEL[ctx.level]])
            : el("span", { class: "dim" }, ["authenticating…"]),
        ]),
      );
    }
  }

  let statusText = "Listening for peers.";
  function setStatus(text: string): void {
    statusText = text;
    renderStatus();
  }

  function renderStatus(): void {
    statusLine.textContent = destructAt > 0 ? `${statusText} ${countdownText()}` : statusText;
  }

  function showNotice(text: string): void {
    notice.textContent = text;
    notice.hidden = false;
  }

  // ----- peers -------------------------------------------------------------
  function acceptPeer(peerId: string): void {
    if (!signal || peers.has(peerId)) return;
    const peer = offerPeer(signal, peerId);
    const ctx: PeerCtx = { id: peerId, peer, dc: null, level: null, busy: false };
    peers.set(peerId, ctx);
    renderPeers();

    void peer.channel
      .then((dc) => {
        ctx.dc = dc;
        dc.onmessage = (event) => {
          void handleMessage(ctx, event.data);
        };
        dc.onclose = () => dropPeer(peerId);
        renderPeers();
      })
      .catch(() => dropPeer(peerId));
  }

  function dropPeer(peerId: string): void {
    const ctx = peers.get(peerId);
    if (!ctx) return;
    peers.delete(peerId);
    ctx.peer.close();
    renderPeers();
  }

  function sendCtl(ctx: PeerCtx, msg: SenderToReceiver): void {
    if (ctx.dc?.readyState === "open") ctx.dc.send(JSON.stringify(msg));
  }

  async function handleMessage(ctx: PeerCtx, raw: unknown): Promise<void> {
    if (typeof raw !== "string" || raw.length > 1024 * 1024) return;
    // Background tabs throttle timers, so the destruct deadline is also
    // enforced here: an expired share must refuse service even if its
    // setTimeout hasn't fired yet.
    if (destructAt > 0 && Date.now() >= destructAt) {
      destroyShare("Share auto-destructed.");
      return;
    }
    let msg: ReceiverToSender;
    try {
      msg = JSON.parse(raw) as ReceiverToSender;
    } catch {
      return;
    }

    if (msg.t === "hello") {
      if (!tokens || typeof msg.token !== "string") return;
      let granted: Level | null = null;
      for (const level of LEVELS) {
        if (safeEqual(tokens[level], msg.token)) granted = level;
      }
      if (!granted) {
        sendCtl(ctx, { t: "deny", reason: "Bad or revoked link." });
        window.setTimeout(() => dropPeer(ctx.id), 250);
        return;
      }
      ctx.level = granted;
      sendCtl(ctx, {
        t: "grant",
        level: granted,
        name: nameInput.value.trim() || "Shared files",
        manifest: toManifest(staged),
      });
      renderPeers();
      return;
    }

    if (!ctx.level) return; // everything below requires a granted level

    if (msg.t === "get") {
      if (typeof msg.path !== "string" || msg.path.length > 4096) return;
      const file = staged.get(msg.path);
      if (!file) {
        sendCtl(ctx, { t: "file-err", id: msg.id, reason: "Gone — that file was destroyed." });
        return;
      }
      if (msg.intent === "download" && !levelAllows(ctx.level, "download")) {
        sendCtl(ctx, { t: "file-err", id: msg.id, reason: "This link is preview-only." });
        return;
      }
      if (ctx.level === "view" && !PREVIEWABLE.has(classify(msg.path))) {
        sendCtl(ctx, { t: "file-err", id: msg.id, reason: "This link can only open previewable files." });
        return;
      }
      if (ctx.busy) {
        sendCtl(ctx, { t: "file-err", id: msg.id, reason: "One transfer at a time." });
        return;
      }
      ctx.busy = true;
      try {
        await serveFile(ctx, msg.id, msg.path, file);
      } finally {
        ctx.busy = false;
      }
      return;
    }

    if (msg.t === "destroy") {
      if (levelAllows(ctx.level, "destroy")) destroyShare("Destroyed remotely by a Manager link.");
      else sendCtl(ctx, { t: "deny", reason: "This link cannot destroy the share." });
    }
  }

  async function serveFile(ctx: PeerCtx, id: number, path: string, file: File): Promise<void> {
    const dc = ctx.dc;
    if (!dc || dc.readyState !== "open") return;
    sendCtl(ctx, { t: "file-head", id, path, size: file.size, mime: file.type || "application/octet-stream" });
    try {
      for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
        if (staged.get(path) !== file) {
          sendCtl(ctx, { t: "file-err", id, reason: "Transfer stopped — the file was destroyed." });
          return;
        }
        const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
        await sendWithBackpressure(dc, chunk);
      }
      sendCtl(ctx, { t: "file-eof", id });
    } catch {
      // channel died mid-transfer; peer cleanup happens via onclose
    }
  }

  function broadcastManifest(): void {
    const manifest = toManifest(staged);
    for (const ctx of peers.values()) {
      if (ctx.level) sendCtl(ctx, { t: "manifest", manifest });
    }
  }

  // ----- destruction -------------------------------------------------------
  destroyButton.addEventListener("click", () => {
    if (window.confirm("Destroy this share? Links die instantly and staged files are cleared.")) {
      destroyShare("Share destroyed.");
    }
  });

  function armDestruct(): void {
    // Never stack timers: clear any previous arming before scheduling.
    if (destructTimer) window.clearTimeout(destructTimer);
    if (countdownTimer) window.clearInterval(countdownTimer);
    const minutes = Number(destructSelect.value);
    if (minutes <= 0) return;
    destructAt = Date.now() + minutes * 60_000;
    destructTimer = window.setTimeout(() => destroyShare("Share self-destructed."), minutes * 60_000);
    countdownTimer = window.setInterval(renderStatus, 1000);
  }

  function countdownText(): string {
    const left = Math.max(0, destructAt - Date.now());
    const mins = Math.floor(left / 60_000);
    const secs = Math.floor((left % 60_000) / 1000);
    return `· self-destruct in ${mins}:${String(secs).padStart(2, "0")}`;
  }

  function destroyShare(reason: string): void {
    for (const ctx of peers.values()) {
      sendCtl(ctx, { t: "destroyed" });
      ctx.peer.close();
    }
    peers.clear();
    teardown(true);
    showNotice(reason);
  }

  function teardown(wipeFiles: boolean): void {
    signal?.send({ t: "close" });
    signal?.close();
    signal = null;
    live = false;
    tokens = null;
    if (destructTimer) window.clearTimeout(destructTimer);
    if (countdownTimer) window.clearInterval(countdownTimer);
    destructAt = 0;
    if (wipeFiles) staged.clear();
    renderStaged();
    livePanel.hidden = true;
    linksBox.replaceChildren();
    peersBox.replaceChildren();
    openButton.disabled = staged.size === 0;
    dropZone.querySelector(".dropzone-title")!.textContent = "Drop files into the drive";
  }
}

// ---------------------------------------------------------------------------
// Drag-and-drop traversal (files and whole folders)
// ---------------------------------------------------------------------------

async function collectDrop(dt: DataTransfer): Promise<Staged[]> {
  const out: Staged[] = [];
  const walks: Promise<void>[] = [];
  // webkitGetAsEntry must be called synchronously inside the drop handler.
  for (const item of [...dt.items]) {
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    if (entry) {
      walks.push(walkEntry(entry, "", out));
    } else {
      const file = item.getAsFile();
      if (file) out.push({ path: file.name, file });
    }
  }
  await Promise.all(walks);
  return out;
}

async function walkEntry(entry: FileSystemEntry, prefix: string, out: Staged[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    out.push({ path: prefix + entry.name, file });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      await Promise.all(batch.map((child) => walkEntry(child, `${prefix}${entry.name}/`, out)));
    }
  }
}
