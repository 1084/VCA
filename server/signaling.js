// Room signaling for group calls (mesh topology, up to maxRoomSize people).
//
// Design notes:
// - Every WebRTC message (description/candidate) is TARGETED: the client says
//   who it's for, and we verify sender and target share a room before
//   relaying. Nothing is ever broadcast server-wide.
// - Capacity is enforced here (default 10). A mesh means every participant
//   sends media to every other participant, so upload bandwidth grows with
//   room size — 10 is a sensible ceiling before an SFU becomes necessary.
// - Display names come from the verified JWT (socket.user), never from
//   client-supplied payloads, so nobody can impersonate another user.

const REACTIONS = ['👍', '🎉', '❤️', '😂', '👏', '😮', '🔥'];
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;
const { Room, Report, roomIsOpen } = require('./rooms');

const nameOf = (user) => (user?.name || (user?.email || 'guest').split('@')[0]).slice(0, 32);

function attachSignaling(io, { maxRoomSize = 10, translate = null } = {}) {
  io.on('connection', (socket) => {
    const displayName = () => nameOf(socket.user);
    const isGuest = () => !!socket.user?.guest;

    // Actually put a socket in a room and introduce everyone.
    const enter = (roomId, named) => enterAs(socket, roomId, named);
    const roomState = (named, roomId) => {
      const set = io.sockets.adapter.rooms.get(roomId);
      let hostPresent = false;
      for (const id of set || []) if (io.sockets.sockets.get(id)?.user?.email === named.ownerEmail) hostPresent = true;
      return { slug: named.slug, name: named.name, theme: named.theme, locked: !!named.locked, tipLink: named.tipLink || '',
        payLink: named.payLink || '', payNote: named.payNote || '', translate: !!named.translate, hostName: (named.ownerEmail || '').split('@')[0], hostPresent };
    };
    const hostSockets = (named) => [...io.sockets.sockets.values()].filter((s) => s.user?.email === named.ownerEmail && s.data.roomId === named.slug);

    socket.on('join', async (roomId) => {
      if (typeof roomId !== 'string' || !ROOM_ID_PATTERN.test(roomId)) return;
      if (socket.data.roomId || socket.data.knocking) return; // one room per connection
      // a guest key opens exactly one room
      if (isGuest() && socket.user.room !== roomId) return socket.emit('denied', { reason: 'wrong-room' });

      const named = await Room.findOne({ slug: roomId }).lean().catch(() => null);
      if (!named) {
        if (isGuest()) return socket.emit('denied', { reason: 'no-room' });
        return enter(roomId); // plain code room, as before
      }
      if (!roomIsOpen(named)) return socket.emit('denied', { reason: 'closed' });
      const isOwner = socket.user?.email === named.ownerEmail;
      if (isOwner) Room.updateOne({ slug: roomId }, { lastSessionAt: new Date() }).catch(() => {});
      if (isOwner || !named.locked) return enter(roomId, named);

      // Locked: knock. The host sees the knock; the guest waits outside.
      const hosts = hostSockets(named);
      if (!hosts.length) return socket.emit('denied', { reason: 'host-away', room: roomState(named, roomId) });
      socket.data.knocking = roomId;
      socket.emit('knocking', { room: roomState(named, roomId) });
      hosts.forEach((h) => h.emit('knock', { id: socket.id, name: displayName() }));
    });

    // Host answers a knock.
    const answer = async (id, admit) => {
      const roomId = socket.data.roomId;
      const guest = io.sockets.sockets.get(id);
      if (!roomId || !guest || guest.data.knocking !== roomId) return;
      const named = await Room.findOne({ slug: roomId }).lean().catch(() => null);
      if (!named || named.ownerEmail !== socket.user?.email) return;
      guest.data.knocking = null;
      if (admit) { guest.emit('admitted'); enterAs(guest, roomId, named); } else guest.emit('denied', { reason: 'host-declined' });
    };
    const enterAs = (g, roomId, named) => {
      const room = io.sockets.adapter.rooms.get(roomId);
      if ((room?.size || 0) >= maxRoomSize) { g.emit('room-full', { max: maxRoomSize }); return false; }
      const existing = [...(room || [])].map((pid) => ({ id: pid, name: nameOf(io.sockets.sockets.get(pid)?.user) }));
      g.join(roomId); g.data.roomId = roomId;
      const set = io.sockets.adapter.rooms.get(roomId);
      if (set && !set.__startedAt) set.__startedAt = Date.now();
      g.emit('peers', existing);
      g.to(roomId).emit('peer-joined', { id: g.id, name: nameOf(g.user), guest: !!g.user?.guest });
      if (named) io.in(roomId).emit('room-state', roomState(named, roomId));
      return true;
    };
    socket.on('admit', ({ id } = {}) => answer(id, true));
    socket.on('deny', ({ id } = {}) => answer(id, false));

    // Host locks or unlocks the door.
    socket.on('lock', async ({ locked } = {}) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const named = await Room.findOneAndUpdate({ slug: roomId, ownerEmail: socket.user?.email }, { locked: !!locked }, { new: true }).lean().catch(() => null);
      if (!named) return;
      io.in(roomId).emit('room-state', roomState(named, roomId));
    });

    // Anyone in a room can report it. Words only, never media.
    socket.on('report', async ({ text } = {}) => {
      const roomId = socket.data.roomId || socket.data.knocking;
      if (!roomId || typeof text !== 'string' || !text.trim()) return;
      await Report.create({ room: roomId, from: displayName(), text: text.trim().slice(0, 1000) }).catch(() => {});
      socket.emit('reported');
    });

    // Host removes someone from the room.
    socket.on('remove', async ({ id } = {}) => {
      const roomId = socket.data.roomId;
      const target = io.sockets.sockets.get(id);
      if (!roomId || !target || target.data.roomId !== roomId) return;
      const named = await Room.findOne({ slug: roomId }).lean().catch(() => null);
      if (!named || named.ownerEmail !== socket.user?.email) return;
      target.emit('denied', { reason: 'removed' });
      target.leave(roomId); target.data.roomId = null;
      socket.to(roomId).emit('peer-left', { id: target.id });
      target.disconnect(true);
    });

    // Relay a payload to one specific peer, only within the sender's room.
    const relayToPeer = (event) =>
      socket.on(event, (payload) => {
        const roomId = socket.data.roomId;
        const to = payload?.to;
        if (!roomId || typeof to !== 'string') return;
        if (!io.sockets.adapter.rooms.get(roomId)?.has(to)) return;
        io.to(to).emit(event, { ...payload, to: undefined, from: socket.id });
      });
    relayToPeer('rtc-description');
    relayToPeer('rtc-candidate');

    // Mic/cam/hand/share status, shown on everyone's tiles.
    socket.on('state', (s) => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      socket.to(roomId).emit('peer-state', {
        from: socket.id,
        micOn: !!s?.micOn,
        camOn: !!s?.camOn,
        hand: !!s?.hand,
        sharing: !!s?.sharing
      });
    });

    // ---- Live captions (Language room) ----
    // Text only: each phone transcribes its own speaker. Interim captions are
    // relayed without translation; final ones are translated when the room's
    // host turned translation on, then sent to everyone.
    const captionLimiter = { n: 0, at: 0 };
    socket.on('caption', async ({ text, lang, final } = {}) => {
      const roomId = socket.data.roomId;
      if (!roomId || typeof text !== 'string' || !text.trim()) return;
      const now = Date.now();
      if (now - captionLimiter.at > 10000) { captionLimiter.n = 0; captionLimiter.at = now; }
      if (++captionLimiter.n > 120) return; // runaway client
      const t = text.trim().slice(0, 500);
      const src = typeof lang === 'string' ? lang.slice(0, 8) : '';
      const base = { id: socket.id, from: displayName(), text: t, lang: src, final: !!final, ts: now };
      if (!final) return io.in(roomId).emit('caption', base);
      const named = await Room.findOne({ slug: roomId }).lean().catch(() => null);
      if (!named?.translate || !translate) return io.in(roomId).emit('caption', base);
      // translate into each listener's language, grouped so one call serves many
      const targets = new Map();
      for (const id of io.sockets.adapter.rooms.get(roomId) || []) {
        const s = io.sockets.sockets.get(id);
        const want = (s?.data.captionLang || 'en').slice(0, 2).toLowerCase();
        if (want !== src.slice(0, 2).toLowerCase()) targets.set(want, [...(targets.get(want) || []), id]);
        else io.to(id).emit('caption', base);
      }
      for (const [want, ids] of targets) {
        const tr = await translate(t, src, want).catch(() => null);
        ids.forEach((id) => io.to(id).emit('caption', { ...base, translated: tr || undefined, to: want }));
      }
    });
    socket.on('caption-lang', (lang) => { if (typeof lang === 'string') socket.data.captionLang = lang.slice(0, 8); });

    socket.on('chat', (text) => {
      const roomId = socket.data.roomId;
      if (!roomId || typeof text !== 'string' || !text.trim()) return;
      io.in(roomId).emit('chat', {
        id: socket.id,
        from: displayName(),
        text: text.slice(0, 2000),
        ts: Date.now()
      });
    });

    socket.on('reaction', (emoji) => {
      const roomId = socket.data.roomId;
      if (!roomId || !REACTIONS.includes(emoji)) return;
      io.in(roomId).emit('reaction', { from: displayName(), emoji });
    });

    // ---- Polls ("Ask the room") ----
    // The server is the referee: it owns the poll, counts one vote per
    // socket (last vote wins), and broadcasts tallies — so nobody can stuff
    // a poll from the client. Polls live only in memory with the room.
    const polls = () => {
      const roomId = socket.data.roomId;
      const room = io.sockets.adapter.rooms.get(roomId);
      if (!room) return null;
      room.__polls ||= new Map(); // pollId -> {id, by, byName, question, options, votes: Map(socketId -> optionIdx), open, ts}
      return room.__polls;
    };
    const tally = (poll) => {
      const counts = poll.options.map(() => 0);
      for (const idx of poll.votes.values()) counts[idx]++;
      return { id: poll.id, by: poll.by, byName: poll.byName, question: poll.question,
        options: poll.options, counts, total: poll.votes.size, open: poll.open, ts: poll.ts };
    };
    socket.on('poll', (p) => {
      const roomId = socket.data.roomId, store = polls();
      if (!roomId || !store) return;
      const question = typeof p?.question === 'string' ? p.question.trim().slice(0, 200) : '';
      const options = Array.isArray(p?.options)
        ? [...new Set(p.options.filter((o) => typeof o === 'string').map((o) => o.trim().slice(0, 60)).filter(Boolean))].slice(0, 5)
        : [];
      if (!question || options.length < 2) return;
      if ([...store.values()].filter((x) => x.open).length >= 3) return; // no poll pile-ups
      const poll = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        by: socket.id, byName: displayName(), question, options, votes: new Map(), open: true, ts: Date.now() };
      store.set(poll.id, poll);
      if (store.size > 20) store.delete(store.keys().next().value);
      io.in(roomId).emit('poll', tally(poll));
    });
    socket.on('poll-vote', ({ id, option } = {}) => {
      const roomId = socket.data.roomId, store = polls();
      const poll = store?.get(id);
      if (!roomId || !poll || !poll.open) return;
      if (!Number.isInteger(option) || option < 0 || option >= poll.options.length) return;
      poll.votes.set(socket.id, option);
      io.in(roomId).emit('poll', tally(poll));
    });
    socket.on('poll-close', ({ id } = {}) => {
      const roomId = socket.data.roomId, store = polls();
      const poll = store?.get(id);
      if (!roomId || !poll || poll.by !== socket.id) return; // only the asker closes it
      poll.open = false;
      io.in(roomId).emit('poll', tally(poll));
    });

    socket.on('disconnecting', async () => {
      const roomId = socket.data.roomId;
      if (roomId) socket.to(roomId).emit('peer-left', { id: socket.id });
      // if the host leaves a named room, tell the room (the door is effectively closed)
      if (roomId && !isGuest()) {
        const named = await Room.findOne({ slug: roomId, ownerEmail: socket.user?.email }).lean().catch(() => null);
        if (named) setImmediate(() => io.in(roomId).emit('room-state', roomState(named, roomId)));
      }
      if (socket.data.knocking) {
        const named = await Room.findOne({ slug: socket.data.knocking }).lean().catch(() => null);
        if (named) hostSockets(named).forEach((h) => h.emit('knock-gone', { id: socket.id }));
      }
      const store = io.sockets.adapter.rooms.get(roomId)?.__polls;
      if (store) for (const poll of store.values()) {
        if (poll.open && poll.votes.delete(socket.id)) socket.to(roomId).emit('poll', tally(poll));
      }
    });
  });
}

module.exports = { attachSignaling, REACTIONS };
