import { useEffect, useRef, useState } from 'react';
import { socket, wallList, wallPin, wallDone, wallUrl, wallRemove, putFile } from './lib';

// The wall of a Studio room: short videos, files to review, homework,
// hand-ins and messages. Room-only. Hosts pin; students hand in and leave
// messages. Same component on desktop (side panel) and phone (sheet).

const KIND_LABEL = { video: 'Video', file: 'File', homework: 'Homework', handin: 'Hand-in', message: 'Message' };
const KIND_ICON = { video: '🎬', file: '📄', homework: '📝', handin: '📥', message: '💬' };
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtDate = (d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtDue = (d) => { const due = new Date(d); const days = Math.ceil((due - Date.now()) / 86400000); return days < 0 ? `was due ${fmtDate(d)}` : days === 0 ? 'due today' : days === 1 ? 'due tomorrow' : `due ${fmtDate(d)}`; };
const ACCEPT = { video: 'video/mp4,video/webm,video/quicktime', any: '.pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.csv,.mp3,.m4a,.wav,.mp4,.webm,.mov,.zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.pages,.numbers,.key' };

export default function Wall({ slug, token, isHost, phone, onToast }) {
  const [pins, setPins] = useState(null);
  const [uploads, setUploads] = useState(true);
  const [limits, setLimits] = useState({});
  const [mode, setMode] = useState(null);     // composer: 'video' | 'file' | 'homework' | 'message' | 'handin'
  const [busy, setBusy] = useState(null);     // upload progress 0..1, or null
  const [err, setErr] = useState('');
  const timer = useRef(null);

  const load = async () => {
    try { const j = await wallList(token, slug); setPins(j.pins); setUploads(j.uploads); setLimits(j.limits || {}); }
    catch (e) { setErr(e.message); setPins([]); }
  };
  useEffect(() => { load(); }, [slug]);
  useEffect(() => {
    const onChanged = () => { clearTimeout(timer.current); timer.current = setTimeout(load, 300); };
    socket.on('wall-changed', onChanged);
    return () => { socket.off('wall-changed', onChanged); clearTimeout(timer.current); };
  }, [slug]);

  const open = async (p) => {
    if (!p.hasFile) { if (p.link) window.open(p.link, '_blank', 'noopener'); return; }
    try { const { url } = await wallUrl(token, slug, p.id); window.open(url, '_blank', 'noopener'); }
    catch (e) { onToast?.(e.message); }
  };
  const remove = async (p) => {
    const what = p.kind === 'message' ? 'this message' : `"${p.title || p.name || KIND_LABEL[p.kind]}"`;
    if (!confirm(`Take ${what} down from the wall?`)) return;
    try { await wallRemove(token, slug, p.id); setPins((ps) => ps.filter((x) => x.id !== p.id)); } catch (e) { onToast?.(e.message); }
  };

  const submit = async ({ kind, title, text, link, due, file }) => {
    setErr(''); setBusy(file ? 0 : null);
    try {
      const body = { kind, title, text, link, due, file: file ? { name: file.name, type: file.type || 'application/octet-stream', size: file.size } : undefined };
      const r = await wallPin(token, slug, body);
      if (r.upload) {
        await putFile(r.upload, r.uploadHeaders, file, (k) => setBusy(k));
        await wallDone(token, slug, r.pin.id);
      }
      setMode(null); setBusy(null); await load();
      onToast?.(kind === 'message' ? 'Left on the wall' : kind === 'handin' ? 'Handed in' : 'Pinned to the wall');
    } catch (e) { setBusy(null); setErr(e.message); }
  };

  const actions = isHost
    ? [['video', 'Video', 'A short clip, MP4 or a link'], ['file', 'File', 'Something to review or grade'], ['homework', 'Homework', 'An assignment with a due date'], ['message', 'Message', 'A note for the room']]
    : [['message', 'Message', 'A thank-you, a question, a review'], ['handin', 'Hand in', 'Homework or a file for review']];

  const groups = pins ? ['homework', 'video', 'file', 'handin', 'message'].map((k) => [k, pins.filter((p) => p.kind === k)]).filter(([, l]) => l.length) : [];

  return (
    <div className={`wall ${phone ? 'phone' : ''}`}>
      {!mode && (
        <div className="wall-actions">
          {actions.map(([k, label, hint]) => (
            <button key={k} className="wall-act" onClick={() => setMode(k)} title={hint}><span>{KIND_ICON[k]}</span>{label}</button>
          ))}
        </div>
      )}
      {mode && <Composer kind={mode} isHost={isHost} uploads={uploads} limits={limits} busy={busy} err={err} onCancel={() => { setMode(null); setErr(''); }} onSubmit={submit} />}
      {!mode && err && <p className="wall-err">{err}</p>}
      {pins === null ? <p className="wall-empty">Looking at the wall…</p>
        : pins.length === 0 ? <p className="wall-empty">{isHost ? 'Nothing on the wall yet. Pin a video, a file, homework or a note; your students see it every time they come in.' : 'Nothing on the wall yet.'}</p>
        : groups.map(([k, list]) => (
          <section key={k} className="wall-group">
            <h4>{KIND_ICON[k]} {KIND_LABEL[k]}{list.length > 1 ? 's' : ''}{k === 'handin' && isHost ? ' · to review' : ''}</h4>
            {list.map((p) => (
              <article key={p.id} className={`pin ${p.kind}`}>
                <button className="pin-main" onClick={() => open(p)} disabled={!p.hasFile && !p.link}>
                  {p.kind === 'message'
                    ? <p className="pin-msg">{p.text}</p>
                    : <>
                      <b>{p.title || p.name || KIND_LABEL[p.kind]}</b>
                      {p.text && <p className="pin-text">{p.text}</p>}
                      <small>
                        {p.kind === 'homework' && p.due && <span className={new Date(p.due) < Date.now() ? 'late' : 'due'}>{fmtDue(p.due)}</span>}
                        {p.hasFile && <span>{p.name}{p.size ? ` · ${fmtSize(p.size)}` : ''}</span>}
                        {!p.hasFile && p.link && <span>{new URL(p.link).hostname.replace(/^www\./, '')} ↗</span>}
                      </small>
                    </>}
                  <small className="pin-by">{p.host ? (isHost ? 'you' : p.by) : p.by}{p.mine && !p.host ? ' (you)' : ''} · {fmtDate(p.ts)}</small>
                </button>
                {(isHost || p.mine) && <button className="pin-x" onClick={() => remove(p)} aria-label="Take down">×</button>}
              </article>
            ))}
          </section>
        ))}
    </div>
  );
}

function Composer({ kind, isHost, uploads, limits, busy, err, onCancel, onSubmit }) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const [due, setDue] = useState('');
  const [file, setFile] = useState(null);
  const fileRef = useRef(null);
  const wantsFile = kind !== 'message';
  const isVideo = kind === 'video';
  const max = isVideo ? limits.video : limits.file;
  const tooBig = file && max && file.size > max;
  const valid = kind === 'message' ? text.trim().length > 0 : (title.trim() || file || link.trim()) && !tooBig;
  const uploading = typeof busy === 'number';
  const heading = { video: 'Pin a video', file: 'Pin a file', homework: 'Set homework', message: isHost ? 'Leave a note' : 'Leave a message', handin: 'Hand in your work' }[kind];
  return (
    <form className="wall-compose" onSubmit={(e) => { e.preventDefault(); if (valid && !uploading) onSubmit({ kind, title: title.trim(), text: text.trim(), link: link.trim(), due: due || undefined, file }); }}>
      <h4>{heading}</h4>
      {kind !== 'message' && <input autoFocus placeholder={kind === 'homework' ? 'Assignment, e.g. Preterite story' : kind === 'handin' ? 'What is this? e.g. Homework 3' : 'Title'} maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />}
      <textarea placeholder={kind === 'message' ? (isHost ? 'A note everyone in the room will see' : 'Thank you, a question, how the lesson went…') : kind === 'homework' ? 'Instructions' : 'A note (optional)'} maxLength={kind === 'message' ? 300 : 1200} rows={kind === 'message' ? 4 : 3} value={text} onChange={(e) => setText(e.target.value)} autoFocus={kind === 'message'} />
      {kind === 'homework' && <label className="wall-due">Due <input type="date" value={due} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDue(e.target.value)} /></label>}
      {wantsFile && (
        <div className="wall-file">
          {uploads ? (
            <>
              <input ref={fileRef} type="file" hidden accept={isVideo ? ACCEPT.video : ACCEPT.any} onChange={(e) => setFile(e.target.files?.[0] || null)} />
              <button type="button" className="btn btn-ghost" onClick={() => fileRef.current?.click()}>{file ? 'Change file' : isVideo ? 'Choose a video' : 'Choose a file'}</button>
              {file && <span className={`wall-fname ${tooBig ? 'late' : ''}`}>{file.name} · {fmtSize(file.size)}{tooBig ? ` — over the ${fmtSize(max)} limit` : ''}</span>}
              {!file && max && <span className="wall-hint">Up to {fmtSize(max)}</span>}
            </>
          ) : <span className="wall-hint">Uploads are not set up yet; pin a link instead.</span>}
        </div>
      )}
      {(isVideo || kind === 'file' || kind === 'homework') && !file && <input placeholder={isVideo ? 'or paste a link (YouTube, Loom, Drive)' : 'or paste a link (optional)'} value={link} onChange={(e) => setLink(e.target.value)} inputMode="url" />}
      {uploading && <div className="wall-prog"><div style={{ width: `${Math.round(busy * 100)}%` }} /></div>}
      {err && <p className="wall-err">{err}</p>}
      <div className="wall-compose-btns">
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={uploading}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={!valid || uploading}>{uploading ? `Uploading ${Math.round(busy * 100)}%` : kind === 'handin' ? 'Hand in' : kind === 'message' ? 'Leave it' : 'Pin it'}</button>
      </div>
    </form>
  );
}
