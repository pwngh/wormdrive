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

// End-to-end smoke: real headless-Chrome tabs over a real WebRTC data channel —
// the core path no other gate reaches. Proves connection + manifest delivery,
// byte transfer, view-vs-download permission gating, an off-main-thread
// spreadsheet render, a manage-link destruct, and the receiver disconnecting an
// adversarial sender that lies about a file's size.
//
// Opt-in: needs a built dist/ and an installed Chrome/Chromium; NOT part of
// `npm run check`. Run:  npm run build && npm run test:e2e
// Chrome is auto-detected; override with CHROME_PATH=/path/to/chrome.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(root, "dist", "index.html"))) {
  console.error("smoke-e2e: dist/index.html missing — run `npm run build` first");
  process.exit(1);
}

if (process.env.CHROME_PATH && !existsSync(process.env.CHROME_PATH)) {
  console.error(`smoke-e2e: CHROME_PATH set but not found: ${process.env.CHROME_PATH}`);
  process.exit(1);
}
const CHROME = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
  process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
].filter(Boolean).find((p) => existsSync(p));
if (!CHROME) {
  console.log("SKIP smoke-e2e: no Chrome/Chromium found — set CHROME_PATH. This harness needs a real browser.");
  process.exit(0);
}

let puppeteer;
try {
  puppeteer = (await import("puppeteer-core")).default;
} catch {
  console.log("SKIP smoke-e2e: puppeteer-core not installed (npm i -D puppeteer-core).");
  process.exit(0);
}

const PORT = process.env.E2E_PORT || "8802";
// 127.0.0.1, not localhost, so loopback is deterministic on Windows/macOS where
// "localhost" can resolve to IPv6 ::1 first.
const ORIGIN = `http://127.0.0.1:${PORT}`;

// The production server serves dist/ and the websocket from one port, so both
// tabs share an origin and the signaling client connects to same-origin /ws.
const server = spawn(process.execPath, [join(root, "server", "signaling.mjs")], {
  env: { ...process.env, PORT },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("server did not start in 5s")), 5000);
  server.stdout.on("data", (d) => { if (d.toString().includes("signaling")) { clearTimeout(t); resolve(); } });
  server.on("exit", (c) => reject(new Error(`server exited early (${c})`)));
});

const fixtures = mkdtempSync(join(tmpdir(), "wd-e2e-"));
const TEXT = `HELLO WORMDRIVE E2E ${"x".repeat(40)}`;

let passed = 0;
const ok = (label) => { console.log(`ok: ${label}`); passed += 1; };
const cleanup = () => {
  server.kill();
  rmSync(fixtures, { recursive: true, force: true });
};

// Fixture writes and the browser launch can throw (e.g. Chrome found but fails
// to launch); run them after cleanup() exists so a failure here still kills the
// server child and removes the temp dir instead of leaking both.
let browser;
try {
  writeFileSync(join(fixtures, "hello.txt"), TEXT);
  writeFileSync(join(fixtures, "secret.bin"), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
  writeFileSync(join(fixtures, "data.csv"), "name,score\nalice,10\nbob,20\n");
  // CI hardening for headless-Chrome WebRTC. --disable-dev-shm-usage moves Chrome's
  // scratch off the tiny /dev/shm on CI runners, which otherwise fills as pages
  // accumulate and hangs the later connections. The mDNS flag (CI-only, since it
  // regresses local macOS) exposes real loopback IPs so host ICE candidates pair
  // instead of hiding behind unresolved .local names.
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  if (process.env.CI) args.push("--disable-features=WebRtcHideLocalIpsWithMdns");
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args });
} catch (err) {
  cleanup();
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
}

const hasRow = (name) =>
  [...document.querySelectorAll(".filerow .path")].some((n) => n.textContent.includes(name));
const clickRow = (name) =>
  [...document.querySelectorAll(".filerow")].find((r) => r.textContent.includes(name))?.click();
