import * as XLSX from "xlsx";

import { el } from "../dom";

const TABLE_CSS = `
  :root { color-scheme: dark; }
  body { margin: 0; padding: 12px; background: #161B22; color: #E8E4D8;
         font: 13px/1.5 "IBM Plex Mono", ui-monospace, monospace; }
  table { border-collapse: collapse; width: max-content; min-width: 100%; }
  td, th { border: 1px solid #2C333D; padding: 4px 10px; white-space: nowrap; }
  tr:first-child td { background: #1D242D; font-weight: 600; position: sticky; top: 0; }
`;

export async function renderSheet(container: HTMLElement, blob: Blob): Promise<void> {
  const data = await blob.arrayBuffer();
  const wb = XLSX.read(data, { type: "array" });
  if (wb.SheetNames.length === 0) throw new Error("Workbook has no sheets.");

  const frame = el("iframe", {
    class: "sheetframe",
    sandbox: "", // fully sandboxed: no scripts, no same-origin — defuses any HTML in cell values
  }) as HTMLIFrameElement;

  const show = (sheetName: string): void => {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) return;
    const html = XLSX.utils.sheet_to_html(sheet, { header: "", footer: "" });
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><style>${TABLE_CSS}</style>${html}`;
  };

  if (wb.SheetNames.length > 1) {
    const tabs = el("div", { class: "row gap wrap" });
    const buttons: HTMLButtonElement[] = [];
    for (const sheetName of wb.SheetNames) {
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
  const first = wb.SheetNames[0];
  if (first) show(first);
}
