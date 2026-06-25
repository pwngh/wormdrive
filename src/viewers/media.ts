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
 * In-browser preview for image, audio, and video payloads once a transfer's blob
 * is in hand. The blob is the decrypted, fully-received file held only in memory;
 * nothing here touches the network. We hand the blob to the browser's native
 * <img>/<audio>/<video> decoders via object URLs rather than parsing formats
 * ourselves, so codec coverage tracks whatever the receiver's browser supports.
 */

import { el } from "../dom";
import { ext } from "../manifest";
import { trackUrl } from "./index";

// Extensions routed to <audio> instead of <video>. Container formats like ogg/m4a
// can hold either stream, so we resolve the ambiguous ones to audio here; anything
// not in this set falls through to <video>, which also handles bare video files.
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus"]);

/**
 * Mount an image preview. The object URL is registered with trackUrl so the
 * viewer's teardown can revoke it; leaking it would pin the decrypted blob in
 * memory past the point where the transfer is meant to be gone.
 */
export function renderImage(container: HTMLElement, blob: Blob): void {
  const url = trackUrl(URL.createObjectURL(blob));
  container.append(el("img", { class: "imgview", src: url, alt: "preview" }));
}

/**
 * Mount an audio or video preview, choosing the element by extension since the
 * blob's MIME type is not reliably present on a received transfer. As with images,
 * the object URL is tracked so it can be revoked on teardown and the decrypted
 * payload doesn't outlive the view.
 */
export function renderMedia(container: HTMLElement, name: string, blob: Blob): void {
  const url = trackUrl(URL.createObjectURL(blob));
  const isAudio = AUDIO_EXT.has(ext(name));
  const node = el(isAudio ? "audio" : "video", {
    class: "mediaview",
    src: url,
    controls: "",
  });
  container.append(node);
}
