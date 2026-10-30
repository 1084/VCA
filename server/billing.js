// Cove Rooms billing: rent, not commission.
//
// Two things are for sale, both through Stripe's hosted Checkout page:
//   month  a subscription ($12 / month on the rooms page), renews until cancelled
//   day    a one-time day pass ($2 / 24 hours)
// Cove never sees a card number. The browser is sent to Stripe, pays there,
// and Stripe tells us by webhook. The room's `paidThrough` moves forward and
// the door opens or closes on that date alone (see roomIsOpen in rooms.js).
//
// paidThrough == null means comped: an invited host whose rent we waive.
// The first successful Checkout turns a comped room into a rented one.
//
// Lesson money is none of this. Students pay their tutor directly through
// the tutor's own links; Cove charges the host for the room and nothing else.
//
// Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_MONTH,
//      STRIPE_PRICE_DAY, CLIENT_ORIGIN (first origin is used for return URLs).

const DAY = 86400000;
const GRACE = 3 * DAY; // a renewal that fails keeps the door open this long while Stripe retries

function attachBilling(app, { stripe, requireAuth, Room, User, webhookSecret, prices, origin, log = console.log }) {
  const ready = !!(stripe && prices.month && prices.day);
  const notReady = (res) => res.status(503).json({ error: 'Billing is not set up yet.' });
  const ownRoom = async (req, res) => {
    const room = await Room.findOne({ slug: String(req.body?.slug || req.query?.slug || ''), ownerEmail: req.user.email });
    if (!room) res.status(404).json({ error: 'Not your room.' });
    return room;
  };

  // What the lobby needs to show the Rent card.
  app.get('/api/billing/status', requireAuth, async (req, res) => {
    const rooms = await Room.find({ ownerEmail: req.user.email }).lean();
    res.json({ ready, prices: { month: 12, day: 2 }, rooms: rooms.map((r) => ({
      slug: r.slug, comped: !r.paidThrough, paidThrough: r.paidThrough, plan: r.plan || '', open: !r.paidThrough || r.paidThrough.getTime() > Date.now(), subscription: !!r.stripeSubscriptionId
    })) });
  });

  // Start Checkout. The browser follows the returned URL to Stripe.
  app.post('/api/billing/checkout', requireAuth, async (req, res) => {
    if (!ready) return notReady(res);
    const room = await ownRoom(req, res); if (!room) return;
    const plan = req.body?.plan === 'day' ? 'day' : 'month';
    if (plan === 'month' && room.stripeSubscriptionId) return res.status(409).json({ error: 'This room already has a monthly lease. Manage it from Billing.' });
    const params = {
      mode: plan === 'month' ? 'subscription' : 'payment',
      line_items: [{ price: prices[plan], quantity: 1 }],
      client_reference_id: room.slug,
      metadata: { slug: room.slug, email: req.user.email, plan },
      success_url: `${origin}/?rent=paid&room=${encodeURIComponent(room.slug)}`,
      cancel_url: `${origin}/?rent=cancelled`,
      allow_promotion_codes: true
    };
    if (room.stripeCustomerId) params.customer = room.stripeCustomerId; else params.customer_email = req.user.email;
    if (plan === 'month') params.subscription_data = { metadata: { slug: room.slug } };
    const session = await stripe.checkout.sessions.create(params);
    res.json({ url: session.url });
  });

  // Stripe's customer portal: change card, cancel, see invoices.
  app.post('/api/billing/portal', requireAuth, async (req, res) => {
    if (!ready) return notReady(res);
    const room = await ownRoom(req, res); if (!room) return;
    if (!room.stripeCustomerId) return res.status(404).json({ error: 'Nothing to manage yet.' });
    const s = await stripe.billingPortal.sessions.create({ customer: room.stripeCustomerId, return_url: `${origin}/` });
    res.json({ url: s.url });
  });

  // Webhook: the only place paidThrough moves. Raw body; signature checked.
  const extend = async (slug, until, patch = {}) => {
    const room = await Room.findOne({ slug });
    if (!room) return log(`billing: webhook for unknown room ${slug}`);
    const cur = room.paidThrough ? room.paidThrough.getTime() : 0;
    room.paidThrough = new Date(Math.max(cur, until));
    Object.assign(room, patch);
    await room.save();
    log(`billing: ${slug} paid through ${room.paidThrough.toISOString()} (${patch.plan || room.plan})`);
  };
  const webhook = async (req, res) => {
    if (!stripe || !webhookSecret) return res.status(503).end();
    let ev;
    try { ev = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), webhookSecret); }
    catch (e) { return res.status(400).send(`Webhook signature failed: ${e.message}`); }
    try {
      const o = ev.data.object;
      if (ev.type === 'checkout.session.completed' && o.payment_status === 'paid' || ev.type === 'checkout.session.async_payment_succeeded') {
        const slug = o.metadata?.slug || o.client_reference_id; const plan = o.metadata?.plan || (o.mode === 'subscription' ? 'month' : 'day');
        if (plan === 'day') {
          // a pass bought while one is running starts when that one ends: nothing paid for is lost
          const cur = await Room.findOne({ slug }); const from = Math.max(Date.now(), cur?.paidThrough?.getTime() || 0);
          await extend(slug, from + DAY, { plan: 'day', stripeCustomerId: o.customer || undefined });
        }
        else {
          // the subscription's own period end is authoritative; invoice.paid below repeats it each cycle
          const sub = o.subscription ? await stripe.subscriptions.retrieve(o.subscription) : null;
          const end = sub?.current_period_end ? sub.current_period_end * 1000 : Date.now() + 31 * DAY;
          await extend(slug, end + GRACE, { plan: 'month', stripeCustomerId: o.customer || undefined, stripeSubscriptionId: o.subscription || undefined });
        }
      } else if (ev.type === 'invoice.paid' && o.subscription) {
        const slug = o.subscription_details?.metadata?.slug || o.lines?.data?.[0]?.metadata?.slug;
        const end = (o.lines?.data?.[0]?.period?.end || 0) * 1000;
        if (slug && end) await extend(slug, end + GRACE, { plan: 'month' });
        else { const room = await Room.findOne({ stripeSubscriptionId: o.subscription }); if (room && end) await extend(room.slug, end + GRACE, { plan: 'month' }); }
      } else if (ev.type === 'customer.subscription.deleted') {
        const room = await Room.findOne({ stripeSubscriptionId: o.id });
        if (room) { room.stripeSubscriptionId = ''; await room.save(); log(`billing: ${room.slug} subscription ended; door closes ${room.paidThrough?.toISOString()}`); }
      }
      res.json({ received: true });
    } catch (e) { log(`billing: webhook ${ev.type} failed: ${e.message}`); res.status(500).end(); }
  };
  return { webhook, ready };
}

function makeStripe(env) {
  if (!env.STRIPE_SECRET_KEY) return null;
  const Stripe = require('stripe');
  return new Stripe(env.STRIPE_SECRET_KEY); // the SDK pins its own API version
}

module.exports = { attachBilling, makeStripe, GRACE, DAY };
