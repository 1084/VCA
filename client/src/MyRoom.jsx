import { useEffect, useState } from 'react';
import { whoAmI, saveRoom, deleteRoom, roomUrl, WALLS, WALL_CSS, DAYS, SLOTS, billingStatus, billingCheckout, billingPortal, billingUpgrade, connectStatus, connectOnboard, connectDashboard, dollars } from './lib';
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
  // Photo: the host frames the crop (drag to move, slider to zoom) before it's
  // shrunk to a 192px JPEG. The default frame favours the top of a portrait,
  // where faces are, rather than the dead centre.
  const [crop, setCrop] = useState(null); // { img, url, zoom, x, y } while framing
  const pickPhoto = (file) => {
    if (!file) return;
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => { const portrait = img.height > img.width; setCrop({ img, url, zoom: 1, x: 0.5, y: portrait ? 0.3 : 0.5 }); };
    img.src = url;
  };
  const cropBox = (c) => { // source square for the current frame
    const side = Math.min(c.img.width, c.img.height) / c.zoom;
    const sx = Math.min(Math.max(c.x * c.img.width - side / 2, 0), c.img.width - side);
    const sy = Math.min(Math.max(c.y * c.img.height - side / 2, 0), c.img.height - side);
    return { sx, sy, side };
  };
  const applyCrop = () => {
    const c = crop; const { sx, sy, side } = cropBox(c);
    const cv = document.createElement('canvas'); const S = 192; cv.width = S; cv.height = S;
    cv.getContext('2d').drawImage(c.img, sx, sy, side, side, 0, 0, S, S);
    set('photo', cv.toDataURL('image/jpeg', 0.82)); URL.revokeObjectURL(c.url); setCrop(null);
  };
  const dragRef = { on: false, px: 0, py: 0 };
  const cropDrag = (e) => {
    if (e.type === 'pointerdown') { dragRef.on = true; dragRef.px = e.clientX; dragRef.py = e.clientY; e.currentTarget.setPointerCapture(e.pointerId); return; }
    if (e.type === 'pointerup' || e.type === 'pointercancel') { dragRef.on = false; return; }
    if (!dragRef.on) return;
    const box = e.currentTarget.getBoundingClientRect(); const { side } = cropBox(crop);
    const dx = (e.clientX - dragRef.px) / box.width * side / crop.img.width, dy = (e.clientY - dragRef.py) / box.height * side / crop.img.height;
    dragRef.px = e.clientX; dragRef.py = e.clientY;
    setCrop((c) => ({ ...c, x: Math.min(1, Math.max(0, c.x - dx)), y: Math.min(1, Math.max(0, c.y - dy)) }));
  };
  const cropStyle = () => { const { sx, sy, side } = cropBox(crop); const k = 240 / side; return { width: crop.img.width * k, height: crop.img.height * k, marginLeft: -sx * k, marginTop: -sy * k }; };

  const load = () => whoAmI(session.token).then(setMe).catch((e) => { if (/^Unauthorized$|\(401\)/.test(e.message || '')) { try { sessionStorage.removeItem('cove.session'); } catch {} location.replace('/'); } else setMe({ host: false, rooms: [] }); });
  useEffect(() => { load(); }, [session.token]);

  // ---- rent: what each room is paid through, and the two things for sale ----
  const [bill, setBill] = useState(null);
  const [rentMsg, setRentMsg] = useState(() => { const p = new URLSearchParams(location.search); const q = p.get('rent'); return p.get('upgrade') === 'done' ? 'Your room is becoming a Studio…' : q === 'paid' ? 'Thank you — the rent is in.' : q === 'cancelled' ? 'No charge was made.' : ''; });
  const [billErr, setBillErr] = useState('');
  const loadBill = (sync = false) => billingStatus(session.token, sync).then((b) => { setBill(b); setBillErr(''); }).catch((e) => { setBill(null); setBillErr(e.message || 'Could not load rent status'); });
  useEffect(() => { loadBill(/upgrade=|rent=|billing=/.test(location.search)); if (/rent=|upgrade=|billing=|payments=/.test(location.search)) history.replaceState(null, '', '/'); }, [session.token, me?.rooms?.length]);
  // Coming back from Stripe with the Back button (or from another tab): nothing is stuck on
  // "Opening…", and the tier and payment status are asked for again, Stripe first.
  useEffect(() => {
    const back = () => { setRenting(''); setPayBusy(false); setRentErr(''); setPayErr(''); loadBill(true); loadPay(); load(); };
    const onShow = (e) => { if (e.persisted) back(); };
    const onVis = () => { if (document.visibilityState === 'visible') back(); };
    window.addEventListener('pageshow', onShow); document.addEventListener('visibilitychange', onVis);
    return () => { window.removeEventListener('pageshow', onShow); document.removeEventListener('visibilitychange', onVis); };
  }, [session.token]);
  // after a payment or an upgrade, poll briefly until Stripe's webhook has landed, then settle the message
  useEffect(() => {
    if (rentMsg === 'Thank you — the rent is in.') {
      const paid = bill?.rooms?.some((b) => !b.comped && b.open);
      if (paid) { const t = setTimeout(() => setRentMsg(''), 4000); return () => clearTimeout(t); }
      const t = setTimeout(loadBill, 2500); return () => clearTimeout(t);
    }
    if (rentMsg === 'Your room is becoming a Studio…') {
      if (bill?.rooms?.some((b) => b.studio)) { setRentMsg('Your room is a Studio now: a front-door page, a lesson price at the door, and the Wall. Edit the room to set them up.'); load(); return; }
      const t = setTimeout(() => loadBill(true), 2500); return () => clearTimeout(t);
    }
  }, [rentMsg, bill]);
  const [renting, setRenting] = useState('');
  const [rentErr, setRentErr] = useState('');
  const rent = async (slug, plan) => {
    setRenting(`${slug}:${plan}`); setRentErr('');
    try { const { url } = await billingCheckout(session.token, slug, plan); location.assign(url); } catch (e) { setRentErr(e.message); setRenting(''); }
  };
  const upgrade = async (slug) => {
    setRenting(`${slug}:up`); setRentErr('');
    try { const r = await billingUpgrade(session.token, slug); if (r.url) location.assign(r.url); else { setRenting(''); setRentMsg('Your room is a Studio now.'); await load(); loadBill(); } }
    catch (e) { setRentErr(e.message); setRenting(''); }
  };
  const manage = async (slug) => { setRentErr(''); try { const { url } = await billingPortal(session.token, slug); location.assign(url); } catch (e) { setRentErr(e.message); } };
  const billOf = (slug) => bill?.rooms?.find((b) => b.slug === slug);
  const fmtDay = (d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  // ---- payments between me and my students (Stripe Connect) ----
  const [pay, setPay] = useState(null);
  const [payMsg, setPayMsg] = useState(() => { const q = new URLSearchParams(location.search).get('payments'); return q === 'done' ? 'Stripe has your details. Payments switch on as soon as Stripe finishes its checks, usually within minutes.' : q === 'again' ? 'That setup link expired. Tap Set up payments again.' : ''; });
  const loadPay = () => connectStatus(session.token).then(setPay).catch(() => setPay(null));
  useEffect(() => { loadPay(); if (location.search.includes('payments=')) history.replaceState(null, '', '/'); }, [session.token]);
  const [payBusy, setPayBusy] = useState(false);
  const [payErr, setPayErr] = useState('');
  const goStripe = async (fn) => { setPayBusy(true); setPayErr(''); try { const { url } = await fn(session.token); location.assign(url); } catch (e) { setPayErr(e.message); setPayBusy(false); } };
  if (!me || !me.host) return null;

  const blank = { slug: '', name: '', theme: 'tutoring', locked: true, tipLink: '', payLink: '', payNote: '', translate: false, tagline: '', about: '', aboutLang: 'en-US', priceNote: '', lessonPrice: 0, tipsOn: true, education: '', wall: '', welcome: '', avail: Array(21).fill(0), tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '', photo: '' };
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
            {pay?.ready && !pay.payoutsReady && !r.tipLink && <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>Students have no way to tip you yet: set up payments below, or add a tip link under Edit.</div>}
            {bill && billOf(r.slug) && (() => { const b = billOf(r.slug); return (
              <div className="rent">
                <span className="muted">{b.comped ? 'Rent: on us.' : b.plan === 'trial' && b.open ? `First month on us, through ${fmtDay(b.paidThrough)}. Rent before then and the door stays open.` : b.open ? `${b.plan === 'studio' ? 'Studio' : b.plan === 'day' ? 'Day pass' : 'Room'} paid through ${fmtDay(b.paidThrough)}${b.subscription ? ' · renews monthly' : b.plan === 'day' ? '' : ' · not renewing'}.` : `Rent lapsed ${fmtDay(b.paidThrough)} — the door is closed until you rent.`}</span>
                {bill.ready && (
                  <span className="rent-btns">
                    {!b.subscription && <button className="wb-btn" disabled={!!renting} onClick={() => rent(r.slug, 'month')}>{renting === `${r.slug}:month` ? 'Opening Stripe…' : `Room · $${bill.prices.month}/mo`}</button>}
                    {!b.subscription && bill.studioReady && !r.studio && <button className="wb-btn" disabled={!!renting} onClick={() => rent(r.slug, 'studio')}>{renting === `${r.slug}:studio` ? 'Opening Stripe…' : `Studio · $${bill.prices.studio}/mo`}</button>}
                    {!r.studio && (b.subscription || b.comped) && <button className="wb-btn" disabled={!!renting} onClick={() => upgrade(r.slug)} title={b.comped ? 'Front-door page, lesson price at the door, and the Wall' : `Switch your lease to Studio ($${bill.prices.studio}/mo): front-door page, lesson price at the door, and the Wall`}>{renting === `${r.slug}:up` ? 'Opening…' : b.comped ? 'Upgrade to Studio' : `Upgrade to Studio · $${bill.prices.studio}/mo`}</button>}
                    <button className="wb-btn" disabled={!!renting} onClick={() => rent(r.slug, 'day')}>{renting === `${r.slug}:day` ? 'Opening Stripe…' : `Day pass · $${bill.prices.day}`}</button>
                    {b.subscription && <button className="wb-btn" onClick={() => manage(r.slug)} title="Change plan, card, or cancel">Billing</button>}
                  </span>
                )}
              </div>
            ); })()}
          </div>
          <div className="myroom-actions">
            <button className="wb-btn" onClick={() => copy(r.slug)}>{copied === r.slug ? 'Copied' : 'Copy link'}</button>
            <button className="wb-btn" onClick={() => setEdit({ ...r })}>Edit</button>
            <button className="btn btn-primary" style={{ padding: '7px 14px', fontSize: 13, width: 'auto' }} onClick={() => onOpen(r.slug)}>Open</button>
          </div>
        </div>
      ))}
      {billErr && <p className="rent-msg warn">Rent status: {billErr}. <button className="ghost" onClick={loadBill}>Retry</button></p>}
      {pay?.ready && (
        <div className="pay-card">
          {pay.payoutsReady ? (
            <>
              <div><b>Payments on.</b> Students tip in the room{me.studio ? ' and pay the lesson price at the door' : ''}; it lands in your own Stripe account. {pay.feeNote && <span className="muted">{pay.feeNote}.</span>}</div>
              <div className="muted">This month: {pay.month.tipCount} tip{pay.month.tipCount === 1 ? '' : 's'} ({dollars(pay.month.tips)}) · {pay.month.lessonCount} lesson{pay.month.lessonCount === 1 ? '' : 's'} ({dollars(pay.month.lessons)}), before Stripe's fee.</div>
              <div className="row-btns"><button className="wb-btn" disabled={payBusy} onClick={() => goStripe(connectDashboard)} title="Your own Stripe account: payments, payouts, refunds, tax forms">Stripe dashboard</button></div>
            </>
          ) : pay.hasAccount ? (
            <>
              <div><b>Payments: almost.</b> Stripe is still checking your details, or needs one more thing from you (it may also email you to finish setting a Stripe password).</div>
              <div className="row-btns"><button className="wb-btn" disabled={payBusy} onClick={() => goStripe(connectOnboard)}>{payBusy ? 'Opening Stripe…' : 'Finish setup'}</button><button className="wb-btn" onClick={loadPay}>Check again</button></div>
            </>
          ) : (
            <>
              <div><b>Take tips and lesson payments in the room.</b> Students pay with Apple Pay, Google Pay or a card without leaving the page; the money goes to your own Stripe account, and Cove takes no cut. Stripe charges you its card fee (2.9% + 30¢){pay.feeNote ? `, and your lease carries ${pay.feeNote}` : ''}.</div>
              <div className="row-btns"><button className="btn btn-primary" style={{ width: 'auto', padding: '8px 14px', fontSize: 13 }} disabled={payBusy} onClick={() => goStripe(connectOnboard)}>{payBusy ? 'Opening Stripe…' : 'Set up payments'}</button></div>
            </>
          )}
          {payErr && <div className="wall-err">{/^(Load failed|Failed to fetch|NetworkError)/.test(payErr) ? "Cove's server didn't answer. Try again in a moment." : payErr}</div>}
          {payMsg && <div className="muted">{payMsg} <button className="ghost" onClick={() => setPayMsg('')} aria-label="Dismiss">×</button></div>}
        </div>
      )}
      {rentErr && <p className="rent-msg warn">{rentErr} <button className="ghost" onClick={() => setRentErr('')} aria-label="Dismiss">×</button></p>}
      {rentMsg && <p className="rent-msg">{rentMsg} <button className="ghost" onClick={() => setRentMsg('')} aria-label="Dismiss">×</button></p>}
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
                </div>
                {crop && (
                  <div className="cropper">
                    <div className="frame" onPointerDown={cropDrag} onPointerMove={cropDrag} onPointerUp={cropDrag} onPointerCancel={cropDrag}>
                      <img src={crop.url} alt="" draggable={false} style={cropStyle()} />
                      <div className="ring" />
                    </div>
                    <div className="tools">
                      <input type="range" min={1} max={3} step={0.01} value={crop.zoom} onChange={(e) => setCrop((c) => ({ ...c, zoom: +e.target.value }))} aria-label="Zoom" />
                      <small>Drag to move · slide to zoom</small>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="wb-btn" onClick={() => { URL.revokeObjectURL(crop.url); setCrop(null); }}>Cancel</button>
                        <button className="btn btn-primary" style={{ padding: '7px 14px', width: 'auto', fontSize: 13 }} onClick={applyCrop}>Use this</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <div className="field"><label>Tagline — under the room name</label><input value={edit.tagline || ''} maxLength={90} placeholder="Alicia Ortiz · Cuernavaca, México · Spanish, chemistry" onChange={(e) => set('tagline', e.target.value)} /></div>
              <div className="field"><label>About, in your language (guests can translate it)</label>
                <textarea value={edit.about || ''} maxLength={1200} placeholder="Who you are, how you teach, who your lessons are for." onChange={(e) => set('about', e.target.value)} />
                <div className="chips" style={{ marginTop: 6 }}>{LANGS.slice(0, 8).map(([code, label]) => <button key={code} className={`chip ${edit.aboutLang === code ? 'on' : ''}`} onClick={() => set('aboutLang', code)}>{label}</button>)}</div></div>
              <div className="field"><label>Lessons &amp; price, in your words</label><input value={edit.priceNote || ''} maxLength={120} placeholder="$30 per 50-minute lesson · packs of 4 for $110" onChange={(e) => set('priceNote', e.target.value)} /></div>
              {pay?.payoutsReady && (
                <div className="field"><label>Lesson price at the door (leave 0 for none)</label>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <span>$</span><input style={{ width: 100 }} inputMode="decimal" value={edit.lessonPrice ? (edit.lessonPrice / 100).toString() : ''} placeholder="0" onChange={(e) => set('lessonPrice', Math.min(50000, Math.round((Number(e.target.value.replace(/[^\d.]/g, '')) || 0) * 100)))} />
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={edit.tipsOn !== false} onChange={(e) => set('tipsOn', e.target.checked)} /> Tips on in the room</label>
                  </div>
                  <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>With a price, students pay before they knock and the knock shows it. Without one, they just knock.</p>
                </div>
              )}
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
          <div className="field"><label>Paid door (optional) — your own payment link. Guests are asked to pay there before knocking; Cove can't check it, so it's on trust. For a price that is enforced before the knock, set up payments and (Studio) a lesson price.</label><input value={edit.payLink} placeholder="https://…" onChange={(e) => set('payLink', e.target.value)} /></div>
          {edit.payLink && <div className="field"><label>What it costs, in your words</label><input value={edit.payNote} maxLength={80} placeholder="$15 per session, or $50 for four" onChange={(e) => set('payNote', e.target.value)} /></div>}
          </>)}
          {!me.termsAcceptedAt && (
            <label className="agree">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              <span>I'm an adult, I'm responsible for who I let into my room, and I agree to the <a href="/rooms/terms.html" target="_blank" rel="noopener">terms</a>, the <a href="/rooms/conduct.html" target="_blank" rel="noopener">conduct rule</a> and the <a href="/rooms/privacy.html" target="_blank" rel="noopener">privacy policy</a>. Rooms unused for 90 days are archived.</span>
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
