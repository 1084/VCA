// Cove payments between a student and their tutor: tips in the room and a
// lesson price at the door. Stripe Connect, direct charges, zero application
// fee. The tutor is the merchant: the charge lands in their own Stripe
// (Express) account, Stripe pays their bank, Stripe sends them the tax form,
// and refunds and disputes are theirs. Cove holds the tutor's account id and
// a record of each payment (room, amount, kind, time) — never a card, never a
// student's name — so it can show the host a quiet "paid" line and a month
// total. Room rent is a different flow on Cove's own account (billing.js).
//
// The tutor absorbs the costs: Stripe's processing fee on each payment (they
// are the merchant), and Cove's own Connect cost for an active account,
// passed on as a labelled $3 / month "Payments" line on their lease.
//
// Env: STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_CONNECT_WEBHOOK_SECRET
//      (a second endpoint, "events on connected accounts"), STRIPE_PRICE_PAYMENTS
//      (the $3 / month add-on), CLIENT_ORIGIN.

const mongoose = require('mongoose');

const TIP_MIN = 100, TIP_MAX = 20000;          // cents
const LESSON_MIN = 100, LESSON_MAX = 50000;

const paymentSchema = new mongoose.Schema({
  room: { type: String, index: true },
  account: { type: String, index: true },     // the tutor's Stripe account
  intentId: { type: String, unique: true },
  kind: { type: String, default: 'tip' },     // 'tip' | 'lesson'
  amount: { type: Number, default: 0 },       // cents, what the student paid
  usedBy: { type: String, default: '' },      // lesson: the guest identity that walked in on it
  ts: { type: Date, default: Date.now }
});
const PaymentModel = mongoose.model('Payment', paymentSchema);

const cleanText = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');
const dollars = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

