import { io } from 'socket.io-client';

export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';

// ICE servers. STUN alone connects most peers directly; the TURN relay that
// rescues the ~10-20% behind strict NATs is issued by the server per room
// join (GET /api/turn) with a short lifetime, so no relay credential ever
// ships in this bundle. See server/turn.js.
export const STUN_ONLY = [{ urls: 'stun:stun.l.google.com:19302' }];
export async function fetchIceServers(token) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${BACKEND_URL}/api/turn`, {
      headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal
    });
    clearTimeout(t);
    if (!res.ok) return STUN_ONLY;
    const j = await res.json();
    return Array.isArray(j.iceServers) && j.iceServers.length ? j.iceServers : STUN_ONLY;
  } catch {
    return STUN_ONLY; // a call must never be blocked on the relay
  }
}
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

// ---- Cove Rooms API (named rooms, guest keys) ----
async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BACKEND_URL}/api/${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Request failed (${res.status})`);
  return j;
}
export const roomInfo = (slug) => api(`r/${encodeURIComponent(slug)}`);
export const guestKey = (slug, name) => api(`r/${encodeURIComponent(slug)}/guest`, { method: 'POST', body: { name } });
export const whoAmI = (token) => api('me', { token });
export const saveRoom = (token, room) => api('rooms', { method: 'POST', token, body: room });
export const deleteRoom = (token, slug) => api(`rooms/${encodeURIComponent(slug)}`, { method: 'DELETE', token });
export const roomSlugFromPath = () => { const m = location.pathname.match(/^\/r\/([a-z0-9-]{3,32})\/?$/i); return m ? m[1].toLowerCase() : null; };
export const roomUrl = (slug) => `${location.origin}/r/${slug}`;
