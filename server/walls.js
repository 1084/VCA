// Cove Walls: what a Studio room remembers between lessons.
//
// A pin is one thing on the wall: a short video, a file to review, a homework
// assignment, a student's hand-in, or a message (thanks, a note, a review).
// Walls are room-only: the host and anyone holding a key to that room can
// see them; the front door never shows them.
//
// Who may do what:
//   host     pin video / file / homework / message; remove anything
//   guest    leave a message; hand in a file; remove their own
// Hand-ins are visible to the host and to the student who handed them in.
//
// Files live in Cloudflare R2 (S3 API). The server never proxies bytes: it
// signs a short-lived PUT for the upload and a short-lived GET for each
// download. If R2 isn't configured, link/text pins still work and file pins
// answer 503 so the UI can say "uploads aren't set up yet".

const mongoose = require('mongoose');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const KINDS = ['video', 'file', 'homework', 'handin', 'message'];
const HOST_KINDS = new Set(['video', 'file', 'homework', 'message']);
const GUEST_KINDS = new Set(['message', 'handin']);
const LIMITS = {
  video: 100 * 1024 * 1024, file: 25 * 1024 * 1024, homework: 25 * 1024 * 1024, handin: 25 * 1024 * 1024, message: 0
};
const MIME_OK = {
  video: /^video\/(mp4|webm|quicktime)$/,
  any: /^(application\/pdf|image\/(png|jpeg|webp|gif)|text\/plain|text\/markdown|text\/csv|audio\/(mpeg|mp4|ogg|wav)|video\/(mp4|webm|quicktime)|application\/(zip|msword|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.apple\.(pages|numbers|keynote)))$/
};
const MAX_PINS = 60;                       // per room
const MAX_BYTES = 2 * 1024 * 1024 * 1024;  // per room, 2 GB
const SIGN_TTL = 10 * 60;                  // seconds a signed URL is good for

const pinSchema = new mongoose.Schema({
  room: { type: String, index: true },
  kind: { type: String, enum: KINDS },
  title: { type: String, default: '' },
  text: { type: String, default: '' },     // message body, homework instructions, file note
  link: { type: String, default: '' },     // optional external link (YouTube, Drive, a worksheet)
  due: { type: Date, default: null },      // homework
  by: { type: String, default: '' },       // display name
  byKey: { type: String, default: '' },    // host email or guest jti — who may remove it / see a hand-in
  host: { type: Boolean, default: false }, // pinned by the host
  key: { type: String, default: '' },      // R2 object key, once a file is attached
  name: { type: String, default: '' },     // original filename
  mime: { type: String, default: '' },
  size: { type: Number, default: 0 },
  ready: { type: Boolean, default: true }, // false until the upload is confirmed
  ts: { type: Date, default: Date.now }
});
pinSchema.index({ room: 1, ts: -1 });
const PinModel = mongoose.model('Pin', pinSchema);

const cleanText = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');
function cleanLink(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim().slice(0, 500);
  if (!s) return '';
  try { const u = new URL(s); return ['http:', 'https:'].includes(u.protocol) ? u.toString() : ''; } catch { return ''; }
}
const safeName = (v) => cleanText(v, 120).replace(/[\\/:*?"<>|]/g, '_') || 'file';

// ---- R2 (S3-compatible). Lazy so the server boots without the SDK configured.
function makeStore(env) {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return null;
  let s3, cmds, presign;
  const load = () => {
    if (s3) return;
    const sdk = require('@aws-sdk/client-s3');
    ({ getSignedUrl: presign } = require('@aws-sdk/s3-request-presigner'));
    cmds = sdk;
    s3 = new sdk.S3Client({
      region: 'auto', endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
    });
  };
  return {
    putUrl: async (key, mime, size) => { load(); return presign(s3, new cmds.PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: mime, ContentLength: size }), { expiresIn: SIGN_TTL }); },
    getUrl: async (key, name) => { load(); return presign(s3, new cmds.GetObjectCommand({ Bucket: R2_BUCKET, Key: key, ResponseContentDisposition: `inline; filename="${encodeURIComponent(name)}"` }), { expiresIn: SIGN_TTL }); },
    head: async (key) => { load(); try { const h = await s3.send(new cmds.HeadObjectCommand({ Bucket: R2_BUCKET, Key: key })); return { size: h.ContentLength || 0, mime: h.ContentType || '' }; } catch { return null; } },
    del: async (key) => { load(); try { await s3.send(new cmds.DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })); } catch { /* best effort */ } }
  };
}

