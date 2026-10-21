import { useCallback, useEffect, useRef, useState } from 'react';
import usePhone, { useKeyboardInset } from './usePhone';
import useCaptions, { LANGS, speechSupported } from './useCaptions';
import { socket, initials, gradFor, STUN_ONLY, fetchIceServers } from './lib';
import useMesh from './useMesh';
import Notes, { useNotesDoc, appendLine, notesText } from './collab/Notes';

const Icon = {
  mic: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round"><path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/></svg>,
  cam: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>,
  share: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>,
  grid: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  hand: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-3 0-5-1.5-6.5-3.8L3 14.7a2 2 0 0 1 3.4-2L8 15"/></svg>,
  chat: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
  people: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  phone: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92V20a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3.09a2 2 0 0 1 2 1.72c.12.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 10"/></svg>,
  more: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round"><circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/></svg>,
  send: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>,
  copy: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>,
  notes: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>,
  poll: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>,
  save: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>,
  shareOut: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13"/></svg>
};

const REACTIONS = ['👍', '🎉', '❤️', '😂', '👏', '😮', '🔥'];

/* A poll card: live tally, one tap to vote (last vote wins), the asker closes it. */
function PollCard({ poll, mine, isAsker, onVote, onClose, compact }) {
  const max = Math.max(1, ...poll.counts);
  return (
    <div className={`poll ${poll.open ? '' : 'closed'} ${compact ? 'compact' : ''}`}>
      <div className="poll-q"><span>{Icon.poll}</span><b>{poll.question}</b><small>{poll.byName} · {poll.total} vote{poll.total === 1 ? '' : 's'}{poll.open ? '' : ' · closed'}</small></div>
      {poll.options.map((o, i) => (
        <button key={i} className={`poll-opt ${mine === i ? 'mine' : ''}`} disabled={!poll.open} onClick={() => onVote(i)}>
          <i style={{ width: `${(poll.counts[i] / max) * 100}%` }} />
          <span>{o}</span><b>{poll.counts[i]}</b>
        </button>
      ))}
      {poll.open && isAsker && <button className="poll-close" onClick={onClose}>Close poll</button>}
    </div>
  );
}

/* "Ask the room": a question and 2–5 answers; Yes / No / Not sure is one tap. */
function PollComposer({ onAsk, onCancel }) {
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState(['Yes', 'No', 'Not sure']);
  const set = (i, v) => setOpts((o) => o.map((x, k) => (k === i ? v : x)));
  const valid = q.trim() && opts.filter((o) => o.trim()).length >= 2;
  return (
    <div className="poll-compose">
      <h3>Ask the room</h3>
      <input autoFocus placeholder="Question, e.g. Move the meeting to Tuesday?" value={q} maxLength={200} onChange={(e) => setQ(e.target.value)} />
      <div className="poll-presets">
        <button onClick={() => setOpts(['Yes', 'No', 'Not sure'])}>Yes / No / Not sure</button>
        <button onClick={() => setOpts(['Agree', 'Disagree'])}>Agree / Disagree</button>
        <button onClick={() => setOpts(['A', 'B', 'C'])}>A / B / C</button>
      </div>
      {opts.map((o, i) => (
        <div key={i} className="poll-optrow">
          <input value={o} maxLength={60} placeholder={`Answer ${i + 1}`} onChange={(e) => set(i, e.target.value)} />
          {opts.length > 2 && <button aria-label="Remove answer" onClick={() => setOpts((x) => x.filter((_, k) => k !== i))}>×</button>}
        </div>
      ))}
      {opts.length < 5 && <button className="wb-btn" onClick={() => setOpts((x) => [...x, ''])}>＋ Answer</button>}
      <div style={{ display: 'flex', marginTop: 12, gap: 8 }}>
        <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" style={{ flex: 2 }} disabled={!valid}
          onClick={() => onAsk(q.trim(), opts.map((x) => x.trim()).filter(Boolean))}>Ask</button>
      </div>
    </div>
  );
}

function Tile({ name, stream, showVideo, micOn, hand, me, mirror, sharing, onPlayBlocked }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    // Only touch srcObject when the stream truly changed. Reassigning the
    // same stream makes the element blink black — and since this effect
    // can re-run on unrelated re-renders (the call timer ticks every
    // second), an unconditional assignment flashes the video once per
    // second, in time with the clock.
    if (ref.current.srcObject !== (stream || null)) {
      ref.current.srcObject = stream || null;
    }
    if (stream && ref.current.paused) {
      // Safari blocks unmuted autoplay until a user gesture; surface it
      // instead of failing silently (the classic "no remote audio" bug).
      ref.current.play().catch(() => onPlayBlocked?.());
    }
  }, [stream, onPlayBlocked]);
  const grad = gradFor(name);
  return (
    <div className="tile">
      <div className="fill" style={{ background: `linear-gradient(160deg,${grad[1]}22,transparent 65%)` }} />
      {stream && (
        <video ref={ref} autoPlay playsInline muted={me}
          className={mirror ? 'mirror' : ''}
          style={{ display: showVideo ? 'block' : 'none' }} />
      )}
      {!showVideo && (
        <div className="persona">
          <div className="avatar" style={{ background: `linear-gradient(135deg,${grad[0]},${grad[1]})` }}>
            {initials(name)}
          </div>
        </div>
      )}
      {sharing && <span className="badge-share">{me ? 'YOU ARE SHARING' : 'SHARING'}</span>}
      <div className="nameplate">
        {!micOn && <span className="mic-off" title="Muted">🔇</span>}
        <span>{me ? `${name} (you)` : name}{hand ? ' ✋' : ''}</span>
      </div>
    </div>
  );
}

