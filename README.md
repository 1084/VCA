# Video chat app — collaboration update

## What changed in this drop
1. **Real-time collaborative workspace** (Notes / Code / Whiteboard) inside each
   room, built on **Yjs** (a CRDT) so simultaneous edits merge instead of
   overwriting each other. Sync runs over a WebSocket endpoint at `/collab`
   on the same server, gated by the same JWT as everything else.
2. **Group calls up to 10 people**: full mesh WebRTC — every participant
   holds one peer connection per other participant, negotiated with the
   "perfect negotiation" pattern so simultaneous joins and mid-call track
   changes (screen share, camera toggles) can't deadlock. Signaling is
   peer-targeted and verified server-side to stay within the sender's room.
   The 10-person cap (MAX_ROOM_SIZE) exists because mesh upload bandwidth
   grows linearly with room size: with 9 peers you upload your video 9
   times. Scaling beyond this means an SFU (mediasoup, LiveKit) — a server
   that receives each stream once and fans it out.
3. **Cove UI**: the client now matches the design mockup — auth, lobby with
   device preview, call stage with tiles/chat/participants/reactions/screen
   share, and the workspace in a filmstrip layout.
4. **Persistent workspaces**: every room's notes, files, and whiteboard now
   survive server restarts and redeploys. State is snapshotted to MongoDB
   (`workspacedocs` collection) on a 2s debounce while people edit, with a
   final flush when the last person leaves — after which the doc is also
   evicted from server memory, so idle rooms cost no RAM. Local-disk options
   like y-leveldb were deliberately avoided: on ephemeral-filesystem hosts
   (Render, Heroku, containers) they silently vanish on every deploy.
5. **Auth hardening (pre-beta)**: login/signup are rate-limited (20
   attempts per IP per 15 min — also caps bcrypt CPU burn), signup enforces
   8-128 character passwords, login errors are generic so responses don't
   reveal whether an account exists, inputs are type-checked before touching
   the database, and sessions last 24h (TOKEN_TTL). `trust proxy` is set so
   rate limiting sees real client IPs behind Render's proxy.
6. **TURN support**: the server mints a one-hour relay credential per room
   join from Cloudflare Realtime TURN (`GET /api/turn`, signed-in users only,
   rate-limited). Set CF_TURN_KEY_ID / CF_TURN_API_TOKEN in server/.env;
   nothing relay-related ships in the client bundle.
7. **Multi-file Code tab**: a shared file tree per room. Create, upload,
   rename, and delete files; everyone sees the same tree and can edit any
   file simultaneously with named cursors. Data model: `ydoc.getMap('files')`
   holds `fileId -> { name }`, and each file's content is `ydoc.getText('file:<id>')`.
2. Previous fixes retained: JWT secret + Mongo URI from `.env` (fail-fast),
   room-scoped WebRTC signaling, backend URL from `VITE_BACKEND_URL`.

## Run it locally
```bash
# server
cd server
cp .env.example .env   # fill in MONGODB_URI and JWT_SECRET
npm install
npm start

# client (new terminal)
cd client
cp .env.example .env   # VITE_BACKEND_URL=http://localhost:5000
npm install
npm run dev
```
Open the Vite URL in two browser windows, sign in, join the same room ID,
and type in Notes/Code or draw on the Whiteboard — edits appear live in both
windows with named, colored cursors.

## Architecture notes
- **Why not socket broadcasts for documents?** Broadcasting "here's my new
  text" loses edits whenever two people type at once — last write wins.
  Yjs represents every keystroke as a mergeable operation, so concurrent
  edits (and reconnects) converge deterministically.
- **One Yjs doc per room** (`room-<roomId>`): `getText('notes')`,
  `getText('code')`, `getArray('whiteboard')`.
- **Editors:** CodeMirror 6 with `y-codemirror.next` — gives shared cursors
  and selections with user names/colors for free (markdown mode for Notes,
  JS/JSX for Code).
- **Whiteboard:** finished strokes are pushed to a shared `Y.Array` in
  normalized coordinates. "Clear board" clears it for everyone.

