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
6. **TURN support**: set VITE_TURN_URLS / VITE_TURN_USERNAME /
   VITE_TURN_CREDENTIAL at client build time to add a relay for the
   ~10-20% of networks where direct peer connections fail. STUN-only is
   fine on a LAN; do not invite real testers without TURN.
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
