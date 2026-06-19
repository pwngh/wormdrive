// File classification and folder-tree derivation. The wire manifest is a
// flat list of file paths; directories are derived, never transmitted.

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

export function ext(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

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

export interface DirRow {
  type: "dir";
  name: string;
  path: string;
  files: number;
  size: number;
}

export interface FileRow {
  type: "file";
  name: string;
  entry: FileEntry;
}

export type Row = DirRow | FileRow;

/** Direct children of `cwd` ("" = root). Directories first, both sorted. */
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

/** ["", "src", "src/viewers"] -> breadcrumb segments with paths. */
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
