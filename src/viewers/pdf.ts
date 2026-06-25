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
 * In-browser PDF preview backed by pdf.js. Renders a received blob to canvas pages
 * inside the preview container; nothing leaves the page. Parsing runs on pdf.js's own
 * worker (configured below) so a large or malformed document can't block the main thread
 * mid-transfer. Lives behind the viewer registry in ./index, which owns the lifecycle
 * hook we use to tear the document down on dismissal.
 */

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { el } from "../dom";
import { onPreviewRelease } from "./index";

// pdf.js spawns its parser in a Web Worker; point it at the bundled worker asset (resolved
// to a URL by Vite's '?url' import) instead of letting it guess a CDN path at runtime.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// Render the first N pages eagerly, the rest behind a button. The cap bounds peak canvas
// memory and time-to-first-paint for huge documents — every rendered page holds a full
// device-pixel-ratio bitmap, so eagerly rasterizing a 500-page PDF would stall and balloon
// memory for a preview the user may dismiss after the first page.
const MAX_FIRST = 20;

/**
 * Render a received PDF blob into `container` as a stack of canvas pages.
 *
 * Reads the blob fully into an ArrayBuffer rather than streaming: the file already lives
 * in memory (it arrived over the transfer) and pdf.js wants the whole buffer for random
 * page access. The document and its worker transport are registered with onPreviewRelease
 * so they're destroyed when the preview closes — `releasePreviewResources` only revokes
 * object URLs, so without this the parsed doc and worker would leak per preview.
 */
export async function renderPdf(container: HTMLElement, blob: Blob): Promise<void> {
  const data = await blob.arrayBuffer();
  // Register teardown against the loading task before awaiting: getDocument spawns the
  // parser Web Worker eagerly, so if the document promise rejects (malformed/hostile PDF)
  // the worker would otherwise leak. loadingTask.destroy() is what doc.destroy() routes
  // through, and it tears the worker down even when parsing never completed.
  const loadingTask = pdfjs.getDocument({ data });
  onPreviewRelease(() => void loadingTask.destroy());
  const doc = await loadingTask.promise;

  // CSS width the pages occupy, clamped to a sane band: never narrower than 320 (mobile) nor
  // wider than 1100 (readability), defaulting to 800 when the container hasn't been laid out yet.
  const width = Math.max(320, Math.min(container.clientWidth || 800, 1100));
  // Oversample by the display's pixel ratio for crisp text, but cap at 2: 3x retina panels
  // would triple bitmap area for no visible gain and risk hitting canvas size limits.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  async function renderPage(n: number): Promise<void> {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width;
    // Rasterize at device resolution (scale * dpr) but lay out at CSS resolution: the canvas
    // backing store is DPR-sized while its style width divides that back out, so the browser
    // down-maps the high-res bitmap into the intended CSS box.
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
