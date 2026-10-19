// Dev-only stand-in for src/lib.js: no backend, no sockets. Used by the
// layout harness (npm run demo) so the call screen can be rendered with
// fake participants at phone sizes. Never imported by the real build.
export { initials, gradFor } from '../src/lib.real';
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
  connect: () => (handlers.connect || []).forEach((f) => f()),
  disconnect: () => {},
  // test hook: push a message from a fake peer
  _incoming: (from, text) => (handlers.chat || []).forEach((f) => f({ id: from, from, text }))
};
if (typeof window !== 'undefined') window.__demoSocket = socket;
