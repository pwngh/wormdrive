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
 * WebRTC plumbing: offer/answer wiring over the signaling relay, ICE
 * candidate queueing, and backpressure-aware sends on the data channel.
 *
 * The relay only ever carries SDP and ICE; the bulk transfer rides the
 * peer-to-peer data channel and never touches the server. This module is
 * the only place that talks to 'RTCPeerConnection', so the sender/receiver
 * layers above stay free of browser RTC quirks (perfect-negotiation timing,
 * candidates arriving before the description, buffer backpressure).
 */

import { BUFFER_HIGH, BUFFER_LOW, ICE_SERVERS, type SignalData } from "./protocol";
import type { Signal } from "./signaling";

export interface Peer {
  /** Resolves once the data channel is open. */
  channel: Promise<RTCDataChannel>;
  /** Feed signaling payloads addressed to this peer. */
  handleSignal: (data: SignalData) => void;
  close: () => void;
}

// Relay each locally gathered candidate to the peer. A null 'event.candidate'
// signals end-of-candidates; we forward it as an explicit 'null' so the far
// side knows gathering is done rather than silently dropping the event.
function wireIce(pc: RTCPeerConnection, signal: Signal, to: string): void {
  pc.onicecandidate = (event) => {
    signal.send({ t: "signal", to, data: { candidate: event.candidate?.toJSON() ?? null } });
  };
}

// Apply one inbound signaling payload — either a remote description or a single
// ICE candidate. Candidates can arrive before the description that gives them a
// transport to attach to, so we buffer any that show up early and flush them
// once 'setRemoteDescription' lands. 'addIceCandidate' failures are swallowed:
// a single rejected candidate is non-fatal, ICE keeps trying the rest.
async function applySignal(
  pc: RTCPeerConnection,
  pending: RTCIceCandidateInit[],
  data: SignalData,
): Promise<void> {
  if (data.desc) {
    // The relay forwards SignalData opaquely, so a malformed/hostile `desc`
    // can make setRemoteDescription reject. Swallow it (as we already do for
    // addIceCandidate) so a fire-and-forget caller can't leak an unhandled
    // rejection; bail before flushing candidates against a description that
    // never applied.
    try {
      await pc.setRemoteDescription(data.desc);
    } catch {
      return;
    }
    // Flush candidates that raced ahead of the description.
    for (const candidate of pending.splice(0)) {
      await pc.addIceCandidate(candidate).catch(() => undefined);
    }
  } else if (data.candidate !== undefined) {
    if (data.candidate === null) return; // end-of-candidates
    if (pc.remoteDescription) {
      await pc.addIceCandidate(data.candidate).catch(() => undefined);
    } else {
      // No remote description yet — hold the candidate for the flush above.
      pending.push(data.candidate);
    }
  }
}

/**
 * Sender side: creates the connection and the data channel, then offers.
 *
 * The sender is the offerer because it owns the channel — only the side that
 * calls 'createDataChannel' gets a usable 'RTCDataChannel' handle directly; the
 * receiver has to wait for 'ondatachannel'. We rely on 'onnegotiationneeded'
 * rather than offering eagerly so the offer fires after the channel is wired,
 * which keeps a single clean negotiation cycle.
 */
