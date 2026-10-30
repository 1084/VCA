require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const { WebSocketServer } = require('ws');
const { setupWSConnection, docs } = require('y-websocket/bin/utils');

// ---- Configuration (from server/.env) ----
const SECRET = process.env.JWT_SECRET;
const MONGODB_URI = process.env.MONGODB_URI;
// Comma-separated list so two front ends can be live during a hosting
// cutover (e.g. the old Netlify URL and cove.johnhubert.llc). Exact match only.
const CLIENT_ORIGIN = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map((o) => o.trim()).filter(Boolean);
const PORT = process.env.PORT || 5000;

// Fail fast on missing secrets — never fall back to a hardcoded value.
if (!SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Add it to server/.env');
  process.exit(1);
}
if (!MONGODB_URI) {
  console.error('FATAL: MONGODB_URI is not set. Add it to server/.env');
  process.exit(1);
}

const app = express();
// Render/Heroku/most PaaS sit behind a reverse proxy; without this the
// rate limiter would see the proxy's IP for everyone and throttle all
// users as one. Harmless locally.
app.set('trust proxy', 1);

const { authLimiter, checkSignup, checkLogin } = require('./security');
const TOKEN_TTL = process.env.TOKEN_TTL || '24h';
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN, // locked to the deployed client(s), never '*'
    methods: ['GET', 'POST']
  }
});

app.use(cors({ origin: CLIENT_ORIGIN }));
// Stripe's webhook must see the raw body to check the signature; mounted before the JSON parser.
const { attachBilling, makeStripe } = require('./billing');
let billingWebhook = (req, res) => res.status(503).end();
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), (req, res) => billingWebhook(req, res));
app.use(express.json({ limit: '256kb' })); // room records carry a small avatar

// Reject query operators smuggled in request bodies ({ email: { $gt: '' } }):
// filters built from user input are treated as literal values.
mongoose.set('sanitizeFilter', true);
mongoose.connect(MONGODB_URI).catch((err) => {
  console.error('FATAL: MongoDB connection failed:', err.message);
  process.exit(1);
});

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  password: String,
  studio: { type: Boolean, default: false }, // premium lease: public page + room look
  // Cove Rooms: invited hosts. Set with the admin action (or bootstrapped
  // from HOST_EMAILS). termsAcceptedAt is recorded when the host creates
  // their first room after ticking the conduct rule + terms.
  host: { type: Boolean, default: false },
  hostSince: Date,
  maxRooms: { type: Number, default: 1 },
  termsAcceptedAt: Date,
  termsVersion: String
});
const User = mongoose.model('User', userSchema);

// ---- Workspace persistence (MongoDB) ----
// One snapshot per room, overwritten in place. NOTE: local-disk options
// like y-leveldb do NOT survive restarts on ephemeral-filesystem hosts
// (Render, Heroku, most containers) — MongoDB does, and it's already here.
const { setupPersistence } = require('./persistence');

const workspaceSchema = new mongoose.Schema({
  name: { type: String, unique: true, index: true },
  state: Buffer,
  updatedAt: Date
});
const WorkspaceDoc = mongoose.model('WorkspaceDoc', workspaceSchema);

setupPersistence({
  load: async (name) => {
    const doc = await WorkspaceDoc.findOne({ name });
    return doc?.state ?? null;
  },
  save: async (name, state) => {
    await WorkspaceDoc.updateOne(
      { name },
      { state, updatedAt: new Date() },
      { upsert: true }
    );
  }
});

