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
export const aboutTranslated = (slug, to) => api(`r/${encodeURIComponent(slug)}/about?to=${encodeURIComponent(to)}`);
export const WALLS = [['', 'Cove'], ['forest', 'Forest'], ['dusk', 'Dusk'], ['clay', 'Clay'], ['slate', 'Slate'], ['plum', 'Plum']];
export const WALL_CSS = { '': '', forest: '#1A2E2A', dusk: '#2B2D44', clay: '#3A2A2A', slate: '#2A3240', plum: '#33223A' };
export const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
export const SLOTS = ['morning', 'afternoon', 'evening'];
// ---- Walls (Studio rooms): what the room remembers between lessons ----
export const wallList = (token, slug) => api(`r/${encodeURIComponent(slug)}/wall`, { token });
export const wallPin = (token, slug, pin) => api(`r/${encodeURIComponent(slug)}/wall`, { method: 'POST', token, body: pin });
export const wallDone = (token, slug, id) => api(`r/${encodeURIComponent(slug)}/wall/${id}/done`, { method: 'POST', token });
export const wallUrl = (token, slug, id) => api(`r/${encodeURIComponent(slug)}/wall/${id}/url`, { token });
export const wallRemove = (token, slug, id) => api(`r/${encodeURIComponent(slug)}/wall/${id}`, { method: 'DELETE', token });
// Browser → R2 directly, with progress. XHR because fetch has no upload progress.
export const putFile = (url, headers, file, onProgress) => new Promise((resolve, reject) => {
  const x = new XMLHttpRequest(); x.open('PUT', url);
  for (const [k, v] of Object.entries(headers || {})) x.setRequestHeader(k, v);
  x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
  x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error(`Upload failed (${x.status})`)));
  x.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
  x.send(file);
});
// ---- Billing (rent for the room; Stripe hosted Checkout) ----
export const billingStatus = (token) => api('billing/status', { token });
export const billingCheckout = (token, slug, plan) => api('billing/checkout', { method: 'POST', token, body: { slug, plan } });
export const billingPortal = (token, slug) => api('billing/portal', { method: 'POST', token, body: { slug } });
