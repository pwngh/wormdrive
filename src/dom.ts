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
 * Small, dependency-free DOM and string utilities shared across sender and receiver UIs.
 * Nothing here knows about the app's protocol, manifest, or transfer state — these are leaf
 * helpers so any view layer can import them without dragging in app logic or creating cycles.
 */

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;
type Child = Node | string | null | undefined;

/**
 * Tiny element builder: el("div", { class: "row", onclick: fn }, [..]).
 *
 * The attr convention keeps call sites terse: keys starting with "on" become listeners,
 * a boolean true sets a bare attribute (e.g. `readonly`), and false/undefined drops it
 * entirely so callers can pass conditional attrs inline without building the object up first.
 * Just enough of a builder to avoid pulling in a framework for a handful of views.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value as EventListener);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
}

/**
 * Human-readable byte size for file rows (e.g. "1.5 MB").
 *
 * Drops to zero decimals once the value is >= 100 so the column stays narrow and the
 * extra digit doesn't imply precision we don't have. Below 1024 bytes we show raw "B"
 * rather than "0.x KB", which reads as nothing for tiny manifest entries.
 */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  // Rounding (toFixed) can push a value just under the boundary up to 1024;
  // promote to the next unit if one exists so we never show "1024 KB".
  if (unit < units.length - 1 && Number(value.toFixed(value >= 100 ? 0 : 1)) >= 1024) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** Staggered animation delay for list rows; capped so long lists don't crawl in. */
export function staggerDelay(index: number): string {
  return `${Math.min(index, 12) * 22}ms`;
}

/**
 * URL-safe random id. 16 bytes -> 22 chars, ~128 bits of entropy.
 *
 * Drawn from crypto.getRandomValues (not Math.random) because these ids double as
 * unguessable session/token components in transfer URLs; a predictable id would let a
 * third party join a relay. The base64 output is made URL-safe (- _ , no padding) so it
 * can drop straight into a link without further escaping.
 */
export function randomId(bytes = 16): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  let binary = "";
  for (const b of raw) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Constant-time string compare for token checks.
 *
 * Compares every character with an accumulated XOR rather than returning early on the
 * first mismatch, so the running time doesn't leak how many leading characters of a
 * token were correct — closing a timing side channel an attacker could otherwise use to
 * recover a token byte by byte. Length is allowed to short-circuit since it isn't secret.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Clipboard write that also works on plain-http LAN deployments,
 *  where navigator.clipboard is unavailable (insecure context). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  const scratch = el("textarea", { readonly: true, style: "position:fixed;left:-9999px" });
  scratch.value = text;
  document.body.append(scratch);
  scratch.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    // execCommand threw or is unsupported — ok stays false
  }
  scratch.remove();
  return ok;
}

/** How long a tapped button shows its confirmation label before reverting. */
const FLASH_MS = 1100;

/**
 * Briefly swap a button's text to a confirmation label, then revert.
 *
 * The button is disabled during the flash so a rapid second tap can't re-trigger the
 * action (or stack timers that race to restore the wrong original text). Captures the
 * current textContent up front rather than assuming a fixed default, so the same helper
 * works for buttons whose resting label varies.
 */
export function flash(button: HTMLButtonElement, label = "Copied"): void {
  const original = button.textContent ?? "";
  button.textContent = label;
  button.disabled = true;
  window.setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, FLASH_MS);
}
