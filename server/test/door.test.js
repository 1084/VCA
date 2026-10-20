// Door flow test: runs the real signaling.js against an in-memory stand-in
// for ./rooms (no MongoDB needed). node server/test/door.test.js
const path = require('path');
const assert = require('assert');
const http = require('http');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { io: Client } = require('socket.io-client');

// ---- in-memory Room / Report ----
const rooms = new Map(); const reports = [];
const q = (filter) => [...rooms.values()].find((r) => Object.entries(filter).every(([k, v]) => r[k] === v)) || null;
const chain = (v) => ({ lean: () => ({ catch: () => Promise.resolve(v) }), catch: () => Promise.resolve(v), then: (f) => Promise.resolve(v).then(f) });
const mockRooms = {
  Room: {
    findOne: (f) => chain(q(f)),
    findOneAndUpdate: (f, upd) => { const r = q(f); if (r) Object.assign(r, upd); return chain(r); },
    updateOne: (f, upd) => { const r = q(f); if (r) Object.assign(r, upd); return chain({ ok: 1 }); }
  },
  Report: { create: async (d) => { reports.push(d); } },
  roomIsOpen: (r) => !r.paidThrough || r.paidThrough > Date.now()
};
require.cache[require.resolve('../rooms')] = { id: 'rooms', filename: 'rooms', loaded: true, exports: mockRooms };
const { attachSignaling } = require('../signaling');

const SECRET = 'test';
rooms.set('ms-ortiz', { slug: 'ms-ortiz', name: 'Spanish with Ms. Ortiz', ownerEmail: 'ortiz@example.com', theme: 'tutoring', locked: true, tipLink: 'https://paypal.me/ortiz' });

(async () => {
  const server = http.createServer();
  const io = new Server(server);
  io.use((s, next) => { try { s.user = jwt.verify(s.handshake.auth.token, SECRET); next(); } catch { next(new Error('Unauthorized')); } });
  attachSignaling(io, { maxRoomSize: 10 });
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const fs=require('fs'); const log=(m)=>fs.writeSync(1, m+'\n'); const console={log:(...a)=>log(a.join(' ')), error:(...a)=>log('ERR '+a.map(x=>x&&x.stack||x).join(' '))}; const connect = (claims) => new Promise((res, rej) => { const c = Client(url, { auth: { token: jwt.sign(claims, SECRET) } }); c.on('connect', () => res(c)); c.on('connect_error', rej); });
  const once = (c, ev) => new Promise((r) => c.once(ev, r));

  // 1. guest knocks while host is away → denied host-away
  const g1 = await connect({ guest: true, room: 'ms-ortiz', name: 'Jamie' });
  g1.emit('join', 'ms-ortiz');
  let d = await once(g1, 'denied'); assert.strictEqual(d.reason, 'host-away'); console.log('✓ host away → denied');
  g1.disconnect();

  // 2. host enters a locked room
  const host = await connect({ email: 'ortiz@example.com' });
  const hp = once(host, 'peers'), hs = once(host, 'room-state');
  host.emit('join', 'ms-ortiz');
  await hp; const st = await hs;
  assert.strictEqual(st.hostPresent, true); assert.strictEqual(st.locked, true); console.log('✓ host in, door locked');

  // 3. guest knocks, host sees knock, admits → guest gets peers
  const g2 = await connect({ guest: true, room: 'ms-ortiz', name: 'Jamie' });
  const knockP = once(host, 'knock');
  g2.emit('join', 'ms-ortiz');
  const kn = await once(g2, 'knocking'); assert.strictEqual(kn.room.hostName, 'ortiz');
  const k = await knockP; assert.strictEqual(k.name, 'Jamie'); console.log('✓ knock reached host');
  const peersP = once(g2, 'peers'); const joinedP = once(host, 'peer-joined');
  host.emit('admit', { id: k.id });
  await once(g2, 'admitted'); const peers = await peersP; const j = await joinedP;
  assert.strictEqual(peers.length, 1); assert.strictEqual(j.name, 'Jamie'); assert.strictEqual(j.guest, true); console.log('✓ admitted, introduced as guest');

  // 4. a guest key for another room is refused
  const g3 = await connect({ guest: true, room: 'other', name: 'Mallory' });
  g3.emit('join', 'ms-ortiz'); d = await once(g3, 'denied'); assert.strictEqual(d.reason, 'wrong-room'); console.log('✓ wrong-room key refused'); g3.disconnect();

  // 5. guest cannot unlock; host can
  g2.emit('lock', { locked: false }); await new Promise((r) => setTimeout(r, 100)); assert.strictEqual(rooms.get('ms-ortiz').locked, true);
  const rsP = once(g2, 'room-state'); host.emit('lock', { locked: false }); const rs = await rsP; assert.strictEqual(rs.locked, false); console.log('✓ only the host unlocks');

  // 6. unlocked: guest walks in without knocking
  const g4 = await connect({ guest: true, room: 'ms-ortiz', name: 'Priya' });
  g4.emit('join', 'ms-ortiz'); const p4 = await once(g4, 'peers'); assert.strictEqual(p4.length, 2); console.log('✓ open door: straight in');

  // 7. report stored with words only; host removes someone
  g4.emit('report', { text: 'test report' }); await once(g4, 'reported'); assert.strictEqual(reports[0].from, 'Priya'); assert.strictEqual(reports[0].room, 'ms-ortiz'); console.log('✓ report stored');
  const remP = once(g4, 'denied'); host.emit('remove', { id: g4.id }); const rm = await remP; assert.strictEqual(rm.reason, 'removed'); console.log('✓ host removed a guest');

  // 8. host declines a knock
  host.emit('lock', { locked: true }); await once(host, 'room-state');
  const g5 = await connect({ guest: true, room: 'ms-ortiz', name: 'Sam' });
  const k5P = once(host, 'knock'); g5.emit('join', 'ms-ortiz'); const k5 = await k5P;
  const d5P = once(g5, 'denied'); host.emit('deny', { id: k5.id }); const d5 = await d5P; assert.strictEqual(d5.reason, 'host-declined'); console.log('✓ declined knock');

  [host, g2, g5].forEach((c) => c.disconnect()); io.close(); server.close();
  console.log('all door tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
