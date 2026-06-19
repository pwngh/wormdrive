// Entry: routes to sender or receiver based on the share fragment.

import "./styles.css";

import { el } from "./dom";
import { initStarfield } from "./fx/starfield";

import { mountReceiver } from "./receiver";
import { mountSender } from "./sender";

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root element.");
root.classList.add("app"); // layout container styles live on the class

initStarfield();

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

// Pasting a different share link into the same tab: do a clean re-mount.
window.addEventListener("hashchange", () => location.reload());
