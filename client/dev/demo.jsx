// Layout harness: renders the call screen with fake peers and no backend.
//   npm run demo   →  http://localhost:5174/?n=3&video=1&cam=1
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../src/index.css';
import CallScreen from '../src/CallScreen';
import RoomEntry from '../src/RoomEntry';
import LobbyScreen from '../src/LobbyScreen';

const q = new URLSearchParams(location.search);
let stream = null;
if (q.get('cam') === '1') {
  const c = document.createElement('canvas'); c.width = 480; c.height = 640;
  const ctx = c.getContext('2d'); let t = 0;
  const draw = () => { t += .02; ctx.fillStyle = `hsl(${200 + Math.sin(t) * 20},40%,30%)`; ctx.fillRect(0, 0, 480, 640);
    ctx.fillStyle = '#f3dcc4'; ctx.beginPath(); ctx.arc(240, 300 + Math.sin(t * 2) * 10, 100, 0, 7); ctx.fill(); requestAnimationFrame(draw); };
  draw(); stream = c.captureStream(24);
}
const root = ReactDOM.createRoot(document.getElementById('root'));
if (q.get('lobby') === '1') root.render(<LobbyScreen session={{ token: 't', email: 'testuser@example.com' }} email="testuser@example.com" onJoin={() => alert('join')} onSignOut={() => alert('sign out')} />);
else if (q.get('door') === '1') root.render(<RoomEntry slug="ms-ortiz" session={null} onEnter={() => alert('enter')} />);
else root.render(
  <CallScreen session={{ token: 't', email: 'testuser@example.com' }}
    call={{ roomId: 'JYP-3467', stream, micOn: true, camOn: q.get('cam') === '1' }}
    onLeave={() => alert('left')} />
);
