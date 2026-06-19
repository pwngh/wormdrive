import { el } from "../dom";
import { ext } from "../manifest";
import { trackUrl } from "./index";

const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus"]);

export function renderImage(container: HTMLElement, blob: Blob): void {
  const url = trackUrl(URL.createObjectURL(blob));
  container.append(el("img", { class: "imgview", src: url, alt: "preview" }));
}

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
