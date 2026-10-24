import { useEffect, useState } from 'react';
import { whoAmI, saveRoom, deleteRoom, roomUrl, WALLS, WALL_CSS, DAYS, SLOTS } from './lib';
import { LANGS } from './useCaptions';

const THEMES = [['plain', 'Plain room'], ['tutoring', 'Tutoring'], ['language', 'Language lesson'], ['meeting', 'Meeting'], ['study', 'Study hall'], ['family', 'Family']];

/** Host-only panel in the lobby: create or edit the rooms you hold. */
export default function MyRoom({ session, onOpen }) {
  const [me, setMe] = useState(null);
  const [edit, setEdit] = useState(null); // room being edited
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const [agree, setAgree] = useState(false);
  const [tab, setTab] = useState('room'); // 'room' | 'studio'
  const pickPhoto = (file) => {
    if (!file) return;
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement('canvas'); const S = 192; c.width = S; c.height = S;
      const side = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
      set('photo', c.toDataURL('image/jpeg', 0.82)); URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const load = () => whoAmI(session.token).then(setMe).catch(() => setMe({ host: false, rooms: [] }));
  useEffect(() => { load(); }, [session.token]);

  if (!me || !me.host) return null;

  const blank = { slug: '', name: '', theme: 'tutoring', locked: true, tipLink: '', payLink: '', payNote: '', translate: false, tagline: '', about: '', aboutLang: 'en-US', priceNote: '', education: '', wall: '', welcome: '', avail: Array(21).fill(0), tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '', photo: '' };
  const save = async () => {
    setBusy(true); setErr('');
    try { await saveRoom(session.token, { ...edit, acceptTerms: agree || !!me.termsAcceptedAt }); setEdit(null); await load(); }
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
        <h3>My rooms {me.studio && <span className="tier">★ STUDIO</span>}</h3>
        {!edit && me.rooms.length < (me.maxRooms || 1) && <button className="wb-btn on" onClick={() => setEdit(blank)}>＋ New room</button>}
      </div>
      {me.rooms.map((r) => (
        <div key={r.slug} className="myroom-row">
          <div>
            <b>{r.name}</b> <span className="muted">· {r.theme} · {r.locked ? 'door locked' : 'door open'}{r.expiresInDays <= 30 ? ` · unused ${r.idleDays} days — archived in ${r.expiresInDays}` : ''}</span>
            <div className="muted mono">{roomUrl(r.slug)}</div>
          </div>
          <div className="myroom-actions">
            <button className="wb-btn" onClick={() => copy(r.slug)}>{copied === r.slug ? 'Copied' : 'Copy link'}</button>
            <button className="wb-btn" onClick={() => setEdit({ ...r })}>Edit</button>
            <button className="btn btn-primary" style={{ padding: '7px 14px', fontSize: 13, width: 'auto' }} onClick={() => onOpen(r.slug)}>Open</button>
          </div>
        </div>
      ))}
      {me.rooms.length === 0 && !edit && <p className="muted" style={{ fontSize: 13.5 }}>You're an invited host. Create your room to get a link you can give students.</p>}
      {edit && (
        <div className="myroom-form">
          {me.studio && (
            <div className="chips" style={{ marginBottom: 12 }}>
              <button className={`chip ${tab === 'room' ? 'on' : ''}`} onClick={() => setTab('room')}>Room</button>
              <button className={`chip ${tab === 'studio' ? 'on' : ''}`} onClick={() => setTab('studio')}>Studio page</button>
            </div>
          )}
          {tab === 'studio' && me.studio ? (
            <>
              <div className="field"><label>Photo</label>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  {edit.photo ? <img src={edit.photo} alt="" style={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover' }} /> : <div className="avatar-sm" style={{ background: 'var(--surface-2)' }} />}
                  <label className="wb-btn" style={{ cursor: 'pointer' }}>Choose<input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => pickPhoto(e.target.files?.[0])} /></label>
                  {edit.photo && <button className="wb-btn" onClick={() => set('photo', '')}>Remove</button>}
                </div></div>
              <div className="field"><label>Tagline — under the room name</label><input value={edit.tagline || ''} maxLength={90} placeholder="Alicia Ortiz · Cuernavaca, México · Spanish, chemistry" onChange={(e) => set('tagline', e.target.value)} /></div>
              <div className="field"><label>About, in your language (guests can translate it)</label>
                <textarea value={edit.about || ''} maxLength={1200} placeholder="Who you are, how you teach, who your lessons are for." onChange={(e) => set('about', e.target.value)} />
                <div className="chips" style={{ marginTop: 6 }}>{LANGS.slice(0, 8).map(([code, label]) => <button key={code} className={`chip ${edit.aboutLang === code ? 'on' : ''}`} onClick={() => set('aboutLang', code)}>{label}</button>)}</div></div>
              <div className="field"><label>Lessons &amp; price, in your words</label><input value={edit.priceNote || ''} maxLength={120} placeholder="$30 per 50-minute lesson · packs of 4 for $110" onChange={(e) => set('priceNote', e.target.value)} /></div>
              <div className="field"><label>Room look</label>
                <div className="swatches">{WALLS.map(([v, l]) => <button key={v} title={l} className={edit.wall === v ? 'on' : ''} style={{ background: WALL_CSS[v] || 'var(--ink)' }} onClick={() => set('wall', v)} />)}</div></div>
              <div className="field"><label>Welcome line — guests see it when they enter; {'{name}'} becomes their name</label><input value={edit.welcome || ''} maxLength={160} placeholder="¡Bienvenido, {name}! Lesson 8 today: the preterite." onChange={(e) => set('welcome', e.target.value)} /></div>
              <div className="field"><label>Usually available ({edit.tz || 'your time zone'}) — morning · afternoon · evening</label>
                <div className="studio-grid">{DAYS.map((d, i) => (
                  <div key={d}><span className="d">{d}</span>{SLOTS.map((sl, k) => <button key={sl} title={`${d} ${sl}`} className={edit.avail?.[i * 3 + k] ? 'on' : ''} onClick={() => { const a = [...(edit.avail || Array(21).fill(0))]; a[i * 3 + k] = a[i * 3 + k] ? 0 : 1; set('avail', a); }} />)}</div>
                ))}</div></div>
              <div className="field"><label>Education &amp; certificates, one per line</label><textarea value={edit.education || ''} maxLength={600} style={{ minHeight: 60 }} placeholder={'M.Sc. Natural Products Chemistry, UAEM, 2023'} onChange={(e) => set('education', e.target.value)} /></div>
              <p className="muted" style={{ fontSize: 12 }}>Everything here is yours and public at your link. Nothing about your students is collected.</p>
            </>
          ) : (<>
          <div className="field"><label>Room link</label>
            <div className="slugrow"><span className="mono muted">{location.origin}/r/</span>
              <input value={edit.slug} maxLength={32} placeholder="ms-ortiz" onChange={(e) => set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} /></div></div>
          <div className="field"><label>Room name</label><input value={edit.name} maxLength={60} placeholder="Spanish with Ms. Ortiz" onChange={(e) => set('name', e.target.value)} /></div>
          <div className="field"><label>Theme</label>
            <div className="chips">{THEMES.map(([v, l]) => <button key={v} className={`chip ${edit.theme === v ? 'on' : ''}`} onClick={() => set('theme', v)}>{l}</button>)}</div></div>
          {edit.theme === 'language' && (
            <div className="field"><label>Language lesson</label>
              <p className="muted" style={{ fontSize: 13, margin: '0 0 8px' }}>Live captions: each person's phone transcribes their own voice on the device and shares the text. No audio leaves anyone's phone.</p>
              <label className="agree" style={{ margin: 0 }}>
                <input type="checkbox" checked={!!edit.translate} onChange={(e) => set('translate', e.target.checked)} />
                <span>Also translate captions. Spoken words are sent <b>as text</b> to a translation service (DeepL) with nothing identifying anyone attached, so each person reads in their own language. Off = captions in the language spoken.</span>
              </label>
            </div>
          )}
          <div className="field"><label>Door</label>
            <div className="chips"><button className={`chip ${edit.locked ? 'on' : ''}`} onClick={() => set('locked', true)}>Locked: guests knock, you admit</button>
              <button className={`chip ${!edit.locked ? 'on' : ''}`} onClick={() => set('locked', false)}>Open: anyone with the link walks in</button></div></div>
          <div className="field"><label>Tip link (optional) — your own PayPal.me, Venmo, Ko-fi, Stripe link…</label><input value={edit.tipLink} placeholder="https://paypal.me/yourname" onChange={(e) => set('tipLink', e.target.value)} /></div>
          <div className="field"><label>Paid door (optional) — your own payment link; guests pay there before you let them in</label><input value={edit.payLink} placeholder="https://…" onChange={(e) => set('payLink', e.target.value)} /></div>
          {edit.payLink && <div className="field"><label>What it costs, in your words</label><input value={edit.payNote} maxLength={80} placeholder="$15 per session, or $50 for four" onChange={(e) => set('payNote', e.target.value)} /></div>}
          </>)}
          {!me.termsAcceptedAt && (
            <label className="agree">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              <span>I'm an adult, I'm responsible for who I let into my room, and I agree to the <a href="/rooms/#trust" target="_blank" rel="noopener">conduct rule</a> and the <a href="https://johnhubert.llc/privacy.html" target="_blank" rel="noopener">privacy policy</a>. Rooms unused for 90 days are archived.</span>
            </label>
          )}
          <p className="form-err">{err}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => { setEdit(null); setErr(''); }}>Cancel</button>
            <button className="btn btn-primary" style={{ width: 'auto', flex: 1 }} disabled={busy || !edit.slug || (!me.termsAcceptedAt && !agree)} onClick={save}>{busy ? '…' : 'Save room'}</button>
            {me.rooms.some((r) => r.slug === edit.slug) && <button className="wb-btn wb-clear" onClick={() => remove(edit.slug)}>Close room</button>}
          </div>
        </div>
      )}
    </div>
  );
}
