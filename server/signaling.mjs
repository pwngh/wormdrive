// wormdrive signaling server
// Relays WebRTC offers/answers/ICE between a share's host and its receivers,
// and (in production) serves the built frontend from ../dist.
// It never sees tokens or file bytes — those travel only over the data channel.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8787);
const WS_PATH = "/ws";
const DIST = fileURLToPath(new URL("../dist", import.meta.url));

// Locked-down CSP for the served app. The receiver renders untrusted
// sender-supplied content via highlight.js/mammoth/xlsx/pdfjs, so keep the
// surface tight: no plugins, no framing, blobs only for previews + workers.
// (style 'unsafe-inline' is required — viewers set inline style attributes.)
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

// ── rooms ────────────────────────────────────────────────────────────────────
/** @type {Map<string, { host: import("ws").WebSocket, peers: Map<string, import("ws").WebSocket> }>} */
const rooms = new Map();
let nextPeer = 1;

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function closeRoom(shareId) {
  const room = rooms.get(shareId);
  if (!room) return;
  for (const peer of room.peers.values()) send(peer, { t: "gone" });
  rooms.delete(shareId);
}

const MAX_PEERS_PER_ROOM = 32;
const MAX_ROOMS = 5000;

function handleMessage(ws, msg) {
  switch (msg.t) {
    case "create": {
      if (typeof msg.shareId !== "string" || msg.shareId.length > 64) return;
      const existing = rooms.get(msg.shareId);
      // Check for a clash BEFORE shedding our own role: a rejected create must
      // not tear down the caller's existing valid room. (Same socket replaying
      // after reconnect is fine; a different live host is the clash.)
      if (
        existing &&
        existing.host !== ws &&
        existing.host.readyState === existing.host.OPEN
      ) {
        send(ws, { t: "error", reason: "room-exists" });
        return;
      }
      // One room per socket: a host re-creating under a new id (or a socket
      // that joined as a peer) must shed its old role first, or abandoned
      // rooms accumulate in the map forever.
      if (
        ws.role &&
        !(ws.role.kind === "host" && ws.role.shareId === msg.shareId)
      ) {
        handleClose(ws);
        ws.role = undefined;
      }
      if (existing && existing.host !== ws) closeRoom(msg.shareId); // stale host: reclaim the id
      // Cap total rooms (after shedding, so a host hopping rooms isn't falsely
      // rejected). Replays/reclaims reuse the id and don't grow the map.
      if (!rooms.has(msg.shareId) && rooms.size >= MAX_ROOMS) {
        send(ws, { t: "error", reason: "server-full" });
        return;
      }
      rooms.set(
        msg.shareId,
        existing?.host === ws ? existing : { host: ws, peers: new Map() }
      );
      ws.role = { kind: "host", shareId: msg.shareId };
      send(ws, { t: "created" });
      return;
    }
    case "join": {
      if (ws.role) return; // already a host or a peer on this socket
      const room = rooms.get(msg.shareId);
      if (!room || room.host.readyState !== room.host.OPEN) {
        send(ws, { t: "error", reason: "no-such-share" });
        return;
      }
      if (room.peers.size >= MAX_PEERS_PER_ROOM) {
        send(ws, { t: "error", reason: "room-full" });
        return;
      }
      const peerId = `p${nextPeer++}`;
      room.peers.set(peerId, ws);
      ws.role = { kind: "peer", shareId: msg.shareId, peerId };
      send(ws, { t: "joined", peerId });
      send(room.host, { t: "peer", peerId });
      return;
    }
    case "signal": {
      const role = ws.role;
      if (!role) return;
      const room = rooms.get(role.shareId);
      if (!room) return;
      if (role.kind === "host") {
        const target = room.peers.get(msg.to);
        if (target) send(target, { t: "signal", from: "host", data: msg.data });
      } else {
        // Peers may only address the host.
        send(room.host, { t: "signal", from: role.peerId, data: msg.data });
      }
      return;
    }
    case "close": {
      if (ws.role?.kind === "host") closeRoom(ws.role.shareId);
      return;
    }
    default:
      return;
  }
}

function handleClose(ws) {
  const role = ws.role;
  if (!role) return;
  if (role.kind === "host") {
    closeRoom(role.shareId);
  } else {
    const room = rooms.get(role.shareId);
    if (room) {
      room.peers.delete(role.peerId);
      send(room.host, { t: "peer-gone", peerId: role.peerId });
    }
  }
}

// ── static serving (production) ─────────────────────────────────────────────
async function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  } catch {
    // Malformed %-encoding must 400, not throw — an exception here is an
    // unhandled rejection, which kills the process.
    res.writeHead(400).end();
    return;
  }
  let filePath = normalize(
    join(DIST, urlPath === "/" ? "index.html" : urlPath)
  );
  if (filePath !== DIST && !filePath.startsWith(DIST + sep)) {
    res.writeHead(403).end();
    return;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, "index.html");
  } catch {
    filePath = join(DIST, "index.html"); // SPA fallback
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
      // Vite content-hashes everything under /assets; index.html must revalidate
      // so a deploy's new hashes are picked up immediately.
      "cache-control": filePath.endsWith("index.html")
        ? "no-cache"
        : "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy": CSP,
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found — run `npm run build` first");
  }
}

// ── wire-up ──────────────────────────────────────────────────────────────────
const server = createServer(serveStatic);
const wss = new WebSocketServer({
  server,
  path: WS_PATH,
  maxPayload: 256 * 1024,
});
wss.on("error", (err) => console.error("[wormdrive] wss error:", err.message));
server.on("error", (err) => {
  console.error("[wormdrive] server error:", err.message);
  process.exit(1);
});

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.connectedAt = Date.now();
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg && typeof msg === "object") handleMessage(ws, msg);
  });
  ws.on("close", () => handleClose(ws));
  ws.on("error", () => {
    /* close handler does the cleanup */
  });
});

const ROLE_GRACE_MS = 30_000;
const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    // Reap sockets that connected but never created/joined a room.
    if (!ws.role && now - ws.connectedAt > ROLE_GRACE_MS) {
      ws.terminate();
      continue;
    }
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(
    `[wormdrive] signaling + static on http://localhost:${PORT}  (ws at ${WS_PATH})`
  );
});
