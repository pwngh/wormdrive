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

/**
 * Smoke test for the static server's HTTP hardening: security headers, CSP,
 * path-traversal + malformed-URL handling, cache policy, and SPA fallback.
 *
 * Boots the *real* production server (server/signaling.mjs) against the built
 * dist/ rather than asserting against the source config, because the headers and
 * traversal guards are only meaningful as the running server actually emits them —
 * a unit test over the config object would pass even if the wiring regressed. The
 * child is killed on process exit so a failed assertion never leaks a listener.
 *
 * Deliberately excluded from `npm run check`: it depends on a fresh build existing,
 * which `check` does not produce. Run it explicitly after a build:
 *   npm run build && npm run test:headers
 */
import { spawn } from "node:child_process";
import { request } from "node:http";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
if (!existsSync(join(dist, "index.html"))) {
  console.error("smoke-headers: dist/index.html missing — run `npm run build` first");
  process.exit(1);
}

const PORT = process.env.HEADERS_PORT || "8801";
const serverPath = join(root, "server", "signaling.mjs");
const server = spawn(process.execPath, [serverPath], {
  env: { ...process.env, PORT },
  stdio: ["ignore", "pipe", "inherit"],
});
process.on("exit", () => server.kill());
// Wait for the startup banner so we don't race the listen().
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("server did not start in 5s")), 5000);
  server.stdout.on("data", (d) => { if (d.toString().includes("signaling")) { clearTimeout(t); resolve(); } });
  server.on("exit", (c) => { clearTimeout(t); reject(new Error(`server exited early (${c})`)); });
});

// Raw GET: `path` is sent verbatim so encoded traversal / malformed paths reach
// the server un-normalized (the whole point of the traversal + %-encoding cases).
const get = (path) =>
  new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });

const assert = (cond, label) => {
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
  console.log(`ok: ${label}`);
};

// 1. index carries the locked-down security headers + no-cache.
const idx = await get("/");
assert(idx.status === 200, "GET / → 200");
const csp = idx.headers["content-security-policy"] || "";
assert(
  csp.includes("default-src 'self'") && csp.includes("object-src 'none'") && csp.includes("frame-ancestors 'none'"),
  "/ carries the locked-down CSP",
);
assert(idx.headers["x-content-type-options"] === "nosniff", "/ x-content-type-options: nosniff");
assert(idx.headers["x-frame-options"] === "DENY", "/ x-frame-options: DENY");
assert(idx.headers["referrer-policy"] === "no-referrer", "/ referrer-policy: no-referrer");
assert((idx.headers["cache-control"] || "").includes("no-cache"), "/ index.html is no-cache");

// 2. content-hashed assets are immutably cached.
const assetsDir = join(dist, "assets");
const asset = existsSync(assetsDir) ? readdirSync(assetsDir).find((f) => f.endsWith(".js")) : null;
if (asset) {
  const a = await get(`/assets/${asset}`);
  assert(a.status === 200 && (a.headers["cache-control"] || "").includes("immutable"), "hashed asset is immutable-cached");
} else {
  console.log("skip: no built asset found to check immutable caching");
}

// 3. encoded ../ traversal is refused before it can escape dist/.
const trav = await get("/%2e%2e/%2e%2e/%2e%2e/etc/passwd");
assert(trav.status === 403, "encoded ../ traversal → 403");

// 4. malformed %-encoding → 400 (and must not crash the process).
const bad = await get("/%ZZ");
assert(bad.status === 400, "malformed %-encoding → 400");

// 5. unknown route falls back to index.html (SPA).
const spa = await get("/no/such/route");
assert(spa.status === 200 && (spa.headers["content-type"] || "").includes("text/html"), "unknown route → SPA index fallback");

// 6. health endpoint.
const hz = await get("/healthz");
assert(hz.status === 200 && hz.body.trim() === "ok", "/healthz → ok");

// 7. the server survived the malformed request.
assert((await get("/")).status === 200, "server alive after malformed request");

console.log("all header smoke tests passed");
process.exit(0);
