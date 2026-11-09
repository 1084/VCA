import { useState } from 'react';
import AuthScreen from './AuthScreen';
import LobbyScreen from './LobbyScreen';
import CallScreen from './CallScreen';
import RoomEntry from './RoomEntry';
import { roomSlugFromPath } from './lib';

// The sign-in lives in this tab's sessionStorage, so a trip to Stripe (rent, Billing, Upgrade,
// payments setup) comes back to the lobby signed in, and so does the Back button. Guests are
// never kept; closing the tab forgets everything; a sign-in older than the token's day is dropped.
const SKEY = 'cove.session';
const restoreSession = () => { try { const s = JSON.parse(sessionStorage.getItem(SKEY)); if (s?.token && !s.guest && Date.now() - (s.at || 0) < 23 * 3600e3) return { token: s.token, email: s.email }; } catch {} return null; };
const keepSession = (s) => { try { if (s && !s.guest) sessionStorage.setItem(SKEY, JSON.stringify({ token: s.token, email: s.email, at: Date.now() })); else sessionStorage.removeItem(SKEY); } catch {} };

export default function App() {
  const [session, setSessionState] = useState(restoreSession); // { token, email, guest? }
  const setSession = (s) => { keepSession(s); setSessionState(s); };
  const [call, setCall] = useState(null); // { roomId, stream, micOn, camOn }
  const [slug] = useState(roomSlugFromPath); // /r/<slug> is a door, no sign-in needed

  // A named-room link: guests get a key at the door; a signed-in host walks through it.
  if (slug && !call) {
    return <RoomEntry slug={slug} session={session} onEnter={(s, c) => { setSession(s); setCall(c); }} />;
  }
  if (!session) return <AuthScreen onAuthed={setSession} />;
  if (!call) return <LobbyScreen session={session} email={session.email} onJoin={setCall} onSignOut={() => { setSession(null); history.replaceState(null, '', '/'); }} />;
  return (
    <CallScreen
      key={call.roomId}
      session={session}
      call={call}
      onLeave={() => { setCall(null); if (session?.guest) { setSession(null); history.replaceState(null, '', `/r/${call.roomId}`); } }}
    />
  );
}
