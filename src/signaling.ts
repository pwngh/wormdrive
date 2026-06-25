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
 * Reconnecting WebSocket client for the signaling relay. Signaling only brokers
 * the WebRTC handshake; once a peer connection is established the data channel
 * carries the transfer directly, so a dropped relay socket never interrupts an
 * in-flight transfer. A host replays its `create` after reconnect so the same
 * shareId is re-registered and outstanding share links keep resolving across a
 * signaling blip. This is the only consumer's view of the relay — message
 * routing is type-driven (see `on`/`dispatch`) so callers never touch the socket.
 */

import { WS_PATH, type ClientToServer, type ServerToClient } from "./protocol";

/**
 * Two separate delays so the first attempt after a clean drop fires sooner
 * (the relay is usually back fast) while repeated failures back off a little
 * to avoid hammering a relay that is genuinely down.
 */
const RECONNECT_DELAY_MS = 1500;
const RECONNECT_RETRY_MS = 2000;

type Handler<T extends ServerToClient["t"]> = (
  msg: Extract<ServerToClient, { t: T }>,
) => void;

/** Thin typed wrapper over the signaling websocket. Works in dev (Vite
 *  proxies /ws) and prod (same origin) without configuration. */
export class Signal {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, (msg: ServerToClient) => void>();
  private closedByUs = false;

  onDisconnect: (() => void) | null = null;
  onReconnect: (() => void) | null = null;
  /** Optional observability hook for otherwise-swallowed failures (a malformed
   *  frame, a reconnect attempt that failed). Wiring it is opt-in; behavior is
   *  unchanged whether or not a consumer sets it. */
  onError: ((where: string, err?: unknown) => void) | null = null;

  /** Sender shares survive a blip in signaling: reconnect + re-create room. */
  private reconnect: (() => ClientToServer) | null = null;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${scheme}://${location.host}${WS_PATH}`);
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        resolve();
      };
      ws.onerror = () => {
        // A socket that errors *before* it ever opened will fire `close` right
        // after and never reach OPEN. Detach onclose so that trailing close
        // can't re-enter handleClose() and schedule a duplicate reconnect timer
        // alongside the one the reconnect path's own .catch already arms.
        // Once the socket has opened we must NOT detach: an abnormal mid-session
        // drop also fires error-then-close, and there handleClose() is the only
        // thing that drives the sender's keepAlive reconnect.
        if (!opened) ws.onclose = null;
        reject(new Error("signaling unreachable"));
      };
      ws.onmessage = (event) => this.dispatch(event.data);
      ws.onclose = () => this.handleClose();
    });
  }

  on<T extends ServerToClient["t"]>(type: T, handler: Handler<T>): void {
    this.handlers.set(type, handler as (msg: ServerToClient) => void);
  }

  send(msg: ClientToServer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Register a message to replay after an automatic reconnect (sender uses
   *  this to re-create its room with the same shareId, keeping links valid). */
  keepAlive(makeMsg: () => ClientToServer): void {
    this.reconnect = makeMsg;
  }

  close(): void {
    this.closedByUs = true;
    this.ws?.close();
  }

  // Route one inbound frame to its registered handler. Parse failures are
  // reported and dropped rather than thrown: a malformed frame from the relay
  // must not tear down the socket and the rest of the session with it.
  private dispatch(raw: unknown): void {
    if (typeof raw !== "string") return;
    let msg: ServerToClient;
    try {
      msg = JSON.parse(raw) as ServerToClient;
    } catch (err) {
      this.onError?.("dispatch:parse", err);
      return;
    }
    // `JSON.parse("null")` / primitives parse fine; guard before reading .t.
    if (!msg || typeof msg !== "object") return;
    this.handlers.get(msg.t)?.(msg);
  }

  // Decide what to do when the socket closes. A close we initiated (`close()`)
  // is terminal and must never reconnect. Receivers leave `reconnect` unset and
  // simply surface the disconnect; only a sender that called `keepAlive` retries,
  // replaying its `create` on success so the room reappears under the same
  // shareId. Each failed attempt re-arms a timer, so retries continue until the
  // relay returns or the caller closes us — `closedByUs` is rechecked inside the
  // loop to abort a retry scheduled just before a deliberate close.
  private handleClose(): void {
    if (this.closedByUs) return;
    this.onDisconnect?.();
    if (!this.reconnect) return;
    const retry = () => {
      if (this.closedByUs) return;
      this.connect()
        .then(() => {
          const replay = this.reconnect;
          if (replay) this.send(replay());
          this.onReconnect?.();
        })
        .catch((err) => {
          this.onError?.("reconnect", err);
          window.setTimeout(retry, RECONNECT_RETRY_MS);
        });
    };
    window.setTimeout(retry, RECONNECT_DELAY_MS);
  }
}
