import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { el } from "../dom";
import { onPreviewRelease } from "./index";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_FIRST = 20; // render the first N pages eagerly, rest on demand

export async function renderPdf(container: HTMLElement, blob: Blob): Promise<void> {
  const data = await blob.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  // Free the parsed document + worker transport when the preview is dismissed;
  // releasePreviewResources only revokes object URLs otherwise.
  onPreviewRelease(() => void doc.destroy());

  const width = Math.max(320, Math.min(container.clientWidth || 800, 1100));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  async function renderPage(n: number): Promise<void> {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width;
    const viewport = page.getViewport({ scale: scale * dpr });

    const canvas = el("canvas", { class: "pdfpage" }) as HTMLCanvasElement;
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable.");
    await page.render({ canvasContext: ctx, viewport }).promise;
    container.append(canvas);
  }

  const eager = Math.min(doc.numPages, MAX_FIRST);
  for (let n = 1; n <= eager; n += 1) await renderPage(n);

  if (doc.numPages > eager) {
    const rest = el("button", { class: "btn small" }, [
      `Render remaining ${doc.numPages - eager} pages`,
    ]) as HTMLButtonElement;
    rest.addEventListener("click", async () => {
      rest.disabled = true;
      rest.textContent = "Rendering…";
      try {
        for (let n = eager + 1; n <= doc.numPages; n += 1) await renderPage(n);
        rest.remove();
      } catch {
        rest.textContent = "Rendering failed";
      }
    });
    container.append(el("div", { class: "centered" }, [rest]));
  }
}
