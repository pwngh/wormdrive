// Inline SVG icon set — hand-drawn 24×24 stroke paths, no dependencies.
// Styled via CSS (`svg.icon` + size/color classes); stroke is currentColor.

import type { FileKind } from "./protocol";

const FILE_OUTLINE = "M13 2.5H6.8a1.3 1.3 0 0 0-1.3 1.3v16.4a1.3 1.3 0 0 0 1.3 1.3h10.4a1.3 1.3 0 0 0 1.3-1.3V8Z";
const FILE_CORNER = "M13 2.5V8h5.5";

const PATHS = {
  folder: [
    "M3 18.5V6a1.5 1.5 0 0 1 1.5-1.5h4.3L11 7.1h8.5A1.5 1.5 0 0 1 21 8.6v9.9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z",
  ],
  file: [FILE_OUTLINE, FILE_CORNER],
  "file-lines": [FILE_OUTLINE, FILE_CORNER, "M9 13.5h6", "M9 17h4"],
  code: ["m8.5 9-3.3 3 3.3 3", "m15.5 9 3.3 3-3.3 3"],
  grid: [
    "M4.5 6A1.5 1.5 0 0 1 6 4.5h12A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18Z",
    "M4.5 9.75h15",
    "M4.5 14.25h15",
    "M11 4.5v15",
  ],
  image: [
    "M4.5 6A1.5 1.5 0 0 1 6 4.5h12A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18Z",
    "M10.2 9.2a1.3 1.3 0 1 1-2.6 0 1.3 1.3 0 0 1 2.6 0Z",
    "m5.5 17.5 4.2-5 3.2 3.6 2.4-2.8 3.6 4.2",
  ],
  play: [
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
    "M10.2 8.9v6.2l5.1-3.1Z",
  ],
  x: ["m6.5 6.5 11 11", "m17.5 6.5-11 11"],
  "chev-l": ["M14.5 6.5 9 12l5.5 5.5"],
  "chev-r": ["M9.5 6.5 15 12l-5.5 5.5"],
  download: ["M12 4.5V15", "M7.5 11l4.5 4.5L16.5 11", "M5 19.5h14"],
  search: ["m15.9 15.9 5.1 5.1", "M10.6 17.2a6.6 6.6 0 1 1 0-13.2 6.6 6.6 0 0 1 0 13.2Z"],
  trash: [
    "M4.5 6.5h15",
    "M9 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v1.5",
    "m6.5 6.5.9 12.6a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12.6",
    "M10 10.5v6",
    "M14 10.5v6",
  ],
} satisfies Record<string, string[]>;

export type IconName = keyof typeof PATHS;

const SVG_NS = "http://www.w3.org/2000/svg";

export function icon(name: IconName, cls = "ic"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", `icon ${cls}`);
  svg.setAttribute("aria-hidden", "true");
  for (const d of PATHS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

const KIND_ICON: Record<FileKind | "dir", IconName> = {
  dir: "folder",
  text: "file-lines",
  code: "code",
  pdf: "file-lines",
  sheet: "grid",
  doc: "file-lines",
  image: "image",
  media: "play",
  other: "file",
};

/** Colored file-type icon for table rows; color comes from `.icon-<kind>`. */
export function kindIcon(kind: FileKind | "dir"): SVGSVGElement {
  return icon(KIND_ICON[kind], `fic icon-${kind}`);
}
