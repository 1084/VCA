import { useEffect, useState } from 'react';
import { whoAmI, saveRoom, deleteRoom, roomUrl } from './lib';

const THEMES = [['plain', 'Plain room'], ['tutoring', 'Tutoring'], ['meeting', 'Meeting'], ['study', 'Study hall'], ['family', 'Family']];

/** Host-only panel in the lobby: create or edit the rooms you hold. */
export default function MyRoom({ session, onOpen }) {
  const [me, setMe] = useState(null);
  const [edit, setEdit] = useState(null); // room being edited
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');

  const load = () => whoAmI(session.token).then(setMe).catch(() => setMe({ host: false, rooms: [] }));
  useEffect(() => { load(); }, [session.token]);

  if (!me || !me.host) return null;

  const blank = { slug: '', name: '', theme: 'tutoring', locked: true, tipLink: '', payLink: '', payNote: '' };
  const save = async () => {
    setBusy(true); setErr('');
    try { await saveRoom(session.token, edit); setEdit(null); await load(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const remove = async (slug) => {
    if (!window.confirm(`Close the room "${slug}" for good? Its link stops working.`)) return;
    await deleteRoom(session.token, slug); await load();
  };
  const copy = (slug) => navigator.clipboard?.writeText(roomUrl(slug)).then(() => { setCopied(slug); setTimeout(() => setCopied(''), 1500); });
  const set = (k, v) => setEdit((e) => ({ ...e, [k]: v }));

  return (
    <div className="myroom">
      <div className="myroom-head">
        <h3>My rooms</h3>
        {!edit && me.rooms.length < 3 && <button className="wb-btn on" onClick={() => setEdit(blank)}>＋ New room</button>}
      </div>
      {me.rooms.map((r) => (
        <div key={r.slug} className="myroom-row">
          <div>
            <b>{r.name}</b> <span className="muted">· {r.theme} · {r.locked ? 'door locked' : 'door open'}</span>
            <div className="muted mono">{roomUrl(r.slug)}</div>
          </div>
          <div className="myroom-actions">
            <button className="wb-btn" onClick={() => copy(r.slug)}>{copied === r.slug ? 'Copied' : 'Copy link'}</button>
            <button className="wb-btn" onClick={() => setEdit({ ...r })}>Edit</button>
            <button className="btn btn-primary" style={{ padding: '7px 14px', fontSize: 13, width: 'auto' }} onClick={() => onOpen(r.slug)}>Open</button>
          </div>
        </div>
      ))}
      {me.rooms.length === 0 && !edit && <p className="muted" style={{ fontSize: 13.5 }}>You're an invited host. Create a room to get a link you can give students.</p>}
      {edit && (
        <div className="myroom-form">
          <div className="field"><label>Room link</label>
            <div className="slugrow"><span className="mono muted">{location.origin}/r/</span>
              <input value={edit.slug} maxLength={32} placeholder="ms-ortiz" onChange={(e) => set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} /></div></div>
          <div className="field"><label>Room name</label><input value={edit.name} maxLength={60} placeholder="Spanish with Ms. Ortiz" onChange={(e) => set('name', e.target.value)} /></div>
          <div className="field"><label>Theme</label>
            <div className="chips">{THEMES.map(([v, l]) => <button key={v} className={`chip ${edit.theme === v ? 'on' : ''}`} onClick={() => set('theme', v)}>{l}</button>)}</div></div>
          <div className="field"><label>Door</label>
            <div className="chips"><button className={`chip ${edit.locked ? 'on' : ''}`} onClick={() => set('locked', true)}>Locked: guests knock, you admit</button>
              <button className={`chip ${!edit.locked ? 'on' : ''}`} onClick={() => set('locked', false)}>Open: anyone with the link walks in</button></div></div>
          <div className="field"><label>Tip link (optional) — your own PayPal.me, Venmo, Ko-fi, Stripe link…</label><input value={edit.tipLink} placeholder="https://paypal.me/yourname" onChange={(e) => set('tipLink', e.target.value)} /></div>
          <div className="field"><label>Paid door (optional) — your own payment link; guests pay there before you let them in</label><input value={edit.payLink} placeholder="https://…" onChange={(e) => set('payLink', e.target.value)} /></div>
          {edit.payLink && <div className="field"><label>What it costs, in your words</label><input value={edit.payNote} maxLength={80} placeholder="$15 per session, or $50 for four" onChange={(e) => set('payNote', e.target.value)} /></div>}
          <p className="form-err">{err}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => { setEdit(null); setErr(''); }}>Cancel</button>
            <button className="btn btn-primary" style={{ width: 'auto', flex: 1 }} disabled={busy || !edit.slug} onClick={save}>{busy ? '…' : 'Save room'}</button>
            {me.rooms.some((r) => r.slug === edit.slug) && <button className="wb-btn wb-clear" onClick={() => remove(edit.slug)}>Close room</button>}
          </div>
        </div>
      )}
    </div>
  );
}
