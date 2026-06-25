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

// Smoke test: create / join / bidirectional signal relay / host close, plus the
// server's defensive limits (peer cap, oversized + malformed frames, over-long
// shareId, peer-may-only-address-host routing, and the room cap + role-grace
// reaper via env-overridable caps).
// Hermetic: spawns its own signaling server(s) on test ports, kills them on exit.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";

const PORT = process.env.SMOKE_PORT || "8799";
// 127.0.0.1, not localhost: on Windows/macOS "localhost" can resolve to IPv6 ::1
// first while the test only needs deterministic loopback to the spawned server.
const URL = `ws://127.0.0.1:${PORT}/ws`;

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "signaling.mjs");
const extraServers = [];
const startServer = (env) =>
  spawn(process.execPath, [serverPath], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
// Resolve once the server prints its startup banner, so we don't race listen().
const waitBanner = (srv) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start in 5s")), 5000);
    srv.stdout.on("data", (d) => { if (d.toString().includes("signaling")) { clearTimeout(t); resolve(); } });
    srv.on("exit", (code) => reject(new Error(`server exited early (${code})`)));
  });

const server = startServer({ PORT });
process.on("exit", () => { server.kill(); extraServers.forEach((s) => s.kill()); });
await waitBanner(server);

// Resolve with the first frame on `ws` that satisfies `pred`, rejecting after
// 3s so a missing reply fails the run loudly instead of hanging CI forever.
const wait = (ws, pred) =>
  new Promise((resolve, reject) => {
    let timer;
    const h = (raw) => {
      const m = JSON.parse(raw.toString());
      if (pred(m)) { clearTimeout(timer); ws.off("message", h); resolve(m); }
    };
    // Remove the listener on the timeout path too, so no handler outlives its
    // wait() and matches a stale frame from a later step.
    timer = setTimeout(() => { ws.off("message", h); reject(new Error("timeout waiting for message")); }, 3000);
    ws.on("message", h);
  });
const open = (ws) => new Promise((r) => ws.on("open", r));

// Fail fast: the first failed assertion exits non-zero so CI flags the exact
// broken step, rather than collecting failures and masking which one regressed.
const assert = (cond, label) => {
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
  console.log(`ok: ${label}`);
};

// Resolves true if NO frame matching `pred` arrives within `ms` — for the
// "server silently drops it" cases that have no reply to wait for.
const expectSilence = (ws, ms, pred = () => true) =>
  new Promise((resolve) => {
    let got = false;
    const h = (raw) => { try { if (pred(JSON.parse(raw.toString()))) got = true; } catch { /* non-JSON */ } };
    ws.on("message", h);
    setTimeout(() => { ws.off("message", h); resolve(!got); }, ms);
  });

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

// ── defensive limits ─────────────────────────────────────────────────────────
// The checks above are happy-path; these exercise the server's caps and
// malformed-input handling, none of which the routing tests reach.

// Per-room peer cap: the 33rd join (MAX_PEERS_PER_ROOM = 32) is refused.
const capHost = new WebSocket(URL);
await open(capHost);
capHost.send(JSON.stringify({ t: "create", shareId: "smokeCap" }));
await wait(capHost, (m) => m.t === "created");
const capPeers = [];
for (let i = 0; i < 32; i++) {
  const p = new WebSocket(URL);
  await open(p);
  const joinedP = wait(p, (m) => m.t === "joined" || m.t === "error");
  p.send(JSON.stringify({ t: "join", shareId: "smokeCap" }));
  const r = await joinedP;
  if (r.t !== "joined") { console.error(`FAIL: peer ${i} unexpectedly refused (${r.reason})`); process.exit(1); }
  capPeers.push(p);
}
const overflow = new WebSocket(URL);
await open(overflow);
overflow.send(JSON.stringify({ t: "join", shareId: "smokeCap" }));
assert((await wait(overflow, (m) => m.t === "error")).reason === "room-full", "33rd peer → room-full (MAX_PEERS_PER_ROOM)");
overflow.close();
for (const p of capPeers) p.close();
capHost.close();

