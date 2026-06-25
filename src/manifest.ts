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
 * File classification and folder-tree derivation. The wire manifest is a
 * flat list of file paths; directories are derived, never transmitted.
 *
 * Keeping the wire format flat means the sender never has to model a tree,
 * and the receiver reconstructs folders on demand (listDir/crumbs) from the
 * paths alone. No directory entries on the wire also means no empty-folder or
 * ordering ambiguity to reconcile between the two sides.
 */

import type { FileEntry, FileKind } from "./protocol";

const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "c", "h", "cpp",
  "hpp", "cc", "cxx", "java", "kt", "kts", "swift", "rb", "php", "cs", "sh",
  "bash", "zsh", "fish", "sql", "html", "htm", "css", "scss", "less", "json",
  "yaml", "yml", "toml", "xml", "ini", "conf", "cfg", "env", "md", "markdown",
  "lua", "r", "scala", "hs", "zig", "dart", "vue", "svelte", "gradle", "proto",
  "graphql", "tf", "ps1", "bat", "asm", "s", "vim", "diff", "patch",
]);

const TEXT_EXT = new Set(["txt", "log", "text", "rst", "adoc", "srt", "nfo"]);
const SHEET_EXT = new Set(["xlsx", "xls", "xlsm", "xlsb", "ods", "csv", "tsv"]);
const DOC_EXT = new Set(["docx"]);
const PDF_EXT = new Set(["pdf"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"]);
const MEDIA_EXT = new Set(["mp4", "webm", "mp3", "wav", "ogg", "m4a", "flac"]);

/** Extension-less files that are clearly text. */
const TEXT_NAMES = new Set([
  "makefile", "dockerfile", "license", "readme", "changelog", "authors",
  "notice", "todo", "gemfile", "rakefile", "procfile", "vagrantfile",
]);

/** Lowercased extension after the last dot, or "" when there isn't one.
 *  Dotfiles (`.env`), extensionless names (`Makefile`), and trailing dots all
 *  return "" — the `dot > 0` guard follows Node's `path.extname` convention. */
export function ext(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Last path segment. No trailing-slash handling — manifest paths never have one. */
export function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Map a path to a preview kind by extension, with a fallback for well-known
 *  extensionless text files (Makefile, Dockerfile, LICENSE…). Unknown → "other".
 *
 *  The kind only drives which viewer the receiver offers; it is advisory, not a
 *  trust boundary. Order matters where extension sets could overlap (e.g. a
 *  format we later add to both CODE_EXT and TEXT_EXT): the first match wins, so
 *  the more specific viewer is preferred over the generic text fallback. */
export function classify(path: string): FileKind {
  const e = ext(path);
  if (PDF_EXT.has(e)) return "pdf";
  if (SHEET_EXT.has(e)) return "sheet";
  if (DOC_EXT.has(e)) return "doc";
  if (IMAGE_EXT.has(e)) return "image";
  if (MEDIA_EXT.has(e)) return "media";
  if (CODE_EXT.has(e)) return "code";
  if (TEXT_EXT.has(e)) return "text";
  if (e === "" && TEXT_NAMES.has(basename(path).toLowerCase())) return "text";
  return "other";
}

/** Map a staged Map<path, File> to the wire manifest, sorted for stable UI. */
export function toManifest(files: ReadonlyMap<string, File>): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const [path, file] of files) {
    entries.push({ path, size: file.size, kind: classify(path) });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

// ---------------------------------------------------------------------------
// Folder navigation over the flat manifest (receiver side)
// ---------------------------------------------------------------------------

/** A folder row synthesized for one listing level. `files`/`size` are rolled up
 *  from every descendant under this directory, not just its direct children, so
 *  the receiver can show aggregate counts without walking the tree itself. */
export interface DirRow {
  type: "dir";
  name: string;
  path: string;
  files: number;
  size: number;
}

/** A leaf row that carries the wire `entry` straight through, so the receiver
 *  keeps the exact path/size/kind it was sent rather than a derived copy. */
export interface FileRow {
  type: "file";
  name: string;
  entry: FileEntry;
}

/** Discriminated on `type` so the UI can switch on dir-vs-file without a
 *  separate flag or instanceof. */
export type Row = DirRow | FileRow;

/** Direct children of `cwd` ("" = root). Directories first, both sorted.
 *
 *  Single pass over the flat manifest: a path with no further slash past the
 *  prefix is a file at this level; otherwise its first segment is a subdirectory
 *  whose counts we accumulate. This avoids precomputing or caching a tree —
 *  cheap enough to recompute per navigation since the manifest is in memory. */
export function listDir(manifest: readonly FileEntry[], cwd: string): Row[] {
  const prefix = cwd === "" ? "" : `${cwd}/`;
  const dirs = new Map<string, DirRow>();
  const files: FileRow[] = [];

  for (const entry of manifest) {
    if (!entry.path.startsWith(prefix)) continue;
    const rest = entry.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      files.push({ type: "file", name: rest, entry });
    } else {
      const name = rest.slice(0, slash);
      const existing = dirs.get(name);
      if (existing) {
        existing.files += 1;
        existing.size += entry.size;
      } else {
        dirs.set(name, { type: "dir", name, path: prefix + name, files: 1, size: entry.size });
      }
    }
  }

  const sortedDirs = [...dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...sortedDirs, ...files];
}

/** ["", "src", "src/viewers"] -> breadcrumb segments with paths.
 *
 *  Always leads with a synthetic "root" crumb (path "") so the receiver can
 *  navigate back to the top level even though "" is never a real path segment. */
export function crumbs(cwd: string): { name: string; path: string }[] {
  const out = [{ name: "root", path: "" }];
  if (cwd === "") return out;
  let acc = "";
  for (const part of cwd.split("/").filter(Boolean)) {
    acc = acc === "" ? part : `${acc}/${part}`;
    out.push({ name: part, path: acc });
  }
  return out;
}
