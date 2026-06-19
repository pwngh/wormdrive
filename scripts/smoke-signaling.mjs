// Smoke test: create / join / bidirectional signal relay / host close.
// Hermetic: spawns its own signaling server on a test port, kills it on exit.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";

const PORT = process.env.SMOKE_PORT || "8799";
const URL = `ws://localhost:${PORT}/ws`;

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "signaling.mjs");
const server = spawn(process.execPath, [serverPath], {
  env: { ...process.env, PORT },
  stdio: ["ignore", "pipe", "inherit"],
});
process.on("exit", () => server.kill());
// Wait for the startup banner so we don't race the listen().
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("server did not start in 5s")), 5000);
  server.stdout.on("data", (d) => {
    if (d.toString().includes("signaling")) { clearTimeout(t); resolve(); }
  });
  server.on("exit", (code) => reject(new Error(`server exited early (${code})`)));
});

const wait = (ws, pred) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for message")), 3000);
    ws.on("message", function h(raw) {
      const m = JSON.parse(raw.toString());
      if (pred(m)) { clearTimeout(t); ws.off("message", h); resolve(m); }
    });
  });
const open = (ws) => new Promise((r) => ws.on("open", r));

const assert = (cond, label) => {
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
  console.log(`ok: ${label}`);
};

const host = new WebSocket(URL);
await open(host);
host.send(JSON.stringify({ t: "create", shareId: "smoke1" }));
assert((await wait(host, (m) => m.t === "created")).t === "created", "host create → created");

// duplicate id from a different socket must be rejected
const clash = new WebSocket(URL);
await open(clash);
clash.send(JSON.stringify({ t: "create", shareId: "smoke1" }));
const err = await wait(clash, (m) => m.t === "error");
assert(err.reason === "room-exists", "duplicate shareId → error room-exists");
clash.close();

// join from a peer
const peer = new WebSocket(URL);
await open(peer);
// Arm the host's "peer" listener BEFORE join: the server emits "joined" and
// "peer" in the same tick, so attaching after awaiting "joined" can miss it.
const announcedP = wait(host, (m) => m.t === "peer");
peer.send(JSON.stringify({ t: "join", shareId: "smoke1" }));
const joined = await wait(peer, (m) => m.t === "joined");
assert(typeof joined.peerId === "string", "peer join → joined with peerId");
const announced = await announcedP;
assert(announced.peerId === joined.peerId, "host notified of peer");

// join to a nonexistent room
const lost = new WebSocket(URL);
await open(lost);
lost.send(JSON.stringify({ t: "join", shareId: "nope" }));
assert((await wait(lost, (m) => m.t === "error")).reason === "no-such-share", "bad shareId → no-such-share");
lost.close();

// signal relay peer → host and host → peer
peer.send(JSON.stringify({ t: "signal", to: "host", data: { hello: 1 } }));
const up = await wait(host, (m) => m.t === "signal");
assert(up.from === joined.peerId && up.data.hello === 1, "peer → host signal relayed with from");

host.send(JSON.stringify({ t: "signal", to: joined.peerId, data: { world: 2 } }));
const down = await wait(peer, (m) => m.t === "signal");
assert(down.from === "host" && down.data.world === 2, "host → peer signal relayed");

// host close → peers told the share is gone
host.send(JSON.stringify({ t: "close" }));
assert((await wait(peer, (m) => m.t === "gone")).t === "gone", "host close → gone to peers");

// Regression: a host re-creating under a new id must close its old room,
// not leak it in the map as a joinable ghost.
const hopper = new WebSocket(URL);
await open(hopper);
hopper.send(JSON.stringify({ t: "create", shareId: "smokeA" }));
await wait(hopper, (m) => m.t === "created");
hopper.send(JSON.stringify({ t: "create", shareId: "smokeB" }));
await wait(hopper, (m) => m.t === "created");
const probe = new WebSocket(URL);
await open(probe);
probe.send(JSON.stringify({ t: "join", shareId: "smokeA" }));
const ghost = await wait(probe, (m) => m.t === "error");
assert(ghost.reason === "no-such-share", "re-create under new id closes the old room");
probe.close();
hopper.close();

peer.close();
host.close();
console.log("all signaling smoke tests passed");
process.exit(0);
