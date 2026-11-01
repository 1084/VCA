// Application flow over express with an in-memory store. node server/test/applications.test.js
const assert = require('assert');
const express = require('express');
const http = require('http');
const { attachApplications } = require('../applications');

let seq = 0; const apps = [];
const proto = { save: async function () { Object.assign(apps.find((x) => x._id === this._id), this); } };
const wrap = (a) => a && Object.assign(Object.create(proto), a);
const match = (f) => (a) => Object.entries(f).every(([k, v]) => k === '_id' ? a._id === String(v) : k === 'ts' ? true : a[k] === v);
const Application = {
  findOne: (f) => { const a = apps.find(match(f)); const p = Promise.resolve(wrap(a)); p.lean = () => ({ catch: () => Promise.resolve(a || null) }); p.catch = (fn) => p.then(undefined, fn); return p; },
  find: (f) => ({ sort: () => ({ limit: () => ({ lean: async () => apps.filter(match(f)) }) }) }),
  create: async (d) => { const a = { _id: String(++seq), status: 'new', ts: new Date(), ...d }; apps.push(a); return wrap(a); },
  deleteOne: async (f) => { const i = apps.findIndex(match(f)); if (i >= 0) apps.splice(i, 1); }
};
const admin = (req, res, next) => (req.get('authorization') === 'Bearer k' ? next() : res.status(401).end());

(async () => {
  const app = express(); app.use(express.json());
  const hosts = []; app.locals.inviteNow = async (email) => { if (email === 'has-account@example.com') { hosts.push(email); return true; } return false; };
  const sent = []; const mail = { applicationReceived: async (m) => { sent.push(['received', m.email]); return { sent: true }; }, applicationNotice: async (m) => { sent.push(['notice', m.email]); return { sent: true }; }, invited: async (m) => { sent.push(['invited', m.email, m.hasAccount]); return { sent: true }; } };
  const { isInvited } = attachApplications(app, { admin, Application, log: () => {}, mail });
  const s = http.createServer(app); await new Promise((r) => s.listen(0, r));
  const base = `http://localhost:${s.address().port}/api`;
  const post = async (path, body, auth) => { const r = await fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer k' } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const get = async (path) => (await fetch(`${base}/${path}`, { headers: { authorization: 'Bearer k' } })).json();

  const good = { name: 'Alicia', email: 'Alicia@Example.com', tier: 'studio', teaches: 'Spanish', where: 'https://preply.com/alicia', billing: 'per lesson', notes: '', agree: true };
  assert.equal((await post('apply', { ...good, agree: false })).status, 400, 'must agree');
  assert.equal((await post('apply', { ...good, email: 'nope' })).status, 400, 'needs an email');
  assert.equal((await post('apply', { ...good, website: 'http://spam' })).status, 200, 'honeypot answers ok and stores nothing');
  assert.equal(apps.length, 0);
  assert.equal((await post('apply', good)).status, 200);
  await new Promise((r) => setTimeout(r, 20)); assert.deepEqual(sent, [['received', 'alicia@example.com'], ['notice', 'alicia@example.com']], 'applicant confirmation + owner notice');
  assert.equal(apps[0].email, 'alicia@example.com'); assert.equal(apps[0].tier, 'studio');
  assert.equal((await post('apply', good)).status, 409, 'one per address per 30 days');
  // admin list, unauthenticated refused
  assert.equal((await fetch(`${base}/admin/applications`)).status, 401);
  let list = await get('admin/applications?status=new'); assert.equal(list.length, 1); assert.equal(list[0].name, 'Alicia');
  // invite: no account yet → becameHost false, but isInvited true (signup will make them a host)
  let r = await post(`admin/applications/${list[0].id}/decide`, { status: 'invited', note: 'call went well' }, true);
  assert.equal(r.body.becameHost, false); assert.equal(r.body.mailed, true); assert.deepEqual(sent.at(-1), ['invited', 'alicia@example.com', false]); assert.equal(await isInvited('alicia@example.com'), true); assert.equal(await isInvited('x@example.com'), false);
  // invite someone who already has an account → host at once
  await post('apply', { ...good, email: 'has-account@example.com' });
  list = await get('admin/applications?status=new');
  r = await post(`admin/applications/${list[0].id}/decide`, { status: 'invited' }, true); assert.equal(r.body.becameHost, true); assert.deepEqual(sent.at(-1), ['invited', 'has-account@example.com', true]); assert.deepEqual(hosts, ['has-account@example.com']);
  // decline shortens retention; delete removes
  await post('apply', { ...good, email: 'no@example.com' }); list = await get('admin/applications?status=new');
  r = await post(`admin/applications/${list[0].id}/decide`, { status: 'declined' }, true); assert.equal(apps.find((a) => a.email === 'no@example.com').status, 'declined');
  await fetch(`${base}/admin/applications/${list[0].id}`, { method: 'DELETE', headers: { authorization: 'Bearer k' } }); assert.equal(apps.some((a) => a.email === 'no@example.com'), false);
  s.close(); console.log('applications.test: all passed'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
