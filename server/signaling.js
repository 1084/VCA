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

function attachSignaling(io, { maxRoomSize = 10 } = {}) {
  io.on('connection', (socket) => {
    const displayName = () =>
      (socket.user?.email || 'guest').split('@')[0].slice(0, 32);

    socket.on('join', (roomId) => {
      if (typeof roomId !== 'string' || !ROOM_ID_PATTERN.test(roomId)) return;
      if (socket.data.roomId) return; // one room per connection

      const room = io.sockets.adapter.rooms.get(roomId);
      if ((room?.size || 0) >= maxRoomSize) {
        socket.emit('room-full', { max: maxRoomSize });
        return;
      }

      const existing = [...(room || [])].map((id) => ({
        id,
        name: (io.sockets.sockets.get(id)?.user?.email || 'guest')
          .split('@')[0]
          .slice(0, 32)
      }));

      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.emit('peers', existing);
      socket.to(roomId).emit('peer-joined', { id: socket.id, name: displayName() });
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

    socket.on('disconnecting', () => {
      const roomId = socket.data.roomId;
      if (roomId) socket.to(roomId).emit('peer-left', { id: socket.id });
      const store = io.sockets.adapter.rooms.get(roomId)?.__polls;
      if (store) for (const poll of store.values()) {
        if (poll.open && poll.votes.delete(socket.id)) socket.to(roomId).emit('poll', tally(poll));
      }
    });
  });
}

module.exports = { attachSignaling, REACTIONS };
