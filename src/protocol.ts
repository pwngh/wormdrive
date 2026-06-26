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

// Wire protocol: constants and message shapes shared by sender, receiver,
// and (informally) the signaling relay. The signaling server never inspects
// payloads beyond routing fields, and never sees tokens or file bytes.

/** Relay WebSocket path. Shared so the client connects exactly where the
 *  signaling server listens — a mismatch fails silently as a 404 upgrade. */
export const WS_PATH = "/ws";

/** Data-channel chunk size. 64 KiB is safely under every browser's
 *  SCTP message limit and keeps progress granular. */
export const CHUNK_SIZE = 64 * 1024;

/** Backpressure: pause sending above HIGH, resume below LOW. */
export const BUFFER_HIGH = 4 * 1024 * 1024;
export const BUFFER_LOW = 1 * 1024 * 1024;

/** Application-level flow control for downloads. The transport acknowledges bytes
 *  when they reach the receiving tab, not when they reach its disk — so a download
 *  streamed to a slow disk would let chunks pile up in the tab's memory with no way
 *  to slow the sender. Fix: the receiver acks the bytes it has actually consumed
 *  (every ACK_INTERVAL), and the sender runs at most FLOW_WINDOW ahead of those
 *  acks, which bounds the receiver's in-flight memory to roughly one window.
 *  FLOW_STALL_MS gives up on a receiver that stops acking entirely (a wedged disk),
 *  so a transfer can't pin the channel open forever. */
export const FLOW_WINDOW = 8 * 1024 * 1024;
export const ACK_INTERVAL = 1 * 1024 * 1024;
export const FLOW_STALL_MS = 30_000;

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

/** A link's privilege level. The string is what travels on the wire in a
 *  `grant`, so renaming a variant is a protocol break, not a refactor. */
export type Level = "view" | "download" | "manage";

/** The levels in ascending privilege order. Ordering is load-bearing: the UI
 *  renders the picker in this order and code may compare by index, so "view"
 *  must stay least-privileged and "manage" most. */
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

/** Whether a link `level` may perform a privileged `action`. The trust boundary
 *  is the sender's browser — the receiver UI uses this only to hide controls;
 *  the sender re-checks before serving bytes or destroying. Previewing isn't
 *  gated here (every level may preview previewable files). */
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

/** Every preview kind in one place: the FileKind type, the previewable set,
 *  and the wire-validation allow-list all derive from this. "other" = no
 *  inline viewer. */
export const FILE_KINDS = [
  "text", "code", "pdf", "sheet", "doc", "image", "media", "other",
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** One manifest row. Deliberately minimal — only what the receiver needs to
 *  list and gate a file without the bytes — so the manifest stays cheap to send
 *  for a large folder. `kind` is the sender's classification, re-validated on
 *  arrival; never trust it blindly (see sanitizeManifest). */
export interface FileEntry {
  /** Relative path inside the share, '/'-separated, no leading slash. */
  path: string;
  size: number;
  kind: FileKind;
}

/** Kinds with an inline viewer — everything except "other". */
export const PREVIEWABLE: ReadonlySet<FileKind> = new Set(
  FILE_KINDS.filter((k) => k !== "other"),
);

const MAX_PATH_LENGTH = 1024;
const KNOWN_KINDS: ReadonlySet<string> = new Set(FILE_KINDS);

/** Validate an untrusted manifest from the sender; null = protocol violation.
 *  This is the sole trust boundary on the wire manifest before the receiver
 *  renders it: it bounds the entry count and, per entry, the path shape (no
 *  empty or ".." segments, no backslashes or control bytes, length-capped), the
 *  size, and the kind. */
export function sanitizeManifest(value: unknown): FileEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_MANIFEST_ENTRIES) return null;
  const out: FileEntry[] = [];
  for (const entry of value as FileEntry[]) {
    if (
      typeof entry?.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.length > MAX_PATH_LENGTH ||
      // Reject empty segments (leading/trailing/double slash) and "..".
      entry.path.split("/").some((seg) => seg === "" || seg === "..") ||
      // Backslashes and control bytes (NUL included). A receiver that streams the
      // manifest into a zip would otherwise let a path like "a\\..\\evil" — no "/",
      // so the segment check above misses it — escape the extraction directory on
      // Windows (zip-slip); control bytes also corrupt names and the save dialog.
      entry.path.includes("\\") ||
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1f\x7f]/.test(entry.path) ||
      !Number.isFinite(entry.size) ||
      entry.size < 0 ||
      !KNOWN_KINDS.has(entry.kind)
    ) {
      return null;
    }
    out.push({ path: entry.path, size: entry.size, kind: entry.kind });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Request policy — the sender's authoritative gates, kept here (pure) so they're
// testable without a browser; the sender/receiver handlers delegate and stay
// thin, so the wiring is obvious by inspection. See test/protocol.test.ts.
// ---------------------------------------------------------------------------

/** Why a granted peer's file request must be refused, or null if it's allowed.
 *  Downloading needs download/manage; a view link may only fetch previewable
 *  kinds. Returns the user-facing reason so the handler forwards it as a file-err.
 *  (Previewing a previewable file is allowed at every level by design.) */
export function permissionDenial(
  level: Level,
  kind: FileKind,
  intent: "preview" | "download",
): string | null {
  if (intent === "download" && !levelAllows(level, "download")) {
    return "This link is preview-only.";
  }
  if (level === "view" && !PREVIEWABLE.has(kind)) {
    return "This link can only open previewable files.";
  }
  return null;
}

/** A file-head's declared size is attacker-controlled and gates how much the
 *  receiver buffers, so it must be finite, non-negative, and no larger than the
 *  size the sanitized manifest already published for that path — otherwise a tiny
 *  manifest entry could stream gigabytes and OOM the receiving tab. */
export function validFileHeadSize(size: number, manifestSize: number): boolean {
  return Number.isFinite(size) && size >= 0 && size <= manifestSize;
}

/** Sender flow-control gate: true once the sender has run a full FLOW_WINDOW ahead
 *  of the bytes the receiver reports having consumed, so it must wait for the next
 *  ack before sending more. This is what keeps a slow receiver disk from inflating
 *  the receiver's in-flight memory during a streamed download. */
export function creditExhausted(sent: number, acked: number): boolean {
  return sent - acked >= FLOW_WINDOW;
}

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

/** One WebRTC handshake message, opaque to the relay. Both fields are optional
 *  because a frame carries exactly one of them: `desc` for an offer/answer,
 *  `candidate` for a trickled ICE candidate (null is the spec's end-of-candidates
 *  marker). The relay forwards the whole object without looking inside. */
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
  // `flow` advertises that this receiver speaks the ack-based flow control below.
  // An older receiver omits it; the sender then streams without the credit gate
  // (its old behavior), so the two stay compatible across a deploy.
  | { t: "hello"; token: string; flow?: boolean }
  | { t: "get"; id: number; path: string; intent: "preview" | "download" }
  // Cumulative bytes the receiver has consumed (written/buffered) for transfer
  // `id` — the sender's credit signal. See creditExhausted / FLOW_WINDOW.
  | { t: "ack"; id: number; bytes: number }
  | { t: "destroy" };

export type SenderToReceiver =
  | { t: "grant"; level: Level; name: string; manifest: FileEntry[] }
  | { t: "deny"; reason: string }
  | { t: "manifest"; manifest: FileEntry[] }
  | { t: "file-head"; id: number; path: string; size: number; mime: string }
  | { t: "file-eof"; id: number }
  | { t: "file-err"; id: number; reason: string }
  | { t: "destroyed" };
