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
 * App entry point. A single bundle serves both roles: the URL fragment alone decides
 * whether this tab is the sender (no fragment) or the receiver (a `#r=…&t=…` share link).
 * Routing lives in the hash so the id and token stay out of HTTP requests, referrers, and
 * server access logs when a link is opened. The token then never leaves the client except
 * peer-to-peer over the DTLS data channel — the relay never sees it. The share id, by
 * contrast, is sent to the signaling server as the room key (it must be, to introduce the
 * two browsers); the privacy boundary that matters is keeping the token off every server.
 *
 * Mount order is deliberate: the card UI goes up first and the WebGL hero is deferred, so a
 * recipient who opens a share link sees the transfer prompt immediately instead of waiting
 * on shader compilation.
 */

import "./styles.css";

import { el } from "./dom";
import { initBlackhole } from "./fx/blackhole";
import { initStarfield } from "./fx/starfield";

import { mountReceiver } from "./receiver";
import { mountSender } from "./sender";

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root element.");
root.classList.add("app"); // layout container styles live on the class

initStarfield(); // ambient drifting field (z-index -2, behind the hole) — cheap, start now

// Defer the heavy black-hole init (getContext + shader compile + RGBA16F alloc)
// until after first paint and an idle slot, so the card mounts instantly instead
// of waiting on WebGL. warpBurst is null-safe before init; the canvas self-sizes
// via its ResizeObserver and centers on the drop target once it exists.
const afterPaint = (fn: () => void): void =>
  void requestAnimationFrame(() => requestAnimationFrame(fn)); // two rAFs == past first paint
const whenIdle = (fn: () => void): void => {
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(fn, { timeout: 600 });
  else setTimeout(fn, 200);
};
afterPaint(() => whenIdle(() => initBlackhole())); // the lensed black hole hero (z-index -1)

// Share links carry routing in the hash so the token never reaches any server.
const params = new URLSearchParams(location.hash.slice(1));
const shareId = params.get("r");
const token = params.get("t");

if (shareId && token) {
  mountReceiver(root, shareId, token);
} else {
  mountSender(root);
}

root.append(
  el("footer", { class: "foot" }, [
    "peer to peer",
    el("span", { class: "sep" }, ["·"]),
    "end-to-end encrypted",
    el("span", { class: "sep" }, ["·"]),
    "nothing stored on any server",
  ]),
);

// Pasting a different share link into the same tab swaps roles (sender <-> receiver) or
// targets a new share id. A full reload is the simplest way to guarantee no peer connection,
// crypto state, or DOM from the previous mount leaks into the new session.
window.addEventListener("hashchange", () => location.reload());
