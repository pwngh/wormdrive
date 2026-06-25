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
 * Unit tests for the pure helpers exported from src/dom.ts.
 *
 * Despite living in the DOM module, fmtSize/randomId/safeEqual/staggerDelay touch no
 * 'document' or 'window', so we exercise them directly under node:test rather than spinning
 * up a browser harness. The only platform surface they need (crypto, btoa) is a global on
 * modern Node, which keeps this suite fast and dependency-free. The cases below pin the
 * boundaries that callers rely on but that aren't obvious from the signatures: unit
 * thresholds, base64url length, constant-time-style equality, and the stagger cap.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { fmtSize, randomId, safeEqual, staggerDelay } from "../src/dom.ts";

test("fmtSize: bytes and unit boundaries", () => {
  assert.equal(fmtSize(0), "0 B");
  assert.equal(fmtSize(1023), "1023 B");
  assert.equal(fmtSize(1024), "1.0 KB");
  assert.equal(fmtSize(1024 * 1024), "1.0 MB");
  assert.equal(fmtSize(1024 ** 3), "1.0 GB");
  assert.equal(fmtSize(1024 ** 4), "1.0 TB");
});

test("fmtSize: drops the decimal at/above 100", () => {
  assert.equal(fmtSize(Math.round(150.7 * 1024)), "151 KB");
  assert.equal(fmtSize(2.5 * 1024 * 1024), "2.5 MB");
});

test("randomId: url-safe alphabet, no padding, expected length", () => {
  const id = randomId(16);
  assert.match(id, /^[A-Za-z0-9_-]+$/); // url-safe, no + / =
  assert.equal(id.length, 22); // 16 bytes -> 22 base64url chars
  // Two fresh ids must differ. Not a strict guarantee, but a collision from 16 random
  // bytes is astronomically unlikely, so a match here means the RNG is broken, not unlucky.
  assert.notEqual(randomId(), randomId());
});

test("safeEqual: equality, length mismatch, single-char difference", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "ab"), false);
  assert.equal(safeEqual("", ""), true);
});

test("staggerDelay: linear, then capped at index 12", () => {
  assert.equal(staggerDelay(0), "0ms");
  assert.equal(staggerDelay(3), "66ms");
  assert.equal(staggerDelay(12), "264ms"); // the cap point: index 12 is the first clamped value (11 is the last linear one)
  assert.equal(staggerDelay(99), "264ms"); // capped: long lists don't drift into multi-second delays
});