export function offerPeer(signal: Signal, peerId: string): Peer {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const pendingIce: RTCIceCandidateInit[] = [];
  wireIce(pc, signal, peerId);

  const dc = pc.createDataChannel("wormdrive", { ordered: true });
  dc.binaryType = "arraybuffer";
  dc.bufferedAmountLowThreshold = BUFFER_LOW;

  const channel = new Promise<RTCDataChannel>((resolve, reject) => {
    dc.onopen = () => resolve(dc);
    dc.onerror = () => reject(new Error("data channel failed"));
  });

  // Parameterless 'setLocalDescription()' lets the browser build the offer for
  // us (perfect-negotiation style), avoiding a hand-rolled createOffer/setLocal
  // dance. A throw here means the connection was already torn down, so swallow.
  pc.onnegotiationneeded = async () => {
    try {
      await pc.setLocalDescription();
      const desc = pc.localDescription;
      if (desc) signal.send({ t: "signal", to: peerId, data: { desc: desc.toJSON() } });
    } catch {
      // connection is torn down elsewhere
    }
  };

  return {
    channel,
    handleSignal: (data) => {
      void applySignal(pc, pendingIce, data);
    },
    close: () => {
      // Detach 'onopen' first so a late open event can't resolve 'channel'
      // after we've decided to close — callers must not get a dead channel.
      dc.onopen = null;
      try {
        dc.close();
      } catch {
        /* already closed */
      }
      pc.close();
    },
  };
}

/**
 * Receiver side: answers the sender's offer, waits for its channel.
 *
 * The receiver never calls 'createDataChannel'; it adopts the one the sender
 * opened via 'ondatachannel'. The channel may already be open by the time that
 * fires, so we resolve immediately in that case and only attach 'onopen'
 * otherwise — attaching unconditionally would miss an already-fired open and
 * hang the 'channel' promise forever.
 */
export function answerPeer(signal: Signal, hostId: string): Peer {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const pendingIce: RTCIceCandidateInit[] = [];
  wireIce(pc, signal, hostId);

  const channel = new Promise<RTCDataChannel>((resolve, reject) => {
    pc.ondatachannel = (event) => {
      const dc = event.channel;
      dc.binaryType = "arraybuffer";
      dc.bufferedAmountLowThreshold = BUFFER_LOW;
      if (dc.readyState === "open") resolve(dc);
      else {
        dc.onopen = () => resolve(dc);
        dc.onerror = () => reject(new Error("data channel failed"));
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") reject(new Error("connection failed"));
    };
  });

  // Apply the inbound payload, then — only when it was an offer — generate and
  // relay our answer. Bare ICE payloads also flow through here but must not
  // trigger an answer, hence the 'type === "offer"' guard.
  const handleSignal = async (data: SignalData) => {
    await applySignal(pc, pendingIce, data);
    if (data.desc?.type === "offer") {
      try {
        await pc.setLocalDescription();
        const local = pc.localDescription;
        if (local) signal.send({ t: "signal", to: hostId, data: { desc: local.toJSON() } });
      } catch {
        /* torn down or invalid remote offer */
      }
    }
  };

  return {
    channel,
    handleSignal: (data) => {
      void handleSignal(data);
    },
    close: () => pc.close(),
  };
}

/**
 * Send respecting the channel's buffer; resolves when the frame is queued.
 *
 * Without this gate a fast producer floods 'dc.send' faster than the network
 * drains it, ballooning the send buffer and (in some browsers) tearing the
 * channel down. We block once 'bufferedAmount' crosses BUFFER_HIGH and resume
 * on 'bufferedamountlow' (fired at BUFFER_LOW), turning the channel's buffer
 * into a flow-control valve. The post-wait 'readyState' recheck guards against
 * the channel closing while we were parked.
 */
export async function sendWithBackpressure(
  dc: RTCDataChannel,
  payload: ArrayBuffer,
): Promise<void> {
  if (dc.readyState !== "open") throw new Error("channel closed");
  if (dc.bufferedAmount > BUFFER_HIGH) {
    await new Promise<void>((resolve, reject) => {
      const onLow = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("channel closed"));
      };
      const cleanup = () => {
        dc.removeEventListener("bufferedamountlow", onLow);
        dc.removeEventListener("close", onClose);
        dc.removeEventListener("error", onClose);
      };
      dc.addEventListener("bufferedamountlow", onLow);
      dc.addEventListener("close", onClose);
      dc.addEventListener("error", onClose);
    });
  }
  if (dc.readyState !== "open") throw new Error("channel closed");
  dc.send(payload);
}