function attachPayments(app, io, { stripe, requireAuth, Room, User, secret, origin, publishableKey = '', connectWebhookSecret = '', paymentsPrice = '', Payment = PaymentModel, log = console.log }) {
  const jwt = require('jsonwebtoken');
  const ready = !!(stripe && publishableKey);
  const notReady = (res) => res.status(503).json({ error: 'Payments are not set up yet.' });

  // ---- tutor: onboarding and status ----
  const accountOf = async (email) => (await User.findOne({ email }).lean())?.stripeAccountId || '';
  const refresh = async (email, acct) => {
    const a = await stripe.accounts.retrieve(acct);
    const payoutsReady = !!(a.charges_enabled && a.payouts_enabled);
    await User.updateOne({ email }, { payoutsReady, stripeAccountId: acct });
    await Room.updateMany({ ownerEmail: email }, { paymentsReady: payoutsReady });
    return payoutsReady;
  };
  app.get('/api/connect/status', requireAuth, async (req, res) => {
    const u = await User.findOne({ email: req.user.email }).lean();
    let payoutsReady = !!u?.payoutsReady;
    if (ready && u?.stripeAccountId && !payoutsReady) { try { payoutsReady = await refresh(req.user.email, u.stripeAccountId); } catch { /* keep what we have */ } }
    const since = new Date(); since.setDate(1); since.setHours(0, 0, 0, 0);
    const month = u?.stripeAccountId ? (await Payment.aggregate([{ $match: { account: u.stripeAccountId, ts: mongoose.trusted({ $gte: since }) } }, { $group: { _id: '$kind', n: { $sum: '$amount' }, c: { $sum: 1 } } }])) : [];
    const sum = (k) => month.find((m) => m._id === k) || { n: 0, c: 0 };
    res.json({ ready, hasAccount: !!u?.stripeAccountId, payoutsReady, feeNote: paymentsPrice ? '$3 / month on your lease while payments are on' : '',
      month: { tips: sum('tip').n, tipCount: sum('tip').c, lessons: sum('lesson').n, lessonCount: sum('lesson').c } });
  });
  app.post('/api/connect/onboard', requireAuth, async (req, res) => {
    if (!ready) return notReady(res);
    const email = req.user.email;
    const u = await User.findOne({ email }).lean();
    if (!u?.host) return res.status(403).json({ error: 'Hosts only.' });
    let acct = u.stripeAccountId;
    try {
    if (!acct) {
      const a = await stripe.accounts.create({ type: 'express', email, business_type: 'individual', capabilities: { card_payments: { requested: true }, transfers: { requested: true } }, metadata: { email } });
      acct = a.id; await User.updateOne({ email }, { stripeAccountId: acct });
      // Apple Pay on a direct charge needs the domain registered on the connected account itself
      try { await stripe.paymentMethodDomains.create({ domain_name: new URL(origin).hostname }, { stripeAccount: acct }); }
      catch (e) { log(`payments: could not register the Apple Pay domain for ${acct}: ${e.message}`); }
    }
    const link = await stripe.accountLinks.create({ account: acct, type: 'account_onboarding', refresh_url: `${origin}/?payments=again`, return_url: `${origin}/?payments=done` });
    res.json({ url: link.url });
    } catch (e) {
      // Stripe's own words are the useful part ("sign up for Connect", a country mismatch, a missing capability)
      log(`payments: onboarding failed for ${email}: ${e.message}`);
      res.status(502).json({ error: `Stripe said: ${e.message}` });
    }
  });
  app.post('/api/connect/dashboard', requireAuth, async (req, res) => {
    if (!ready) return notReady(res);
    const acct = await accountOf(req.user.email);
    if (!acct) return res.status(404).json({ error: 'No payments account yet.' });
    const l = await stripe.accounts.createLoginLink(acct);
    res.json({ url: l.url });
  });

  // ---- student: pay a tip or the lesson price, inside the room ----
  const roomKey = async (req, res, next) => {
    try {
      const t = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const u = jwt.verify(t, secret);
      const room = await Room.findOne({ slug: req.params.slug }).lean();
      if (!room) return res.status(404).json({ error: 'No room at this link.' });
      if (!(u.guest && u.room === room.slug)) return res.status(403).json({ error: 'Only guests pay here; hosts are paid.' });
      req.pay = { room, guest: u };
      next();
    } catch { res.status(401).json({ error: 'Unauthorized' }); }
  };
  app.post('/api/r/:slug/pay', roomKey, async (req, res) => {
    if (!ready) return notReady(res);
    const { room } = req.pay;
    const host = await User.findOne({ email: room.ownerEmail }).lean();
    if (!host?.stripeAccountId || !host.payoutsReady) return res.status(409).json({ error: `${(room.ownerEmail || '').split('@')[0]} isn't taking payments here yet.` });
    const kind = req.body?.kind === 'lesson' ? 'lesson' : 'tip';
    let amount;
    if (kind === 'lesson') {
      if (!room.studio || !room.lessonPrice) return res.status(409).json({ error: 'This room has no lesson price.' });
      amount = room.lessonPrice;
    } else {
      if (room.tipsOn === false) return res.status(409).json({ error: 'Tips are off in this room.' });
      amount = Math.round(Number(req.body?.amount) || 0);
      if (!(amount >= TIP_MIN && amount <= TIP_MAX)) return res.status(400).json({ error: `Tips are ${dollars(TIP_MIN)} to ${dollars(TIP_MAX)}.` });
    }
    const name = cleanText(req.pay.guest.name, 32);
    const pi = await stripe.paymentIntents.create({
      amount, currency: 'usd',
      automatic_payment_methods: { enabled: true },
      description: kind === 'lesson' ? `Lesson in ${room.name || room.slug}` : `Tip in ${room.name || room.slug}`,
      statement_descriptor_suffix: 'COVE',
      metadata: { slug: room.slug, kind, from: name }   // the name goes to the tutor's Stripe receipt line, not to Cove's records
    }, { stripeAccount: host.stripeAccountId });
    res.json({ clientSecret: pi.client_secret, intentId: pi.id, account: host.stripeAccountId, publishableKey, amount, kind, to: (room.ownerEmail || '').split('@')[0] });
  });
  // Has this lesson payment landed? (the door asks before it knocks)
  app.get('/api/r/:slug/pay/:intentId', roomKey, async (req, res) => {
    const p = await Payment.findOne({ intentId: req.params.intentId, room: req.params.slug }).lean().catch(() => null);
    res.json({ paid: !!p, kind: p?.kind || null, amount: p?.amount || 0 });
  });

  // ---- Stripe → Cove: events on connected accounts ----
  const webhook = async (req, res) => {
    if (!stripe || !connectWebhookSecret) return res.status(503).end();
    let ev;
    try { ev = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), connectWebhookSecret); }
    catch (e) { return res.status(400).send(`Webhook signature failed: ${e.message}`); }
    try {
      const o = ev.data.object, acct = ev.account || '';
      if (ev.type === 'account.updated') {
        const payoutsReady = !!(o.charges_enabled && o.payouts_enabled);
        const u = await User.findOne({ stripeAccountId: o.id });
        if (u && u.payoutsReady !== payoutsReady) {
          await User.updateOne({ email: u.email }, { payoutsReady });
          await Room.updateMany({ ownerEmail: u.email }, { paymentsReady: payoutsReady });
          log(`payments: ${u.email} ${payoutsReady ? 'can take payments' : 'cannot take payments yet'}`);
          if (payoutsReady && paymentsPrice) await addPaymentsLine(u.email);
        }
      } else if (ev.type === 'payment_intent.succeeded') {
        const slug = o.metadata?.slug, kind = o.metadata?.kind === 'lesson' ? 'lesson' : 'tip';
        if (!slug) return res.json({ received: true });
        const exists = await Payment.findOne({ intentId: o.id }).lean().catch(() => null);
        if (!exists) {
          await Payment.create({ room: slug, account: acct, intentId: o.id, kind, amount: o.amount_received || o.amount || 0 });
          log(`payments: ${slug} ${kind} ${dollars(o.amount_received || o.amount || 0)}`);
          // a quiet line for the host, with the student's chosen name; nothing is stored with it
          const room = await Room.findOne({ slug }).lean().catch(() => null);
          if (room) for (const s of io.sockets.sockets.values()) if (s.data?.roomId === slug && s.user?.email === room.ownerEmail) s.emit('paid', { kind, amount: o.amount_received || o.amount || 0, from: o.metadata?.from || 'Someone' });
        }
      }
      res.json({ received: true });
    } catch (e) { log(`payments: webhook ${ev.type} failed: ${e.message}`); res.status(500).end(); }
  };

  // The $3 / month line: added to the tutor's lease once payments are on. A
  // comped host (no lease) pays nothing; the line joins their next lease.
  const addPaymentsLine = async (email) => {
    if (!paymentsPrice) return;
    const rooms = await Room.find({ ownerEmail: email });
    for (const r of rooms) {
      if (!r.stripeSubscriptionId || r.paymentsItemId) continue;
      try {
        const item = await stripe.subscriptionItems.create({ subscription: r.stripeSubscriptionId, price: paymentsPrice, quantity: 1, proration_behavior: 'none' });
        r.paymentsItemId = item.id; await r.save();
        log(`payments: ${r.slug} lease now carries the payments line`);
      } catch (e) { log(`payments: could not add the payments line to ${r.slug}: ${e.message}`); }
    }
  };

  // Called by signaling when a guest knocks with a lesson payment: true if it is real and unused.
  const claimLesson = async (slug, intentId, who) => {
    const p = await Payment.findOne({ intentId, room: slug, kind: 'lesson' });
    if (!p || (p.usedBy && p.usedBy !== who)) return null;
    if (!p.usedBy) { p.usedBy = who; await p.save(); }
    return { amount: p.amount };
  };

  return { webhook, ready, claimLesson, addPaymentsLine, Payment };
}

module.exports = { attachPayments, Payment: PaymentModel, TIP_MIN, TIP_MAX, LESSON_MIN, LESSON_MAX, dollars };
