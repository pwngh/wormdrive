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
 * Local dev orchestrator: brings up the signaling relay and the Vite dev server
 * as one foreground process so a single Ctrl-C tears both down together.
 *
 * Children are spawned with process.execPath and a direct script path rather than
 * an npm/shell wrapper: no shell means no quoting or PATH surprises across OSes,
 * and reusing the current Node binary keeps both halves on the same runtime the
 * developer launched this with.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Spawn one child and tag every line of its output with a [name] prefix so the
// interleaved signal/vite logs stay attributable in a shared terminal. stdin is
// closed (neither child reads it) and both streams are piped here rather than
// inherited precisely so we can prefix them.
function run(name, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  // Drop empty trailing fragments from the split so a chunk ending in "\n"
  // doesn't emit a bare "[name] " line.
  const prefix = (line) => line.length > 0 && console.log(`[${name}] ${line}`);
  child.stdout.on("data", (d) => d.toString().split("\n").forEach(prefix));
  child.stderr.on("data", (d) => d.toString().split("\n").forEach(prefix));
  return child;
}

// The Vite proxy targets :8787 (vite.config.ts), so the dev signaling port is
// pinned — an inherited PORT from the parent environment must not move it.
const signaling = run("signal", ["server/signaling.mjs"], { PORT: "8787" });
const vite = run("vite", ["node_modules/vite/bin/vite.js"]);

// Best-effort SIGTERM to both children. Idempotent on purpose: it runs on our
// own signal handlers AND on either child's exit, so if one dies we take the
// other down with it instead of leaving a half-running dev stack.
function shutdown() {
  signaling.kill("SIGTERM");
  vite.kill("SIGTERM");
}

process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });

// If either half exits, tear down the other and propagate its code so a crashed
// child surfaces a non-zero status to the caller (a null code from a signal
// death falls back to 0, since that's an intentional shutdown, not a failure).
for (const child of [signaling, vite]) {
  child.on("exit", (code) => {
    shutdown();
    process.exit(code ?? 0);
  });
  // A spawn failure emits 'error' (not 'exit'); without a listener Node throws
  // it as an uncaught exception, skipping shutdown() and orphaning the sibling.
  child.on("error", (err) => {
    console.error(`[dev] failed to spawn child: ${err.message}`);
    shutdown();
    process.exit(1);
  });
}
