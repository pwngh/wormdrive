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
 * Preview lifecycle and dispatch for received files. Two concerns live here so
 * the rest of the receiver never touches viewer internals: a process-wide
 * registry of resources every viewer leaks (object URLs, parsed-document
 * destructors), and the single 'renderPreview' switch that lazily loads the
 * right viewer per 'FileKind'. Centralizing teardown matters because previews
 * swap in place and the overlay closes mid-stream; without one drain point an
 * object URL from a prior preview keeps its blob (and the decrypted bytes it
 * wraps) alive in memory longer than intended.
 */

import { el } from "../dom";
import type { FileKind } from "../protocol";

/** Object URLs and teardown callbacks registered by viewers; both are
 *  revoked/run on every preview switch and when the overlay closes. */
const liveUrls: string[] = [];
const disposers: Array<() => void> = [];

/**
 * Register an object URL for revocation on the next preview switch / overlay
 * close, returning it unchanged so call sites can wrap 'URL.createObjectURL'
 * inline (e.g. 'img.src = trackUrl(URL.createObjectURL(blob))'). Tracking at
 * creation is what guarantees the URL — and the decrypted blob it pins — is
 * released; nothing else revokes them.
 */
export function trackUrl(url: string): string {
  liveUrls.push(url);
  return url;
}

/** Register a teardown callback (e.g. a parsed-document destructor) to run on
 *  the next preview switch / overlay close. */
export function onPreviewRelease(dispose: () => void): void {
  disposers.push(dispose);
}

/**
 * Drain every tracked URL and disposer, used both when switching previews and
 * when the overlay closes. 'splice(0)' empties each list as it reads, so a
 * re-entrant call (or a disposer that registers more work) can't double-revoke
 * or loop. Disposer failures are swallowed so one viewer's broken teardown
 * can't strand the URLs and blobs queued behind it.
 */
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

/**
 * Render a received file into 'container', dispatching on 'FileKind' to the
 * matching viewer. Any failure — a missing chunk, a parse error, an unsupported
 * codec — is caught and rendered as inline placeholder text rather than thrown,
 * so a single bad file degrades to "Preview failed" instead of tearing down the
 * receiver UI mid-transfer. Callers pass the raw 'blob'; each viewer is
 * responsible for tracking any object URL it creates from it via 'trackUrl' (and
 * any parsed-document destructor via 'onPreviewRelease') so 'releasePreviewResources'
 * can reclaim them on the next preview switch or overlay close.
 */
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
