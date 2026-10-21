// Cove Rooms: named rooms that belong to an invited host, guests who need
// no account, a lockable door with knocking, and a report path.
//
// Design notes:
// - A Room has a slug (the link), an owner (by email), a theme, a lock flag,
//   and the host's own payment links. No money passes through here: the
//   links open whatever the tutor already uses (PayPal, Wise, Stripe link).
// - Guests get a short-lived JWT scoped to ONE room ({guest, room, name}).
//   It can open that room's socket and that room's notes document and
//   nothing else. Nothing about a guest is stored.
// - Hosts are invited: HOST_EMAILS (comma-separated) or user.host in Mongo.
// - Reports store the room, the reporter's display name, their words and
//   the time. Never media. Read with the admin key.

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const SLUG_RX = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;
const THEMES = ['plain', 'tutoring', 'meeting', 'study', 'family', 'language'];
const RESERVED = new Set(['api', 'r', 'rooms', 'admin', 'collab', 'socket.io', 'assets', 'privacy', 'terms']);
const GUEST_TTL = '12h';

const roomSchema = new mongoose.Schema({
  slug: { type: String, unique: true, index: true },
  name: { type: String, default: '' },
  ownerEmail: { type: String, index: true },
  theme: { type: String, default: 'plain' },
  locked: { type: Boolean, default: true },
  tipLink: { type: String, default: '' },
  payLink: { type: String, default: '' },
  payNote: { type: String, default: '' },      // e.g. "$15 per session"
  translate: { type: Boolean, default: false }, // language room: send caption text to the translator (host opt-in)
  paidThrough: { type: Date, default: null },  // null = comped (invited host)
  createdAt: { type: Date, default: Date.now },
  lastSessionAt: { type: Date, default: Date.now } // the host was last in the room; drives expiry
});
const TERMS_VERSION = '2026-10-20';
const ROOM_IDLE_DAYS = 90;   // named room with no host session for this long is archived
const NOTES_IDLE_DAYS = 30;  // plain-code room notes untouched for this long are deleted
const Room = mongoose.model('Room', roomSchema);

const reportSchema = new mongoose.Schema({
  room: String,
  from: String,
  text: String,
  ts: { type: Date, default: Date.now },
  handled: { type: Boolean, default: false }
});
reportSchema.index({ ts: 1 }, { expireAfterSeconds: 365 * 86400 }); // reports live one year
const Report = mongoose.model('Report', reportSchema);

