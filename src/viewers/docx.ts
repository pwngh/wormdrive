import mammoth from "mammoth";

import { el } from "../dom";

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

export async function renderDocx(container: HTMLElement, blob: Blob): Promise<void> {
  const arrayBuffer = await blob.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer });

  const frame = el("iframe", {
    class: "docframe",
    sandbox: "", // no scripts, no same-origin
  }) as HTMLIFrameElement;
  frame.srcdoc = `<!doctype html><meta charset="utf-8"><style>${DOC_CSS}</style>${result.value}`;
  container.append(frame);
}