## Security model for the Code tab
Uploaded/typed code **cannot run on or harm the server**, because the
workspace is a text editor, not an execution environment: the server only
relays and merges edit operations. There is no `eval`, no `exec`, and no
filesystem write anywhere in the pipeline — a malicious file in the Code
tab is inert data, same as if it were pasted into Notes.

The real risks and their defenses:
- **XSS in other users' browsers** — file *contents* are safe (CodeMirror
  renders text nodes), and file *names* are both validated against a strict
  pattern (letters/digits/dots/dashes, no slashes, no leading dot, max 64)
  and rendered through React's escaping. Nothing is ever `innerHTML`'d.
- **Resource exhaustion (crashing the site)** — layered limits:
  1. text-only extension allowlist + 200 KB upload cap + binary (NUL byte)
     rejection in `client/src/collab/files.js`;
  2. a CodeMirror `changeFilter` blocks local edits that would push a file
     past 200k chars (remote sync passes through so clients never desync);
  3. server-side `maxPayload` caps any single sync message (2 MB default,
     `COLLAB_MAX_MESSAGE_BYTES`);
  4. a per-room update budget (20 MB default, `COLLAB_ROOM_BUDGET_BYTES`)
     disconnects any client that floods a room — this catches modified
     clients that bypass all browser-side limits.
- **Path traversal** — impossible by construction: "files" are keys in a
  shared document, never paths on the server's disk, and names can't
  contain slashes anyway.
- **The one thing to never do casually:** adding a "Run code" button. That
  changes everything — execution requires real sandboxing (browser-side
  WebAssembly/WebContainers, or server-side isolation like Firecracker/
  gVisor with no network access and CPU/memory limits). Nothing in this
  codebase executes workspace content today; keep it that way until a
  sandbox design exists.

## Known limits / next steps
- Persistence stores one snapshot per room, overwritten in place, so
  storage stays bounded. There's no edit history/versioning yet — a room's
  workspace is always its latest state.
- Any authenticated user who knows a room code can open that room's doc —
  same trust model as the calls themselves. Add room membership checks
  on the `/collab` upgrade if rooms become invite-only.
- Whiteboard strokes appear for others on pen-up; live mid-stroke preview
  can be added via Yjs awareness later.
- Deleting a file clears its content and removes it from the tree, but
  Yjs retains lightweight tombstones in the doc until persistence-level
  compaction — harmless at this scale.


## Hosting (2026-10)

Front end: **Cloudflare Pages**, project `cove`, built from this repo.

| Setting | Value |
|---|---|
| Root directory | `client` |
| Build command | `npm run build` |
| Build output | `dist` |
| Environment variable | `VITE_BACKEND_URL=https://<your Render service>.onrender.com` |
| Custom domain | `cove.johnhubert.llc` (Cloudflare adds the CNAME) |

`client/public/_redirects` makes every path serve the app shell;
`client/public/_headers` sets security headers and long caching for hashed assets.

Back end: Render (unchanged). `CLIENT_ORIGIN` accepts a comma-separated list, so set it to
`https://cove.johnhubert.llc,https://vcacoveapp.netlify.app` during the cutover and drop the
Netlify origin afterwards.

Netlify: retired. `netlify.toml.retire` → rename to `netlify.toml` and push once Pages is live;
the old URL then 301s to the new domain.

### In the room (2026-10)

Workspace (Notes / Code / Whiteboard) was replaced by three meeting tools:

- **Notes** — one shared text area per room (Yjs, saved with the room code). Checklist / bullet /
  timestamp helpers. *Share notes* sends notes + poll results as text through the share sheet;
  *Save notes to this device* writes a `.txt`.
- **Ask the room** — polls with 2–5 answers (Yes / No / Not sure is one tap). The server referees
  (one vote per connection, only the asker closes); the result lands in chat and in the notes.
- **Hand queue** — raised hands show in the order they went up.

### Cove Rooms (2026-10-20)

Named rooms for invited hosts, guests without accounts, a lockable door, and a report path.

- Hosts: `user.host` set with `POST /api/admin/hosts {email, host, maxRooms}` (Bearer `ADMIN_KEY`);
  `HOST_EMAILS` still works as a bootstrap. One room per host by default (`maxRooms`). The first
  room records `termsAcceptedAt` + `termsVersion` (conduct rule + terms checkbox).
