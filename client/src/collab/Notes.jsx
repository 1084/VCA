import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { BACKEND_URL, initials, gradFor } from '../lib';

const COLLAB_URL = BACKEND_URL.replace(/^http/, 'ws') + '/collab';
const CURSOR_COLORS = ['#FFB454', '#7CCFDE', '#B0A7F5', '#8FE3B0', '#F5A0C0'];
export const MAX_NOTES_CHARS = 50_000;

/**
 * Shared notes for the room: one Y.Text ("notes") behind a plain textarea,
 * so phones get their native keyboard, autocorrect and selection. Local
 * edits are diffed against the Y.Text (common prefix / suffix) and applied
 * as insert/delete; remote edits replace the textarea value and keep the
 * caret in place. Poll results are appended by CallScreen via `appendLine`.
 *
 * Persistence: the server snapshots the Y.Doc (see server/persistence.js),
 * so notes survive everyone leaving and come back with the room code.
 */
export function useNotesDoc(roomId, token, email) {
  const [doc, setDoc] = useState(null);
  const [present, setPresent] = useState([]);
  useEffect(() => {
    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(COLLAB_URL, `room-${roomId}`, ydoc, { params: { token } });
    const name = email ? email.split('@')[0] : 'guest';
    const color = CURSOR_COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % CURSOR_COLORS.length];
    provider.awareness.setLocalStateField('user', { name, color });
    const onAwareness = () =>
      setPresent([...provider.awareness.getStates().values()].map((s) => s.user).filter(Boolean).slice(0, 8));
    provider.awareness.on('change', onAwareness);
    onAwareness();
    setDoc({ ydoc, provider, text: ydoc.getText('notes') });
    return () => {
      provider.awareness.off('change', onAwareness);
      provider.destroy();
      ydoc.destroy();
      setDoc(null);
    };
  }, [roomId, token, email]);
  return { doc, present };
}

export function appendLine(doc, line) {
  if (!doc) return;
  const t = doc.text;
  const cur = t.toString();
  const sep = cur.length === 0 ? '' : cur.endsWith('\n') ? '' : '\n';
  const add = sep + line + '\n';
  if (cur.length + add.length > MAX_NOTES_CHARS) return;
  t.insert(cur.length, add);
}

export function notesText(doc) {
  return doc ? doc.text.toString() : '';
}

export default function Notes({ doc, present, placeholder = 'Shared notes — everyone in the room can type here.' }) {
  const ref = useRef(null);
  const [len, setLen] = useState(0);

  useEffect(() => {
    if (!doc) return;
    const ta = ref.current;
    const ytext = doc.text;
    const sync = () => {
      const v = ytext.toString();
      setLen(v.length);
      if (ta.value === v) return;
      if (document.activeElement === ta) {
        // keep the caret in place; shift it by the size of a remote change
        // that landed before it
        const old = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
        let p = 0;
        while (p < old.length && p < v.length && old[p] === v[p]) p++;
        const delta = v.length - old.length;
        const shift = p < s ? delta : 0;
        ta.value = v;
        const ns = Math.max(p, Math.min(v.length, s + shift));
        const ne = Math.max(ns, Math.min(v.length, e + shift));
        ta.setSelectionRange(ns, ne);
      } else {
        ta.value = v;
      }
    };
    ytext.observe(sync);
    doc.provider.on('synced', sync);
    sync();
    return () => { ytext.unobserve(sync); doc.provider.off('synced', sync); };
  }, [doc]);

  const onInput = () => {
    if (!doc) return;
    const ta = ref.current;
    const old = doc.text.toString();
    let nw = ta.value;
    if (nw.length > MAX_NOTES_CHARS) { nw = nw.slice(0, MAX_NOTES_CHARS); ta.value = nw; }
    let p = 0;
    while (p < old.length && p < nw.length && old[p] === nw[p]) p++;
    let so = old.length, sn = nw.length;
    while (so > p && sn > p && old[so - 1] === nw[sn - 1]) { so--; sn--; }
    doc.ydoc.transact(() => {
      if (so > p) doc.text.delete(p, so - p);
      if (sn > p) doc.text.insert(p, nw.slice(p, sn));
    });
    setLen(nw.length);
  };

  // "☐ " at the start of the current line: a checklist item you can tick by
  // retyping the box — cheap, and it survives export as plain text.
  const insertAtLineStart = (prefix) => {
    const ta = ref.current;
    const v = ta.value, s = ta.selectionStart;
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    ta.setRangeText(prefix, ls, ls, 'end');
    onInput();
    ta.focus();
  };

  return (
    <div className="notes" aria-label="Shared notes">
      <div className="notes-tools">
        <button className="wb-btn" onClick={() => insertAtLineStart('☐ ')} title="Checklist item">☐ Item</button>
        <button className="wb-btn" onClick={() => insertAtLineStart('• ')} title="Bullet">• Bullet</button>
        <button className="wb-btn" onClick={() => insertAtLineStart(`[${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}] `)} title="Timestamp">🕒 Time</button>
        <div className="ws-presence">
          {present.map((u, i) => (
            <span key={i} className="pav" title={u.name}
              style={{ background: `linear-gradient(135deg,${gradFor(u.name)[0]},${gradFor(u.name)[1]})` }}>
              {initials(u.name)}
            </span>
          ))}
          <span className="lbl">{present.length} here · {len.toLocaleString()} chars</span>
        </div>
      </div>
      <textarea ref={ref} className="notes-ta" onInput={onInput} placeholder={placeholder}
        spellCheck autoCapitalize="sentences" />
    </div>
  );
}
