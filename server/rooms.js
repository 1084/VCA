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
const THEMES = ['plain', 'tutoring', 'meeting', 'study', 'family'];
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
  paidThrough: { type: Date, default: null },  // null = comped (invited host)
  createdAt: { type: Date, default: Date.now }
});
const Room = mongoose.model('Room', roomSchema);

const reportSchema = new mongoose.Schema({
  room: String,
  from: String,
  text: String,
  ts: { type: Date, default: Date.now },
  handled: { type: Boolean, default: false }
});
const Report = mongoose.model('Report', reportSchema);

const hostEmails = () => (process.env.HOST_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const isHostEmail = (email) => hostEmails().includes(String(email || '').toLowerCase());

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

function attachRooms(app, io, { secret, adminKey, requireAuth }) {
  // ---- who am I (hosts see their room editor) ----
  app.get('/api/me', requireAuth, async (req, res) => {
    const email = req.user.email;
    const host = isHostEmail(email);
    const rooms = host ? await Room.find({ ownerEmail: email }).lean() : [];
    res.json({ email, host, rooms: rooms.map(publicRoom) });
  });

  // ---- create / update my room (hosts only) ----
  app.post('/api/rooms', requireAuth, async (req, res) => {
    const email = req.user.email;
    if (!isHostEmail(email)) return res.status(403).json({ error: 'Rooms are invitation-only for now. Write to support@johnhubert.llc.' });
    const slug = cleanText(req.body?.slug, 32).toLowerCase();
    if (!SLUG_RX.test(slug) || RESERVED.has(slug)) return res.status(400).json({ error: 'Room link: 3–32 letters, numbers or dashes.' });
    const existing = await Room.findOne({ slug });
    if (existing && existing.ownerEmail !== email) return res.status(409).json({ error: 'That link is taken.' });
    const mine = await Room.countDocuments({ ownerEmail: email });
    if (!existing && mine >= 3) return res.status(400).json({ error: 'Up to three rooms per host for now.' });
    const theme = THEMES.includes(req.body?.theme) ? req.body.theme : 'plain';
    const doc = {
      slug, ownerEmail: email, theme,
      name: cleanText(req.body?.name, 60) || slug,
      locked: req.body?.locked !== false,
      tipLink: cleanLink(req.body?.tipLink),
      payLink: cleanLink(req.body?.payLink),
      payNote: cleanText(req.body?.payNote, 80)
    };
    const room = await Room.findOneAndUpdate({ slug }, doc, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.json(publicRoom(room));
  });

  app.delete('/api/rooms/:slug', requireAuth, async (req, res) => {
    const r = await Room.deleteOne({ slug: req.params.slug, ownerEmail: req.user.email });
    res.json({ ok: r.deletedCount === 1 });
  });

  // ---- what anyone can see from outside the door ----
  app.get('/api/r/:slug', async (req, res) => {
    const room = await Room.findOne({ slug: req.params.slug }).lean();
    if (!room || !roomIsOpen(room)) return res.status(404).json({ error: 'No room at this link.' });
    res.json({ ...publicRoom(room), ...presence(io, room) });
  });

  // ---- a guest asks for a key to one room ----
  app.post('/api/r/:slug/guest', async (req, res) => {
    const room = await Room.findOne({ slug: req.params.slug }).lean();
    if (!room || !roomIsOpen(room)) return res.status(404).json({ error: 'No room at this link.' });
    const name = cleanText(req.body?.name, 32).replace(/[@<>]/g, '');
    if (name.length < 1) return res.status(400).json({ error: 'Tell the room your name.' });
    const token = jwt.sign({ guest: true, room: room.slug, name }, secret, { expiresIn: GUEST_TTL });
    res.json({ token, name, room: publicRoom(room) });
  });

  // ---- reports, read by a person ----
  app.get('/api/admin/reports', async (req, res) => {
    if (!adminKey) return res.status(503).json({ error: 'ADMIN_KEY not configured' });
    if (req.get('authorization') !== `Bearer ${adminKey}`) return res.status(401).json({ error: 'Unauthorized' });
    const list = await Report.find({}).sort({ ts: -1 }).limit(200).lean();
    res.json(list);
  });
  app.post('/api/admin/reports/:id/handled', async (req, res) => {
    if (!adminKey || req.get('authorization') !== `Bearer ${adminKey}`) return res.status(401).json({ error: 'Unauthorized' });
    await Report.updateOne({ _id: req.params.id }, { handled: true });
    res.json({ ok: true });
  });
  // the host can close their own room's door server-side at any time
  app.get('/api/admin/rooms', async (req, res) => {
    if (!adminKey || req.get('authorization') !== `Bearer ${adminKey}`) return res.status(401).json({ error: 'Unauthorized' });
    res.json((await Room.find({}).lean()).map((r) => ({ ...publicRoom(r), ownerEmail: r.ownerEmail, ...presence(io, r) })));
  });
}

function publicRoom(r) {
  return { slug: r.slug, name: r.name, theme: r.theme, locked: !!r.locked, tipLink: r.tipLink || '', payLink: r.payLink || '', payNote: r.payNote || '',
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

module.exports = { attachRooms, Room, Report, isHostEmail, roomIsOpen, presence, SLUG_RX };
