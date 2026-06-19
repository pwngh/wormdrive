import { el } from "../dom";
import type { FileKind } from "../protocol";

/** Object URLs and teardown callbacks registered by viewers; both are
 *  revoked/run on every preview switch and when the overlay closes. */
const liveUrls: string[] = [];
const disposers: Array<() => void> = [];

export function trackUrl(url: string): string {
  liveUrls.push(url);
  return url;
}

/** Register a teardown callback (e.g. a parsed-document destructor) to run on
 *  the next preview switch / overlay close. */
export function onPreviewRelease(dispose: () => void): void {
  disposers.push(dispose);
}

export function releasePreviewResources(): void {
  for (const url of liveUrls.splice(0)) URL.revokeObjectURL(url);
  for (const dispose of disposers.splice(0)) {
    try {
      dispose();
    } catch {
      // a viewer's own teardown failing must not break the rest of cleanup
    }
  }
}

export async function renderPreview(
  container: HTMLElement,
  kind: FileKind,
  name: string,
  blob: Blob,
): Promise<void> {
  try {
    // Each viewer is a lazily-loaded chunk so receivers only download the
    // library (pdf.js, SheetJS, mammoth, highlight.js…) they actually need.
    switch (kind) {
      case "text":
      case "code":
        await (await import("./text")).renderText(container, name, blob);
        return;
      case "pdf":
        await (await import("./pdf")).renderPdf(container, blob);
        return;
      case "sheet":
        await (await import("./sheet")).renderSheet(container, blob);
        return;
      case "doc":
        await (await import("./docx")).renderDocx(container, blob);
        return;
      case "image":
        (await import("./media")).renderImage(container, blob);
        return;
      case "media":
        (await import("./media")).renderMedia(container, name, blob);
        return;
      case "other":
        container.append(el("p", { class: "dim centered" }, ["No inline preview for this file type."]));
        return;
    }
  } catch (err) {
    container.append(
      el("p", { class: "dim centered" }, [
        `Preview failed: ${err instanceof Error ? err.message : "unknown error"}`,
      ]),
    );
  }
}
