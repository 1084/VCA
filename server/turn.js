// Short-lived TURN credentials, issued per user per room join.
//
// Why: a TURN credential baked into the client bundle can be copied by anyone
// who views the page source and used to relay traffic through our account
// from anywhere. Credentials minted here expire after TURN_TTL seconds and are
// only handed to signed-in users, so abuse needs a live Cove account and a
// fresh request every hour — and both of those are rate-limited.
//
// Provider: Cloudflare Realtime TURN (dash → Realtime → TURN Server → create a
// key). First 1,000 GB/month are free. Secrets go in server/.env:
//   CF_TURN_KEY_ID=...        the TURN key id
//   CF_TURN_API_TOKEN=...     the key's API token (shown once at creation)
//   TURN_TTL=3600             optional, seconds (default 1 hour)
// If the variables are missing, clients get STUN only (direct connections
// still work for most network pairs; strict NATs will fail to connect).

const rateLimit = require('express-rate-limit');

const STUN = { urls: 'stun:stun.l.google.com:19302' };
const KEY_ID = process.env.CF_TURN_KEY_ID;
const API_TOKEN = process.env.CF_TURN_API_TOKEN;
const TTL = Math.min(Math.max(Number(process.env.TURN_TTL) || 3600, 300), 86400);

// One credential per room join is normal; 30 per 15 minutes per IP is plenty
// for a human (and their flaky Wi-Fi) and useless for a relay-farming script.
const turnLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many connection attempts — try again in a few minutes.' }
});

async function mintIceServers() {
  if (!KEY_ID || !API_TOKEN) return { iceServers: [STUN], relay: false };
  const r = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: TTL }),
      signal: AbortSignal.timeout(5000)
    }
  );
  if (!r.ok) throw new Error(`Cloudflare TURN ${r.status}`);
  const j = await r.json();
  // The API returns { iceServers: [...] } (newer) or { iceServers: {...} } (older).
  const list = Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers].filter(Boolean);
  return { iceServers: [STUN, ...list], relay: list.length > 0, ttl: TTL };
}

// GET /api/turn  (Authorization: Bearer <jwt>) → { iceServers, relay, ttl }
function attachTurn(app, { verifyToken }) {
  app.get('/api/turn', turnLimiter, async (req, res) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    try { verifyToken(token); } catch { return res.status(401).json({ error: 'Unauthorized' }); }
    try {
      res.set('cache-control', 'no-store');
      res.json(await mintIceServers());
    } catch (err) {
      // Never block a call on the relay: fall back to STUN and log it.
      console.error('turn credential failed:', err.message);
      res.json({ iceServers: [STUN], relay: false });
    }
  });
}

module.exports = { attachTurn, STUN };
