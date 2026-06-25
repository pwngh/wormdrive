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

// Spreadsheet parsing runs here, off the main thread. The workbook comes from an
// untrusted peer, so doing XLSX.read in a worker means a malformed/pathological
// file can hang (or be terminated by the caller) without freezing the receiver's
// UI. Only pre-rendered HTML strings cross back to the main thread.
import * as XLSX from "xlsx";

// Post a result back to the main thread. The cast exists because the worker
// build sees the DOM-less core lib types, where `self` is not typed as a
// DedicatedWorkerGlobalScope and so lacks `postMessage`; narrowing here keeps
// that one assertion contained instead of leaking through every call site.
const post = (message: unknown): void =>
  (self as unknown as { postMessage(m: unknown): void }).postMessage(message);

// Request is the raw workbook bytes (transferred as an ArrayBuffer); reply is
// either { sheetNames, html } with one pre-rendered HTML string per sheet, or
// { error } on a parse failure. Errors are reported as data rather than thrown
// so the receiver can show a message instead of seeing the worker die silently.
self.onmessage = (e: MessageEvent): void => {
  try {
    const wb = XLSX.read(new Uint8Array(e.data as ArrayBuffer), { type: "array" });
    const html: Record<string, string> = {};
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      // One pathological sheet must not lose the rest of the workbook.
      try {
        html[name] = sheet ? XLSX.utils.sheet_to_html(sheet, { header: "", footer: "" }) : "";
      } catch {
        html[name] = "";
      }
    }
    post({ sheetNames: wb.SheetNames, html });
  } catch (err) {
    post({ error: err instanceof Error ? err.message : "spreadsheet parse failed" });
  }
};