// Oversized frame (> 256 KiB maxPayload): the offending socket is dropped but
// the server process survives — a fresh create still works afterward.
const big = new WebSocket(URL);
await open(big);
big.send(JSON.stringify({ t: "create", shareId: "x".repeat(300 * 1024) }));
await new Promise((r) => setTimeout(r, 200));
const afterBig = new WebSocket(URL);
await open(afterBig);
afterBig.send(JSON.stringify({ t: "create", shareId: "smokeBig" }));
assert((await wait(afterBig, (m) => m.t === "created")).t === "created", "oversized frame dropped, server survives");
afterBig.close();
try { big.close(); } catch { /* already closed by the server */ }

// Malformed / non-object frames must be ignored, not crash the dispatch.
const junk = new WebSocket(URL);
await open(junk);
junk.send("null");
junk.send("42");
junk.send("{ not json");
junk.send(JSON.stringify({ t: "create", shareId: "smokeJunk" }));
assert((await wait(junk, (m) => m.t === "created")).t === "created", "non-object / bad-JSON frames ignored, no crash");
junk.close();

// Over-long shareId (> 64 chars) is silently dropped: no created, no error.
const longId = new WebSocket(URL);
await open(longId);
longId.send(JSON.stringify({ t: "create", shareId: "z".repeat(65) }));
assert(await expectSilence(longId, 400, (m) => m.t === "created" || m.t === "error"), "over-long shareId silently dropped");
longId.close();

// Routing: a peer may only address the host — a forged `to` aimed at another
// peer is still delivered to the host, never peer-to-peer.
const rHost = new WebSocket(URL);
await open(rHost);
rHost.send(JSON.stringify({ t: "create", shareId: "smokeRoute" }));
await wait(rHost, (m) => m.t === "created");
const pA = new WebSocket(URL);
await open(pA);
const aAnnounced = wait(rHost, (m) => m.t === "peer");
pA.send(JSON.stringify({ t: "join", shareId: "smokeRoute" }));
const aJoined = await wait(pA, (m) => m.t === "joined");
await aAnnounced;
const pB = new WebSocket(URL);
await open(pB);
const bAnnounced = wait(rHost, (m) => m.t === "peer");
pB.send(JSON.stringify({ t: "join", shareId: "smokeRoute" }));
const bJoined = await wait(pB, (m) => m.t === "joined");
await bAnnounced;
const hostGot = wait(rHost, (m) => m.t === "signal");
const bSilent = expectSilence(pB, 500, (m) => m.t === "signal");
pA.send(JSON.stringify({ t: "signal", to: bJoined.peerId, data: { sneak: 1 } }));
assert((await hostGot).from === aJoined.peerId, "peer signal forced to host (from = sender)");
assert(await bSilent, "forged peer→peer target not delivered to other peer");
pA.close();
pB.close();
rHost.close();

// ── caps via env-overridable limits ──────────────────────────────────────────
// A tiny dedicated server proves the room cap without opening 5000 sockets.
{
  const capPort = "8797";
  const cap = startServer({ PORT: capPort, WORMDRIVE_MAX_ROOMS: "2" });
  extraServers.push(cap);
  await waitBanner(cap);
  const capUrl = `ws://127.0.0.1:${capPort}/ws`;
  const create = async (id) => {
    const w = new WebSocket(capUrl);
    await open(w);
    w.send(JSON.stringify({ t: "create", shareId: id }));
    return { w, m: await wait(w, (m) => m.t === "created" || m.t === "error") };
  };
  const a = await create("rcap-a");
  const b = await create("rcap-b");
  assert(a.m.t === "created" && b.m.t === "created", "rooms below MAX_ROOMS are created");
  const c = await create("rcap-c");
  assert(c.m.t === "error" && c.m.reason === "server-full", "room past MAX_ROOMS → server-full");
  a.w.close();
  b.w.close();
  c.w.close();
  cap.kill();
}

// A short grace + fast heartbeat reaps a socket that never created or joined.
{
  const gracePort = "8798";
  const g = startServer({ PORT: gracePort, WORMDRIVE_ROLE_GRACE_MS: "200", WORMDRIVE_HEARTBEAT_MS: "300" });
  extraServers.push(g);
  await waitBanner(g);
  const idle = new WebSocket(`ws://127.0.0.1:${gracePort}/ws`);
  await open(idle);
  const reaped = await new Promise((resolve) => {
    idle.on("close", () => resolve(true));
    setTimeout(() => resolve(false), 3000);
  });
  assert(reaped, "role-less socket reaped after the grace period");
  g.kill();
}

console.log("all signaling smoke tests passed");
process.exit(0);
