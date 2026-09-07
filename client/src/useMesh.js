import { useRef, useState } from 'react';
import { ICE_SERVERS } from './lib';

/**
 * WebRTC mesh: one RTCPeerConnection per remote participant.
 *
 * Negotiation uses the "perfect negotiation" pattern (MDN): both sides may
 * create offers whenever tracks change; when offers collide, the "polite"
 * peer (decided by comparing socket ids, so both sides agree) rolls back and
 * accepts, the "impolite" peer ignores the incoming offer. This removes all
 * initiator bookkeeping and makes renegotiation (screen share, camera added
 * mid-call) safe even when two people change tracks at the same instant.
 *
 * ICE candidates that arrive before the remote description are queued and
 * flushed afterwards — without this, joins are flaky on slow networks.
 */
export default function useMesh(socket, initialStream) {
  const [peers, setPeers] = useState({}); // id -> {name, stream, micOn, camOn, hand, sharing}
  const entriesRef = useRef({}); // id -> {pc, polite, makingOffer, ignoreOffer, queued, videoSender, stream}
  const localStreamRef = useRef(initialStream);

  const patch = (id, p) =>
    setPeers((prev) => ({
      ...prev,
      [id]: {
        name: 'guest', micOn: true, camOn: true, hand: false, sharing: false, stream: null,
        ...(prev[id] || {}),
        ...p
      }
    }));

  const ensure = (id, name) => {
    let entry = entriesRef.current[id];
    if (entry) {
      if (name) patch(id, { name });
      return entry;
    }
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    entry = {
      pc,
      polite: socket.id < id, // opposite on the other side — both agree
      makingOffer: false,
      ignoreOffer: false,
      queued: [],
      videoSender: null,
      stream: new MediaStream()
    };
    entriesRef.current[id] = entry;

    const ls = localStreamRef.current;
    if (ls && ls.getTracks().length) {
      ls.getTracks().forEach((t) => {
        const sender = pc.addTrack(t, ls);
        if (t.kind === 'video') entry.videoSender = sender;
      });
      if (!ls.getVideoTracks().length) pc.addTransceiver('video', { direction: 'recvonly' });
    } else {
      // No devices at all: still negotiate so we can RECEIVE everyone else.
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.addTransceiver('video', { direction: 'recvonly' });
    }

    pc.ontrack = (e) => {
      // Accumulate tracks into one persistent stream per peer; the <video>
      // element attached to it picks up added tracks automatically.
      entry.stream.addTrack(e.track);
      patch(id, { stream: entry.stream });
    };
    pc.onicecandidate = (e) =>
      e.candidate && socket.emit('rtc-candidate', { to: id, candidate: e.candidate });
    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        socket.emit('rtc-description', { to: id, description: pc.localDescription });
      } catch (err) {
        console.error('negotiation failed:', err);
      } finally {
        entry.makingOffer = false;
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce();
    };

    patch(id, name ? { name } : {});
    return entry;
  };

  const onDescription = async (id, description) => {
    const entry = ensure(id);
    const { pc } = entry;
    const collision =
      description.type === 'offer' && (entry.makingOffer || pc.signalingState !== 'stable');
    entry.ignoreOffer = !entry.polite && collision;
    if (entry.ignoreOffer) return;
    try {
      await pc.setRemoteDescription(description); // implicit rollback for polite peers
      while (entry.queued.length) {
        try { await pc.addIceCandidate(entry.queued.shift()); } catch { /* stale */ }
      }
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        socket.emit('rtc-description', { to: id, description: pc.localDescription });
      }
    } catch (err) {
      console.error('description failed:', err);
    }
  };

  const onCandidate = async (id, candidate) => {
    const entry = ensure(id);
    if (!entry.pc.remoteDescription) {
      entry.queued.push(candidate);
      return;
    }
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch (err) {
      if (!entry.ignoreOffer) console.error('candidate failed:', err);
    }
  };

  const setPeerState = (id, s) => {
    if (entriesRef.current[id]) patch(id, s);
  };

  const remove = (id) => {
    entriesRef.current[id]?.pc.close();
    delete entriesRef.current[id];
    setPeers((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
  };

  const closeAll = () => {
    Object.values(entriesRef.current).forEach((e) => e.pc.close());
    entriesRef.current = {};
    setPeers({});
  };

  /**
   * Swap the outgoing video track for everyone (camera <-> screen share,
   * or adding a camera mid-call). Passing null blanks outgoing video
   * without renegotiating. If a connection never had a video sender
   * (audio-only join), addTrack triggers renegotiation — which perfect
   * negotiation handles.
   */
  const replaceVideo = (track, stream) => {
    Object.values(entriesRef.current).forEach((entry) => {
      if (entry.videoSender) entry.videoSender.replaceTrack(track || null);
      else if (track) entry.videoSender = entry.pc.addTrack(track, stream);
    });
  };

  return {
    peers, ensure, onDescription, onCandidate,
    setPeerState, remove, closeAll, replaceVideo, localStreamRef
  };
}
