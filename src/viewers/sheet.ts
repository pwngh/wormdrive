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

import { el } from "../dom";

/**
 * Renders a received spreadsheet as read-only HTML tables in the receiver tab.
 *
 * Two trust boundaries shape this module. The workbook bytes are attacker-controlled,
 * so parsing happens off-thread in a Web Worker (see parseInWorker) and the resulting
 * cell HTML is displayed inside a fully sandboxed iframe — never injected into the
 * receiver's own document. Styling is inlined into the iframe srcdoc rather than shared
 * with the host page, since the sandbox has no access to the parent's stylesheets.
 */

const TABLE_CSS = `
  :root { color-scheme: dark; }
  body { margin: 0; padding: 12px; background: #161B22; color: #E8E4D8;
         font: 13px/1.5 "IBM Plex Mono", ui-monospace, monospace; }
  table { border-collapse: collapse; width: max-content; min-width: 100%; }
  td, th { border: 1px solid #2C333D; padding: 4px 10px; white-space: nowrap; }
  tr:first-child td { background: #1D242D; font-weight: 600; position: sticky; top: 0; }
`;

interface SheetParse {
  sheetNames: string[];
  html: Record<string, string>;
}

// Untrusted workbooks are parsed in a Web Worker (sheet.worker.ts) so a malformed
// file's parse cost can't freeze the receiver tab; a runaway parse is terminated
// after this budget and surfaced as an error.
const PARSE_TIMEOUT_MS = 10_000;

// Spin up a one-shot worker per parse and resolve with whichever fires first:
// a result message, a worker error, or the timeout. 'finish' funnels all three
// paths through a single teardown so the timer is always cleared and the worker
// always terminated — a leaked worker would hold the transferred buffer alive.
function parseInWorker(data: ArrayBuffer): Promise<SheetParse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./sheet.worker.ts", import.meta.url), { type: "module" });
    let timer = 0;
    const finish = (run: () => void): void => {
      window.clearTimeout(timer);
      worker.terminate();
      run();
    };
    timer = window.setTimeout(
      () => finish(() => reject(new Error("Spreadsheet parsing timed out — the file may be malformed."))),
      PARSE_TIMEOUT_MS,
    );
    worker.onmessage = (e: MessageEvent): void => {
      const msg = e.data as { error?: string } & Partial<SheetParse>;
      finish(() =>
        msg.error
          ? reject(new Error(msg.error))
          : resolve({ sheetNames: msg.sheetNames ?? [], html: msg.html ?? {} }),
      );
    };
    worker.onerror = (): void => finish(() => reject(new Error("Spreadsheet worker failed.")));
    // Transfer ownership of the buffer instead of structured-cloning it: workbooks can be
    // large, and a copy would briefly double memory. Transfer neuters 'data' here, which is
    // fine since the caller never touches it again after this call.
    worker.postMessage(data, [data]);
  });
}

/**
 * Parse a received workbook and mount its sheets as read-only tables in 'container'.
 *
 * Multi-sheet workbooks get a row of tab buttons; the parsed HTML for every sheet is
 * held in memory and swapped into the iframe's srcdoc on click, so switching sheets is
 * instant and never re-parses. The first sheet is shown by default. Throws if the file
 * parsed to zero sheets, which usually means it wasn't a workbook at all.
 */
export async function renderSheet(container: HTMLElement, blob: Blob): Promise<void> {
  const data = await blob.arrayBuffer();
  const { sheetNames, html } = await parseInWorker(data);
  if (sheetNames.length === 0) throw new Error("Workbook has no sheets.");

  const frame = el("iframe", {
    class: "sheetframe",
    sandbox: "", // fully sandboxed: no scripts, no same-origin — defuses any HTML in cell values
  }) as HTMLIFrameElement;

  const show = (sheetName: string): void => {
    const sheetHtml = html[sheetName];
    if (sheetHtml === undefined) return;
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><style>${TABLE_CSS}</style>${sheetHtml}`;
  };

  if (sheetNames.length > 1) {
    const tabs = el("div", { class: "row gap wrap" });
    const buttons: HTMLButtonElement[] = [];
    for (const sheetName of sheetNames) {
      const b = el("button", { class: "btn small" }, [sheetName]) as HTMLButtonElement;
      b.addEventListener("click", () => {
        for (const other of buttons) other.classList.remove("primary");
        b.classList.add("primary");
        show(sheetName);
      });
      buttons.push(b);
      tabs.append(b);
    }
    buttons[0]?.classList.add("primary");
    container.append(tabs);
  }

  container.append(frame);
  const first = sheetNames[0];
  if (first) show(first);
}
