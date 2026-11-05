// Cove Rooms billing: rent, not commission.
//
// Three things are for sale, all through Stripe's hosted Checkout page:
//   month   a Room lease ($12 / month), renews until cancelled
//   studio  a Studio lease ($20 / month): the Room plus the front-door page and the Wall
//   day     a one-time day pass ($2 / 24 hours)
// The tier follows the money: paying for Studio turns the Studio features on
// for that room and its host; switching to Room (via the portal) turns them
// off at the next invoice. Comped rooms keep whatever tier the admin set.
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
//      STRIPE_PRICE_STUDIO, STRIPE_PRICE_DAY, CLIENT_ORIGIN (first origin is used for return URLs).

const DAY = 86400000;
const GRACE = 3 * DAY; // a renewal that fails keeps the door open this long while Stripe retries

function attachBilling(app, { stripe, requireAuth, Room, User, webhookSecret, prices, origin, log = console.log, paymentsPrice = '' }) {
  const ready = !!(stripe && prices.month && prices.day);
  const PLANS = { month: 'month', studio: 'studio', day: 'day' };
  const planOfPrice = (priceId) => (priceId && priceId === prices.studio ? 'studio' : priceId && priceId === prices.month ? 'month' : null);
  // the lease among a subscription's items (the $3 payments add-on sits beside it)
  const planOfItems = (items) => { for (const it of items || []) { const p = planOfPrice(it.price?.id || it.pricing?.price_details?.price); if (p) return p; } return null; };
  const isLease = (plan) => plan === 'month' || plan === 'studio';
  // The tier follows what was paid for. Only called from webhook events.
  const setTier = async (room, plan) => {
    if (!isLease(plan)) return;
    const studio = plan === 'studio';
    if (room.studio !== studio) { room.studio = studio; await room.save(); }
    await User.updateOne({ email: room.ownerEmail }, { studio }).catch(() => {});
    log(`billing: ${room.slug} is now ${studio ? 'Studio' : 'Room'} tier`);
  };
  const notReady = (res) => res.status(503).json({ error: 'Billing is not set up yet.' });
  const ownRoom = async (req, res) => {
    const room = await Room.findOne({ slug: String(req.body?.slug || req.query?.slug || ''), ownerEmail: req.user.email });
    if (!room) res.status(404).json({ error: 'Not your room.' });
    return room;
  };

  // Ask Stripe what each lease is on right now, and make the tier match. Used when a host
  // comes back from the portal (a switch may already have happened, so no event is coming).
  const syncLeases = async (email) => {
    if (!stripe) return;
    const rooms = await Room.find({ ownerEmail: email });
    for (const room of rooms) {
      if (!room.stripeSubscriptionId) continue;
      try {
        const sub = await stripe.subscriptions.retrieve(room.stripeSubscriptionId);
        const plan = planOfItems(sub.items?.data);
        if (plan && room.plan !== plan) { room.plan = plan; await room.save(); await setTier(room, plan); }
        else if (plan && (room.studio !== (plan === 'studio'))) await setTier(room, plan);
      } catch (e) { log(`billing: sync ${room.slug}: ${e.message}`); }
    }
  };

  // What the lobby needs to show the Rent card. ?sync=1 asks Stripe first.
  app.get('/api/billing/status', requireAuth, async (req, res) => {
    if (req.query.sync === '1') await syncLeases(req.user.email);
    const rooms = await Room.find({ ownerEmail: req.user.email }).lean();
    res.json({ ready, studioReady: ready && !!prices.studio, prices: { month: 12, studio: 20, day: 2 }, rooms: rooms.map((r) => ({
      slug: r.slug, comped: !r.paidThrough, paidThrough: r.paidThrough, plan: r.plan || '', studio: !!r.studio, open: !r.paidThrough || r.paidThrough.getTime() > Date.now(), subscription: !!r.stripeSubscriptionId
    })) });
  });

  // Start Checkout. The browser follows the returned URL to Stripe.
  const checkout = async (req, res) => {
    if (!ready) return notReady(res);
    const room = await ownRoom(req, res); if (!room) return;
    const plan = PLANS[req.body?.plan] || 'month';
    if (plan === 'studio' && !prices.studio) return res.status(503).json({ error: 'Studio leases are not set up yet.' });
    if (isLease(plan) && room.stripeSubscriptionId) return res.status(409).json({ error: 'This room already has a monthly lease. Change or cancel it from Billing.' });
    const params = {
      mode: isLease(plan) ? 'subscription' : 'payment',
      line_items: [{ price: prices[plan], quantity: 1 }],
      client_reference_id: room.slug,
      metadata: { slug: room.slug, email: req.user.email, plan },
      success_url: `${origin}/?${req.query?.upgrade ? 'upgrade=done' : 'rent=paid'}&room=${encodeURIComponent(room.slug)}`,
      cancel_url: `${origin}/?rent=cancelled`,
      allow_promotion_codes: true
    };
    if (room.stripeCustomerId) params.customer = room.stripeCustomerId; else params.customer_email = req.user.email;
    if (isLease(plan)) {
      params.subscription_data = { metadata: { slug: room.slug } };
      // a host who already takes payments carries the $3 / month payments line on the lease
      if (paymentsPrice && (await User.findOne({ email: req.user.email }).lean())?.payoutsReady) params.line_items.push({ price: paymentsPrice, quantity: 1 });
    }
    const session = await stripe.checkout.sessions.create(params);
    res.json({ url: session.url });
  };
  app.post('/api/billing/checkout', requireAuth, checkout);

  // Stripe's customer portal: change card, cancel, see invoices.
  app.post('/api/billing/portal', requireAuth, async (req, res) => {
    if (!ready) return notReady(res);
    const room = await ownRoom(req, res); if (!room) return;
    if (!room.stripeCustomerId) return res.status(404).json({ error: 'Nothing to manage yet.' });
    const s = await stripe.billingPortal.sessions.create({ customer: room.stripeCustomerId, return_url: `${origin}/` });
    res.json({ url: s.url });
  });

  // Upgrade to Studio: any host may, no approval. How depends on how they pay.
  //   lease     → Stripe's portal, straight to the plan switch (tier follows the next invoice)
  //   comped    → the tier simply switches; nothing to pay
  //   otherwise → Checkout for the Studio lease
  app.post('/api/billing/upgrade', requireAuth, async (req, res) => {
    const room = await ownRoom(req, res); if (!room) return;
    if (room.studio) return res.status(409).json({ error: 'This room is already a Studio.' });
    const u = await User.findOne({ email: req.user.email }).lean();
    if (u?.comped) {
      room.studio = true; room.plan = 'studio'; await room.save();
      await User.updateOne({ email: req.user.email }, { studio: true });
      log(`billing: ${room.slug} upgraded to Studio (comped)`);
      return res.json({ done: true });
    }
    if (!ready || !prices.studio) return res.status(503).json({ error: 'Studio leases are not set up yet.' });
    if (room.stripeSubscriptionId && room.stripeCustomerId) {
      const s = await stripe.billingPortal.sessions.create({
        customer: room.stripeCustomerId, return_url: `${origin}/?upgrade=done`,
        flow_data: { type: 'subscription_update', subscription_update: { subscription: room.stripeSubscriptionId }, after_completion: { type: 'redirect', redirect: { return_url: `${origin}/?upgrade=done` } } }
      });
      return res.json({ url: s.url });
    }
    // no lease yet: rent Studio
    req.body = { slug: room.slug, plan: 'studio' }; req.query = { ...(req.query || {}), upgrade: '1' };
    return checkout(req, res);
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
    if (isLease(patch.plan)) await setTier(room, patch.plan);
    return room;
  };
  const webhook = async (req, res) => {
    if (!stripe || !webhookSecret) return res.status(503).end();
    let ev;
    try { ev = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), webhookSecret); }
    catch (e) { return res.status(400).send(`Webhook signature failed: ${e.message}`); }
    try {
      const o = ev.data.object;
      if (ev.type === 'checkout.session.completed' && o.payment_status === 'paid' || ev.type === 'checkout.session.async_payment_succeeded') {
        const slug = o.metadata?.slug || o.client_reference_id; const plan = PLANS[o.metadata?.plan] || (o.mode === 'subscription' ? 'month' : 'day');
        if (plan === 'day') {
          // a pass bought while one is running starts when that one ends: nothing paid for is lost
          const cur = await Room.findOne({ slug }); const from = Math.max(Date.now(), cur?.paidThrough?.getTime() || 0);
          await extend(slug, from + DAY, { plan: 'day', stripeCustomerId: o.customer || undefined });
        }
        else {
          // the subscription's own period end is authoritative; invoice.paid below repeats it each cycle
          const sub = o.subscription ? await stripe.subscriptions.retrieve(o.subscription) : null;
          // current_period_end lives on the subscription in older API versions and on its item in newer ones
          const cpe = sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end;
          const end = cpe ? cpe * 1000 : Date.now() + 31 * DAY;
          await extend(slug, end + GRACE, { plan, stripeCustomerId: o.customer || undefined, stripeSubscriptionId: o.subscription || undefined });
        }
      } else if (ev.type === 'invoice.paid') {
        // older API versions: invoice.subscription / subscription_details; newer: invoice.parent.subscription_details
        const sd = o.parent?.subscription_details || o.subscription_details || {};
        const subId = o.subscription || sd.subscription || o.lines?.data?.[0]?.parent?.subscription_item_details?.subscription || '';
        if (!subId) return res.json({ received: true });
        const lines = o.lines?.data || []; const line = lines[0] || {};
        const slug = sd.metadata?.slug || lines.map((l) => l.metadata?.slug).find(Boolean);
        const end = Math.max(0, ...lines.map((l) => (l.period?.end || 0) * 1000));
        // which lease was paid: scan the lines for a lease price (the payments add-on is a line too)
        const plan = planOfItems(lines) || 'month';
        if (slug && end) await extend(slug, end + GRACE, { plan });
        else { const room = await Room.findOne({ stripeSubscriptionId: subId }); if (room && end) await extend(room.slug, end + GRACE, { plan }); }
      } else if (ev.type === 'customer.subscription.updated') {
        // a plan switch in the portal: the tier follows the new price right away
        const room = await Room.findOne({ stripeSubscriptionId: o.id });
        const plan = planOfItems(o.items?.data);
        if (room && plan && room.plan !== plan) { room.plan = plan; await room.save(); await setTier(room, plan); }
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
