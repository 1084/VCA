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
  const fs=require('fs'); const log=(m)=>fs.writeSync(1, m+'\n'); const console={log:(...a)=>log(a.join(' ')), error:(...a)=>log('ERR '+a.map(x=>x&&x.stack||x).join(' '))}; const connect = (claims) => new Promise((res, rej) => { const c = Client(url, { auth: { token: jwt.sign(claims, SECRET) } }); c._claims = claims; c.on('connect', () => res(c)); c.on('connect_error', rej); });
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
  const remP = once(g4, 'denied'); const lockedP = once(host, 'room-state'); host.emit('remove', { id: g4.id }); const rm = await remP; assert.strictEqual(rm.reason, 'removed'); console.log('✓ host removed a guest');
  const afterRm = await lockedP; assert.strictEqual(afterRm.locked, true); assert.strictEqual(rooms.get('ms-ortiz').locked, true); console.log('✓ removing someone locked the door');

  // 7b. the removed key can't knock again (host sees nothing); a fresh key can
  const g4b = await connect({ guest: true, room: 'ms-ortiz', name: 'Priya', jti: 'priya-key' });
  // same key id as g4 would need the same token; g4 had no jti, so its identity is name|iat — reuse g4's exact claims via its token
  g4b.disconnect();
  const g4c = Client(url, { auth: { token: g4.io.opts.auth.token } }); await once(g4c, 'connect');
  let sawKnock = false; const kw = () => { sawKnock = true; }; host.on('knock', kw);
  g4c.emit('join', 'ms-ortiz'); const d4 = await once(g4c, 'denied'); assert.strictEqual(d4.reason, 'removed'); await new Promise((r) => setTimeout(r, 80)); assert.strictEqual(sawKnock, false); host.off('knock', kw); g4c.disconnect(); console.log('✓ removed key is refused without a knock');

  // 8. host declines a knock
  const g5 = await connect({ guest: true, room: 'ms-ortiz', name: 'Sam' });
  const k5P = once(host, 'knock'); g5.emit('join', 'ms-ortiz'); const k5 = await k5P;
  const d5P = once(g5, 'denied'); host.emit('deny', { id: k5.id }); const d5 = await d5P; assert.strictEqual(d5.reason, 'host-declined'); console.log('✓ declined knock');

  // 9. a guest the host let in (g2, Jamie) drops and reconnects: back in without a knock
  let knockAgain = false; const kw2 = () => { knockAgain = true; }; host.on('knock', kw2);
  const g2tok = g2.io.opts.auth.token; g2.disconnect(); await new Promise((r) => setTimeout(r, 60));
  const g2b = Client(url, { auth: { token: g2tok } }); await once(g2b, 'connect');
  const adP = once(g2b, 'admitted'); const pe = once(g2b, 'peers'); g2b.emit('join', 'ms-ortiz'); await adP; await pe;
  await new Promise((r) => setTimeout(r, 80)); assert.strictEqual(knockAgain, false); host.off('knock', kw2); console.log('✓ admitted guest reconnects without knocking');
  // ...but not once removed: remove the reconnected Jamie, and the same key is refused
  const rm2P = once(g2b, 'denied'); host.emit('remove', { id: g2b.id }); await rm2P;
  const g2c = Client(url, { auth: { token: g2tok } }); await once(g2c, 'connect');
  g2c.emit('join', 'ms-ortiz'); const d2c = await once(g2c, 'denied'); assert.strictEqual(d2c.reason, 'removed'); g2c.disconnect(); console.log('✓ removal wins over an earlier admission');

  [host, g2b, g5].forEach((c) => c.disconnect()); io.close(); server.close();
  console.log('all door tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
