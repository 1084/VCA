import { useState } from 'react';
import AuthScreen from './AuthScreen';
import LobbyScreen from './LobbyScreen';
import CallScreen from './CallScreen';

export default function App() {
  const [session, setSession] = useState(null); // { token, email }
  const [call, setCall] = useState(null); // { roomId, stream, micOn, camOn }

  if (!session) return <AuthScreen onAuthed={setSession} />;
  if (!call) return <LobbyScreen email={session.email} onJoin={setCall} />;
  return (
    <CallScreen
      key={call.roomId}
      session={session}
      call={call}
      onLeave={() => setCall(null)}
    />
  );
}
