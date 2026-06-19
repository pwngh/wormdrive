import hljs from "highlight.js/lib/common";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import "highlight.js/styles/github-dark.css";

import { el } from "../dom";
import { ext } from "../manifest";
import { TEXT_PREVIEW_CAP } from "../protocol";

hljs.registerLanguage("dockerfile", dockerfile);

/** Map file extensions to highlight.js language names where they differ. */
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

export async function renderText(container: HTMLElement, name: string, blob: Blob): Promise<void> {
  const truncated = blob.size > TEXT_PREVIEW_CAP;
  const slice = truncated ? blob.slice(0, TEXT_PREVIEW_CAP) : blob;
  // A byte-offset slice can cut a multi-byte UTF-8 char, leaving a trailing
  // U+FFFD; drop it on the truncated path so the preview doesn't end in "�".
  const text = truncated ? (await slice.text()).replace(/�$/, "") : await slice.text();

  const e = ext(name);
  const lang = LANG[e] ?? (name.toLowerCase() === "dockerfile" ? "dockerfile" : e);

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
