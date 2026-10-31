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
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const SLUG_RX = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;
const THEMES = ['plain', 'tutoring', 'meeting', 'study', 'family', 'language'];
const WALLS = ['', 'forest', 'dusk', 'clay', 'slate', 'plum'];
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
  // ---- Studio (premium lease): the host's own public page + room look ----
  studio: { type: Boolean, default: false },
  tagline: { type: String, default: '' },      // "Alicia Ortiz · Cuernavaca · Spanish, chemistry"
  about: { type: String, default: '' },        // in the host's language
  aboutLang: { type: String, default: '' },
  priceNote: { type: String, default: '' },    // "$30 per 50-minute lesson · packs of 4 for $110"
  education: { type: String, default: '' },    // plain text, one per line
  wall: { type: String, default: '' },         // one of WALLS
  welcome: { type: String, default: '' },      // "{name}" is replaced with the guest's name
  avail: { type: [Number], default: [] },      // 21 flags: day*3 + slot (morning/afternoon/evening)
  tz: { type: String, default: '' },
  photo: { type: String, default: '' },        // data: URL, ≤ 120 KB (small avatar)
  paidThrough: { type: Date, default: null },  // null = comped (invited host); otherwise the door closes after this
  plan: { type: String, default: '' },         // 'month' | 'day' — last thing bought (billing.js)
  stripeCustomerId: { type: String, default: '' },
  stripeSubscriptionId: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  lastSessionAt: { type: Date, default: Date.now } // the host was last in the room; drives expiry
});
const TERMS_VERSION = '2026-10-30';
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
  return { user: u, host, maxRooms: u?.maxRooms || 1, termsAcceptedAt: u?.termsAcceptedAt || null, studio: !!u?.studio };
};

// Only http(s) links; the page opens them in a new tab. Nothing else.
function cleanLink(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim().slice(0, 300);
  if (!s) return '';
  try { const u = new URL(s); return ['http:', 'https:'].includes(u.protocol) ? u.toString() : ''; } catch { return ''; }
}
const cleanText = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');

// A small avatar as a data URL. Kept tiny so it lives happily in the room record.
function cleanPhoto(v) {
  if (typeof v !== 'string') return '';
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v) || v.length > 160_000) return '';
  return v;
}
function roomIsOpen(room) {
  return !room.paidThrough || room.paidThrough.getTime() > Date.now();
}

