import { useEffect, useRef, useState } from 'react';
import { socket, initials, gradFor } from './lib';
import useMesh from './useMesh';
import Workspace from './collab/Workspace';

const Icon = {
  mic: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round"><path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/></svg>,
  cam: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>,
  share: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>,
  grid: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  hand: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-3 0-5-1.5-6.5-3.8L3 14.7a2 2 0 0 1 3.4-2L8 15"/></svg>,
  chat: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
  people: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  phone: <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92V20a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3.09a2 2 0 0 1 2 1.72c.12.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 10"/></svg>
};

function Tile({ name, stream, showVideo, micOn, hand, me, mirror, sharing, onPlayBlocked }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.srcObject = stream || null;
    if (stream) {
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
  const [panel, setPanel] = useState(null); // 'chat' | 'people' | null
  const [wsOn, setWsOn] = useState(false);
  const [wsEverOn, setWsEverOn] = useState(false);
  const [msgs, setMsgs] = useState([]);
  const [draft, setDraft] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [toastMsg, setToastMsg] = useState('');
  const [floats, setFloats] = useState([]);
  const [playBlocked, setPlayBlocked] = useState(false);
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

  const mesh = useMesh(socket, call.stream);
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
    socket.connect();

    const onConnect = () => { socket.emit('join', roomId); sendState(); };
    const onPeers = (list) => list.forEach(({ id, name }) => mesh.ensure(id, name));
    const onJoined = ({ id, name }) => { mesh.ensure(id, name); sendState(); toast(`${name} joined`); };
    const onDesc = ({ from, description }) => mesh.onDescription(from, description);
    const onCand = ({ from, candidate }) => mesh.onCandidate(from, candidate);
    const onLeft = ({ id }) => mesh.remove(id);
    const onState = ({ from, ...s }) => mesh.setPeerState(from, s);
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
    socket.on('reaction', onReaction);
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
      socket.off('reaction', onReaction);
      socket.off('room-full', onFull);
      socket.off('connect_error', onAuthErr);
      mesh.closeAll();
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs, panel]);

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
      const vs = await navigator.mediaDevices.getUserMedia({ video: true });
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
    navigator.clipboard?.writeText(roomId).then(() => toast('Room code copied'));
  };
  const openWorkspace = () => {
    const v = !wsOn;
    setWsOn(v);
    if (v && !wsEverOn) setWsEverOn(true);
    if (v) toast('Workspace open — shared with everyone in the room');
  };

  const mm = String((seconds / 60) | 0).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  const peerList = Object.entries(mesh.peers);
  const localTileStream = sharing ? shareStream : localStream;

  return (
    <section className="screen call">
      <div className="call-top">
        <div className="room-chip">
          <span className="live">LIVE</span>
          <span>{roomId}</span>
          <button onClick={copyCode} title="Copy room code" style={{ color: 'var(--muted)' }}>⧉</button>
        </div>
        <div className="mark" style={{ fontSize: 16 }}><span className="dot" />Cove</div>
        <span className="timer">{mm}:{ss} · {peerList.length + 1}/10</span>
      </div>

      <div className={`call-body ${wsOn ? 'ws' : ''}`}>
        <div className="stage">
          <Tile name={me} me stream={localTileStream}
            showVideo={!!localTileStream && (sharing || (camOn && !!localStream?.getVideoTracks().length))}
            micOn={micOn} hand={hand} sharing={sharing} mirror={!sharing} />
          {peerList.map(([id, p]) => (
            <Tile key={id} name={p.name} stream={p.stream}
              showVideo={!!p.stream && (p.camOn || p.sharing)}
              micOn={p.micOn} hand={p.hand} sharing={p.sharing}
              onPlayBlocked={() => setPlayBlocked(true)} />
          ))}
        </div>

        {wsEverOn && <Workspace roomId={roomId} token={token} email={email} />}

        {panel === 'chat' && (
          <aside className="panel" aria-label="Chat">
            <div className="panel-head"><h3>Chat</h3><button onClick={() => setPanel(null)} aria-label="Close chat">×</button></div>
            <div className="panel-body">
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
            <div className="panel-body">
              {[[socket.id, { name: me, micOn, hand, meRow: true }], ...peerList].map(([id, p]) => {
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
                  </div>
                );
              })}
            </div>
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
          {Icon.grid}<span>Workspace</span>
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
        <button className="ctl ctl-leave" onClick={leave}>{Icon.phone}Leave</button>
        {floats.map((f) => (
          <div key={f.id} className="react-pop" style={{ left: `${f.left}%` }}
            onAnimationEnd={() => setFloats((prev) => prev.filter((x) => x.id !== f.id))}>
            {f.emoji}
          </div>
        ))}
      </div>

      {playBlocked && (
        <button className="unblock" onClick={unblockPlayback}>
          🔊 Tap to enable incoming audio &amp; video
        </button>
      )}
      <div className={`toast ${toastMsg ? 'on' : ''}`} role="status">{toastMsg}</div>
    </section>
  );
}
