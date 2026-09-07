// Persistence for collaborative workspace documents.
//
// y-websocket keeps docs in memory; without this, a server restart wipes
// every room's notes, files, and whiteboard. This module wires y-websocket's
// persistence hooks to a pluggable { load, save } backend (MongoDB in
// production — see index.js).
//
// Lifecycle:
//  - bindState: when the first client opens a room's doc, load the stored
//    snapshot and merge it in (Yjs merging means this is safe even if
//    clients already sent edits — nothing is overwritten). Then save a
//    fresh snapshot on a debounce while edits flow.
//  - writeState: when the LAST client leaves, do a final synchronous flush.
//    y-websocket then evicts the doc from memory — a nice side effect:
//    idle rooms no longer occupy RAM at all.
//
// Snapshots are Y.encodeStateAsUpdate(doc) — one compact binary blob per
// room, overwritten in place, so storage stays bounded (no unbounded
// update logs to compact).

const Y = require('yjs');
const { setPersistence } = require('y-websocket/bin/utils');

const SAVE_DEBOUNCE_MS = 2000;

function setupPersistence({ load, save }) {
  const timers = new Map();

  const snapshot = (docName, ydoc) =>
    save(docName, Buffer.from(Y.encodeStateAsUpdate(ydoc))).catch((err) =>
      console.error(`Persistence: save failed for "${docName}":`, err.message)
    );

  setPersistence({
    bindState: async (docName, ydoc) => {
      try {
        const stored = await load(docName);
        if (stored && stored.length) Y.applyUpdate(ydoc, stored);
      } catch (err) {
        console.error(`Persistence: load failed for "${docName}":`, err.message);
      }
      ydoc.on('update', () => {
        clearTimeout(timers.get(docName));
        timers.set(docName, setTimeout(() => snapshot(docName, ydoc), SAVE_DEBOUNCE_MS));
      });
    },

    writeState: async (docName, ydoc) => {
      clearTimeout(timers.get(docName));
      timers.delete(docName);
      await snapshot(docName, ydoc);
    }
  });
}

module.exports = { setupPersistence, SAVE_DEBOUNCE_MS };
