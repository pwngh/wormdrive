// Fetch + cache the self-hosted webfonts (latin subset) into public/fonts/.
// Runs automatically before `dev` and `build` via npm pre-hooks. The fonts are
// gitignored, not vendored, so the repo carries no binaries.
//
// Idempotent: skips files already present. Network-tolerant: if the fetch
// fails (offline, CDN down, Google rotated the hashes), it warns and exits 0 —
// the app then falls back to the system font stack declared in styles.css.
// We parse the live css2 API rather than pinning gstatic URLs so a hash
// rotation doesn't silently 404.
import { mkdir, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "fonts");
const CSS_URL =
  "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap";
// A modern-browser UA makes Google serve woff2 (older UAs get ttf).
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Map a CSS @font-face block to a stable local filename. Space Grotesk is a
// variable font (one file for all weights); IBM Plex Mono ships per-weight.
const localName = (family, weight) =>
  family === "Space Grotesk"
    ? "space-grotesk-var.woff2"
    : family === "IBM Plex Mono"
      ? `ibm-plex-mono-${weight}.woff2`
      : null;

const WANTED = ["space-grotesk-var.woff2", "ibm-plex-mono-400.woff2", "ibm-plex-mono-500.woff2"];
const exists = (p) => access(p).then(() => true, () => false);
const get = (url) => fetch(url, { headers: { "user-agent": UA } });

await mkdir(OUT, { recursive: true });

const missing = [];
for (const f of WANTED) if (!(await exists(join(OUT, f)))) missing.push(f);
if (missing.length === 0) process.exit(0); // all cached

try {
  const css = await (await get(CSS_URL)).text();
  const written = new Set();
  for (const block of css.split("@font-face").slice(1)) {
    const range = (block.match(/unicode-range:\s*([^;]+);/) || [])[1] || "";
    if (!/U\+0000-00FF/.test(range)) continue; // latin subset only
    const family = (block.match(/font-family:\s*'([^']+)'/) || [])[1];
    const weight = (block.match(/font-weight:\s*(\d+)/) || [])[1];
    const url = (block.match(/url\((https:[^)]+\.woff2)\)/) || [])[1];
    const name = family && url && localName(family, weight);
    if (!name || written.has(name)) continue; // variable font repeats per weight
    written.add(name);
    const buf = Buffer.from(await (await get(url)).arrayBuffer());
    await writeFile(join(OUT, name), buf);
    console.log(`[fonts] ${name} (${buf.length} bytes)`);
  }
  const still = [];
  for (const f of WANTED) if (!(await exists(join(OUT, f)))) still.push(f);
  if (still.length) console.warn(`[fonts] missing after fetch: ${still.join(", ")} — using system fonts`);
} catch (err) {
  console.warn(`[fonts] fetch failed (${err.message}) — using system fonts`);
}
