// Runs the signaling server and Vite dev server together.
// Uses process.execPath and direct script paths (no shell) for portability.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function run(name, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const prefix = (line) => line.length > 0 && console.log(`[${name}] ${line}`);
  child.stdout.on("data", (d) => d.toString().split("\n").forEach(prefix));
  child.stderr.on("data", (d) => d.toString().split("\n").forEach(prefix));
  return child;
}

// The Vite proxy targets :8787 (vite.config.ts), so the dev signaling port is
// pinned — an inherited PORT from the parent environment must not move it.
const signaling = run("signal", ["server/signaling.mjs"], { PORT: "8787" });
const vite = run("vite", ["node_modules/vite/bin/vite.js"]);

function shutdown() {
  signaling.kill("SIGTERM");
  vite.kill("SIGTERM");
}

process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });

for (const child of [signaling, vite]) {
  child.on("exit", (code) => {
    shutdown();
    process.exit(code ?? 0);
  });
}
