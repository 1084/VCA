// Payments over express with a fake Stripe and in-memory users/rooms/payments. node server/test/payments.test.js
const assert = require('assert');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const { attachPayments } = require('../payments');

const SECRET = 'test';
const users = { 'ortiz@example.com': { email: 'ortiz@example.com', host: true, stripeAccountId: '', payoutsReady: false } };
const User = { findOne: (f) => ({ lean: async () => Object.values(users).find((u) => Object.entries(f).every(([k, v]) => u[k] === v)) || null, then: undefined }), updateOne: async (f, u) => { const x = Object.values(users).find((y) => y.email === f.email); if (x) Object.assign(x, u); } };
User.findOne = (f) => { const u = Object.values(users).find((x) => Object.entries(f).every(([k, v]) => x[k] === v)) || null; const p = Promise.resolve(u); p.lean = async () => u; return p; };
const rooms = { 'ms-ortiz': { slug: 'ms-ortiz', name: 'Spanish', ownerEmail: 'ortiz@example.com', studio: true, lessonPrice: 3000, tipsOn: true, paymentsReady: false, stripeSubscriptionId: 'sub_1', paymentsItemId: '', save: async function () {} } };
const Room = { findOne: (f) => { const r = rooms[f.slug] || null; const p = Promise.resolve(r); p.lean = () => ({ catch: () => Promise.resolve(r), then: (fn) => Promise.resolve(r).then(fn) }); p.catch = (fn) => p.then(undefined, fn); return p; }, find: async (f) => Object.values(rooms).filter((r) => r.ownerEmail === f.ownerEmail), updateMany: async (f, u) => Object.values(rooms).filter((r) => r.ownerEmail === f.ownerEmail).forEach((r) => Object.assign(r, u)) };
const pays = [];
const Payment = {
  findOne: (f) => { const p = pays.find((x) => Object.entries(f).every(([k, v]) => x[k] === v)) || null; const pr = Promise.resolve(p && Object.assign(Object.create({ save: async function () { Object.assign(pays.find((x) => x.intentId === this.intentId), this); } }), p)); pr.lean = () => ({ catch: () => Promise.resolve(p) }); pr.catch = (fn) => pr.then(undefined, fn); return pr; },
  create: async (d) => { pays.push({ usedBy: '', ts: new Date(), ...d }); },
  aggregate: async () => { const g = {}; for (const p of pays) { g[p.kind] ||= { _id: p.kind, n: 0, c: 0 }; g[p.kind].n += p.amount; g[p.kind].c++; } return Object.values(g); }
};
const created = { accounts: [], links: [], intents: [], items: [] };
const stripe = {
  accounts: { create: async (p) => { created.accounts.push(p); return { id: 'acct_1' }; }, retrieve: async (id) => ({ id, charges_enabled: created.ready, payouts_enabled: created.ready }), createLoginLink: async () => ({ url: 'https://dash.stripe.test' }) },
  accountLinks: { create: async (p) => { created.links.push(p); return { url: 'https://onboard.stripe.test' }; } },
  paymentMethodDomains: { create: async (p, o) => { created.domains = [p.domain_name, o.stripeAccount]; return { id: 'pmd_1' }; } },
  paymentIntents: { create: async (p, o) => { created.intents.push([p, o]); return { id: 'pi_' + created.intents.length, client_secret: 'cs_x' }; } },
  subscriptionItems: { create: async (p) => { created.items.push(p); return { id: 'si_1' }; } },
  webhooks: { constructEvent: (body, sig) => { if (sig !== 'good') throw new Error('bad sig'); return JSON.parse(body); } }
};
const requireAuth = (req, res, next) => { try { req.user = jwt.verify((req.get('authorization') || '').slice(7), SECRET); next(); } catch { res.status(401).end(); } };
const emitted = []; const io = { sockets: { sockets: new Map([['h1', { data: { roomId: 'ms-ortiz' }, user: { email: 'ortiz@example.com' }, emit: (ev, d) => emitted.push([ev, d]) }]]) } };