function attachRooms(app, io, { secret, adminKey, requireAuth, User, WorkspaceDoc, authLimiter, translate = null, onRoomDeleted = async () => {} }) {
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
    res.json({ email, host: h.host, studio: h.studio, maxRooms: h.maxRooms, termsAcceptedAt: h.termsAcceptedAt, termsVersion: TERMS_VERSION,
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
      translate: theme === 'language' && req.body?.translate === true,
      studio: !!h.studio // the room's tier always follows the account's; saving re-syncs it
    };
    // Studio fields (kept on the record; the door shows them only while studio is on)
    if (h.studio || existing?.studio) {
      Object.assign(doc, {
        tagline: cleanText(req.body?.tagline, 90), about: cleanText(req.body?.about, 1200), aboutLang: cleanText(req.body?.aboutLang, 8),
        priceNote: cleanText(req.body?.priceNote, 120), education: cleanText(req.body?.education, 600),
        wall: WALLS.includes(req.body?.wall) ? req.body.wall : '', welcome: cleanText(req.body?.welcome, 160),
        avail: Array.isArray(req.body?.avail) ? req.body.avail.slice(0, 21).map((v) => (v ? 1 : 0)) : [], tz: cleanText(req.body?.tz, 40),
        photo: cleanPhoto(req.body?.photo)
      });
    }
    const room = await Room.findOneAndUpdate({ slug }, doc, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.json(publicRoom(room));
  });

  app.delete('/api/rooms/:slug', requireAuth, async (req, res) => {
    const r = await Room.deleteOne({ slug: req.params.slug, ownerEmail: req.user.email });
    if (r.deletedCount === 1) { await WorkspaceDoc.deleteOne({ name: `room-${req.params.slug}` }).catch(() => {}); await onRoomDeleted(req.params.slug).catch(() => {}); }
    res.json({ ok: r.deletedCount === 1 });
  });

  // ---- what anyone can see from outside the door ----
  app.get('/api/r/:slug', async (req, res) => {
    const room = await Room.findOne({ slug: req.params.slug }).lean();
    if (!room || !roomIsOpen(room)) return res.status(404).json({ error: 'No room at this link.' });
    res.json({ ...publicRoom(room), ...presence(io, room) });
  });

  // ---- translate the host's About for a visitor (text only; nothing stored) ----
  app.get('/api/r/:slug/about', authLimiter, async (req, res) => {
    const room = await Room.findOne({ slug: req.params.slug }).lean();
    if (!room?.studio || !room.about) return res.status(404).json({ error: 'No page' });
    const to = cleanText(req.query.to, 5).toLowerCase();
    if (!translate || !to) return res.json({ text: room.about, translated: false });
    try { res.json({ text: await translate(room.about, room.aboutLang, to), translated: true }); }
    catch { res.json({ text: room.about, translated: false }); }
  });

  // ---- a guest asks for a key to one room (rate-limited like sign-in) ----
  app.post('/api/r/:slug/guest', authLimiter, async (req, res) => {
    const room = await Room.findOne({ slug: req.params.slug }).lean();
    if (!room || !roomIsOpen(room)) return res.status(404).json({ error: 'No room at this link.' });
    const name = cleanText(req.body?.name, 32).replace(/[@<>]/g, '');
    if (name.length < 1) return res.status(400).json({ error: 'Tell the room your name.' });
    const token = jwt.sign({ guest: true, room: room.slug, name, jti: crypto.randomUUID() }, secret, { expiresIn: GUEST_TTL });
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
    await onRoomDeleted(req.params.slug).catch(() => {});
    res.json({ ok: r.deletedCount === 1 });
  });
  // invite or revoke a host: { email, host: true|false, maxRooms? }
  app.get('/api/admin/hosts', admin, async (req, res) => {
    res.json(await User.find({ host: true }, { email: 1, hostSince: 1, maxRooms: 1, studio: 1, termsAcceptedAt: 1, termsVersion: 1 }).lean());
  });
  app.post('/api/admin/hosts', admin, async (req, res) => {
    const email = cleanText(req.body?.email, 254).toLowerCase();
    if (!email) return res.status(400).json({ error: 'email required' });
    const u = await User.findOne({ email });
    if (!u) return res.status(404).json({ error: 'No account with that email yet — they sign up first, then you invite.' });
    const host = req.body?.host !== false;
    const upd = { host, ...(host && !u.hostSince ? { hostSince: new Date() } : {}) };
    if (Number.isInteger(req.body?.maxRooms) && req.body.maxRooms >= 1 && req.body.maxRooms <= 10) upd.maxRooms = req.body.maxRooms;
    if (typeof req.body?.studio === 'boolean') { upd.studio = req.body.studio; await Room.updateMany({ ownerEmail: email }, { studio: req.body.studio }); }
    await User.updateOne({ email }, upd);
    if (!host) {
      const rooms = await Room.find({ ownerEmail: email }).lean();
      for (const r of rooms) { await Room.deleteOne({ slug: r.slug }); await WorkspaceDoc.deleteOne({ name: `room-${r.slug}` }).catch(() => {}); }
    }
    res.json({ ok: true, email, host, maxRooms: upd.maxRooms || u.maxRooms || 1, studio: typeof upd.studio === 'boolean' ? upd.studio : !!u.studio });
  });

  // ---- expiry sweep: nothing lingers that nobody uses ----
  const sweep = async () => {
    try {
      const cutoff = new Date(Date.now() - ROOM_IDLE_DAYS * 86400000);
      // sanitizeFilter is on globally (see index.js); these dates are ours, so mark the operators trusted
      // trusted() must wrap each operator object, not the whole filter: sanitizeFilter checks the leaves
      const before = () => mongoose.trusted({ $lt: cutoff });
      const stale = await Room.find({ $or: [{ lastSessionAt: before() }, { lastSessionAt: null, createdAt: before() }] }).lean();
      for (const r of stale) {
        await Room.deleteOne({ slug: r.slug });
        await WorkspaceDoc.deleteOne({ name: `room-${r.slug}` }).catch(() => {});
        console.log(`rooms: archived idle room ${r.slug} (${ROOM_IDLE_DAYS}+ days)`);
      }
      // notes for plain code rooms (not a named room) idle 30+ days
      const named = new Set((await Room.find({}, { slug: 1 }).lean()).map((r) => `room-${r.slug}`));
      const old = await WorkspaceDoc.find({ updatedAt: mongoose.trusted({ $lt: new Date(Date.now() - NOTES_IDLE_DAYS * 86400000) }) }, { name: 1 }).lean();
      for (const d of old) if (!named.has(d.name)) await WorkspaceDoc.deleteOne({ _id: d._id });
    } catch (e) { console.warn('rooms sweep failed:', e.message); }
  };
  setTimeout(sweep, 30_000);
  setInterval(sweep, 6 * 3600_000).unref();
}

function publicRoom(r) {
  const base = { slug: r.slug, name: r.name, theme: r.theme, locked: !!r.locked, tipLink: r.tipLink || '', payLink: r.payLink || '', payNote: r.payNote || '', translate: !!r.translate,
    hostName: (r.ownerEmail || '').split('@')[0], studio: !!r.studio };
  if (r.studio) Object.assign(base, { tagline: r.tagline || '', about: r.about || '', aboutLang: r.aboutLang || '', priceNote: r.priceNote || '', education: r.education || '',
    wall: r.wall || '', welcome: r.welcome || '', avail: r.avail || [], tz: r.tz || '', photo: r.photo || '' });
  return base;
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
