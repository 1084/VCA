// Applications for a room. The form on /rooms/ posts here; the owner reviews
// on /rooms/admin.html (bearer ADMIN_KEY) and marks each one invited or
// declined. An invited email becomes a host the moment that person signs up
// (or at once, if they already have an account). The tier they asked for is
// a note for the call; the tier they get follows what they rent (billing.js),
// or what the admin sets for a comped room.
//
// Stored: name, email, which tier they want, what they teach, where they
// teach now, how they bill, anything else, when, and the decision. Declined
// applications are deleted after 90 days; the rest after a year.

const mongoose = require('mongoose');

const TIERS = ['room', 'studio'];
const STATUS = ['new', 'invited', 'declined'];

const applicationSchema = new mongoose.Schema({
  name: { type: String, default: '' },
  email: { type: String, index: true },
  tier: { type: String, default: 'room' },
  teaches: { type: String, default: '' },
  where: { type: String, default: '' },     // a link or a name
  billing: { type: String, default: '' },
  notes: { type: String, default: '' },
  status: { type: String, default: 'new', index: true },
  decidedAt: { type: Date, default: null },
  adminNote: { type: String, default: '' },
  ts: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 365 * 86400000) }
});
applicationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const ApplicationModel = mongoose.model('Application', applicationSchema);

const cleanText = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function attachApplications(app, { admin, authLimiter = (req, res, next) => next(), Application = ApplicationModel, log = console.log }) {
  // ---- public: send an application ----
  app.post('/api/apply', authLimiter, async (req, res) => {
    const b = req.body || {};
    if (typeof b.website === 'string' && b.website) return res.json({ ok: true }); // honeypot: bots fill it, people never see it
    const email = cleanText(b.email, 254).toLowerCase();
    const name = cleanText(b.name, 80);
    const tier = TIERS.includes(b.tier) ? b.tier : 'room';
    const teaches = cleanText(b.teaches, 400), where = cleanText(b.where, 300), billing = cleanText(b.billing, 300), notes = cleanText(b.notes, 1200);
    if (!EMAIL_RX.test(email)) return res.status(400).json({ error: 'An email address we can reply to, please.' });
    if (!name) return res.status(400).json({ error: 'Your name, please.' });
    if (!teaches) return res.status(400).json({ error: 'Tell us what you teach or what the room is for.' });
    if (b.agree !== true) return res.status(400).json({ error: 'Please read and agree to the conduct rule and the privacy policy.' });
    const recent = await Application.findOne({ email, ts: mongoose.trusted({ $gt: new Date(Date.now() - 30 * 86400000) }) }).lean().catch(() => null); // trusted: sanitizeFilter is on
    if (recent) return res.status(409).json({ error: 'We already have an application from this address. We reply to every one; give us a few days.' });
    await Application.create({ name, email, tier, teaches, where, billing, notes });
    log(`apply: ${email} (${tier})`);
    res.json({ ok: true });
  });

  // ---- admin: review ----
  app.get('/api/admin/applications', admin, async (req, res) => {
    const status = STATUS.includes(req.query.status) ? req.query.status : null;
    const list = await Application.find(status ? { status } : {}).sort({ ts: -1 }).limit(200).lean();
    res.json(list.map((a) => ({ id: String(a._id), name: a.name, email: a.email, tier: a.tier, teaches: a.teaches, where: a.where, billing: a.billing, notes: a.notes, status: a.status, ts: a.ts, decidedAt: a.decidedAt, adminNote: a.adminNote })));
  });
  // decide: { status: 'invited' | 'declined' | 'new', note }
  app.post('/api/admin/applications/:id/decide', admin, async (req, res) => {
    const status = STATUS.includes(req.body?.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ error: 'status must be invited, declined or new' });
    const a = await Application.findOne({ _id: req.params.id }).catch(() => null);
    if (!a) return res.status(404).json({ error: 'No such application.' });
    a.status = status; a.decidedAt = status === 'new' ? null : new Date(); a.adminNote = cleanText(req.body?.note, 300);
    a.expiresAt = new Date(Date.now() + (status === 'declined' ? 90 : 365) * 86400000);
    await a.save();
    let becameHost = false;
    if (status === 'invited' && typeof app.locals.inviteNow === 'function') becameHost = await app.locals.inviteNow(a.email);
    res.json({ ok: true, id: String(a._id), status, becameHost });
  });
  app.delete('/api/admin/applications/:id', admin, async (req, res) => {
    await Application.deleteOne({ _id: req.params.id }).catch(() => {});
    res.json({ ok: true });
  });

  // Called at signup: is this email invited? (an invitation outlives the account's creation)
  const isInvited = async (email) => !!(await Application.findOne({ email: String(email || '').toLowerCase(), status: 'invited' }).lean().catch(() => null));
  return { isInvited, Application };
}

module.exports = { attachApplications, Application: ApplicationModel, TIERS, STATUS };
