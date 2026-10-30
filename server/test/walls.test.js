// Wall API test: real walls.js over express with an in-memory Pin and a fake
// store (no MongoDB, no R2). node server/test/walls.test.js
const assert = require('assert');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const { attachWalls } = require('../walls');

const SECRET = 'test';
const rooms = { 'ms-ortiz': { slug: 'ms-ortiz', ownerEmail: 'ortiz@example.com', studio: true }, plain: { slug: 'plain', ownerEmail: 'x@example.com', studio: false } };
const Room = { findOne: (f) => ({ lean: async () => rooms[f.slug] || null }) };

// ---- in-memory Pin ----
let seq = 0; const pins = [];
const match = (f) => (p) => Object.entries(f).every(([k, v]) => (k === '_id' ? String(p._id) === String(v) : p[k] === v));
const proto = { save: async function () { const p = pins.find((x) => x._id === this._id); Object.assign(p, this); } };
const wrap = (p) => p && Object.assign(Object.create(proto), p);
const Pin = {
  find: (f) => ({ sort: () => ({ lean: async () => pins.filter(match(f)).slice().reverse() }), lean: async () => pins.filter(match(f)) }),
  findOne: (f) => { const p = pins.find(match(f)); const r = Promise.resolve(wrap(p)); r.lean = () => ({ catch: () => Promise.resolve(p || null) }); r.catch = (fn) => r.then(undefined, fn); return r; },
  countDocuments: async (f) => pins.filter(match(f)).length,
  aggregate: async ([{ $match }]) => [{ n: pins.filter(match($match)).reduce((a, p) => a + (p.size || 0), 0) }],
  create: async (d) => { const p = { _id: String(++seq), ts: new Date(), ...d }; pins.push(p); return wrap(p); },
  deleteOne: async (f) => { const i = pins.findIndex(match(f)); if (i >= 0) pins.splice(i, 1); },
  deleteMany: async (f) => { for (let i = pins.length - 1; i >= 0; i--) if (match(f)(pins[i])) pins.splice(i, 1); }
};

const objects = new Map(); const deleted = [];
const store = {
  putUrl: async (key) => `https://r2.test/put/${key}`, getUrl: async (key) => `https://r2.test/get/${key}`,
  head: async (key) => (objects.has(key) ? { size: objects.get(key), mime: 'application/pdf' } : null), del: async (key) => deleted.push(key)
};
const emitted = []; const io = { to: (slug) => ({ emit: (ev) => emitted.push(`${slug}:${ev}`) }) };

