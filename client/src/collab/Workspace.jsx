import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Transaction } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { yCollab } from 'y-codemirror.next';
import Whiteboard from './Whiteboard';
import { BACKEND_URL, initials, gradFor } from '../lib';
import {
  validateFileName, looksBinary,
  MAX_FILES, MAX_FILE_CHARS, MAX_UPLOAD_BYTES
} from './files';

const COLLAB_URL = BACKEND_URL.replace(/^http/, 'ws') + '/collab';
const CURSOR_COLORS = ['#FFB454', '#7CCFDE', '#B0A7F5', '#8FE3B0', '#F5A0C0'];

// Blocks LOCAL edits past the size cap; remote Yjs transactions pass through
// so clients never desync. (See files.js for the full security model.)
const sizeLimit = EditorState.changeFilter.of((tr) => {
  if (!tr.docChanged || tr.newDoc.length <= MAX_FILE_CHARS) return true;
  return !tr.annotation(Transaction.userEvent);
});

const langFor = (name = '') => {
  const ext = name.split('.').pop().toLowerCase();
  if (['js', 'jsx', 'ts', 'tsx', 'json'].includes(ext)) {
    return javascript({ jsx: true, typescript: ext[0] === 't' });
  }
  if (['md', 'txt'].includes(ext)) return markdown();
  return [];
};

const baseExtensions = [basicSetup, oneDark, EditorView.lineWrapping, sizeLimit];

