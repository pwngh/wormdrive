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

// Permission model + the wire-manifest trust boundary. Run via
// `node --experimental-strip-types --test` (see package.json "test:unit").
import test from "node:test";
import assert from "node:assert/strict";

import {
  levelAllows,
  sanitizeManifest,
  permissionDenial,
  validFileHeadSize,
  creditExhausted,
  FLOW_WINDOW,
  PREVIEWABLE,
  FILE_KINDS,
} from "../src/protocol.ts";

const NUL = String.fromCharCode(0);
// A known-valid manifest entry; spread `over` to mutate exactly one field.
// Lets each rejection test isolate the single property under test against an
// otherwise-clean baseline, so a failure can only mean that property was (mis)handled.
const entry = (over = {}) => ({ path: "a.txt", size: 1, kind: "text", ...over });

test("levelAllows: download is gated to download/manage", () => {
  assert.equal(levelAllows("view", "download"), false);
  assert.equal(levelAllows("download", "download"), true);
  assert.equal(levelAllows("manage", "download"), true);
});

test("levelAllows: destroy is manage-only", () => {
  assert.equal(levelAllows("view", "destroy"), false);
  assert.equal(levelAllows("download", "destroy"), false);
  assert.equal(levelAllows("manage", "destroy"), true);
});

test("PREVIEWABLE is every kind except 'other'", () => {
  for (const k of FILE_KINDS) assert.equal(PREVIEWABLE.has(k), k !== "other");
});

test("sanitizeManifest: passes a clean manifest through unchanged", () => {
  const clean = sanitizeManifest([entry(), entry({ path: "dir/b.pdf", kind: "pdf", size: 0 })]);
  assert.deepEqual(clean, [
    { path: "a.txt", size: 1, kind: "text" },
    { path: "dir/b.pdf", size: 0, kind: "pdf" },
  ]);
});

test("sanitizeManifest: rejects non-arrays", () => {
  for (const bad of [null, undefined, {}, "x", 7]) assert.equal(sanitizeManifest(bad), null);
});

test("sanitizeManifest: rejects traversal, absolute, and empty segments", () => {
  for (const path of ["../etc/passwd", "a/../b", "a//b", "/abs", "trailing/", ""]) {
    assert.equal(sanitizeManifest([entry({ path })]), null, path);
  }
});

test("sanitizeManifest: rejects backslashes and control bytes (zip-slip surface)", () => {
  // Streamed into a zip, a backslash path like "a\\..\\evil" has no "/" so the
  // segment check misses it — it must be rejected here, along with control bytes.
  for (const path of ["a\\..\\evil", "C:\\Windows\\x", "a\\b", `a${NUL}b`, "tab\tname", "del\x7fname"]) {
    assert.equal(sanitizeManifest([entry({ path })]), null, JSON.stringify(path));
  }
});

test("sanitizeManifest: rejects NUL and over-long paths, accepts the boundary", () => {
  assert.equal(sanitizeManifest([entry({ path: `a${NUL}b` })]), null);
  assert.equal(sanitizeManifest([entry({ path: "a".repeat(1025) })]), null);
  assert.notEqual(sanitizeManifest([entry({ path: "a".repeat(1024) })]), null);
});

test("sanitizeManifest: rejects bad sizes and unknown kinds", () => {
  assert.equal(sanitizeManifest([entry({ size: -1 })]), null);
  assert.equal(sanitizeManifest([entry({ size: Infinity })]), null);
  assert.equal(sanitizeManifest([entry({ size: Number.NaN })]), null);
  assert.equal(sanitizeManifest([entry({ kind: "exe" })]), null);
});

test("sanitizeManifest: enforces the entry-count cap", () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => entry({ path: `f${i}.txt` }));
  assert.equal(sanitizeManifest(mk(5000))?.length, 5000);
  assert.equal(sanitizeManifest(mk(5001)), null);
});

test("sanitizeManifest: drops attacker-supplied extra properties", () => {
  const clean = sanitizeManifest([{ path: "a.txt", size: 1, kind: "text", evil: "x" }]);
  assert.deepEqual(clean, [{ path: "a.txt", size: 1, kind: "text" }]);
});

test("permissionDenial: any level may preview a previewable kind", () => {
  assert.equal(permissionDenial("view", "text", "preview"), null);
  assert.equal(permissionDenial("view", "image", "preview"), null);
});

test("permissionDenial: view cannot download, even a previewable kind", () => {
  assert.equal(permissionDenial("view", "text", "download"), "This link is preview-only.");
});

test("permissionDenial: view cannot open a non-previewable kind", () => {
  assert.equal(permissionDenial("view", "other", "preview"), "This link can only open previewable files.");
});

test("permissionDenial: download and manage may download any kind", () => {
  assert.equal(permissionDenial("download", "other", "download"), null);
  assert.equal(permissionDenial("manage", "other", "download"), null);
});

test("validFileHeadSize: accepts 0..manifestSize, rejects over / negative / non-finite", () => {
  assert.equal(validFileHeadSize(0, 10), true);
  assert.equal(validFileHeadSize(10, 10), true);
  assert.equal(validFileHeadSize(11, 10), false);
  assert.equal(validFileHeadSize(-1, 10), false);
  assert.equal(validFileHeadSize(Number.NaN, 10), false);
  assert.equal(validFileHeadSize(Number.POSITIVE_INFINITY, 10), false);
});

test("creditExhausted: makes the sender wait once a full window is unacked", () => {
  assert.equal(creditExhausted(0, 0), false);
  assert.equal(creditExhausted(FLOW_WINDOW - 1, 0), false, "just under a window: keep sending");
  assert.equal(creditExhausted(FLOW_WINDOW, 0), true, "exactly a window outstanding: wait");
  assert.equal(creditExhausted(FLOW_WINDOW + 100, 100), true, "a full window outstanding: wait");
  assert.equal(creditExhausted(FLOW_WINDOW + 100, 200), false, "an ack opened room: resume");
  assert.equal(creditExhausted(0, 100), false, "a bogus over-ack (acked > sent) only frees credit, never blocks");
});
