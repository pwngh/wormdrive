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
 * File classification + folder-tree derivation, exercised as pure logic over the manifest.
 *
 * These helpers run on both sender and receiver to render the same folder view from the
 * same manifest, so their edge cases (dotfiles, extensionless well-known files, same-named
 * files in different folders, nested size/count aggregation) are pinned here rather than
 * caught later as a UI mismatch between the two sides. No DOM, no network, no I/O: the
 * functions are deterministic over plain manifest rows, which keeps this suite fast and
 * runnable under bare 'node:test'.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ext, basename, classify, listDir, crumbs } from "../src/manifest.ts";

test("ext: extension after the last dot, lowercased", () => {
  assert.equal(ext("a.TXT"), "txt");
  assert.equal(ext("dir/a.tar.gz"), "gz");
  assert.equal(ext("README"), ""); // no dot
  assert.equal(ext(".env"), ""); // dotfile -> no extension
  assert.equal(ext("trailing."), ""); // trailing dot
});

test("basename: last path segment", () => {
  assert.equal(basename("a/b/c.txt"), "c.txt");
  assert.equal(basename("c.txt"), "c.txt");
  assert.equal(basename("a/b/"), "");
});

test("classify: maps extensions to preview kinds", () => {
  assert.equal(classify("x.ts"), "code");
  assert.equal(classify("x.PDF"), "pdf");
  assert.equal(classify("x.csv"), "sheet");
  assert.equal(classify("x.docx"), "doc");
  assert.equal(classify("x.png"), "image");
  assert.equal(classify("x.mp4"), "media");
  assert.equal(classify("x.txt"), "text");
  assert.equal(classify("x.bin"), "other");
});

test("classify: well-known extensionless text files", () => {
  assert.equal(classify("Makefile"), "text");
  assert.equal(classify("path/to/Dockerfile"), "text");
  assert.equal(classify("LICENSE"), "text");
  assert.equal(classify("mystery"), "other");
});

test("listDir: dirs first, both sorted; nested folders aggregate count + size", () => {
  const m = [
    { path: "b.txt", size: 1, kind: "text" as const },
    { path: "a.txt", size: 2, kind: "text" as const },
    { path: "docs/intro.md", size: 3, kind: "text" as const },
    { path: "docs/deep/x.md", size: 4, kind: "text" as const },
  ];
  const rows = listDir(m, "");
  assert.deepEqual(rows.map((r) => r.name), ["docs", "a.txt", "b.txt"]);
  const dir = rows.find((r) => r.type === "dir");
  // The top-level 'docs' row rolls up its whole subtree, not just direct children:
  // 2 files (intro.md + deep/x.md) totalling 7 bytes, so the folder view can show a
  // size/count summary without the receiver descending into every nested directory.
  assert.equal(dir?.type === "dir" && dir.files, 2);
  assert.equal(dir?.type === "dir" && dir.size, 7);
});

test("listDir: same filename in different folders stays distinct", () => {
  const m = [
    { path: "x/readme.md", size: 1, kind: "text" as const },
    { path: "y/readme.md", size: 1, kind: "text" as const },
  ];
  assert.deepEqual(listDir(m, "x").map((r) => r.name), ["readme.md"]);
});

test("crumbs: root and nested trails", () => {
  assert.deepEqual(crumbs(""), [{ name: "root", path: "" }]);
  assert.deepEqual(crumbs("a/b"), [
    { name: "root", path: "" },
    { name: "a", path: "a" },
    { name: "b", path: "a/b" },
  ]);
});
