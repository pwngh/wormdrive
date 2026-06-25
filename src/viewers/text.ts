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
 * Text and source-code preview backed by highlight.js. Renders a received blob as
 * syntax-highlighted text in the preview container; nothing leaves the page. Lives behind
 * the viewer registry in ./index. See renderText for the size and cost caps that keep a
 * huge or pathological file from stalling the main thread.
 */

import hljs from "highlight.js/lib/common";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import "highlight.js/styles/github-dark.css";

import { el } from "../dom";
import { ext } from "../manifest";
import { TEXT_PREVIEW_CAP } from "../protocol";

hljs.registerLanguage("dockerfile", dockerfile);

// Map file extensions to highlight.js language names where they differ. Only the
// mismatches live here; an extension that already equals its hljs language (json,
// css, go, ...) is passed through untouched at the call site, so it needs no entry.
const LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  html: "xml",
  htm: "xml",
  svg: "xml",
  vue: "xml",
  toml: "ini",
  conf: "ini",
  cfg: "ini",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  ps1: "powershell",
};

const AUTO_DETECT_CAP = 100 * 1024; // auto-detection is O(n * languages); keep it for small files

/**
 * Render a received blob as syntax-highlighted text into 'container'.
 *
 * Highlighting strategy is tiered by cost: a known extension/Dockerfile maps
 * straight to a hljs language and skips detection entirely; otherwise we fall back
 * to 'highlightAuto', but only under AUTO_DETECT_CAP since auto-detect runs every
 * registered grammar over the input. Past that cap we render plain text rather than
 * stall the viewer on a large file. The TEXT_PREVIEW_CAP slice keeps even a huge
 * file from being fully decoded into the DOM — this is a preview, not the download.
 */
export async function renderText(container: HTMLElement, name: string, blob: Blob): Promise<void> {
  const truncated = blob.size > TEXT_PREVIEW_CAP;
  const slice = truncated ? blob.slice(0, TEXT_PREVIEW_CAP) : blob;
  // A byte-offset slice can cut a multi-byte UTF-8 char, leaving a trailing
  // U+FFFD; drop it on the truncated path so the preview doesn't end in "�".
  const text = truncated ? (await slice.text()).replace(/�$/, "") : await slice.text();

  const e = ext(name);
  // Dockerfile has no extension, so it's matched by full filename rather than via LANG.
  // Anything not in LANG falls through to the raw extension, which hljs.getLanguage
  // then validates below before we trust it as a language.
  const lang = Object.hasOwn(LANG, e) ? LANG[e] : (name.toLowerCase() === "dockerfile" ? "dockerfile" : e);

  const code = el("code");
  if (lang && hljs.getLanguage(lang)) {
    // hljs escapes input; its output is safe to assign to innerHTML.
    code.innerHTML = hljs.highlight(text, { language: lang }).value;
  } else if (blob.size <= AUTO_DETECT_CAP) {
    code.innerHTML = hljs.highlightAuto(text).value;
  } else {
    code.textContent = text;
  }

  if (truncated) {
    container.append(
      el("p", { class: "notice" }, [
        `Preview truncated to the first ${(TEXT_PREVIEW_CAP / (1024 * 1024)).toFixed(1)} MB — download for the full file.`,
      ]),
    );
  }
  container.append(el("pre", { class: "codeview" }, [code]));
}