- Expiry sweep every 6 h: a named room with no host session for 90 days is archived (room +
  notes deleted; the lobby warns from 30 days out); notes of plain code rooms idle 30 days are
  deleted. Guest-key requests share the sign-in rate limit.
- Hosts see **My rooms** in the lobby:
  link (`/r/<slug>`), name, theme, door locked/open, their own tip link and paid-door link.
- Guests open `/r/<slug>`: the door shows whether the host is in and how many are inside; a
  name is enough to get a 12-hour key scoped to that one room (socket + notes). Nothing is
  stored about guests.
- Locked door: the guest knocks, the host sees a banner and lets them in or not. Knocking
  only works while the host is in the room, so a paid guest can never enter an empty room.
- Money never passes through Cove: tip and paid-door links open the host's own PayPal /
  Wise / Stripe link. The host admits a paying guest on seeing their payment arrive.
- Report (everyone, even while knocking): room, name, words, time → `Report` collection;
  read with `GET /api/admin/reports` (Bearer `ADMIN_KEY`). Hosts can remove people and
  lock/unlock from the call.
- Tests: `cd server && npm test` runs the door flow against the real signaling module with
  an in-memory stand-in for Mongo.

### Language room (2026-10-21)

Theme `language` adds live captions. Each participant's browser transcribes their **own** voice with
the Web Speech API (on-device dictation on iOS/Android) and sends text, never audio, as `caption`
events; the lane under the stage shows everyone's captions, tap one to add it to Notes. The host
can turn on **translate** for the room: final captions are sent as text to DeepL via the server
(`DEEPL_API_KEY`; free keys end in `:fx`), translated into each listener's chosen language, and
cached in memory. Without a key, captions show as spoken. Each person picks their language from
the Captions button (`caption-lang`). Browser support: Safari iOS 14.5+, Chrome, Edge; Firefox has
no speech recognition and only shows others' captions.

### Studio (2026-10-24)

A premium lease flag on the host (`user.studio`, set with `POST /api/admin/hosts {email, studio:true}`).
Studio hosts get a **Studio page** tab in the room editor: photo (resized to 192 px on the device,
stored as a small data URL), tagline, About in their language (visitors can translate it:
`GET /api/r/:slug/about?to=xx`, text only), price line, education, a wall color for the room, a
welcome line with `{name}`, and a "usually available" grid (21 flags, a signal not a booking
system). The front door at `/r/<slug>` shows all of it; the room takes the wall color and shows
the welcome card for the first 45 s. Everything is the host's own public content; nothing about
guests is collected. Revoking `studio` hides the page sections (data stays until the host clears it).

### Layout harness (no backend)

```
cd client && npm run demo     # http://localhost:5174/?n=3&video=1&cam=1
```
`n` = fake remote participants, `video=1` gives them moving canvas "video", `cam=1` turns your
own camera tile on. Used to check the phone layout at iPhone sizes without a second device.

## Rent (Stripe, hosted Checkout only)

Hosts pay for the room; students never pay Cove. Two prices, both created in
the Stripe Dashboard: a recurring **$12 / month** price and a one-time
**$2 day pass**. Cove never sees a card: `POST /api/billing/checkout` sends the
browser to Stripe, and Stripe's webhook (`POST /api/billing/webhook`, raw body,
signature checked) is the only thing that moves a room's `paidThrough`.
`paidThrough == null` is a comped room (invited host). The door closes when
`paidThrough` passes; a failed renewal gets a 3-day grace while Stripe retries.
`POST /api/billing/portal` opens Stripe's customer portal (change card, cancel).

Render env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTH`,
`STRIPE_PRICE_DAY`. Webhook events to subscribe: `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `invoice.paid`,
`customer.subscription.deleted`. Use test-mode keys first; card `4242 4242 4242 4242`.

## Walls (Studio rooms)

What a Studio room remembers between lessons: short videos, files to review,
homework with a due date, students' hand-ins, and messages. Room-only; the
front door never shows them. Files go straight from the browser to Cloudflare
R2 by signed URL (`server/walls.js`). Render env: `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. Without them, link and
text pins work and file pins answer 503.