export default function Workspace({ roomId, token, email }) {
  const [tab, setTab] = useState('notes');
  const [present, setPresent] = useState([]); // [{name,color}]
  const [collab, setCollab] = useState(null);
  const [fileList, setFileList] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const notesMount = useRef(null);
  const codeMount = useRef(null);
  const uploadInput = useRef(null);

  useEffect(() => {
    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(COLLAB_URL, `room-${roomId}`, ydoc, {
      params: { token }
    });

    const name = email ? email.split('@')[0] : 'guest';
    const color =
      CURSOR_COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % CURSOR_COLORS.length];
    provider.awareness.setLocalStateField('user', { name, color, colorLight: color + '55' });
    const onAwareness = () => {
      const users = [...provider.awareness.getStates().values()]
        .map((s) => s.user)
        .filter(Boolean)
        .slice(0, 8);
      setPresent(users);
    };
    provider.awareness.on('change', onAwareness);
    onAwareness();

    const notesUndo = new Y.UndoManager(ydoc.getText('notes'));
    const notesView = new EditorView({
      state: EditorState.create({
        doc: ydoc.getText('notes').toString(),
        extensions: [
          ...baseExtensions,
          markdown(),
          yCollab(ydoc.getText('notes'), provider.awareness, { undoManager: notesUndo })
        ]
      }),
      parent: notesMount.current
    });

    const files = ydoc.getMap('files');
    const syncFiles = () => {
      const arr = [...files.entries()]
        .map(([id, v]) => ({ id, name: v?.name ?? 'untitled' }))
        .sort((a, b) => a.name.localeCompare(b.name));
      setFileList(arr);
      setActiveId((prev) => (arr.some((f) => f.id === prev) ? prev : arr[0]?.id ?? null));
    };
    files.observe(syncFiles);
    syncFiles();
    provider.on('synced', () => {
      if (files.size === 0) files.set('starter', { name: 'main.js' });
    });

    setCollab({ ydoc, provider });
    return () => {
      notesView.destroy();
      files.unobserve(syncFiles);
      provider.awareness.off('change', onAwareness);
      provider.destroy();
      ydoc.destroy();
      setCollab(null);
    };
  }, [roomId, token, email]);

  useEffect(() => {
    if (!collab || !activeId) return;
    const fileName = collab.ydoc.getMap('files').get(activeId)?.name;
    const ytext = collab.ydoc.getText('file:' + activeId);
    const undoManager = new Y.UndoManager(ytext);
    const view = new EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          ...baseExtensions,
          langFor(fileName),
          yCollab(ytext, collab.provider.awareness, { undoManager })
        ]
      }),
      parent: codeMount.current
    });
    return () => view.destroy();
  }, [collab, activeId]);

  const createFile = (name, content = '') => {
    const err = validateFileName(name);
    if (err) return void alert(err);
    const files = collab.ydoc.getMap('files');
    if (files.size >= MAX_FILES) return void alert(`Room limit is ${MAX_FILES} files.`);
    if ([...files.values()].some((f) => f?.name === name))
      return void alert(`"${name}" already exists in this room.`);
    const id = crypto.randomUUID();
    collab.ydoc.transact(() => {
      files.set(id, { name });
      if (content) collab.ydoc.getText('file:' + id).insert(0, content.slice(0, MAX_FILE_CHARS));
    });
    setActiveId(id);
  };

  const addFile = () => {
    const name = window.prompt('File name (e.g. utils.js):');
    if (name) createFile(name.trim());
  };
  const renameFile = (id) => {
    const files = collab.ydoc.getMap('files');
    const name = window.prompt('New name:', files.get(id)?.name);
    if (!name) return;
    const err = validateFileName(name.trim());
    if (err) return void alert(err);
    files.set(id, { name: name.trim() });
  };
  const deleteFile = (id) => {
    const files = collab.ydoc.getMap('files');
    if (!window.confirm(`Delete ${files.get(id)?.name} for everyone in the room?`)) return;
    collab.ydoc.transact(() => {
      const ytext = collab.ydoc.getText('file:' + id);
      ytext.delete(0, ytext.length);
      files.delete(id);
    });
  };
  const onUpload = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > MAX_UPLOAD_BYTES)
      return void alert(`Files are capped at ${Math.round(MAX_UPLOAD_BYTES / 1000)} KB of text.`);
    const err = validateFileName(f.name);
    if (err) return void alert(err);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result);
      if (looksBinary(text))
        return void alert('That looks like a binary file — only plain text is supported.');
      createFile(f.name, text);
    };
    reader.readAsText(f);
  };

  return (
    <div className="workspace" aria-label="Shared workspace">
      <div className="ws-head" role="tablist">
        <button className={`ws-tab ${tab === 'notes' ? 'on' : ''}`} role="tab" onClick={() => setTab('notes')}>📝 Notes</button>
        <button className={`ws-tab ${tab === 'code' ? 'on' : ''}`} role="tab" onClick={() => setTab('code')}>⌨️ Code</button>
        <button className={`ws-tab ${tab === 'board' ? 'on' : ''}`} role="tab" onClick={() => setTab('board')}>🖊 Whiteboard</button>
        <div className="ws-presence">
          {present.map((u, i) => (
            <span key={i} className="pav" title={u.name}
              style={{ background: `linear-gradient(135deg,${gradFor(u.name)[0]},${gradFor(u.name)[1]})` }}>
              {initials(u.name)}
            </span>
          ))}
          <span className="lbl">{present.length} in workspace</span>
        </div>
      </div>

      <div className="ws-pane" style={{ display: tab === 'notes' ? 'flex' : 'none' }}>
        <div ref={notesMount} className="ws-mount" />
      </div>

      <div className="ws-pane" style={{ display: tab === 'code' ? 'flex' : 'none' }}>
        <div className="code-wrap">
          <nav className="ftree" aria-label="Shared files">
            <div className="ftree-actions">
              <button className="wb-btn on" onClick={addFile}>＋ New</button>
              <button className="wb-btn" onClick={() => uploadInput.current?.click()}>⇪ Upload</button>
              <input ref={uploadInput} type="file" style={{ display: 'none' }} onChange={onUpload}
                accept=".js,.jsx,.ts,.tsx,.json,.md,.txt,.css,.html,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.sh,.sql,.yml,.yaml,.toml" />
            </div>
            <div className="ftree-list">
              {fileList.map((f) => (
                <div key={f.id} className={`file ${f.id === activeId ? 'on' : ''}`}
                  onClick={() => setActiveId(f.id)}>
                  <span className="fname">{f.name}</span>
                  <button className="fop" title="Rename"
                    onClick={(e) => { e.stopPropagation(); renameFile(f.id); }}>✎</button>
                  <button className="fop" title="Delete"
                    onClick={(e) => { e.stopPropagation(); deleteFile(f.id); }}>✕</button>
                </div>
              ))}
              {fileList.length === 0 && <p className="ftree-empty">No files yet — create one to start.</p>}
            </div>
          </nav>
          <div key={activeId} ref={codeMount} className="ws-mount" />
        </div>
      </div>

      <div className="ws-pane" style={{ display: tab === 'board' ? 'flex' : 'none' }}>
        {collab && <Whiteboard ydoc={collab.ydoc} />}
      </div>
    </div>
  );
}
