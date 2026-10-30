import { useEffect, useState } from 'react';
import { roomInfo, guestKey, initials, gradFor, aboutTranslated, WALL_CSS, DAYS } from './lib';

/**
 * The door to a named room, for guests. No account: a name is enough.
 * Shows what anyone may see from outside — whether the host is in, how many
 * people are inside, the host's payment note — then asks for a guest key
 * and hands the call to CallScreen, which knocks if the door is locked.
 */
export default function RoomEntry({ slug, onEnter, session }) {
  const [room, setRoom] = useState(null);
  const [err, setErr] = useState('');
  const [name, setName] = useState(() => { try { return localStorage.getItem('cove-guest-name') || ''; } catch { return ''; } });
  const [busy, setBusy] = useState(false);
  const [about, setAbout] = useState(null); // { text, translated }
  const myLang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  const toggleAbout = async () => {
    if (about?.translated) return setAbout(null);
    try { setAbout(await aboutTranslated(slug, myLang)); } catch { /* keep original */ }
  };

  const refresh = () => roomInfo(slug).then((r) => { setRoom(r); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { refresh(); const t = setInterval(refresh, 10000); return () => clearInterval(t); }, [slug]);

  const enter = async () => {
    setBusy(true); setErr('');
    try {
      let token = session?.token, email = session?.email;
      if (!token) {
        const k = await guestKey(slug, name.trim());
        token = k.token; email = `${k.name}@guest`;
        try { localStorage.setItem('cove-guest-name', k.name); } catch { /* fine */ }
      }
      let stream = null;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { stream = null; }
      onEnter({ token, email, guest: !session }, { roomId: slug, stream, micOn: !!stream, camOn: false, camId: '' });
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  const g = gradFor(room?.hostName || slug);
  const studio = !!room?.studio;
  const wall = studio ? WALL_CSS[room.wall] || '' : '';
  const canTranslate = studio && room.about && room.aboutLang && room.aboutLang.slice(0, 2).toLowerCase() !== myLang;
  const today = (new Date().getDay() + 6) % 7;
  return (
    <section className={`screen door ${studio ? 'studio' : ''}`} style={wall ? { '--wall': wall } : undefined}>
      <div className="door-card">
        <div className="mark"><span className="dot" />Cove</div>
        {!room && !err && <p className="hint" style={{ marginTop: 18 }}>Finding the room…</p>}
        {err && !room && <p className="form-err" style={{ marginTop: 18 }}>{err}</p>}
        {room && (
          <>
            <div className="door-host">
              {studio && room.photo ? <img className="avatar-lg photo" src={room.photo} alt="" /> : <div className="avatar-lg" style={{ background: `linear-gradient(135deg,${g[0]},${g[1]})` }}>{initials(room.hostName)}</div>}
              <div>
                <h2>{room.name}</h2>
                <div className="hint" style={{ margin: 0 }}>{studio && room.tagline ? room.tagline : `Hosted by ${room.hostName}`}</div>
              </div>
            </div>
            <div className={`door-status ${room.hostPresent ? 'in' : 'out'}`}>
              <span className="lamp" />
              {room.hostPresent
                ? <>{room.hostName} is in the room{room.count > 1 ? ` with ${room.count - 1} other${room.count > 2 ? 's' : ''}` : ''}.</>
                : <>{room.hostName} isn't in the room yet. You can wait here; this page checks every few seconds.</>}
            </div>
            {studio && room.about && (
              <div className="door-sec">
                <h4>About {canTranslate && <button className="lnk" onClick={toggleAbout}>{about?.translated ? 'Show original' : 'Translate'}</button>}</h4>
                <p>{about?.text || room.about}</p>
              </div>
            )}
            {studio && room.priceNote && (
              <div className="door-sec"><h4>Lessons</h4><p>{room.priceNote}</p></div>
            )}
            {studio && room.avail?.some(Boolean) && (
              <div className="door-sec">
                <h4>Usually available {room.tz && <span className="mono muted">{room.tz}</span>}</h4>
                <div className="week">{DAYS.map((d, i) => (
                  <div key={d} className={i === today ? 'today' : ''}><span className="d">{d}</span>{[0, 1, 2].map((s) => <i key={s} className={room.avail[i * 3 + s] ? 'on' : ''} />)}</div>
                ))}</div>
                <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>Morning · afternoon · evening, {room.hostName}'s time. A signal, not a booking system: ask in the room or by email.</p>
              </div>
            )}
            {studio && room.education && (
              <div className="door-sec"><h4>Education</h4><p style={{ whiteSpace: 'pre-line' }}>{room.education}</p></div>
            )}
            {room.payLink && (
              <div className="door-pay">
                <b>Pay the teacher</b>
                <span>{(room.payNote || 'This room has a paid door').replace(/[.]?$/, '.')} Pay through {room.hostName}'s own link, then knock. Nothing is charged until {room.hostName} is in the room and lets you in.</span>
                <a className="btn btn-ghost" href={room.payLink} target="_blank" rel="noopener noreferrer">Open {room.hostName}'s payment link ↗</a>
              </div>
            )}
            {!session && (
              <div className="field" style={{ marginTop: 18 }}>
                <label>Your name, as the room should see it</label>
                <input value={name} maxLength={32} placeholder="e.g. Jamie" onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && name.trim() && enter()} />
              </div>
            )}
            <p className="form-err">{err}</p>
            <button className="btn btn-primary" disabled={busy || (!session && !name.trim())} onClick={enter}>
              {busy ? '…' : room.locked ? (room.hostPresent ? 'Knock' : 'Wait at the door') : 'Enter the room'}
            </button>
            <p className="hint" style={{ marginTop: 14, fontSize: 12.5 }}>
              No download, no account. Your microphone will be asked for; the camera stays off until you turn it on inside.
              By entering you agree to the <a href="/rooms/conduct.html" target="_blank" rel="noopener">conduct rule</a>.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
