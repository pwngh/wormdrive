# worm·drive

![license: MIT](https://img.shields.io/badge/license-MIT-f5a524)
![node](https://img.shields.io/badge/node-%E2%89%A520-3dd68c)
![frontend](https://img.shields.io/badge/frontend-zero%20deps-a8c7ff)
![transport](https://img.shields.io/badge/transport-WebRTC%20%2B%20DTLS-f1b0ff)

Peer-to-peer file shares that vanish. Drop in files or a whole folder, get three
links (view / download / manage), and serve them straight from your browser tab —
wormhole-style transfer with a Drive-style folder browser and inline viewers.

Nothing is uploaded anywhere. A tiny signaling server introduces browsers to each
other; after that, file bytes move directly between peers over an encrypted
WebRTC data channel. Close your tab (or hit **Destroy**) and the share is gone.

## Quickstart

Requires Node ≥ 20 and an evergreen browser.

```sh
npm install
npm run dev        # signaling server on :8787 + Vite on :5173
```

Open http://localhost:5173, stage some files, and open a share. Paste one of the
three links into another browser/profile/machine to receive.

**Production:**

```sh
npm run build      # typecheck + bundle to dist/
npm start          # one process: static frontend + signaling on :8787
```

`PORT=9000 npm start` to change the port.

## Deployment

Classic `configure`/`make` (hand-rolled POSIX sh, no autotools). The Makefile
is generated; settings live in one place.

```sh
./configure --host root@<vps-ip>    # capture host/domain/port -> Makefile
make provision                      # once: bootstrap a fresh Debian/Ubuntu VPS
make deploy                         # every release: build, sync, restart, healthcheck
```

`make check` runs the typecheck and the signaling protocol smoke suite;
`make help` lists the rest. Deploys sync to a staging directory and swap it
in with two renames, so the live tree is never half-updated — the displaced
tree is kept, and `make rollback` flips back to it.

DNS is the only manual step: point A/AAAA for `wormdrive.app` at the box and
Caddy fetches the certificate once the records resolve. Share links come out
as `https://wormdrive.app/#r=…&t=…`, and the client derives `wss://` from the
page origin — TLS needs no app config.

The provisioning is tuned for a small VPS (1 core / 1.5 GB): the build never
runs on the server, the remote install is a single dependency (`ws`), Node's
heap is capped at 256 MB inside a 512 MB-fenced unit, a 1 GB swapfile gives
OOM headroom, and journald is capped so logs can't eat the disk. File bytes
never touch the box — it relays a few KB of SDP per connection and serves
static assets, so the smallest tier is plenty.

## Permission levels

Every share mints three independent links. The level is encoded in the link's
secret token and enforced by the **sender's** browser:

| Level | Can do |
|---|---|
| `view` | Browse the folder tree and open inline previews of previewable files. No downloads. |
| `download` | Everything above, plus download any file. |
| `manage` | Everything above, plus remotely destroy the share. |

## Inline viewers

- **Code & text** — syntax highlighting for ~40 languages (highlight.js), large files truncated at 1.5 MB
- **PDF** — rendered in-page (pdf.js), first 20 pages eagerly, rest on demand
- **Spreadsheets** — `.xlsx .xls .csv .tsv .ods` with sheet tabs (SheetJS)
- **Word** — `.docx` via mammoth (legacy binary `.doc` is download-only)
- **Images, audio, video** — native rendering

The explorer is keyboard-first: `/` filters across the whole share, arrows +
Enter navigate, Backspace goes up a folder, and the viewer pages between
files with ←/→. Opens feel instant because the receiver speculatively warms
a blob cache (idle scan of the open folder, hover intent, viewer neighbors) —
small amber dots mark files already in memory. User clicks always jump the
queue ahead of speculation; the wire still carries one transfer at a time.

## Destroying things

- **Destroy button** (sender) — wipes the staged files, notifies every connected peer, closes the share.
- **Per-file ✕** (sender) — removes one file; everyone's listing updates live, and any in-flight transfer of that file is aborted.
- **Manage link** — a manager peer can trigger the same full destroy remotely.
- **Auto-destruct timer** — optional 5 min – 6 h countdown, enforced at access
  time as well as by timer, so a throttled background tab can't outlive its deadline.
- **Inherent** — the share lives in the sender's tab. Close the tab and it's over.

## Security & threat model

- File bytes travel only on a WebRTC data channel, which is always DTLS-encrypted
  end-to-end. The signaling server sees share IDs and SDP/ICE metadata — never
  tokens, file names, or file contents.
- Tokens are ~128-bit random values carried in the URL **hash** (`#r=…&t=…`), so
  they never appear in server request logs. The sender verifies them with a
  constant-time compare.
- Honest caveats:
  - **`view` is soft enforcement for previews.** A previewing browser necessarily
    receives the file bytes to render them; a technical user could extract them.
    `view` reliably prevents casual downloads, not determined exfiltration.
  - A **malicious signaling server** could in principle man-in-the-middle the SDP
    exchange. Run your own (it's ~220 lines) if that's in your threat model.
  - **Downloads are memory-bound** — the whole file is assembled in the receiving
    tab before saving. Fine for documents and media; multi-GB files will hurt.
  - Anyone holding a link has that link's power until you destroy the share.

### Hardening

Both ends of the data channel treat the other as untrusted. The receiver
shape-validates every sender message, sanitizes manifests (entry count, path
format and length, sizes, kinds), and hard-caps transfer buffering at the
declared file size — a lying sender is disconnected, not tolerated. The
sender type- and length-checks tokens and paths, drops oversized control
frames, and re-checks the destruct deadline on every request. The relay
enforces one room per socket, caps peers per room at 32, allow-lists HTTP
methods, rejects malformed percent-encoding, uses a separator-exact path
guard, and serves hashed assets immutable with `nosniff`/frame-deny/
no-referrer headers.

## Networking

Connections use a public STUN server for NAT traversal. Most home/office NATs
work out of the box. If both ends are behind strict/symmetric NAT, you'll need a
TURN relay: add it to `ICE_SERVERS` in `src/protocol.ts`, e.g.

```ts
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "turn:turn.example.com:3478", username: "u", credential: "secret" },
];
```

(Note: with a classic TURN relay the encrypted packets transit the relay, but
DTLS keeps the relay unable to read them.)

## Layout

```
server/signaling.mjs      WS relay + static server (plain Node, one dep: ws)
src/protocol.ts           shared constants + every message shape on the wire
src/sender.ts             stage files, mint links, serve peers, destroy
src/receiver.ts           join, browse, preview, download
src/rtc.ts                WebRTC plumbing + backpressure
src/signaling.ts          reconnecting WS client
src/viewers/*             per-format preview renderers
src/manifest.ts           file classification + folder tree
configure + Makefile.in   parameter capture + ops targets (POSIX)
deploy/provision.sh       one-shot VPS bootstrap, streamed over ssh
scripts/smoke-signaling.mjs   hermetic protocol smoke suite (9 assertions)
```

## Portability notes

- Frontend is strict TypeScript with zero framework dependencies; Vite is the
  only build tool.
- Server is plain Node ESM with a single dependency (`ws`); no bundling needed.
- No platform-specific shell usage anywhere (dev script spawns `process.execPath`
  directly), so Windows/macOS/Linux all work.

## License

[MIT](LICENSE) © Preston Neal
