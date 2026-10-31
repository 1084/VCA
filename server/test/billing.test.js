// Billing test: real billing.js over express with an in-memory Room and a fake
// Stripe. Checks Checkout params, each webhook's effect on paidThrough, and
// that a bad signature is refused. node server/test/billing.test.js
const assert = require('assert');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const { attachBilling, GRACE, DAY } = require('../billing');

const SECRET = 'test';
const rooms = new Map();
const mk = (r) => { const o = { paidThrough: null, plan: '', stripeCustomerId: '', stripeSubscriptionId: '', ...r, save: async function () { } }; rooms.set(o.slug, o); return o; };
mk({ slug: 'ms-ortiz', ownerEmail: 'ortiz@example.com' });
const find = (f) => [...rooms.values()].find((r) => Object.entries(f).every(([k, v]) => r[k] === v)) || null;
const Room = { findOne: async (f) => find(f), find: (f) => ({ lean: async () => [...rooms.values()].filter((r) => r.ownerEmail === f.ownerEmail) }) };
const created = [];
const stripe = {
  checkout: { sessions: { create: async (p) => { created.push(p); return { url: 'https://checkout.stripe.test/s' }; } } },
  billingPortal: { sessions: { create: async () => ({ url: 'https://portal.stripe.test' }) } },
  subscriptions: { retrieve: async (id) => ({ id, items: { data: [{ current_period_end: Math.floor((Date.now() + 30 * DAY) / 1000) }] } }) },
  webhooks: { constructEvent: (body, sig) => { if (sig !== 'good') throw new Error('bad sig'); return JSON.parse(body); } }
};
const requireAuth = (req, res, next) => { try { req.user = jwt.verify((req.get('authorization') || '').slice(7), SECRET); next(); } catch { res.status(401).end(); } };

(async () => {
  const app = express(); const log = () => {};
  let hook;
  app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), (req, res) => hook(req, res));
  app.use(express.json());
  ({ webhook: hook } = attachBilling(app, { stripe, requireAuth, Room, User: {}, webhookSecret: 'whsec', prices: { month: 'price_m', day: 'price_d' }, origin: 'https://cove.test', log }));
  const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}/api/billing`;
  const tok = jwt.sign({ email: 'ortiz@example.com' }, SECRET);
  const post = async (path, body, headers = {}) => { const r = await fetch(`${base}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const event = (type, object, sig = 'good') => post('webhook', { type, data: { object } }, { 'stripe-signature': sig });

  // status: comped room is open
  let s = await (await fetch(`${base}/status`, { headers: { authorization: `Bearer ${tok}` } })).json();
  assert.equal(s.ready, true); assert.equal(s.rooms[0].comped, true); assert.equal(s.rooms[0].open, true);

  // checkout: day pass → payment mode, right price, return URLs on our origin
  let r = await post('checkout', { slug: 'ms-ortiz', plan: 'day' });
  assert.equal(r.status, 200); assert.equal(created[0].mode, 'payment'); assert.equal(created[0].line_items[0].price, 'price_d');
  assert.match(created[0].success_url, /^https:\/\/cove.test\/\?rent=paid/); assert.equal(created[0].customer_email, 'ortiz@example.com');
  // someone else's room
  const other = jwt.sign({ email: 'eve@example.com' }, SECRET);
  const rr = await fetch(`${base}/checkout`, { method: 'POST', headers: { authorization: `Bearer ${other}`, 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'ms-ortiz', plan: 'day' }) });
  assert.equal(rr.status, 404);

  // bad signature refused, nothing changes
  assert.equal((await event('checkout.session.completed', {}, 'bad')).status, 400);
  assert.equal(rooms.get('ms-ortiz').paidThrough, null);

  // day pass paid → paidThrough ≈ now + 24h, plan day, customer stored
  const t0 = Date.now();
  assert.equal((await event('checkout.session.completed', { payment_status: 'paid', mode: 'payment', customer: 'cus_1', metadata: { slug: 'ms-ortiz', plan: 'day' } })).status, 200);
  let room = rooms.get('ms-ortiz');
  assert.ok(Math.abs(room.paidThrough.getTime() - (t0 + DAY)) < 5000); assert.equal(room.plan, 'day'); assert.equal(room.stripeCustomerId, 'cus_1');
  // a second day pass stacks on the first
  await event('checkout.session.completed', { payment_status: 'paid', mode: 'payment', customer: 'cus_1', metadata: { slug: 'ms-ortiz', plan: 'day' } });
  assert.ok(Math.abs(room.paidThrough.getTime() - (t0 + 2 * DAY)) < 5000, 'a second pass starts when the first ends');

  // monthly: subscription → paidThrough = period end + grace, ids stored; checkout reuses customer
  r = await post('checkout', { slug: 'ms-ortiz', plan: 'month' });
  assert.equal(created.at(-1).mode, 'subscription'); assert.equal(created.at(-1).customer, 'cus_1'); assert.equal(created.at(-1).customer_email, undefined);
  await event('checkout.session.completed', { payment_status: 'paid', mode: 'subscription', customer: 'cus_1', subscription: 'sub_1', metadata: { slug: 'ms-ortiz', plan: 'month' } });
  assert.ok(Math.abs(room.paidThrough.getTime() - (t0 + 30 * DAY + GRACE)) < 5000); assert.equal(room.stripeSubscriptionId, 'sub_1'); assert.equal(room.plan, 'month');
  // a second monthly checkout is refused while one is active
  assert.equal((await post('checkout', { slug: 'ms-ortiz', plan: 'month' })).status, 409);
  // renewal invoice moves it forward
  const end2 = Math.floor((Date.now() + 60 * DAY) / 1000);
  await event('invoice.paid', { subscription: 'sub_1', subscription_details: { metadata: { slug: 'ms-ortiz' } }, lines: { data: [{ period: { end: end2 } }] } });
  assert.ok(Math.abs(room.paidThrough.getTime() - (end2 * 1000 + GRACE)) < 5000);
  // newest API shape: subscription under invoice.parent, no slug metadata → matched by subscription id
  const end3 = Math.floor((Date.now() + 90 * DAY) / 1000);
  await event('invoice.paid', { parent: { subscription_details: { subscription: 'sub_1', metadata: {} } }, lines: { data: [{ period: { end: end3 } }] } });
  assert.ok(Math.abs(room.paidThrough.getTime() - (end3 * 1000 + GRACE)) < 5000, 'parent.subscription_details shape handled');
  // an invoice with no subscription at all (a one-off) is ignored without error
  assert.equal((await event('invoice.paid', { lines: { data: [] } })).status, 200);
  // cancellation: subscription id cleared, paidThrough kept (door closes when it lapses)
  await event('customer.subscription.deleted', { id: 'sub_1' });
  assert.equal(room.stripeSubscriptionId, ''); assert.ok(room.paidThrough.getTime() > Date.now());
  // portal
  assert.equal((await post('portal', { slug: 'ms-ortiz' })).body.url, 'https://portal.stripe.test');

  // unconfigured: 503, never a crash
  const app2 = express(); app2.use(express.json());
  attachBilling(app2, { stripe: null, requireAuth, Room, User: {}, webhookSecret: '', prices: { month: '', day: '' }, origin: 'x', log });
  const s2 = http.createServer(app2); await new Promise((r) => s2.listen(0, r));
  const r2 = await fetch(`http://localhost:${s2.address().port}/api/billing/checkout`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'ms-ortiz' }) });
  assert.equal(r2.status, 503);
  server.close(); s2.close();
  console.log('billing.test: all passed'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
