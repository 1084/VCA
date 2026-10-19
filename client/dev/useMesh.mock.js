// Dev-only stand-in for src/useMesh.js: N fake peers from the URL.
//   ?n=4        number of remote participants (default 2)
//   &video=1    give them moving "video" (canvas streams) instead of avatars
import { useMemo, useRef } from 'react';

const NAMES = ['maya', 'jordan', 'priya', 'luis', 'sam', 'aiko', 'noah', 'zara', 'eli'];

function fakeStream(i) {
  const c = document.createElement('canvas'); c.width = 480; c.height = 640;
  const ctx = c.getContext('2d'); let t = 0;
  const draw = () => {
    t += 0.02;
    const g = ctx.createLinearGradient(0, 0, 480, 640);
    g.addColorStop(0, `hsl(${(i * 47 + t * 20) % 360},45%,35%)`); g.addColorStop(1, '#0c1518');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 480, 640);
    ctx.fillStyle = '#f3dcc4'; ctx.beginPath(); ctx.arc(240 + Math.sin(t) * 20, 300, 90, 0, 7); ctx.fill();
    requestAnimationFrame(draw);
  };
  draw();
  return c.captureStream(24);
}

export default function useMesh(_socket, initialStream) {
  const q = new URLSearchParams(location.search);
  const n = Math.min(9, Math.max(0, +(q.get('n') ?? 2)));
  const video = q.get('video') === '1';
  const localStreamRef = useRef(initialStream);
  const peers = useMemo(() => Object.fromEntries(Array.from({ length: n }, (_, i) => [
    `p${i}`, { name: NAMES[i], stream: video ? fakeStream(i) : null, micOn: i % 3 !== 1, camOn: video, hand: i === 1, sharing: false }
  ])), [n, video]);
  return {
    peers, localStreamRef,
    ensure() {}, remove() {}, closeAll() {}, onDescription() {}, onCandidate() {}, setPeerState() {}, replaceVideo() {}
  };
}