const hasDownloadButton = () =>
  [...document.querySelectorAll("button")].some((b) => b.textContent.includes("Download"));

try {
  // ---- sender: stage files, open the share, read the three links ----
  const sender = await browser.newPage();
  await sender.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  const input = await sender.waitForSelector("input[type=file][multiple]", { timeout: 10000 });
  await input.uploadFile(join(fixtures, "hello.txt"), join(fixtures, "secret.bin"), join(fixtures, "data.csv"));
  await sender.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Open share");
    return b && !b.disabled;
  }, { timeout: 10000 });
  await sender.evaluate(() => {
    [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Open share").click();
  });
  await sender.waitForSelector(".ticket-download code.link", { timeout: 10000 });
  const links = await sender.evaluate(() => {
    const get = (lvl) => document.querySelector(`.ticket-${lvl} code.link`)?.textContent || null;
    return { view: get("view"), download: get("download"), manage: get("manage") };
  });
  if (!links.view || !links.download || !links.manage) throw new Error("did not mint all three links");
  ok("sender staged files and minted three permission links");

  // ---- receiver (download link): connect, receive manifest, transfer bytes ----
  const recv = await browser.newPage();
  await recv.goto(links.download, { waitUntil: "domcontentloaded" });
  await recv.waitForFunction(hasRow, { timeout: 20000 }, "hello.txt");
  ok("receiver connected over WebRTC and received the manifest (download link)");

  await recv.evaluate(clickRow, "hello.txt");
  await recv.waitForFunction((needle) => document.body.innerText.includes(needle), { timeout: 20000 }, TEXT);
  ok("receiver previewed hello.txt — file bytes transferred over the data channel");

  if (!(await recv.evaluate(hasDownloadButton))) throw new Error("download link should expose a Download control");
  ok("download link exposes a Download control");
  await recv.close();

  // ---- download: the toolbar streams the folder/file straight to disk ----
  const dl = await browser.newPage();
  await dl.goto(links.download, { waitUntil: "domcontentloaded" });
  await dl.waitForFunction(hasRow, { timeout: 20000 }, "hello.txt");
  // Mock the File System Access API so the stream lands in memory we can inspect.
  // This drives the REAL streaming path: transfer sink → ZipStream → writable,
  // i.e. bytes never buffer into a Blob (the multi-gigabyte-safe path).
  await dl.evaluate(() => {
    window.__saved = { chunks: [], closed: false };
    window.showSaveFilePicker = () =>
      Promise.resolve({
        createWritable: () =>
          Promise.resolve({
            write: (chunk) => {
              window.__saved.chunks.push([...new Uint8Array(chunk)]);
              return Promise.resolve();
            },
            close: () => {
              window.__saved.closed = true;
              return Promise.resolve();
            },
            abort: () => Promise.resolve(),
          }),
      });
  });
  // The toolbar's "Download all" button is distinct from a preview's "Download".
  await dl.waitForFunction(
    () => [...document.querySelectorAll(".toolbar button")].some((b) => b.textContent.includes("Download all")),
    { timeout: 20000 },
  );
  await dl.evaluate(() => {
    [...document.querySelectorAll(".toolbar button")].find((b) => b.textContent.includes("Download all")).click();
  });
  await dl.waitForFunction(() => window.__saved.closed && window.__saved.chunks.length > 0, { timeout: 20000 });
  const zip = Buffer.from((await dl.evaluate(() => window.__saved.chunks.flat())));
  if (zip.readUInt32LE(0) !== 0x04034b50) throw new Error("download-all: not a zip (bad local file header)");
  const eocd = zip.length - 22;
  if (zip.readUInt32LE(eocd) !== 0x06054b50) throw new Error("download-all: missing end-of-central-directory record");
  const entries = zip.readUInt16LE(eocd + 10);
  if (entries !== 3) throw new Error(`download-all: expected 3 zip entries, got ${entries}`);
  const zipText = zip.toString("latin1");
  for (const name of ["hello.txt", "secret.bin", "data.csv"]) {
    if (!zipText.includes(name)) throw new Error(`download-all: zip is missing ${name}`);
  }
  // The streamed bytes are intact: hello.txt's data follows its local-header name.
  const dataAt = zipText.indexOf("hello.txt") + "hello.txt".length;
  if (zip.toString("utf8", dataAt, dataAt + TEXT.length) !== TEXT)
    throw new Error("download-all: hello.txt content is corrupted inside the zip");
  ok("download-all streamed the whole folder to disk as a valid zip (3 files, content intact)");

  // A single file streams straight to disk with no zip wrapper. Filter to one
  // file so the button collapses to a single direct download.
  await dl.evaluate(() => {
    window.__saved = { chunks: [], closed: false };
    const input = document.querySelector(".searchwrap input") || document.querySelector(".toolbar input");
    input.value = "data.csv";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await dl.waitForFunction(
    () => [...document.querySelectorAll(".toolbar button")].some((b) => b.textContent.includes("Download data.csv")),
    { timeout: 20000 },
  );
  await dl.evaluate(() => {
    [...document.querySelectorAll(".toolbar button")].find((b) => b.textContent.includes("Download data.csv")).click();
  });
  await dl.waitForFunction(() => window.__saved.closed && window.__saved.chunks.length > 0, { timeout: 20000 });
  const csv = Buffer.from((await dl.evaluate(() => window.__saved.chunks.flat()))).toString("utf8");
  if (csv !== "name,score\nalice,10\nbob,20\n") throw new Error(`single-file stream corrupted: ${JSON.stringify(csv)}`);
  ok("download streamed a single file straight to disk (no zip wrapper, bytes intact)");

  // The in-memory fallback (browsers without the File System Access API): clear
  // the filter, hide showSaveFilePicker so runDownload takes the bundleInMemory +
  // saveBlob path, and capture the Blob the synthetic <a download> would save.
  await dl.evaluate(() => {
    const input = document.querySelector(".searchwrap input") || document.querySelector(".toolbar input");
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    window.showSaveFilePicker = undefined;
    window.__mem = { bytes: null };
    URL.createObjectURL = (blob) => {
      void blob.arrayBuffer().then((ab) => {
        window.__mem.bytes = [...new Uint8Array(ab)];
      });
      return "blob:captured";
    };
    HTMLAnchorElement.prototype.click = function () {}; // don't actually navigate
  });
  await dl.waitForFunction(
    () => [...document.querySelectorAll(".toolbar button")].some((b) => b.textContent.includes("Download all")),
    { timeout: 20000 },
  );
  await dl.evaluate(() => {
    [...document.querySelectorAll(".toolbar button")].find((b) => b.textContent.includes("Download all")).click();
  });
  await dl.waitForFunction(() => window.__mem.bytes && window.__mem.bytes.length > 0, { timeout: 20000 });
  const memZip = Buffer.from((await dl.evaluate(() => window.__mem.bytes)));
  if (memZip.readUInt32LE(0) !== 0x04034b50) throw new Error("fallback: not a zip (bad local file header)");
  const memEntries = memZip.readUInt16LE(memZip.length - 22 + 10);
  if (memEntries !== 3) throw new Error(`fallback: expected 3 zip entries, got ${memEntries}`);
  ok("in-memory fallback (no File System Access API) bundled the folder into a zip");
  await dl.close();

  // ---- flow control: a file larger than the credit window streams to a slow disk ----
  // A separate one-file share (so the counts above stay put). The file is bigger
  // than FLOW_WINDOW (8 MiB), and the mock disk write deliberately lags the network,
  // so the sender's credit gate must actually engage — and the transfer must still
  // finish, with every byte delivered. This is the case the tiny fixtures can't
  // reach: a real ack crossing the wire, the window filling, and no deadlock.
  const BIG = 9 * 1024 * 1024;
  writeFileSync(join(fixtures, "big.bin"), Buffer.alloc(BIG));
  const bigSender = await browser.newPage();
  await bigSender.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  const bigInput = await bigSender.waitForSelector("input[type=file][multiple]", { timeout: 10000 });
  await bigInput.uploadFile(join(fixtures, "big.bin"));
  await bigSender.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Open share");
    return b && !b.disabled;
  }, { timeout: 10000 });
  await bigSender.evaluate(() => {
    [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Open share").click();
  });
  await bigSender.waitForSelector(".ticket-download code.link", { timeout: 10000 });
  const bigLink = await bigSender.evaluate(() => document.querySelector(".ticket-download code.link").textContent);

  const bigRecv = await browser.newPage();
  await bigRecv.goto(bigLink, { waitUntil: "domcontentloaded" });
  await bigRecv.waitForFunction(hasRow, { timeout: 20000 }, "big.bin");
  await bigRecv.evaluate(() => {
    window.__big = { bytes: 0, closed: false };
    window.showSaveFilePicker = () =>
      Promise.resolve({
        createWritable: () =>
          Promise.resolve({
            // Lag each write ~3 ms so acks trail the network and the window engages.
            write: (chunk) =>
              new Promise((r) => setTimeout(() => {
                window.__big.bytes += chunk.byteLength;
                r();
              }, 3)),
            close: () => {
              window.__big.closed = true;
              return Promise.resolve();
            },
            abort: () => Promise.resolve(),
          }),
      });
  });
  await bigRecv.waitForFunction(
    () => [...document.querySelectorAll(".toolbar button")].some((b) => b.textContent.includes("Download")),
    { timeout: 20000 },
  );
  await bigRecv.evaluate(() => {
    [...document.querySelectorAll(".toolbar button")].find((b) => b.textContent.includes("Download")).click();
  });
  await bigRecv.waitForFunction(() => window.__big.closed, { timeout: 60000 });
  const streamed = await bigRecv.evaluate(() => window.__big.bytes);
  if (streamed !== BIG) throw new Error(`flow control: streamed ${streamed} of ${BIG} bytes`);
  ok("a file larger than the flow-control window streamed to a slow sink without stalling");
  await bigRecv.close();
  await bigSender.close();

  // ---- flow control: a failed disk write surfaces an error instead of wedging ----
  // A writable whose write() rejects (quota, device removed). The receiver must
  // surface the failure and recover, not freeze its acks and hang the transfer
  // engine forever — the case the slow-but-succeeding sink above can't reach.
  const failRecv = await browser.newPage();
  await failRecv.goto(links.download, { waitUntil: "domcontentloaded" });
  await failRecv.waitForFunction(hasRow, { timeout: 20000 }, "data.csv");
  await failRecv.evaluate(() => {
    window.showSaveFilePicker = () =>
      Promise.resolve({
        createWritable: () =>
          Promise.resolve({
            write: () => Promise.reject(new Error("mock disk full")),
            close: () => Promise.resolve(),
            abort: () => Promise.resolve(),
          }),
      });
    const input = document.querySelector(".searchwrap input") || document.querySelector(".toolbar input");
    input.value = "data.csv"; // collapse to a single direct stream
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await failRecv.waitForFunction(
    () => [...document.querySelectorAll(".toolbar button")].some((b) => b.textContent.includes("Download data.csv")),
    { timeout: 20000 },
  );
  await failRecv.evaluate(() => {
    [...document.querySelectorAll(".toolbar button")].find((b) => b.textContent.includes("Download data.csv")).click();
  });
  // Liveness: with the write rejection surfaced, "Download failed" shows within a
  // beat; without the fix the engine wedges and this times out.
  await failRecv.waitForFunction(() => document.body.textContent.includes("Download failed"), { timeout: 15000 });
  ok("a failed disk write surfaced an error instead of wedging the receiver");
  await failRecv.close();

  // ---- receiver (view link): preview-only gating ----
  const viewer = await browser.newPage();
  await viewer.goto(links.view, { waitUntil: "domcontentloaded" });
  await viewer.waitForFunction(hasRow, { timeout: 20000 }, "hello.txt");
  ok("receiver connected over WebRTC (view link)");

  const binLocked = await viewer.evaluate(() => {
    const row = [...document.querySelectorAll(".filerow")].find((r) => r.textContent.includes("secret.bin"));
    return !!row && (row.classList.contains("locked") || row.getAttribute("aria-disabled") === "true");
  });
  if (!binLocked) throw new Error("view link should lock the non-previewable secret.bin");
  ok("view link locks the non-previewable file (secret.bin)");

  await viewer.evaluate(clickRow, "hello.txt");
  await viewer.waitForFunction((needle) => document.body.innerText.includes(needle), { timeout: 20000 }, TEXT);
  if (await viewer.evaluate(hasDownloadButton)) throw new Error("view link must NOT expose a Download control");
  ok("view link previews but offers no Download control (preview-only enforced)");
  await viewer.close();

  // ---- receiver: a spreadsheet renders via the off-main-thread parser worker ----
  const sheetRecv = await browser.newPage();
  await sheetRecv.goto(links.download, { waitUntil: "domcontentloaded" });
  await sheetRecv.waitForFunction(hasRow, { timeout: 20000 }, "data.csv");
  await sheetRecv.evaluate(clickRow, "data.csv");
  await sheetRecv.waitForSelector("iframe.sheetframe", { timeout: 20000 });
  ok("spreadsheet (data.csv) parsed in a Web Worker and rendered");
  await sheetRecv.close();

  // ---- destruct: a manage link destroys the share for every connected peer ----
  const witness = await browser.newPage();
  await witness.goto(links.download, { waitUntil: "domcontentloaded" });
  await witness.waitForFunction(hasRow, { timeout: 20000 }, "hello.txt");
  const manager = await browser.newPage();
  manager.on("dialog", (d) => d.accept()); // accept the "destroy for everyone?" confirm
  await manager.goto(links.manage, { waitUntil: "domcontentloaded" });
  await manager.waitForFunction(hasRow, { timeout: 20000 }, "hello.txt");
  await manager.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Destroy share"))?.click();
  });
  await witness.waitForFunction(() => document.body.innerText.includes("destroyed"), { timeout: 20000 });
  ok("manage link destroyed the share — connected peers were notified");
  await sender.waitForFunction(() => document.body.innerText.includes("Destroyed remotely"), { timeout: 20000 });
  ok("sender honored the remote destroy and ended the share");
  await witness.close();
  await manager.close();

  // ---- adversarial: a sender that lies about a file's declared size is dropped ----
  const evilShare = "tamper-share-1";
  const evilToken = "t".repeat(22);
  const evil = await browser.newPage();
  // A same-origin page (the relay's /healthz) so the injected WebSocket can
  // reach the relay — an about:blank null origin can't open the socket.
  await evil.goto(`${ORIGIN}/healthz`);
  await evil.evaluate(
    (wsUrl, shareId) => {
      window.__tamper = { sentBadHead: false, channelClosed: false, gotAnswer: false, connState: "new", dcState: "new" };
      const ws = new WebSocket(wsUrl);
      const send = (m) => ws.send(JSON.stringify(m));
      let pc, dc, peerId;
      const pendingIce = [];
      ws.addEventListener("open", () => send({ t: "create", shareId }));
      ws.onmessage = async (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === "peer") {
          peerId = m.peerId;
          // Use the same ICE config as the real app sender. Host-only candidates don't
          // pair in headless CI, where Chrome hides loopback IPs behind unresolved mDNS
          // .local names, so this injected peer must take the STUN-reflexive path the app
          // connection (checks above) uses to connect.
          pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
          pc.onicecandidate = (e) =>
            send({ t: "signal", to: peerId, data: { candidate: e.candidate ? e.candidate.toJSON() : null } });
          // Observe the disconnect via BOTH the channel-close event AND the peer-connection
          // state — an abrupt transport teardown can swallow the dc 'close' in headless CI.
          pc.onconnectionstatechange = () => {
            window.__tamper.connState = pc.connectionState;
            if (["disconnected", "failed", "closed"].includes(pc.connectionState))
              window.__tamper.channelClosed = true;
          };
          dc = pc.createDataChannel("wormdrive", { ordered: true });
          dc.onclose = () => { window.__tamper.dcState = "closed"; window.__tamper.channelClosed = true; };
          dc.onmessage = (e) => {
            if (typeof e.data !== "string") return;
            const msg = JSON.parse(e.data);
            if (msg.t === "hello") {
              dc.send(JSON.stringify({ t: "grant", level: "download", name: "t", manifest: [{ path: "f.txt", size: 10, kind: "text" }] }));
            } else if (msg.t === "get") {
              // Declare 9 MB for a file the manifest said was 10 bytes.
              dc.send(JSON.stringify({ t: "file-head", id: msg.id, path: msg.path, size: 9_000_000, mime: "text/plain" }));
              window.__tamper.sentBadHead = true;
            }
          };
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          send({ t: "signal", to: peerId, data: { desc: pc.localDescription.toJSON() } });
        } else if (m.t === "signal") {
          if (m.data.desc) {
            await pc.setRemoteDescription(m.data.desc);
            window.__tamper.gotAnswer = true;
            // Drain candidates that arrived before the answer: addIceCandidate
            // rejects until a remote description is set, so they were buffered.
            for (const c of pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
          } else if (m.data.candidate) {
            // Buffer until the remote description lands; otherwise queue would-be-early adds.
            if (pc && pc.remoteDescription) await pc.addIceCandidate(m.data.candidate).catch(() => {});
            else pendingIce.push(m.data.candidate);
          }
        }
      };
    },
    `ws://127.0.0.1:${PORT}/ws`,
    evilShare,
  );
  await new Promise((r) => setTimeout(r, 300)); // let the malicious host create its room

  const victim = await browser.newPage();
  await victim.goto(`${ORIGIN}/#r=${evilShare}&t=${evilToken}`, { waitUntil: "domcontentloaded" });
  try {
    await victim.waitForFunction(hasRow, { timeout: 20000 }, "f.txt");
  } catch (e) {
    const st = await evil.evaluate(() => window.__tamper).catch(() => null);
    throw new Error(`tamper: victim never got the manifest row — connection/grant failed. evil=${JSON.stringify(st)}`, { cause: e });
  }
  await victim.evaluate(clickRow, "f.txt");
  // The receiver detects the oversized file-head and disconnects immediately, surfacing a
  // "Disconnected: …" message. Assert from the receiver's side (it acts synchronously)
  // rather than waiting for the malicious sender to notice the drop: an abrupt WebRTC
  // teardown only reaches the sender via the slow ICE-disconnect timeout, which can exceed
  // 20s in headless CI even though the receiver already cut it off (channelClosed/connState
  // do flip there, just too late to wait on).
  try {
    await evil.waitForFunction(() => window.__tamper.sentBadHead, { timeout: 20000 });
    await victim.waitForFunction(() => document.body.textContent.includes("Disconnected"), { timeout: 20000 });
  } catch (e) {
    const st = await evil.evaluate(() => window.__tamper).catch(() => null);
    throw new Error(`tamper: receiver did not disconnect after the lie. evil=${JSON.stringify(st)}`, { cause: e });
  }
  ok("receiver disconnected a sender that lied about a file's declared size");
  await victim.close();
  await evil.close();

  await browser.close();
  cleanup();
  console.log(`all e2e smoke tests passed (${passed} checks)`);
  process.exit(0);
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  await browser.close().catch(() => {});
  cleanup();
  process.exit(1);
}