app.post('/api/signup', authLimiter, async (req, res) => {
  try {
    const v = checkSignup(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const existing = await User.findOne({ email: v.email });
    if (existing) return res.status(409).json({ error: 'Email already exists' });
    const hash = await bcrypt.hash(v.password, 10);
    await new User({ email: v.email, password: hash }).save();
    res.json({ token: jwt.sign({ email: v.email }, SECRET, { expiresIn: TOKEN_TTL }) });
  } catch (err) {
    console.error('signup failed:', err.message);
    res.status(500).json({ error: 'Something went wrong — please try again.' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const v = checkLogin(req.body);
    if (v.error) return res.status(401).json({ error: v.error });
    const user = await User.findOne({ email: v.email });
    // Same message whether the account is missing or the password is
    // wrong — no free account-enumeration oracle.
    if (!user || !(await bcrypt.compare(v.password, user.password))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    res.json({ token: jwt.sign({ email: v.email }, SECRET, { expiresIn: TOKEN_TTL }) });
  } catch (err) {
    console.error('login failed:', err.message);
    res.status(500).json({ error: 'Something went wrong — please try again.' });
  }
});

// ---- TURN credentials (short-lived, per signed-in user) ----
const { attachTurn } = require('./turn');
attachTurn(app, { verifyToken: (t) => jwt.verify(t, SECRET) });

// ---- Cove Rooms (named rooms, guests, door, reports) ----
const requireAuth = (req, res, next) => {
  try {
    const t = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    req.user = jwt.verify(t, SECRET);
    if (req.user.guest) return res.status(403).json({ error: 'Guests cannot do that.' });
    next();
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
};
const { attachRooms } = require('./rooms');
const { makeTranslator } = require('./translate');
const translator = makeTranslator(process.env);
const { attachWalls } = require('./walls');
const { Room: RoomModel } = require('./rooms');
const walls = attachWalls(app, io, { secret: SECRET, Room: RoomModel, authLimiter });
attachRooms(app, io, { secret: SECRET, adminKey: process.env.ADMIN_KEY || '', requireAuth, User, WorkspaceDoc, authLimiter, translate: translator, onRoomDeleted: walls.clearWall });
const billing = attachBilling(app, {
  stripe: makeStripe(process.env), requireAuth, Room: RoomModel, User,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  prices: { month: process.env.STRIPE_PRICE_MONTH || '', day: process.env.STRIPE_PRICE_DAY || '' },
  origin: CLIENT_ORIGIN[0] || 'http://localhost:5173'
});
billingWebhook = billing.webhook;
console.log(`billing: ${billing.ready ? 'ready' : 'not configured (STRIPE_SECRET_KEY / STRIPE_PRICE_MONTH / STRIPE_PRICE_DAY)'}`);

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Unauthorized'));
  try {
    socket.user = jwt.verify(token, SECRET);
    next();
  } catch (err) {
    next(new Error('Unauthorized'));
  }
});

// ---- Room signaling (mesh, up to MAX_ROOM_SIZE people) ----
const { attachSignaling } = require('./signaling');
attachSignaling(io, { maxRoomSize: Number(process.env.MAX_ROOM_SIZE) || 10, translate: translator });

// ---- Real-time collaboration (Yjs over WebSocket) ----
// Socket.IO broadcasts are fine for WebRTC *signaling* (fire-and-forget
// messages), but shared documents need conflict resolution: if two people
// type at once, naive "send my new text to everyone" messages overwrite
// each other. Yjs is a CRDT — every edit is a mergeable operation, so
// concurrent edits from any number of users converge to the same result
// automatically, including offline/reconnect cases.
//
// This runs on the SAME http server, on the /collab path, so it deploys
// exactly like the rest of the app. Documents are per-room: the client
// connects to /collab/room-<roomId> and all workspace tabs (notes, code,
// whiteboard) live inside that one Yjs document.
const wss = new WebSocketServer({
  noServer: true,
  // Backstop #1: no single sync message may exceed this. Legit editing
  // messages are tiny; only abuse (giant pastes scripted past the client
  // limits) gets near it. ws closes the offending connection automatically.
  maxPayload: Number(process.env.COLLAB_MAX_MESSAGE_BYTES) || 2 * 1024 * 1024
});

// Backstop #2: total update traffic budget per room document. The client
// enforces per-file size limits, but clients can't be trusted — a modified
// client could stream unlimited edits and balloon server memory. Track
// cumulative update bytes per doc and disconnect any sender that pushes a
// room past the budget. Normal meetings use a tiny fraction of this.
const ROOM_UPDATE_BUDGET =
  Number(process.env.COLLAB_ROOM_BUDGET_BYTES) || 20 * 1024 * 1024;

function guardDoc(doc, docName) {
  if (doc.__updateBytes !== undefined) return; // guard once per doc
  doc.__updateBytes = 0;
  doc.on('update', (update, origin) => {
    doc.__updateBytes += update.length;
    if (doc.__updateBytes > ROOM_UPDATE_BUDGET && origin && typeof origin.close === 'function') {
      console.warn(`Collab room "${docName}" exceeded its update budget — disconnecting sender`);
      origin.close();
    }
  });
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Only handle /collab here. Returning (not destroying!) lets Socket.IO's
  // own upgrade listener handle /socket.io connections.
  if (!url.pathname.startsWith('/collab')) return;

  // Same JWT gate as the Socket.IO middleware.
  try {
    jwt.verify(url.searchParams.get('token'), SECRET);
  } catch (err) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const docName = url.pathname.slice('/collab/'.length) || 'default';
  // a guest key opens only its own room's notes
  try {
    const u = jwt.verify(url.searchParams.get('token'), SECRET);
    if (u.guest && docName !== `room-${u.room}`) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  } catch { /* already verified above */ }
  wss.handleUpgrade(req, socket, head, (ws) => {
    setupWSConnection(ws, req, { docName });
    const doc = docs.get(docName);
    if (doc) guardDoc(doc, docName);
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
