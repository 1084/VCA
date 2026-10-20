import { useState } from 'react';
import AuthScreen from './AuthScreen';
import LobbyScreen from './LobbyScreen';
import CallScreen from './CallScreen';
import RoomEntry from './RoomEntry';
import { roomSlugFromPath } from './lib';

export default function App() {
  const [session, setSession] = useState(null); // { token, email, guest? }
  const [call, setCall] = useState(null); // { roomId, stream, micOn, camOn }
  const [slug] = useState(roomSlugFromPath); // /r/<slug> is a door, no sign-in needed

  // A named-room link: guests get a key at the door; a signed-in host walks through it.
  if (slug && !call) {
    return <RoomEntry slug={slug} session={session} onEnter={(s, c) => { setSession(s); setCall(c); }} />;
  }
  if (!session) return <AuthScreen onAuthed={setSession} />;
  if (!call) return <LobbyScreen session={session} email={session.email} onJoin={setCall} />;
  return (
    <CallScreen
      key={call.roomId}
      session={session}
      call={call}
      onLeave={() => { setCall(null); if (session?.guest) { setSession(null); history.replaceState(null, '', `/r/${call.roomId}`); } }}
    />
  );
}
