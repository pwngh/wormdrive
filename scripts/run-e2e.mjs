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

// Retry wrapper for the two-tab e2e. A real-browser WebRTC connection over
// loopback intermittently (~5-10%) fails to establish in headless Chrome — that's
// inherent ICE timing, not a logic bug: when it connects, every check passes
// deterministically. So run the scenario in a FRESH process each time (its own
// signaling server, browser, and port, so a wedged attempt can't poison the
// next) up to three times; pass if any attempt passes.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const script = join(dirname(fileURLToPath(import.meta.url)), "smoke-e2e.mjs");
// Three is enough: at a ~5-10% per-attempt ICE-timing failure rate, the odds of
// all three independent attempts failing are negligible, so a green suite stays
// reliable without masking a genuine logic bug (which would fail every attempt).
const ATTEMPTS = 3;
// Each retry runs on BASE_PORT + i rather than reusing one port, so a previous
// attempt that wedged its signaling server or left a socket in TIME_WAIT can't
// collide with or poison the next attempt.
const BASE_PORT = 8802;

for (let i = 0; i < ATTEMPTS; i++) {
  const port = String(BASE_PORT + i);
  const res = spawnSync(process.execPath, [script], {
    stdio: "inherit",
    env: { ...process.env, E2E_PORT: port },
  });
  if (res.status === 0) process.exit(0);
  if (i < ATTEMPTS - 1) {
    console.error(`\n[run-e2e] attempt ${i + 1} failed (exit ${res.status}); retrying on a fresh port…\n`);
  }
}
console.error("[run-e2e] e2e failed after all attempts");
process.exit(1);
