// Dev-only stand-in for src/lib.js: no backend, no sockets. Used by the
// layout harness (npm run demo) so the call screen can be rendered with
// fake participants at phone sizes. Never imported by the real build.
export { initials, gradFor, roomSlugFromPath, roomUrl, newRoomCode, ROOM_CODE_PATTERN } from '../src/lib.real';
const Q = new URLSearchParams(location.search);
const ROOM = { slug: 'ms-ortiz', name: 'Spanish with Ms. Ortiz', theme: Q.get('lang') === '1' ? 'language' : 'tutoring', translate: Q.get('tr') === '1', locked: Q.get('open') !== '1', tipLink: 'https://paypal.me/ortiz', payLink: Q.get('pay') === '1' ? 'https://paypal.me/ortiz/15' : '', payNote: '$15 per session', hostName: Q.get('host') === '1' ? 'testuser' : 'ortiz' };
const STUDIO = Q.get('studio') === '1' ? { studio: true, tagline: 'Alicia Ortiz · Cuernavaca, México · Spanish, chemistry', about: 'Hola, soy Alicia. Tengo una maestría en Química de Productos Naturales y cinco años enseñando español y química en privado. Mis clases son conversacionales primero; la gramática llega cuando la necesitas.', aboutLang: 'es-ES', priceNote: '$30 per 50-minute lesson · packs of 4 for $110', education: 'M.Sc. Natural Products Chemistry, UAEM, 2023\nB.Sc. Molecular Design, UAEM, 2022', wall: 'forest', welcome: '¡Bienvenido, {name}! Lesson 8 today: the preterite.', avail: [1,0,0, 1,1,0, 1,1,0, 1,1,1, 0,0,0, 0,0,0, 1,0,0], tz: 'America/New_York', photo: '' } : {};
Object.assign(ROOM, STUDIO);
export const roomInfo = async () => ({ ...ROOM, hostPresent: Q.get('away') !== '1', count: 3, startedAt: Date.now() - 120000 });
export const aboutTranslated = async () => ({ text: "Hi, I'm Alicia. I hold a master's in Natural Products Chemistry and have taught Spanish and chemistry privately for five years. Lessons are conversational first; grammar comes when you need it.", translated: true });
export const WALLS = [['', 'Cove'], ['forest', 'Forest'], ['dusk', 'Dusk'], ['clay', 'Clay'], ['slate', 'Slate'], ['plum', 'Plum']];
export const WALL_CSS = { '': '', forest: '#1A2E2A', dusk: '#2B2D44', clay: '#3A2A2A', slate: '#2A3240', plum: '#33223A' };
export const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
export const SLOTS = ['morning', 'afternoon', 'evening'];
export const guestKey = async (slug, name) => ({ token: 'guest', name, room: ROOM });
export const whoAmI = async () => ({ email: 'testuser@example.com', host: true, studio: Q.get('studio') === '1', maxRooms: 1, termsAcceptedAt: null, rooms: Q.get('norooms') === '1' ? [] : [{ ...ROOM, idleDays: 70, expiresInDays: 20 }] });
export const saveRoom = async (t, r) => r;
export const deleteRoom = async () => ({ ok: true });
export const BACKEND_URL = '';
export const STUN_ONLY = [];
export const fetchIceServers = async () => [];
const handlers = {};
export const socket = {
  id: 'me',
  auth: {},
  on: (e, f) => { (handlers[e] ||= []).push(f); },
  off: (e, f) => { handlers[e] = (handlers[e] || []).filter((x) => x !== f); },
  emit: (e, v) => {
    if (e === 'chat') (handlers.chat || []).forEach((f) => f({ id: 'me', from: 'you', text: v }));
    if (e === 'reaction') (handlers.reaction || []).forEach((f) => f({ emoji: v }));
    // fake poll referee
    if (e === 'poll') { const t = { id: 'p' + Date.now(), by: 'me', byName: 'you', question: v.question, options: v.options, counts: v.options.map(() => 0), total: 0, open: true, ts: Date.now() }; socket._poll = t; (handlers.poll || []).forEach((f) => f({ ...t })); }
    if (e === 'poll-vote' && socket._poll) { const t = socket._poll; t.counts[v.option]++; t.total++; (handlers.poll || []).forEach((f) => f({ ...t, counts: [...t.counts] })); }
    if (e === 'poll-close' && socket._poll) { const t = socket._poll; t.open = false; (handlers.poll || []).forEach((f) => f({ ...t, counts: [...t.counts] })); }
  },
  _fakeVotes: (n) => { const t = socket._poll; for (let i = 0; i < n; i++) t.counts[i % t.options.length]++, t.total++; (handlers.poll || []).forEach((f) => f({ ...t, counts: [...t.counts] })); },
  _peerState: (from, s) => (handlers['peer-state'] || []).forEach((f) => f({ from, ...s })),
  connect: () => { (handlers.connect || []).forEach((f) => f()); setTimeout(() => { if (Q.get('knock') === '1') (handlers.knocking || []).forEach((f) => f({ room: ROOM })); else if (Q.get('room') === '1' || Q.get('host') === '1') (handlers['room-state'] || []).forEach((f) => f({ ...ROOM, hostPresent: true })); }, 50); },
  _caption: (c) => (handlers.caption || []).forEach((f) => f(c)),
  _knock: (name) => (handlers.knock || []).forEach((f) => f({ id: 'k' + name, name })),
  disconnect: () => {},
  // test hook: push a message from a fake peer
  _incoming: (from, text) => (handlers.chat || []).forEach((f) => f({ id: from, from, text }))
};
if (typeof window !== 'undefined') window.__demoSocket = socket;
