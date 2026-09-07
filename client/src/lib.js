import { io } from 'socket.io-client';

export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';

// ICE servers. STUN alone connects most peers directly; a TURN relay is
// what rescues the ~10-20% behind strict NATs/firewalls. Configure one
// before real-world testing (see client/.env.example).
const stun = { urls: 'stun:stun.l.google.com:19302' };
const turnUrls = (import.meta.env.VITE_TURN_URLS || '')
  .split(',').map((u) => u.trim()).filter(Boolean);
export const ICE_SERVERS = turnUrls.length
  ? [stun, {
      urls: turnUrls,
      username: import.meta.env.VITE_TURN_USERNAME || '',
      credential: import.meta.env.VITE_TURN_CREDENTIAL || ''
    }]
  : [stun];
export const socket = io(BACKEND_URL, { autoConnect: false });

export const initials = (n = '?') =>
  n.split(/[\s._-]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';

const GRADS = [
  ['#7CCFDE', '#4A7C8A'],
  ['#FFB454', '#C77A2B'],
  ['#B0A7F5', '#6C5FC7'],
  ['#8FE3B0', '#3E9C6B'],
  ['#F5A0C0', '#C25580']
];
export const gradFor = (n = '') =>
  GRADS[[...n].reduce((a, c) => a + c.charCodeAt(0), 0) % GRADS.length];

export const newRoomCode = () => {
  const L = () => String.fromCharCode(65 + ((Math.random() * 26) | 0));
  return `${L()}${L()}${L()}-${1000 + ((Math.random() * 9000) | 0)}`;
};

export const ROOM_CODE_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;
