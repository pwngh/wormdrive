// Wire protocol: constants and message shapes shared by sender, receiver,
// and (informally) the signaling relay. The signaling server never inspects
// payloads beyond routing fields, and never sees tokens or file bytes.

export const WS_PATH = "/ws";

/** Data-channel chunk size. 64 KiB is safely under every browser's
 *  SCTP message limit and keeps progress granular. */
export const CHUNK_SIZE = 64 * 1024;

/** Backpressure: pause sending above HIGH, resume below LOW. */
export const BUFFER_HIGH = 4 * 1024 * 1024;
export const BUFFER_LOW = 1 * 1024 * 1024;

/** Text previews are capped so a giant log can't lock the tab. */
export const TEXT_PREVIEW_CAP = 1.5 * 1024 * 1024;

/** Max files in a share. The sender caps staging here; the receiver rejects
 *  any manifest larger. Both must agree or honest large folders disconnect. */
export const MAX_MANIFEST_ENTRIES = 5000;

/** STUN only by default. Behind symmetric NAT on both ends you would add a
 *  TURN server here — see README "Networking". */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

// ---------------------------------------------------------------------------
// Permission model
// ---------------------------------------------------------------------------

export type Level = "view" | "download" | "manage";
export const LEVELS: readonly Level[] = ["view", "download", "manage"] as const;

export const LEVEL_LABEL: Record<Level, string> = {
  view: "Viewer",
  download: "Downloader",
  manage: "Manager",
};

export const LEVEL_BLURB: Record<Level, string> = {
  view: "browse + preview only",
  download: "browse, preview + download",
  manage: "everything + destroy the share",
};

export function levelAllows(level: Level, action: "download" | "destroy"): boolean {
  switch (action) {
    case "download":
      return level === "download" || level === "manage";
    case "destroy":
      return level === "manage";
  }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export type FileKind =
  | "text"
  | "code"
  | "pdf"
  | "sheet"
  | "doc"
  | "image"
  | "media"
  | "other";

export interface FileEntry {
  /** Relative path inside the share, '/'-separated, no leading slash. */
  path: string;
  size: number;
  kind: FileKind;
}

export const PREVIEWABLE: ReadonlySet<FileKind> = new Set([
  "text",
  "code",
  "pdf",
  "sheet",
  "doc",
  "image",
  "media",
]);

// ---------------------------------------------------------------------------
// Signaling messages (browser <-> relay). The relay only routes; `data` for
// "signal" is opaque to it.
// ---------------------------------------------------------------------------

export type ClientToServer =
  | { t: "create"; shareId: string }
  | { t: "join"; shareId: string }
  | { t: "signal"; to: string; data: SignalData }
  | { t: "close" };

export type ServerToClient =
  | { t: "created" }
  | { t: "joined"; peerId: string }
  | { t: "peer"; peerId: string }
  | { t: "signal"; from: string; data: SignalData }
  | { t: "peer-gone"; peerId: string }
  | { t: "gone" }
  | { t: "error"; reason: string };

export interface SignalData {
  desc?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit | null;
}

// ---------------------------------------------------------------------------
// Data-channel messages (receiver <-> sender, end to end over DTLS).
// Control frames are JSON strings; file bytes are raw ArrayBuffers that
// arrive, in order, between `file-head` and `file-eof`.
// ---------------------------------------------------------------------------

export type ReceiverToSender =
  | { t: "hello"; token: string }
  | { t: "get"; id: number; path: string; intent: "preview" | "download" }
  | { t: "destroy" };

export type SenderToReceiver =
  | { t: "grant"; level: Level; name: string; manifest: FileEntry[] }
  | { t: "deny"; reason: string }
  | { t: "manifest"; manifest: FileEntry[] }
  | { t: "file-head"; id: number; path: string; size: number; mime: string }
  | { t: "file-eof"; id: number }
  | { t: "file-err"; id: number; reason: string }
  | { t: "destroyed" };
