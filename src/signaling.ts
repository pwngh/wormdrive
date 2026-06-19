// Reconnecting WebSocket client for the signaling relay. A host replays its
// `create` after reconnect so share links survive signaling blips;
// established data channels are unaffected by signaling loss.

import { WS_PATH, type ClientToServer, type ServerToClient } from "./protocol";

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

  /** Sender shares survive a blip in signaling: reconnect + re-create room. */
  private reconnect: (() => ClientToServer) | null = null;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${scheme}://${location.host}${WS_PATH}`);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("signaling unreachable"));
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

  private dispatch(raw: unknown): void {
    if (typeof raw !== "string") return;
    let msg: ServerToClient;
    try {
      msg = JSON.parse(raw) as ServerToClient;
    } catch {
      return;
    }
    // `JSON.parse("null")` / primitives parse fine; guard before reading .t.
    if (!msg || typeof msg !== "object") return;
    this.handlers.get(msg.t)?.(msg);
  }

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
        .catch(() => window.setTimeout(retry, 2000));
    };
    window.setTimeout(retry, 1500);
  }
}