const hostEmails = () => (process.env.HOST_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const isHostEmail = (email) => hostEmails().includes(String(email || '').toLowerCase());
// a host is a user with the flag, or bootstrapped from HOST_EMAILS
const hostOf = async (User, email) => {
  const u = await User.findOne({ email }).lean();
  const host = !!(u?.host || isHostEmail(email));
  return { user: u, host, maxRooms: u?.maxRooms || 1, termsAcceptedAt: u?.termsAcceptedAt || null };
};

// Only http(s) links; the page opens them in a new tab. Nothing else.
function cleanLink(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim().slice(0, 300);
  if (!s) return '';
  try { const u = new URL(s); return ['http:', 'https:'].includes(u.protocol) ? u.toString() : ''; } catch { return ''; }
}
const cleanText = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');

function roomIsOpen(room) {
  return !room.paidThrough || room.paidThrough.getTime() > Date.now();
}

function attachRooms(app, io, { secret, adminKey, requireAuth, User, WorkspaceDoc, authLimiter }) {
  const admin = (req, res, next) => {
    if (!adminKey) return res.status(503).json({ error: 'ADMIN_KEY not configured' });
    if (req.get('authorization') !== `Bearer ${adminKey}`) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };
  const daysIdle = (r) => Math.floor((Date.now() - new Date(r.lastSessionAt || r.createdAt).getTime()) / 86400000);

  // ---- who am I (hosts see their room editor) ----
  app.get('/api/me', requireAuth, async (req, res) => {
    const email = req.user.email;
    const h = await hostOf(User, email);
    const rooms = h.host ? await Room.find({ ownerEmail: email }).lean() : [];
    res.json({ email, host: h.host, maxRooms: h.maxRooms, termsAcceptedAt: h.termsAcceptedAt, termsVersion: TERMS_VERSION,
      rooms: rooms.map((r) => ({ ...publicRoom(r), idleDays: daysIdle(r), expiresInDays: Math.max(0, ROOM_IDLE_DAYS - daysIdle(r)) })) });
  });

  // ---- create / update my room (hosts only) ----
  app.post('/api/rooms', requireAuth, async (req, res) => {
    const email = req.user.email;
    const h = await hostOf(User, email);
    if (!h.host) return res.status(403).json({ error: 'Rooms are invitation-only for now. Write to support@johnhubert.llc.' });
    // the conduct rule + terms are accepted once, at the first room
    if (!h.termsAcceptedAt) {
      if (req.body?.acceptTerms !== true) return res.status(400).json({ error: 'Please accept the conduct rule and terms to open a room.' });
      await User.updateOne({ email }, { termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION, $setOnInsert: {} });
    }
    const slug = cleanText(req.body?.slug, 32).toLowerCase();
    if (!SLUG_RX.test(slug) || RESERVED.has(slug)) return res.status(400).json({ error: 'Room link: 3–32 letters, numbers or dashes.' });
    const existing = await Room.findOne({ slug });
    if (existing && existing.ownerEmail !== email) return res.status(409).json({ error: 'That link is taken.' });
    const mine = await Room.countDocuments({ ownerEmail: email });
    if (!existing && mine >= h.maxRooms) return res.status(400).json({ error: h.maxRooms === 1 ? 'One room per host for now — write to us if you need another.' : `Up to ${h.maxRooms} rooms for your account.` });
    const theme = THEMES.includes(req.body?.theme) ? req.body.theme : 'plain';
    const doc = {
      slug, ownerEmail: email, theme,
      name: cleanText(req.body?.name, 60) || slug,
      locked: req.body?.locked !== false,
      tipLink: cleanLink(req.body?.tipLink),
      payLink: cleanLink(req.body?.payLink),
      payNote: cleanText(req.body?.payNote, 80),
      translate: theme === 'language' && req.body?.translate === true
    };
    const room = await Room.findOneAndUpdate({ slug }, doc, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.json(publicRoom(room));
  });

  app.delete('/api/rooms/:slug', requireAuth, async (req, res) => {
    const r = await Room.deleteOne({ slug: req.params.slug, ownerEmail: req.user.email });
    if (r.deletedCount === 1) await WorkspaceDoc.deleteOne({ name: `room-${req.params.slug}` }).catch(() => {});
    res.json({ ok: r.deletedCount === 1 });
  });

  // ---- what anyone can see from outside the door ----
  app.get('/api/r/:slug', async (req, res) => {
    const room = await Room.findOne({ slug: req.params.slug }).lean();
    if (!room || !roomIsOpen(room)) return res.status(404).json({ error: 'No room at this link.' });
    res.json({ ...publicRoom(room), ...presence(io, room) });
  });

  // ---- a guest asks for a key to one room (rate-limited like sign-in) ----
  app.post('/api/r/:slug/guest', authLimiter, async (req, res) => {
    const room = await Room.findOne({ slug: req.params.slug }).lean();
    if (!room || !roomIsOpen(room)) return res.status(404).json({ error: 'No room at this link.' });
    const name = cleanText(req.body?.name, 32).replace(/[@<>]/g, '');
    if (name.length < 1) return res.status(400).json({ error: 'Tell the room your name.' });
    const token = jwt.sign({ guest: true, room: room.slug, name }, secret, { expiresIn: GUEST_TTL });
    res.json({ token, name, room: publicRoom(room) });
  });

  // ---- admin: reports, rooms, hosts (bearer ADMIN_KEY; a person on the other end) ----
  app.get('/api/admin/reports', admin, async (req, res) => {
    res.json(await Report.find({}).sort({ ts: -1 }).limit(200).lean());
  });
  app.post('/api/admin/reports/:id/handled', admin, async (req, res) => {
    await Report.updateOne({ _id: req.params.id }, { handled: true });
    res.json({ ok: true });
  });
  app.get('/api/admin/rooms', admin, async (req, res) => {
    res.json((await Room.find({}).lean()).map((r) => ({ ...publicRoom(r), ownerEmail: r.ownerEmail, idleDays: daysIdle(r), ...presence(io, r) })));
  });
  app.delete('/api/admin/rooms/:slug', admin, async (req, res) => {
    const r = await Room.deleteOne({ slug: req.params.slug });
    await WorkspaceDoc.deleteOne({ name: `room-${req.params.slug}` }).catch(() => {});
    res.json({ ok: r.deletedCount === 1 });
  });
  // invite or revoke a host: { email, host: true|false, maxRooms? }
  app.get('/api/admin/hosts', admin, async (req, res) => {
    res.json(await User.find({ host: true }, { email: 1, hostSince: 1, maxRooms: 1, termsAcceptedAt: 1, termsVersion: 1 }).lean());
  });
  app.post('/api/admin/hosts', admin, async (req, res) => {
    const email = cleanText(req.body?.email, 254).toLowerCase();
    if (!email) return res.status(400).json({ error: 'email required' });
    const u = await User.findOne({ email });
    if (!u) return res.status(404).json({ error: 'No account with that email yet — they sign up first, then you invite.' });
    const host = req.body?.host !== false;
    const upd = { host, ...(host && !u.hostSince ? { hostSince: new Date() } : {}) };
    if (Number.isInteger(req.body?.maxRooms) && req.body.maxRooms >= 1 && req.body.maxRooms <= 10) upd.maxRooms = req.body.maxRooms;
    await User.updateOne({ email }, upd);
    if (!host) {
      const rooms = await Room.find({ ownerEmail: email }).lean();
      for (const r of rooms) { await Room.deleteOne({ slug: r.slug }); await WorkspaceDoc.deleteOne({ name: `room-${r.slug}` }).catch(() => {}); }
    }
    res.json({ ok: true, email, host, maxRooms: upd.maxRooms || u.maxRooms || 1 });
  });

  // ---- expiry sweep: nothing lingers that nobody uses ----
  const sweep = async () => {
    try {
      const cutoff = new Date(Date.now() - ROOM_IDLE_DAYS * 86400000);
      const stale = await Room.find({ $or: [{ lastSessionAt: { $lt: cutoff } }, { lastSessionAt: null, createdAt: { $lt: cutoff } }] }).lean();
      for (const r of stale) {
        await Room.deleteOne({ slug: r.slug });
        await WorkspaceDoc.deleteOne({ name: `room-${r.slug}` }).catch(() => {});
        console.log(`rooms: archived idle room ${r.slug} (${ROOM_IDLE_DAYS}+ days)`);
      }
      // notes for plain code rooms (not a named room) idle 30+ days
      const named = new Set((await Room.find({}, { slug: 1 }).lean()).map((r) => `room-${r.slug}`));
      const old = await WorkspaceDoc.find({ updatedAt: { $lt: new Date(Date.now() - NOTES_IDLE_DAYS * 86400000) } }, { name: 1 }).lean();
      for (const d of old) if (!named.has(d.name)) await WorkspaceDoc.deleteOne({ _id: d._id });
    } catch (e) { console.warn('rooms sweep failed:', e.message); }
  };
  setTimeout(sweep, 30_000);
  setInterval(sweep, 6 * 3600_000).unref();
}

function publicRoom(r) {
  return { slug: r.slug, name: r.name, theme: r.theme, locked: !!r.locked, tipLink: r.tipLink || '', payLink: r.payLink || '', payNote: r.payNote || '', translate: !!r.translate,
    hostName: (r.ownerEmail || '').split('@')[0] };
}

function presence(io, room) {
  const set = io.sockets.adapter.rooms.get(room.slug);
  let hostPresent = false, count = 0;
  for (const id of set || []) {
    const s = io.sockets.sockets.get(id);
    if (!s) continue;
    count++;
    if (s.user?.email === room.ownerEmail) hostPresent = true;
  }
  return { hostPresent, count, startedAt: set?.__startedAt || null };
}

module.exports = { attachRooms, Room, Report, isHostEmail, roomIsOpen, presence, SLUG_RX, TERMS_VERSION, ROOM_IDLE_DAYS, NOTES_IDLE_DAYS };
