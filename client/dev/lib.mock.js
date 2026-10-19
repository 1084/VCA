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
  },
  connect: () => (handlers.connect || []).forEach((f) => f()),
  disconnect: () => {},
  // test hook: push a message from a fake peer
  _incoming: (from, text) => (handlers.chat || []).forEach((f) => f({ id: from, from, text }))
};
if (typeof window !== 'undefined') window.__demoSocket = socket;