(async () => {
  const app = express(); let hook;
  app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), (req, res) => hook(req, res));
  app.use(express.json());
  const pm = attachPayments(app, io, { stripe, requireAuth, Room, User, secret: SECRET, origin: 'https://cove.test', publishableKey: 'pk_test', connectWebhookSecret: 'whsec', paymentsPrice: 'price_pay', Payment, log: () => {} });
  hook = pm.webhook;
  const s = http.createServer(app); await new Promise((r) => s.listen(0, r));
  const base = `http://localhost:${s.address().port}/api`;
  const host = jwt.sign({ email: 'ortiz@example.com' }, SECRET);
  const jamie = jwt.sign({ guest: true, room: 'ms-ortiz', name: 'Jamie', jti: 'j1' }, SECRET);
  const call = async (tok, path, method = 'GET', body, headers = {}) => { const r = await fetch(`${base}/${path}`, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const event = (type, object, account) => call('x', 'payments/webhook', 'POST', { type, account, data: { object } }, { 'stripe-signature': 'good' });

  // status before anything
  let r = await call(host, 'connect/status'); assert.equal(r.body.hasAccount, false); assert.equal(r.body.payoutsReady, false);
  // student can't pay yet
  r = await call(jamie, 'r/ms-ortiz/pay', 'POST', { kind: 'tip', amount: 500 }); assert.equal(r.status, 409);
  // onboard: creates an Express account with card + transfers, returns Stripe's link
  r = await call(host, 'connect/onboard', 'POST'); assert.equal(r.body.url, 'https://onboard.stripe.test');
  assert.equal(created.accounts[0].type, undefined, 'no legacy type field'); assert.equal(created.accounts[0].controller.stripe_dashboard.type, 'full'); assert.equal(created.accounts[0].controller.fees.payer, 'account'); assert.equal(created.accounts[0].controller.losses.payments, 'stripe'); assert.ok(created.accounts[0].capabilities.card_payments); assert.equal(users['ortiz@example.com'].stripeAccountId, 'acct_1');
  assert.match(created.links[0].return_url, /payments=done/);
  assert.deepEqual(created.domains, ['cove.test', 'acct_1'], 'Apple Pay domain registered on the tutor account');
  // second onboard call reuses the account
  await call(host, 'connect/onboard', 'POST'); assert.equal(created.accounts.length, 1);
  // Stripe says the account is ready → host + rooms flagged, payments line added to the lease
  await event('account.updated', { id: 'acct_1', charges_enabled: true, payouts_enabled: true });
  assert.equal(users['ortiz@example.com'].payoutsReady, true); assert.equal(rooms['ms-ortiz'].paymentsReady, true);
  assert.equal(created.items[0].price, 'price_pay'); assert.equal(rooms['ms-ortiz'].paymentsItemId, 'si_1');
  await event('account.updated', { id: 'acct_1', charges_enabled: true, payouts_enabled: true }); assert.equal(created.items.length, 1, 'line added once');

  // tip: a PaymentIntent on the tutor's account, direct charge, no application fee
  r = await call(jamie, 'r/ms-ortiz/pay', 'POST', { kind: 'tip', amount: 500 });
  assert.equal(r.status, 200); assert.equal(r.body.clientSecret, 'cs_x'); assert.equal(r.body.account, 'acct_1'); assert.equal(r.body.publishableKey, 'pk_test');
  const [p1, o1] = created.intents[0]; assert.equal(p1.amount, 500); assert.equal(o1.stripeAccount, 'acct_1'); assert.equal(p1.application_fee_amount, undefined); assert.equal(p1.metadata.kind, 'tip'); assert.equal(p1.metadata.from, 'Jamie');
  assert.equal((await call(jamie, 'r/ms-ortiz/pay', 'POST', { kind: 'tip', amount: 50 })).status, 400, 'below minimum');
  assert.equal((await call(host, 'r/ms-ortiz/pay', 'POST', { kind: 'tip', amount: 500 })).status, 403, 'hosts do not tip themselves');
  // lesson: the room's price, not the client's number
  r = await call(jamie, 'r/ms-ortiz/pay', 'POST', { kind: 'lesson', amount: 1 }); assert.equal(r.body.amount, 3000); const lessonPi = r.body.intentId;
  // webhook: tip succeeded → record + a quiet line to the host; replay is ignored
  await event('payment_intent.succeeded', { id: 'pi_1', amount_received: 500, metadata: { slug: 'ms-ortiz', kind: 'tip', from: 'Jamie' } }, 'acct_1');
  assert.equal(pays.length, 1); assert.deepEqual(emitted[0], ['paid', { kind: 'tip', amount: 500, from: 'Jamie' }]);
  await event('payment_intent.succeeded', { id: 'pi_1', amount_received: 500, metadata: { slug: 'ms-ortiz', kind: 'tip' } }, 'acct_1'); assert.equal(pays.length, 1);
  // lesson paid → the door can see it; claimLesson works once per guest
  assert.equal((await call(jamie, `r/ms-ortiz/pay/${lessonPi}`)).body.paid, false);
  await event('payment_intent.succeeded', { id: lessonPi, amount_received: 3000, metadata: { slug: 'ms-ortiz', kind: 'lesson', from: 'Jamie' } }, 'acct_1');
  assert.equal((await call(jamie, `r/ms-ortiz/pay/${lessonPi}`)).body.paid, true);
  assert.deepEqual(await pm.claimLesson('ms-ortiz', lessonPi, 'key:j1'), { amount: 3000 });
  assert.deepEqual(await pm.claimLesson('ms-ortiz', lessonPi, 'key:j1'), { amount: 3000 }, 'same guest may reconnect on it');
  assert.equal(await pm.claimLesson('ms-ortiz', lessonPi, 'key:someone-else'), null, 'another guest cannot reuse it');
  assert.equal(await pm.claimLesson('ms-ortiz', 'pi_1', 'key:j1'), null, 'a tip is not a lesson');
  // month total for the host
  r = await call(host, 'connect/status'); assert.equal(r.body.month.tips, 500); assert.equal(r.body.month.lessons, 3000); assert.equal(r.body.payoutsReady, true);
  // bad signature
  assert.equal((await call('x', 'payments/webhook', 'POST', {}, { 'stripe-signature': 'bad' })).status, 400);
  s.close(); console.log('payments.test: all passed'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
