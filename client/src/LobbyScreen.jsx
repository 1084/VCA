import { useEffect, useRef, useState } from 'react';
import { initials, gradFor, newRoomCode, ROOM_CODE_PATTERN } from './lib';

export default function LobbyScreen({ email, onJoin }) {
  const name = email.split('@')[0];
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(false);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [joining, setJoining] = useState(false);
  const [devices, setDevices] = useState({ cams: [], mics: [] });
  const [camId, setCamId] = useState('');
  const [micId, setMicId] = useState('');
  const previewRef = useRef(null);
  const previewStream = useRef(null);
  const grad = gradFor(name);

  // Device labels are only revealed after a permission grant, so this runs
  // on mount (covers returning users) and again after the camera turns on.
  const refreshDevices = async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices({
        cams: list.filter((d) => d.kind === 'videoinput'),
        mics: list.filter((d) => d.kind === 'audioinput')
      });
    } catch { /* enumeration unsupported — dropdowns just stay hidden */ }
  };
  useEffect(() => { refreshDevices(); }, []);

  const camConstraint = (id) => (id ? { deviceId: { ideal: id } } : true);

  const startPreview = async (id) => {
    previewStream.current?.getTracks().forEach((t) => t.stop());
    const s = await navigator.mediaDevices.getUserMedia({ video: camConstraint(id) });
    previewStream.current = s;
    setCamOn(true);
    requestAnimationFrame(() => {
      if (previewRef.current) previewRef.current.srcObject = s;
    });
    refreshDevices();
  };
  const tryCamera = async () => {
    try {
      await startPreview(camId);
    } catch {
      setErr('Camera unavailable — you can still join without video.');
    }
  };
  const cameraOff = () => {
    previewStream.current?.getTracks().forEach((t) => t.stop());
    previewStream.current = null;
    setCamOn(false);
  };
  const pickCam = async (id) => {
    setCamId(id);
    if (!camOn) return;
    try {
      await startPreview(id);
    } catch {
      setErr('Could not switch to that camera.');
      cameraOff();
    }
  };
  useEffect(() => () => previewStream.current?.getTracks().forEach((t) => t.stop()), []);

  const join = async (roomId) => {
    const id = (roomId || code).trim().toUpperCase();
    if (!ROOM_CODE_PATTERN.test(id)) return setErr('Room codes look like KJH-4821.');
    setErr('');
    setJoining(true);
    previewStream.current?.getTracks().forEach((t) => t.stop());
    previewStream.current = null;

    // Get the real call stream with the chosen devices; degrade gracefully.
    const audio = micId ? { deviceId: { ideal: micId } } : true;
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio,
        video: camOn ? camConstraint(camId) : false
      });
    } catch {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        stream = null; // join receive-only
      }
    }
    if (stream && !micOn) stream.getAudioTracks().forEach((t) => (t.enabled = false));
    const hasVideo = !!stream?.getVideoTracks().length;
    onJoin({
      roomId: id,
      stream,
      micOn: micOn && !!stream,
      camOn: camOn && hasVideo,
      camId
    });
  };

  const label = (d, i, kind) => d.label || `${kind} ${i + 1}`;

  return (
    <section className="screen lobby">
      <div className="lobby-head">
        <div className="mark"><span className="dot" />Cove</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: 'var(--muted)', fontSize: 13 }}>{email}</span>
          <div className="avatar-sm" style={{ background: `linear-gradient(135deg,${grad[0]},${grad[1]})` }}>
            {initials(name)}
          </div>
        </div>
      </div>
      <div className="lobby-grid">
        <div className="preview">
          <div className="preview-stage">
            {camOn ? (
              <video ref={previewRef} autoPlay playsInline muted />
            ) : (
              <div className="preview-off">
                <div className="avatar-lg" style={{ background: `linear-gradient(135deg,${grad[0]},${grad[1]})` }}>
                  {initials(name)}
                </div>
                <span>Camera is off — you&rsquo;ll join without video</span>
                <button className="btn btn-ghost" style={{ fontSize: 13, padding: '8px 14px' }} onClick={tryCamera}>
                  Turn on camera
                </button>
              </div>
            )}
          </div>
          <div className="preview-controls">
            <button className={`toggle ${micOn ? '' : 'off'}`} aria-pressed={micOn}
              onClick={() => setMicOn(!micOn)}>
              {micOn ? (<><span className="mic-meter"><i /><i /><i /></span> Mic is on</>) : 'Mic is off'}
            </button>
            <button className={`toggle ${camOn ? '' : 'off'}`} aria-pressed={camOn}
              onClick={() => (camOn ? cameraOff() : tryCamera())}>
              {camOn ? 'Camera is on' : 'Camera is off'}
            </button>
          </div>
          {(devices.cams.length > 0 || devices.mics.length > 0) && (
            <div className="device-row">
              <select value={camId} onChange={(e) => pickCam(e.target.value)} aria-label="Camera">
                <option value="">Default camera</option>
                {devices.cams.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>{label(d, i, 'Camera')}</option>
                ))}
              </select>
              <select value={micId} onChange={(e) => setMicId(e.target.value)} aria-label="Microphone">
                <option value="">Default microphone</option>
                {devices.mics.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>{label(d, i, 'Microphone')}</option>
                ))}
              </select>
            </div>
          )}
          {devices.cams.length > 0 && !devices.cams.some((d) => d.label) && (
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>
              Turn on the camera once to see device names.
            </p>
          )}
        </div>
        <div className="join-panel">
          <h2>Ready when you are.</h2>
          <p className="hint">Enter a room code from your invite, or start a fresh room and share the code. Rooms hold up to 10 people.</p>
          <div className="code-row">
            <input placeholder="e.g. KJH-4821" maxLength={32} aria-label="Room code"
              value={code} onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && join()} />
            <button className="btn btn-primary" style={{ width: 'auto' }} disabled={joining} onClick={() => join()}>
              {joining ? '…' : 'Join'}
            </button>
          </div>
          <p className="form-err">{err}</p>
          <div className="divider">or</div>
          <button className="btn btn-ghost" style={{ width: '100%' }} disabled={joining}
            onClick={() => join(newRoomCode())}>
            ＋ Start a new room
          </button>
        </div>
      </div>
    </section>
  );
}