export default function CallScreen({ session, call, onLeave }) {
  const { token, email } = session;
  const { roomId } = call;
  const me = email.split('@')[0];

  const [localStream, setLocalStream] = useState(call.stream);
  const [micOn, setMicOn] = useState(call.micOn);
  const [camOn, setCamOn] = useState(call.camOn);
  const [sharing, setSharing] = useState(false);
  const [shareStream, setShareStream] = useState(null);
  const [hand, setHand] = useState(false);
  const [panel, setPanel] = useState(null); // 'chat' | 'people' | null (desktop side panels)
  const phone = usePhone();          // narrow or short viewport → theater layout
  const kb = useKeyboardInset();     // on-screen keyboard height (0 on desktop)
  const [sheet, setSheet] = useState(null); // phone: 'more' | 'people' | 'ask' | null
  const [askOpen, setAskOpen] = useState(false); // desktop poll composer
  const [polls, setPolls] = useState({});    // id -> tally from the server
  const [myVotes, setMyVotes] = useState({}); // pollId -> option index
  const handSince = useRef({});               // peer id -> when the hand went up (for the queue)
  const notes = useNotesDoc(roomId, token, email);
  // Named-room door state (null for plain code rooms)
  const [room, setRoom] = useState(null);          // room-state from the server: name, locked, hostPresent, links…
  const [door, setDoor] = useState('in');          // 'in' | 'knocking' | 'denied'
  const [deniedWhy, setDeniedWhy] = useState('');
  const [knocks, setKnocks] = useState([]);        // host: [{id,name}]
  const [reportOpen, setReportOpen] = useState(false);
  const [reportText, setReportText] = useState('');
  const isHost = !!room && room.hostName === me && !session.guest;
  // Language room: live captions
  const isLang = room?.theme === 'language';
  const [capOn, setCapOn] = useState(true);
  const [capLang, setCapLang] = useState(() => { try { return localStorage.getItem('cove-caption-lang') || (navigator.language?.startsWith('es') ? 'es-ES' : 'en-US'); } catch { return 'en-US'; } });
  const [captions, setCaptions] = useState([]);      // final captions, last 40
  const [interim, setInterim] = useState({});        // id -> live partial text
  const [langPick, setLangPick] = useState(false);
  const capsRef = useRef(null);
  const sendCaption = useCallback((text, final) => socket.emit('caption', { text, lang: capLang, final }), [capLang]);
  const caps = useCaptions({ enabled: isLang && capOn, lang: capLang, micOn,
    onFinal: (t) => sendCaption(t, true), onInterim: (t) => sendCaption(t, false) });
  useEffect(() => { if (isLang) { socket.emit('caption-lang', capLang); try { localStorage.setItem('cove-caption-lang', capLang); } catch { /* fine */ } } }, [isLang, capLang]);
  useEffect(() => { capsRef.current?.scrollTo?.({ top: 1e9, behavior: 'smooth' }); }, [captions, interim]);
  const notesRef = useRef(null); notesRef.current = notes.doc;
  const [wsOn, setWsOn] = useState(false);
  const [wsEverOn, setWsEverOn] = useState(false);
  const [msgs, setMsgs] = useState([]);
  const [draft, setDraft] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [toastMsg, setToastMsg] = useState('');
  const [floats, setFloats] = useState([]);
  const [playBlocked, setPlayBlocked] = useState(false);
  const onPlayBlocked = useCallback(() => setPlayBlocked(true), []);
  const unblockPlayback = () => {
    document.querySelectorAll('.call video').forEach((v) => v.play().catch(() => {}));
    setPlayBlocked(false);
  };

  // Belt-and-suspenders: if the tab is closed or navigated away without
  // clicking Leave, release the camera/mic explicitly. Browsers should do
  // this themselves, but Safari in particular is unreliable about it.
  useEffect(() => {
    const release = () => {
      shareTrackRef.current?.stop();
      mesh.localStreamRef.current?.getTracks().forEach((tr) => tr.stop());
    };
    window.addEventListener('pagehide', release);
    return () => window.removeEventListener('pagehide', release);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Relay credentials are fetched right before joining (see lib.js); the ref
  // lets peer connections created later pick them up without re-rendering.
  const iceRef = useRef(STUN_ONLY);
  const mesh = useMesh(socket, call.stream, iceRef);
  const stateRef = useRef({});
  stateRef.current = { micOn, camOn, hand, sharing };
  const shareTrackRef = useRef(null);
  const toastTimer = useRef(null);
  const chatEndRef = useRef(null);

  const toast = (m) => {
    setToastMsg(m);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 2200);
  };
  const sendState = (over = {}) => socket.emit('state', { ...stateRef.current, ...over });

  // ---- lifetime: socket wiring ----
  useEffect(() => {
    socket.auth = { token };
    // Get a short-lived TURN credential first (≈100 ms, falls back to STUN on
    // any failure), then connect — so every peer connection has the relay.
    let alive = true; // don't connect if the user left before the credential arrived
    fetchIceServers(token).then((ice) => { if (!alive) return; iceRef.current = ice; socket.connect(); });

    const onConnect = () => { socket.emit('join', roomId); sendState(); };
    const onPeers = (list) => list.forEach(({ id, name }) => mesh.ensure(id, name));
    const onJoined = ({ id, name }) => { mesh.ensure(id, name); sendState(); toast(`${name} joined`); };
    const onDesc = ({ from, description }) => mesh.onDescription(from, description);
    const onCand = ({ from, candidate }) => mesh.onCandidate(from, candidate);
    const onLeft = ({ id }) => mesh.remove(id);
    const onState = ({ from, ...s }) => {
      if (s.hand && !handSince.current[from]) handSince.current[from] = Date.now();
      if (!s.hand) delete handSince.current[from];
      mesh.setPeerState(from, s);
    };
    const onPoll = (t) => setPolls((prev) => {
      const was = prev[t.id];
      if (was?.open && !t.open) {
        // closed: a line in chat for everyone, and into the notes by the asker
        setMsgs((m) => [...m.slice(-199), { id: 'poll', from: 'Poll', text: `${t.question} — ${t.options.map((o, i) => `${o} ${t.counts[i]}`).join(' · ')}`, ts: Date.now() }]);
        if (t.by === socket.id) appendLine(notesRef.current, `Poll: ${t.question} → ${t.options.map((o, i) => `${o} ${t.counts[i]}`).join(', ')} (${t.total} votes)`);
      }
      return { ...prev, [t.id]: t };
    });
    const onChat = (m) => setMsgs((prev) => [...prev.slice(-199), m]);
    const onReaction = ({ emoji }) =>
      setFloats((f) => [...f, { id: Math.random(), emoji, left: 42 + Math.random() * 16 }]);
    const onFull = ({ max }) => { alert(`That room is full (max ${max} people).`); leave(); };
    const onAuthErr = () => { alert('Session expired — please sign in again.'); leave(); };

    socket.on('connect', onConnect);
    socket.on('peers', onPeers);
    socket.on('peer-joined', onJoined);
    socket.on('rtc-description', onDesc);
    socket.on('rtc-candidate', onCand);
    socket.on('peer-left', onLeft);
    socket.on('peer-state', onState);
    socket.on('chat', onChat);
    const onRoomState = (r) => setRoom(r);
    const onKnocking = ({ room: r }) => { setRoom(r); setDoor('knocking'); };
    const onAdmitted = () => { setDoor('in'); toast('You\'re in'); };
    const onDenied = ({ reason, room: r } = {}) => { if (r) setRoom(r); setDeniedWhy(reason || ''); setDoor('denied'); };
    const onKnock = ({ id, name }) => setKnocks((k) => (k.some((x) => x.id === id) ? k : [...k, { id, name }]));
    const onKnockGone = ({ id }) => setKnocks((k) => k.filter((x) => x.id !== id));
    const onReported = () => { setReportOpen(false); setReportText(''); toast('Report sent. A person will read it.'); };
    const onCaption = (c) => {
      if (c.final) { setInterim((m) => { const n = { ...m }; delete n[c.id]; return n; }); setCaptions((l) => [...l.slice(-39), c]); }
      else setInterim((m) => ({ ...m, [c.id]: { from: c.from, text: c.text } }));
    };
    socket.on('caption', onCaption);
    socket.on('room-state', onRoomState);
    socket.on('knocking', onKnocking);
    socket.on('admitted', onAdmitted);
    socket.on('denied', onDenied);
    socket.on('knock', onKnock);
    socket.on('knock-gone', onKnockGone);
    socket.on('reported', onReported);
    socket.on('reaction', onReaction);
    socket.on('poll', onPoll);
    socket.on('room-full', onFull);
    socket.on('connect_error', onAuthErr);

    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    // IMPORTANT: this cleanup must only undo what the setup above can
    // recreate (listeners, peer connections, the socket). React StrictMode
    // deliberately runs setup -> cleanup -> setup in dev to catch cleanups
    // with irreversible side effects. Hardware (camera/mic) is NOT touched
    // here — releasing it belongs to leave(), the one true exit path.
    return () => {
      clearInterval(t);
      socket.off('connect', onConnect);
      socket.off('peers', onPeers);
      socket.off('peer-joined', onJoined);
      socket.off('rtc-description', onDesc);
      socket.off('rtc-candidate', onCand);
      socket.off('peer-left', onLeft);
      socket.off('peer-state', onState);
      socket.off('chat', onChat);
      socket.off('room-state', onRoomState);
      socket.off('knocking', onKnocking);
      socket.off('admitted', onAdmitted);
      socket.off('denied', onDenied);
      socket.off('knock', onKnock);
      socket.off('knock-gone', onKnockGone);
      socket.off('reported', onReported);
      socket.off('caption', onCaption);
      socket.off('reaction', onReaction);
      socket.off('poll', onPoll);
      socket.off('room-full', onFull);
      socket.off('connect_error', onAuthErr);
      mesh.closeAll();
      alive = false;
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs, panel, phone]);
  // On a phone the chat lane sits above the keyboard; closing the sheet on
  // every leave path keeps state tidy if the room is torn down underneath.
  useEffect(() => { if (!phone) setSheet(null); }, [phone]);

  // Release every capture track we ever acquired (lobby stream, mid-call
  // camera, screen share) so the camera light goes off the moment you
  // leave. Unmounting then triggers the effect cleanup above, which closes
  // the peer connections and the socket.
  const leave = () => {
    shareTrackRef.current?.stop();
    shareTrackRef.current = null;
    mesh.localStreamRef.current?.getTracks().forEach((tr) => tr.stop());
    onLeave();
  };

  // ---- controls ----
  const toggleMic = () => {
    const v = !micOn;
    setMicOn(v);
    mesh.localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = v));
    sendState({ micOn: v });
  };

  const toggleCam = async () => {
    if (camOn) {
      // Fully STOP the track, don't just disable it: a disabled track sends
      // black frames but keeps the hardware open, so the camera light stays
      // on — off should mean off. Turning it back on re-acquires.
      const ls = mesh.localStreamRef.current;
      ls?.getVideoTracks().forEach((t) => { t.stop(); ls.removeTrack(t); });
      if (!sharing) mesh.replaceVideo(null);
      setCamOn(false);
      sendState({ camOn: false });
      return;
    }
    try {
      const vs = await navigator.mediaDevices.getUserMedia({
        video: call.camId ? { deviceId: { ideal: call.camId } } : true
      });
      const track = vs.getVideoTracks()[0];
      let ls = mesh.localStreamRef.current;
      if (!ls) {
        ls = new MediaStream();
        mesh.localStreamRef.current = ls;
      }
      ls.addTrack(track);
      setLocalStream(ls);
      if (!sharing) mesh.replaceVideo(track, ls);
      setCamOn(true);
      sendState({ camOn: true });
    } catch {
      toast('Camera unavailable');
    }
  };

  const toggleShare = async () => {
    if (sharing) return stopShare();
    if (!navigator.mediaDevices?.getDisplayMedia) return toast('Screen sharing is not available on this device');
    try {
      const ds = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = ds.getVideoTracks()[0];
      shareTrackRef.current = track;
      mesh.replaceVideo(track, ds);
      track.onended = stopShare;
      setShareStream(ds);
      setSharing(true);
      sendState({ sharing: true });
      toast('Sharing your screen');
    } catch { /* user cancelled the picker */ }
  };
  const stopShare = () => {
    const cam = mesh.localStreamRef.current
      ?.getVideoTracks()
      .find((t) => t !== shareTrackRef.current);
    mesh.replaceVideo(camOn && cam ? cam : null, mesh.localStreamRef.current);
    shareTrackRef.current?.stop();
    shareTrackRef.current = null;
    setShareStream(null);
    setSharing(false);
    sendState({ sharing: false });
    toast('Stopped sharing');
  };

  const toggleHand = () => {
    const v = !hand;
    if (v) handSince.current[socket.id] = Date.now(); else delete handSince.current[socket.id];
    setHand(v);
    sendState({ hand: v });
    if (v) toast('Hand raised');
  };
  const react = (emoji) => socket.emit('reaction', emoji);
  const sendMsg = () => {
    const v = draft.trim();
    if (!v) return;
    socket.emit('chat', v);
    setDraft('');
  };
  const copyCode = () => {
    const v = room ? `${location.origin}/r/${roomId}` : roomId;
    navigator.clipboard?.writeText(v).then(() => toast(room ? 'Room link copied' : 'Room code copied'));
  };
  const openWorkspace = () => {
    const v = !wsOn;
    setWsOn(v);
    if (v && !wsEverOn) setWsEverOn(true);
    if (v && !wsEverOn) toast('Notes are shared with everyone in the room');
  };

  const peerList = Object.entries(mesh.peers);
  const ask = (question, options) => { socket.emit('poll', { question, options }); setSheet(null); setAskOpen(false); };
  const vote = (id, option) => { socket.emit('poll-vote', { id, option }); setMyVotes((v) => ({ ...v, [id]: option })); };
  const closePoll = (id) => socket.emit('poll-close', { id });
  const openPolls = Object.values(polls).filter((p) => p.open).sort((a, b) => a.ts - b.ts);

  // Notes leave the room as plain text: share sheet where there is one,
  // otherwise a .txt download (on iOS the share sheet includes Save to Files).
  const exportText = () => {
    const names = [me, ...peerList.map(([, p]) => p.name)];
    const closed = Object.values(polls).filter((p) => !p.open);
    return [`Cove · room ${roomId} · ${new Date().toLocaleString()}`, `With: ${names.join(', ')}`, '',
      notesText(notes.doc).trim() || '(no notes)',
      ...(closed.length ? ['', 'Polls:', ...closed.map((p) => `• ${p.question} → ${p.options.map((o, i) => `${o} ${p.counts[i]}`).join(', ')}`)] : [])
    ].join('\n');
  };
  const downloadNotes = () => {
    const blob = new Blob([exportText()], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `cove-${roomId}-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Notes saved');
  };
  const shareNotes = async () => {
    const text = exportText();
    if (navigator.share) { try { await navigator.share({ title: `Cove notes · ${roomId}`, text }); return; } catch { /* cancelled */ return; } }
    try { await navigator.clipboard.writeText(text); toast('Notes copied'); } catch { downloadNotes(); }
  };
  const handQueue = [[socket.id, { name: me, hand }], ...peerList].filter(([, p]) => p.hand)
    .sort((a, b) => (handSince.current[a[0]] || 0) - (handSince.current[b[0]] || 0));

  const admit = (id) => { socket.emit('admit', { id }); setKnocks((k) => k.filter((x) => x.id !== id)); };
  const deny = (id) => { socket.emit('deny', { id }); setKnocks((k) => k.filter((x) => x.id !== id)); };
  const setLock = (locked) => socket.emit('lock', { locked });
  const removePeer = (id) => { if (window.confirm('Remove this person from the room?')) socket.emit('remove', { id }); };
  const sendReport = () => { if (reportText.trim()) socket.emit('report', { text: reportText.trim() }); };
  const tipLink = room?.tipLink || '';
  const saveCaption = (c) => { appendLine(notes.doc, c.translated ? `${c.from}: ${c.text} — ${c.translated}` : `${c.from}: ${c.text}`); toast('Added to notes'); };
  const captionLane = isLang && (
    <div className="caps" ref={capsRef} aria-live="polite">
      {captions.slice(-6).map((c, i) => (
        <div key={c.ts + i} className={`cap ${c.id === socket.id ? 'me' : ''}`} onClick={() => saveCaption(c)} title="Tap to add to notes">
          <span className="who">{c.from}</span>
          <span className="txt">{c.text}</span>
          {c.translated && <span className="tr">{c.translated}</span>}
        </div>
      ))}
      {Object.entries(interim).map(([id, v]) => (
        <div key={id} className="cap interim"><span className="who">{v.from}</span><span className="txt">{v.text}…</span></div>
      ))}
      {captions.length === 0 && Object.keys(interim).length === 0 && (
        <div className="cap hint">{caps.supported ? (caps.listening ? 'Listening — captions appear here as people speak.' : capOn ? (micOn ? 'Starting captions…' : 'Unmute to caption your voice.') : 'Captions off.') : 'This browser can\'t transcribe; you\'ll still see others\' captions.'}{caps.error ? ` ${caps.error}` : ''}</div>
      )}
    </div>
  );
  const langSheet = langPick && (
    <div className="ph-scrim" style={{ zIndex: 75 }} onClick={() => setLangPick(false)}>
      <div className="ph-sheet desk" role="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 16, marginBottom: 4 }}>Captions</h3>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, marginBottom: 10 }}>The language you'll speak. Your phone transcribes your voice on the device and shares the text{room?.translate ? '; others read it translated into their own language' : ''}.</p>
        <div className="chips" style={{ marginBottom: 12 }}>
          {LANGS.map(([code, label]) => <button key={code} className={`chip ${capLang === code ? 'on' : ''}`} onClick={() => setCapLang(code)}>{label}</button>)}
        </div>
        <label className="agree" style={{ margin: '4px 0 10px' }}><input type="checkbox" checked={capOn} onChange={(e) => setCapOn(e.target.checked)} /><span>Caption my voice</span></label>
        <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => setLangPick(false)}>Done</button>
      </div>
    </div>
  );
  const roomTitle = room?.name || roomId;

  const mm = String((seconds / 60) | 0).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  const localTileStream = sharing ? shareStream : localStream;

  const tiles = (
    <>
      <Tile name={me} me stream={localTileStream}
        showVideo={!!localTileStream && (sharing || (camOn && !!localStream?.getVideoTracks().length))}
        micOn={micOn} hand={hand} sharing={sharing} mirror={!sharing} />
      {peerList.map(([id, p]) => (
        <Tile key={id} name={p.name} stream={p.stream}
          showVideo={!!p.stream && (p.camOn || p.sharing)}
          micOn={p.micOn} hand={p.hand} sharing={p.sharing}
          onPlayBlocked={onPlayBlocked} />
      ))}
    </>
  );
  const peopleRows = [[socket.id, { name: me, micOn, hand, meRow: true }], ...peerList].map(([id, p]) => {
    const g = gradFor(p.name);
    return (
      <div key={id} className="p-item">
        <div className="avatar" style={{ background: `linear-gradient(135deg,${g[0]},${g[1]})` }}>
          {initials(p.name)}
        </div>
        <div>
          <div>{p.name}{p.meRow ? ' (you)' : ''}{p.hand ? ' ✋' : ''}</div>
          <div className="status">{p.micOn ? 'Mic on' : 'Muted'}</div>
        </div>
        {p.meRow && <span className="role">YOU</span>}
        {!p.meRow && isHost && <button className="role" style={{ color: '#FFA3A3' }} onClick={() => removePeer(id)}>Remove</button>}
      </div>
    );
  });

  /* Door UI shared by both layouts */
  const doorOverlay = door !== 'in' && (
    <div className="ph-scrim" style={{ zIndex: 70 }}>
      <div className="ph-sheet desk door-wait" role="dialog">
        <div className="grab" />
        {door === 'knocking' ? (
          <>
            <h3>Knocking…</h3>
            <p>{room?.hostName || 'The host'} can see you're at the door. Hang on a moment.</p>
            <div className="knock-dots"><i /><i /><i /></div>
          </>
        ) : (
          <>
            <h3>{deniedWhy === 'host-away' ? `${room?.hostName || 'The host'} isn't in yet` : deniedWhy === 'host-declined' ? 'Not this time' : deniedWhy === 'removed' ? 'You were removed from the room' : deniedWhy === 'closed' ? 'This room is closed' : 'No way in'}</h3>
            <p>{deniedWhy === 'host-away' ? 'The door only opens while the host is in the room. Go back to the door and try again in a bit.' : deniedWhy === 'host-declined' ? 'The host didn\'t let you in. If you were expected, check the link with them.' : ''}</p>
          </>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={leave}>Back to the door</button>
          {door === 'knocking' && <button className="btn btn-ghost" onClick={() => setReportOpen(true)}>Report</button>}
        </div>
      </div>
    </div>
  );
  const knockBanner = isHost && knocks.length > 0 && (
    <div className="knocks">
      {knocks.map((k) => (
        <div key={k.id} className="knock">
          <span>✋ <b>{k.name}</b> is at the door</span>
          <button className="btn btn-primary" style={{ padding: '7px 14px', width: 'auto', fontSize: 13 }} onClick={() => admit(k.id)}>Let in</button>
          <button className="btn btn-ghost" style={{ padding: '7px 12px', fontSize: 13 }} onClick={() => deny(k.id)}>Not now</button>
        </div>
      ))}
    </div>
  );
  const reportDialog = reportOpen && (
    <div className="ph-scrim" style={{ zIndex: 75 }} onClick={() => setReportOpen(false)}>
      <div className="ph-sheet desk" role="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 16, marginBottom: 6 }}>Report this room</h3>
        <p style={{ color: 'var(--muted)', fontSize: 13.5, marginBottom: 10 }}>Tell us what happened. We receive the room, the time and your words — never any video. A person reads every report.</p>
        <textarea className="report-ta" value={reportText} maxLength={1000} placeholder="What happened?" onChange={(e) => setReportText(e.target.value)} />
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setReportOpen(false)}>Cancel</button>
          <button className="btn btn-primary" style={{ flex: 2 }} disabled={!reportText.trim()} onClick={sendReport}>Send report</button>
        </div>
      </div>
    </div>
  );
  const handCount = (hand ? 1 : 0) + peerList.filter(([, p]) => p.hand).length;

  /* ---------- PHONE: theater layout ----------
     Video owns the screen. A thin rail on the right holds the occasional
     actions, chat is a transparent lane above a persistent input, and the
     bottom row is only Mic / Camera / Leave. Everything else lives in the
     "More" sheet. Desktop markup below is unchanged. */
  if (phone) {
    const recent = msgs.slice(-3);
    return (
      <section className="screen call phone" style={{ '--kb': `${kb}px` }}>
        <div className="call-top">
          <div className="room-chip">
            <span className="live">LIVE</span>
            <span>{roomTitle}</span>
            {room?.locked && <span title="Door locked">🔒</span>}
            <button onClick={copyCode} title="Copy room link" aria-label="Copy room link" style={{ color: 'var(--muted)' }}>⧉</button>
          </div>
          <span className="timer">{mm}:{ss} · {peerList.length + 1}/10</span>
        </div>
        {knockBanner}

        <div className={`call-body ${wsOn ? 'ws' : ''}`}>
          <div className="stage">{tiles}</div>
          {wsEverOn && <div className="workspace"><Notes doc={notes.doc} present={notes.present} /></div>}
        </div>
        {wsOn && (
          <div className="ph-ws-bar">
            {Icon.notes}<b>Notes</b><small>shared · saved with the room</small>
            <button className="ghost" onClick={shareNotes} aria-label="Share notes">{Icon.shareOut}</button>
            <button onClick={() => setWsOn(false)} aria-label="Close notes">Close</button>
          </div>
        )}
        {handQueue.length > 0 && !wsOn && (
          <div className="ph-queue">✋ {handQueue.map(([, p]) => p.name).slice(0, 3).join(' → ')}{handQueue.length > 3 ? ` +${handQueue.length - 3}` : ''}</div>
        )}

        <div className="ph-rail" style={{ display: wsOn ? 'none' : undefined }}>
          <button className={`ctl ${sheet === 'people' ? 'active' : ''}`} onClick={() => setSheet(sheet === 'people' ? null : 'people')} aria-label="People">
            {Icon.people}<b className="count">{peerList.length + 1}</b>
          </button>
          <button className={`ctl ${hand ? 'active' : ''}`} onClick={toggleHand} aria-pressed={hand} aria-label="Raise hand">
            {Icon.hand}{handCount > 0 && <b className="count">{handCount}</b>}
          </button>
          {isLang && (
            <button className={`ctl ${capOn && caps.listening ? 'active' : ''}`} onClick={() => setLangPick(true)} aria-label="Captions">
              <b style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '.02em' }}>{capLang.slice(0, 2).toUpperCase()}</b>
            </button>
          )}
          <button className={`ctl ${openPolls.length ? 'active' : ''}`} onClick={() => setSheet(sheet === 'ask' ? null : 'ask')} aria-label="Ask the room">
            {Icon.poll}{openPolls.length > 0 && <b className="count">{openPolls.length}</b>}
          </button>
          <button className={`ctl ${sheet === 'more' ? 'active' : ''}`} onClick={() => setSheet(sheet === 'more' ? null : 'more')} aria-label="More">
            {Icon.more}
          </button>
        </div>

        <div className="ph-bottom">
          {!wsOn && captionLane}
          {!wsOn && openPolls.slice(-1).map((p) => (
            <PollCard key={p.id} poll={p} mine={myVotes[p.id]} isAsker={p.by === socket.id} compact
              onVote={(i) => vote(p.id, i)} onClose={() => closePoll(p.id)} />
          ))}
          {!wsOn && (
            <div className="ph-chat" aria-live="polite">
              {recent.map((m, i) => (
                <div key={`${msgs.length}-${i}`} className={`msg ${m.id === socket.id ? 'me' : ''}`}>
                  <span className="who">{m.id === socket.id ? 'You' : m.from}:</span> {m.text}
                </div>
              ))}
            </div>
          )}
          <div className="ph-input">
            <input placeholder="Message everyone…" value={draft} enterKeyHint="send"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendMsg()} />
            <button className="send" onClick={sendMsg} aria-label="Send" disabled={!draft.trim()}>{Icon.send}</button>
          </div>
          <div className="ph-primary">
            <button className={`ctl ${micOn ? '' : 'off'}`} onClick={toggleMic} aria-pressed={micOn} aria-label="Mic">
              {Icon.mic}<span>{micOn ? 'Mute' : 'Unmute'}</span>
            </button>
            <button className={`ctl ${camOn ? '' : 'off'}`} onClick={toggleCam} aria-pressed={camOn} aria-label="Camera">
              {Icon.cam}<span>{camOn ? 'Camera' : 'Cam off'}</span>
            </button>
            <button className="ctl ctl-leave" onClick={leave}>{Icon.phone}<span>Leave</span></button>
          </div>
          {floats.map((f) => (
            <div key={f.id} className="react-pop" style={{ left: `${f.left}%` }}
              onAnimationEnd={() => setFloats((prev) => prev.filter((x) => x.id !== f.id))}>
              {f.emoji}
            </div>
          ))}
        </div>

        {sheet && (
          <div className="ph-scrim" onClick={() => setSheet(null)}>
            <div className="ph-sheet" role="dialog" onClick={(e) => e.stopPropagation()}>
              <div className="grab" />
              {sheet === 'people' ? (
                <>
                  <h3>In this room ({peerList.length + 1})</h3>
                  <div className="ph-people">{peopleRows}</div>
                </>
              ) : sheet === 'ask' ? (
                openPolls.length ? (
                  <>
                    <h3>Polls</h3>
                    {openPolls.map((p) => (
                      <PollCard key={p.id} poll={p} mine={myVotes[p.id]} isAsker={p.by === socket.id}
                        onVote={(i) => vote(p.id, i)} onClose={() => closePoll(p.id)} />
                    ))}
                    {openPolls.length < 3 && <button className="btn btn-ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setSheet('ask-new')}>Ask another question</button>}
                  </>
                ) : <PollComposer onAsk={ask} onCancel={() => setSheet(null)} />
              ) : sheet === 'ask-new' ? (
                <PollComposer onAsk={ask} onCancel={() => setSheet('ask')} />
              ) : (
                <>
                  <h3>More</h3>
                  <button className="row" onClick={() => { setSheet(null); openWorkspace(); }}>
                    {Icon.notes}<span>{wsOn ? 'Hide notes' : 'Notes'}</span><small>Shared with the room, saved with the room code</small>
                  </button>
                  <button className="row" onClick={() => { setSheet(null); shareNotes(); }}>
                    {Icon.shareOut}<span>Share notes</span><small>Notes and poll results as text</small>
                  </button>
                  <button className="row" onClick={() => { setSheet(null); downloadNotes(); }}>
                    {Icon.save}<span>Save notes to this device</span><small>.txt file</small>
                  </button>
                  {tipLink && !isHost && (
                    <a className="row" href={tipLink} target="_blank" rel="noopener noreferrer" onClick={() => setSheet(null)}>
                      <span style={{ fontSize: 18 }}>💛</span><span>Tip {room.hostName}</span><small>Opens their own link; they keep all of it</small>
                    </a>
                  )}
                  {isHost && (
                    <button className="row" onClick={() => { setSheet(null); setLock(!room.locked); }}>
                      <span style={{ fontSize: 18 }}>{room.locked ? '🔓' : '🔒'}</span><span>{room.locked ? 'Unlock the door' : 'Lock the door'}</span><small>{room.locked ? 'Anyone with the link walks in' : 'Guests knock; you let them in'}</small>
                    </button>
                  )}
                  <button className="row" onClick={() => { setSheet(null); setReportOpen(true); }}>
                    <span style={{ fontSize: 18 }}>🚩</span><span>Report this room</span><small>Words only, read by a person</small>
                  </button>
                  <div className="row-emoji">{REACTIONS.map((e) => <button key={e} onClick={() => { setSheet(null); react(e); }}>{e}</button>)}</div>
                  <button className="row" onClick={() => { setSheet(null); toggleShare(); }}>
                    {Icon.share}<span>{sharing ? 'Stop sharing' : 'Share screen'}</span>
                    <small>{navigator.mediaDevices?.getDisplayMedia ? '' : 'Not on this device'}</small>
                  </button>
                  <button className="row" onClick={() => { setSheet(null); copyCode(); }}>
                    {Icon.copy}<span>{room ? 'Copy room link' : 'Copy room code'}</span><small>{room ? `${location.host}/r/${roomId}` : roomId}</small>
                  </button>
                  {playBlocked && (
                    <button className="row" onClick={() => { setSheet(null); unblockPlayback(); }}>
                      <span style={{ fontSize: 18 }}>🔊</span><span>Enable incoming audio</span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {playBlocked && !sheet && (
          <button className="unblock" onClick={unblockPlayback}>
            🔊 Tap to enable incoming audio &amp; video
          </button>
        )}
        {doorOverlay}{reportDialog}{langSheet}
        <div className={`toast ${toastMsg ? 'on' : ''}`} role="status">{toastMsg}</div>
      </section>
    );
  }

  return (
    <section className="screen call">
      <div className="call-top">
        <div className="room-chip">
          <span className="live">LIVE</span>
          <span>{roomTitle}</span>
          {room?.locked && <span title="Door locked">🔒</span>}
          <button onClick={copyCode} title="Copy room link" style={{ color: 'var(--muted)' }}>⧉</button>
        </div>
        <div className="mark" style={{ fontSize: 16 }}><span className="dot" />Cove</div>
        <span className="timer">{mm}:{ss} · {peerList.length + 1}/10</span>
      </div>

      <div className={`call-body ${wsOn ? 'ws' : ''}`}>
        <div className="stage-col"><div className="stage">{tiles}</div>{captionLane}</div>

        {wsEverOn && (
          <div className="workspace">
            <div className="ws-head">
              <span className="ws-title">{Icon.notes} Notes</span>
              <span className="ws-sub">shared with the room</span>
              <button className="wb-btn" onClick={shareNotes}>Share</button>
              <button className="wb-btn" onClick={downloadNotes}>Save .txt</button>
              <button className="wb-btn" onClick={() => setWsOn(false)}>Close</button>
            </div>
            <Notes doc={notes.doc} present={notes.present} />
          </div>
        )}

        {panel === 'chat' && (
          <aside className="panel" aria-label="Chat">
            <div className="panel-head"><h3>Chat</h3><button onClick={() => setPanel(null)} aria-label="Close chat">×</button></div>
            <div className="panel-body">
              {openPolls.map((p) => (
                <PollCard key={p.id} poll={p} mine={myVotes[p.id]} isAsker={p.by === socket.id}
                  onVote={(i) => vote(p.id, i)} onClose={() => closePoll(p.id)} />
              ))}
              {msgs.map((m, i) => (
                <div key={i} className={`msg ${m.id === socket.id ? 'me' : ''}`}>
                  <div className="who"><b>{m.id === socket.id ? 'You' : m.from}</b></div>
                  <div className="bubble">{m.text}</div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <div className="chat-input">
              <input placeholder="Message everyone…" value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMsg()} />
              <button className="send" onClick={sendMsg}>Send</button>
            </div>
          </aside>
        )}

        {panel === 'people' && (
          <aside className="panel" aria-label="Participants">
            <div className="panel-head">
              <h3>Participants ({peerList.length + 1})</h3>
              <button onClick={() => setPanel(null)} aria-label="Close participants">×</button>
            </div>
            <div className="panel-body">{peopleRows}</div>
          </aside>
        )}
      </div>

      <div className="controls">
        <button className={`ctl ${micOn ? '' : 'off'}`} onClick={toggleMic} aria-pressed={micOn}>
          {Icon.mic}<span>Mic</span>
        </button>
        <button className={`ctl ${camOn ? '' : 'off'}`} onClick={toggleCam} aria-pressed={camOn}>
          {Icon.cam}<span>Camera</span>
        </button>
        <button className={`ctl ${sharing ? 'active' : ''}`} onClick={toggleShare} aria-pressed={sharing}>
          {Icon.share}<span>Share</span>
        </button>
        <button className={`ctl ${wsOn ? 'active' : ''}`} onClick={openWorkspace} aria-pressed={wsOn}>
          {Icon.notes}<span>Notes</span>
        </button>
        <button className={`ctl ${openPolls.length ? 'active' : ''}`} onClick={() => { setAskOpen(true); if (panel !== 'chat') setPanel('chat'); }}>
          {Icon.poll}<span>Ask</span>
        </button>
        <button className="ctl" onClick={() => react('👍')}>
          <span style={{ fontSize: 18, lineHeight: '19px' }}>👍</span><span>React</span>
        </button>
        <button className={`ctl ${hand ? 'active' : ''}`} onClick={toggleHand} aria-pressed={hand}>
          {Icon.hand}<span>Hand</span>
        </button>
        <button className={`ctl ${panel === 'chat' ? 'active' : ''}`}
          onClick={() => setPanel(panel === 'chat' ? null : 'chat')}>
          {Icon.chat}<span>Chat</span>
        </button>
        <button className={`ctl ${panel === 'people' ? 'active' : ''}`}
          onClick={() => setPanel(panel === 'people' ? null : 'people')}>
          {Icon.people}<span>People</span>
        </button>
        {isLang && (
          <button className={`ctl ${capOn && caps.listening ? 'active' : ''}`} onClick={() => setLangPick(true)} title="Captions and language">
            <span style={{ fontSize: 13, lineHeight: '19px', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{capLang.slice(0, 2).toUpperCase()}</span><span>Captions</span>
          </button>
        )}
        {isHost && (
          <button className={`ctl ${room.locked ? 'active' : ''}`} onClick={() => setLock(!room.locked)} title={room.locked ? 'Door locked: guests knock' : 'Door open'}>
            <span style={{ fontSize: 18, lineHeight: '19px' }}>{room.locked ? '🔒' : '🔓'}</span><span>Door</span>
          </button>
        )}
        {tipLink && !isHost && (
          <a className="ctl" href={tipLink} target="_blank" rel="noopener noreferrer" title={`Tip ${room.hostName} through their own link`}>
            <span style={{ fontSize: 18, lineHeight: '19px' }}>💛</span><span>Tip</span>
          </a>
        )}
        <button className="ctl" onClick={() => setReportOpen(true)} title="Report this room">
          <span style={{ fontSize: 18, lineHeight: '19px' }}>🚩</span><span>Report</span>
        </button>
        <button className="ctl ctl-leave" onClick={leave}>{Icon.phone}Leave</button>
        {floats.map((f) => (
          <div key={f.id} className="react-pop" style={{ left: `${f.left}%` }}
            onAnimationEnd={() => setFloats((prev) => prev.filter((x) => x.id !== f.id))}>
            {f.emoji}
          </div>
        ))}
      </div>

      {askOpen && (
        <div className="ph-scrim" onClick={() => setAskOpen(false)}>
          <div className="ph-sheet desk" role="dialog" onClick={(e) => e.stopPropagation()}>
            <PollComposer onAsk={ask} onCancel={() => setAskOpen(false)} />
          </div>
        </div>
      )}
      {handQueue.length > 0 && <div className="queue-chip">✋ {handQueue.map(([, p]) => p.name).join(' → ')}</div>}
      {knockBanner}{doorOverlay}{reportDialog}{langSheet}
      {playBlocked && (
        <button className="unblock" onClick={unblockPlayback}>
          🔊 Tap to enable incoming audio &amp; video
        </button>
      )}
      <div className={`toast ${toastMsg ? 'on' : ''}`} role="status">{toastMsg}</div>
    </section>
  );
}