(async () => {
  const app = express(); app.use(express.json());
  attachWalls(app, io, { secret: SECRET, Room, store, Pin });
  const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}/api/r`;
  const host = jwt.sign({ email: 'ortiz@example.com' }, SECRET);
  const jamie = jwt.sign({ guest: true, room: 'ms-ortiz', name: 'Jamie', jti: 'j1' }, SECRET);
  const sam = jwt.sign({ guest: true, room: 'ms-ortiz', name: 'Sam', jti: 's1' }, SECRET);
  const other = jwt.sign({ guest: true, room: 'plain', name: 'Eve', jti: 'e1' }, SECRET);
  const call = async (tok, path, method = 'GET', body) => {
    const r = await fetch(`${base}/${path}`, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };

  // non-studio room has no wall; a key for another room is refused
  assert.equal((await call(host, 'plain/wall')).status, 404);
  assert.equal((await call(other, 'ms-ortiz/wall')).status, 403);

  // host pins homework (text + due) and a video link
  let r = await call(host, 'ms-ortiz/wall', 'POST', { kind: 'homework', title: 'Preterite story', text: 'Write 10 sentences.', due: '2026-11-07' });
  assert.equal(r.status, 200); assert.equal(r.body.pin.kind, 'homework'); assert.equal(r.body.upload, null);
  r = await call(host, 'ms-ortiz/wall', 'POST', { kind: 'video', title: 'Lesson 3 recap', link: 'https://youtu.be/abc' });
  assert.equal(r.status, 200);
  // host pins a file: gets an upload URL, pin hidden until confirmed
  r = await call(host, 'ms-ortiz/wall', 'POST', { kind: 'file', title: 'Worksheet', file: { name: 'ws.pdf', type: 'application/pdf', size: 1234 } });
  assert.equal(r.status, 200); assert.match(r.body.upload, /^https:\/\/r2.test\/put\/rooms\/ms-ortiz\//); const fileId = r.body.pin.id;
  assert.equal((await call(jamie, 'ms-ortiz/wall')).body.pins.length, 2, 'unconfirmed file is hidden');
  assert.equal((await call(host, `ms-ortiz/wall/${fileId}/done`, 'POST')).status, 409, 'done before upload arrives');
  objects.set(r.body.upload.replace('https://r2.test/put/', ''), 1234);
  assert.equal((await call(host, `ms-ortiz/wall/${fileId}/done`, 'POST')).status, 200);
  assert.equal((await call(jamie, 'ms-ortiz/wall')).body.pins.length, 3);
  // bad mime / too big
  assert.equal((await call(host, 'ms-ortiz/wall', 'POST', { kind: 'video', title: 'x', file: { name: 'a.exe', type: 'application/x-msdownload', size: 10 } })).status, 415);
  assert.equal((await call(host, 'ms-ortiz/wall', 'POST', { kind: 'file', title: 'x', file: { name: 'a.pdf', type: 'application/pdf', size: 26 * 1048576 } })).status, 413);

  // guests: message ok, homework forbidden; hand-in visible only to host + author
  assert.equal((await call(jamie, 'ms-ortiz/wall', 'POST', { kind: 'message', text: 'Gracias por la clase!' })).status, 200);
  assert.equal((await call(jamie, 'ms-ortiz/wall', 'POST', { kind: 'homework', title: 'nope' })).status, 403);
  r = await call(jamie, 'ms-ortiz/wall', 'POST', { kind: 'handin', title: 'My story', file: { name: 'story.pdf', type: 'application/pdf', size: 500 } });
  objects.set(r.body.upload.replace('https://r2.test/put/', ''), 500);
  await call(jamie, `ms-ortiz/wall/${r.body.pin.id}/done`, 'POST'); const handinId = r.body.pin.id;
  const kinds = (b) => b.pins.map((p) => p.kind).sort().join(',');
  assert.equal(kinds((await call(host, 'ms-ortiz/wall')).body), 'file,handin,homework,message,video');
  assert.equal(kinds((await call(jamie, 'ms-ortiz/wall')).body), 'file,handin,homework,message,video');
  assert.equal(kinds((await call(sam, 'ms-ortiz/wall')).body), 'file,homework,message,video', 'Sam cannot see Jamie\'s hand-in');
  assert.equal((await call(sam, `ms-ortiz/wall/${handinId}/url`)).status, 404);
  assert.match((await call(host, `ms-ortiz/wall/${handinId}/url`)).body.url, /^https:\/\/r2.test\/get\//);

  // removal: Sam cannot remove Jamie's message; Jamie can; host can remove the file (and the object goes)
  const msgId = (await call(host, 'ms-ortiz/wall')).body.pins.find((p) => p.kind === 'message').id;
  assert.equal((await call(sam, `ms-ortiz/wall/${msgId}`, 'DELETE')).status, 403);
  assert.equal((await call(jamie, `ms-ortiz/wall/${msgId}`, 'DELETE')).status, 200);
  assert.equal((await call(host, `ms-ortiz/wall/${fileId}`, 'DELETE')).status, 200);
  assert.equal(deleted.length, 1);
  assert.ok(emitted.filter((e) => e === 'ms-ortiz:wall-changed').length >= 5, 'room is told the wall changed');

  // no store: file pins answer 503, text pins still work
  const app2 = express(); app2.use(express.json()); const io2 = { to: () => ({ emit() {} }) };
  attachWalls(app2, io2, { secret: SECRET, Room, store: null, Pin });
  const s2 = http.createServer(app2); await new Promise((r) => s2.listen(0, r));
  const r2 = await fetch(`http://localhost:${s2.address().port}/api/r/ms-ortiz/wall`, { method: 'POST', headers: { authorization: `Bearer ${host}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'file', title: 'x', file: { name: 'a.pdf', type: 'application/pdf', size: 5 } }) });
  assert.equal(r2.status, 503);
  server.close(); s2.close();
  console.log('walls.test: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
