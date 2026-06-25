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
 * In-browser preview of a received .docx, converted to HTML with mammoth and shown
 * in a fully sandboxed iframe. This is the trust boundary: the document arrives over
 * the relay from the sender and is never run in the app's own context. mammoth gives us
 * a structural HTML approximation (headings, tables, images, links) rather than a
 * pixel-faithful render, which is the right tradeoff for a preview — no external fetches,
 * no fonts to load, no layout engine beyond the browser's own.
 */

import mammoth from "mammoth";

import { el } from "../dom";

// Inlined into the iframe's srcdoc so the preview styles itself with zero network requests
// (srcdoc content has an opaque origin, so a relative stylesheet URL wouldn't resolve, and
// inlining keeps the preview self-contained with no network dependency). Colors mirror the
// app's dark theme; the serif body font signals "document" while headings stay sans.
const DOC_CSS = `
  :root { color-scheme: dark; }
  body { margin: 0; padding: 28px; background: #161B22; color: #E8E4D8; max-width: 760px;
         font: 15px/1.65 Georgia, "Times New Roman", serif; }
  h1, h2, h3, h4 { font-family: "Space Grotesk", system-ui, sans-serif; line-height: 1.25; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
  td, th { border: 1px solid #2C333D; padding: 4px 10px; }
  a { color: #F5A524; }
`;

/**
 * Convert a received .docx blob to HTML and mount it as a sandboxed preview inside `container`.
 *
 * The blob is read fully into an ArrayBuffer because mammoth has no streaming API; .docx
 * previews are small enough that this is fine. The converted HTML is handed to the iframe via
 * `srcdoc` rather than appended into the live DOM so the sandbox attribute (no scripts, no
 * same-origin) actually contains it — anything malformed or hostile in the document stays in
 * the frame and can't touch the app. mammoth's conversion warnings (`result.messages`) are
 * intentionally dropped: a lossy preview is acceptable, and surfacing them would only alarm.
 */
export async function renderDocx(container: HTMLElement, blob: Blob): Promise<void> {
  const arrayBuffer = await blob.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer });

  const frame = el("iframe", {
    class: "docframe",
    sandbox: "", // fully sandboxed: no scripts, no same-origin — mammoth's HTML comes from an untrusted .docx
  }) as HTMLIFrameElement;
  frame.srcdoc = `<!doctype html><meta charset="utf-8"><style>${DOC_CSS}</style>${result.value}`;
  container.append(frame);
}