function attachWalls(app, io, { secret, Room, authLimiter = (req, res, next) => next(), store = makeStore(process.env), Pin = PinModel }) {
  // Anyone with a key to the room: the host's user token, or a guest key for this slug.
  const roomKey = async (req, res, next) => {
    try {
      const t = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const u = jwt.verify(t, secret);
      const room = await Room.findOne({ slug: req.params.slug }).lean();
      if (!room || !room.studio) return res.status(404).json({ error: 'This room has no wall.' });
      const isHost = !u.guest && u.email === room.ownerEmail;
      if (!isHost && !(u.guest && u.room === room.slug)) return res.status(403).json({ error: 'Not your room.' });
      req.wall = { room, isHost, who: isHost ? room.ownerEmail : u.jti, name: isHost ? (room.ownerEmail || '').split('@')[0] : u.name };
      next();
    } catch { res.status(401).json({ error: 'Unauthorized' }); }
  };
  const view = (p, w) => ({
    id: String(p._id), kind: p.kind, title: p.title, text: p.text, link: p.link, due: p.due, by: p.by, host: p.host,
    name: p.name, mime: p.mime, size: p.size, ready: p.ready, ts: p.ts, mine: p.byKey === w.who, hasFile: !!p.key
  });
  const canSee = (p, w) => p.kind !== 'handin' || w.isHost || p.byKey === w.who;
  const changed = (slug) => io.to(slug).emit('wall-changed');

  app.get('/api/r/:slug/wall', roomKey, async (req, res) => {
    const pins = await Pin.find({ room: req.params.slug, ready: true }).sort({ ts: -1 }).lean();
    res.json({ pins: pins.filter((p) => canSee(p, req.wall)).map((p) => view(p, req.wall)), uploads: !!store,
      limits: { pins: MAX_PINS, bytes: MAX_BYTES, video: LIMITS.video, file: LIMITS.file } });
  });

  // Create a pin. Text/link pins are ready at once; file pins return an upload
  // URL and sit unready until /done confirms the object exists.
  app.post('/api/r/:slug/wall', authLimiter, roomKey, async (req, res) => {
    const w = req.wall; const b = req.body || {};
    const kind = KINDS.includes(b.kind) ? b.kind : '';
    if (!kind) return res.status(400).json({ error: 'What kind of pin?' });
    if (!(w.isHost ? HOST_KINDS : GUEST_KINDS).has(kind)) return res.status(403).json({ error: w.isHost ? 'Hosts review hand-ins; students hand them in.' : 'Students can leave a message or hand in work.' });
    const count = await Pin.countDocuments({ room: w.room.slug });
    if (count >= MAX_PINS) return res.status(409).json({ error: `This wall is full (${MAX_PINS} pins). Take something down first.` });
    const title = cleanText(b.title, 80), text = cleanText(b.text, kind === 'message' ? 300 : 1200), link = cleanLink(b.link);
    const due = kind === 'homework' && b.due && !Number.isNaN(Date.parse(b.due)) ? new Date(b.due) : null;
    const file = b.file && typeof b.file === 'object' ? b.file : null;
    if (kind === 'message' && !text) return res.status(400).json({ error: 'Say something first.' });
    if (kind !== 'message' && !title && !file && !link) return res.status(400).json({ error: 'Give it a title, a link or a file.' });
    const pin = { room: w.room.slug, kind, title, text, link, due, by: w.name, byKey: w.who, host: w.isHost, ready: !file };
    let upload = null;
    if (file) {
      if (!store) return res.status(503).json({ error: 'Uploads are not set up yet. Pin a link instead.' });
      const size = Number(file.size) || 0, mime = cleanText(file.type, 80);
      const okMime = kind === 'video' ? MIME_OK.video : MIME_OK.any;
      if (!okMime.test(mime)) return res.status(415).json({ error: kind === 'video' ? 'Videos must be MP4, WebM or MOV.' : 'That file type is not allowed here.' });
      if (size <= 0 || size > LIMITS[kind]) return res.status(413).json({ error: `Too big: the limit is ${Math.round(LIMITS[kind] / 1048576)} MB.` });
      const used = (await Pin.aggregate([{ $match: { room: w.room.slug } }, { $group: { _id: null, n: { $sum: '$size' } } }]))[0]?.n || 0;
      if (used + size > MAX_BYTES) return res.status(409).json({ error: 'This room is out of wall space. Take a file down first.' });
      Object.assign(pin, { key: `rooms/${w.room.slug}/${crypto.randomUUID()}/${safeName(file.name)}`, name: safeName(file.name), mime, size });
      upload = await store.putUrl(pin.key, mime, size);
    }
    const doc = await Pin.create(pin);
    if (doc.ready) changed(w.room.slug);
    res.json({ pin: view(doc, w), upload, uploadHeaders: upload ? { 'content-type': pin.mime } : null });
  });

  // The browser finished the PUT: make sure the object is really there before showing it.
  app.post('/api/r/:slug/wall/:id/done', roomKey, async (req, res) => {
    const p = await Pin.findOne({ _id: req.params.id, room: req.params.slug }).catch(() => null);
    if (!p || p.ready) return res.status(404).json({ error: 'Nothing to confirm.' });
    if (p.byKey !== req.wall.who) return res.status(403).json({ error: 'Not yours.' });
    const h = store ? await store.head(p.key) : null;
    if (!h) return res.status(409).json({ error: 'The upload did not arrive. Try again.' });
    p.size = h.size || p.size; p.ready = true; await p.save();
    changed(req.params.slug);
    res.json({ pin: view(p, req.wall) });
  });

  // A short-lived link to open or download the file.
  app.get('/api/r/:slug/wall/:id/url', roomKey, async (req, res) => {
    const p = await Pin.findOne({ _id: req.params.id, room: req.params.slug, ready: true }).lean().catch(() => null);
    if (!p || !p.key || !canSee(p, req.wall)) return res.status(404).json({ error: 'No such file.' });
    if (!store) return res.status(503).json({ error: 'Uploads are not set up.' });
    res.json({ url: await store.getUrl(p.key, p.name), mime: p.mime, name: p.name });
  });

  // Take a pin down: the host may remove anything; a guest only their own.
  app.delete('/api/r/:slug/wall/:id', roomKey, async (req, res) => {
    const p = await Pin.findOne({ _id: req.params.id, room: req.params.slug }).catch(() => null);
    if (!p) return res.status(404).json({ error: 'Already gone.' });
    if (!req.wall.isHost && p.byKey !== req.wall.who) return res.status(403).json({ error: 'Not yours to take down.' });
    await Pin.deleteOne({ _id: p._id });
    if (p.key && store) await store.del(p.key);
    changed(req.params.slug);
    res.json({ ok: true });
  });

  // Called when a room is deleted: clear its wall and its files.
  const clearWall = async (slug) => {
    const pins = await Pin.find({ room: slug }).lean();
    await Pin.deleteMany({ room: slug });
    if (store) for (const p of pins) if (p.key) await store.del(p.key);
  };
  return { Pin, clearWall };
}

module.exports = { attachWalls, makeStore, Pin: PinModel, KINDS, LIMITS, MAX_PINS, MAX_BYTES };
