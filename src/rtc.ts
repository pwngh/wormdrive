// WebRTC plumbing: offer/answer wiring over the signaling relay, ICE
// candidate queueing, and backpressure-aware sends on the data channel.

import { BUFFER_HIGH, BUFFER_LOW, ICE_SERVERS, type SignalData } from "./protocol";
import type { Signal } from "./signaling";

export interface Peer {
  /** Resolves once the data channel is open. */
  channel: Promise<RTCDataChannel>;
  /** Feed signaling payloads addressed to this peer. */
  handleSignal: (data: SignalData) => void;
  close: () => void;
}

function wireIce(pc: RTCPeerConnection, signal: Signal, to: string): void {
  pc.onicecandidate = (event) => {
    signal.send({ t: "signal", to, data: { candidate: event.candidate?.toJSON() ?? null } });
  };
}

async function applySignal(
  pc: RTCPeerConnection,
  pending: RTCIceCandidateInit[],
  data: SignalData,
): Promise<void> {
  if (data.desc) {
    await pc.setRemoteDescription(data.desc);
    // Flush candidates that raced ahead of the description.
    for (const candidate of pending.splice(0)) {
      await pc.addIceCandidate(candidate).catch(() => undefined);
    }
  } else if (data.candidate !== undefined) {
    if (data.candidate === null) return; // end-of-candidates
    if (pc.remoteDescription) {
      await pc.addIceCandidate(data.candidate).catch(() => undefined);
    } else {
      pending.push(data.candidate);
    }
  }
}

/** Sender side: creates the connection and the data channel, then offers. */
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

/** Receiver side: answers the sender's offer, waits for its channel. */
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

  const handleSignal = async (data: SignalData) => {
    await applySignal(pc, pendingIce, data);
    if (data.desc?.type === "offer") {
      await pc.setLocalDescription();
      const local = pc.localDescription;
      if (local) signal.send({ t: "signal", to: hostId, data: { desc: local.toJSON() } });
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

/** Send respecting the channel's buffer; resolves when the frame is queued. */
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
