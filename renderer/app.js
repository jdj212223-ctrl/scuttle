/* Scuttle renderer: editor, explorer, tabs, search, terminal, git, GitHub, pets. */
const S = window.scuttle;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SEP = '/';
const basename = (p) => p.split(SEP).filter(Boolean).pop() || p;
const dirname = (p) => p.slice(0, p.lastIndexOf(SEP)) || SEP;
const join = (...a) => a.join(SEP).replace(/\/+/g, '/');

const state = {
  settings: null, root: null, tabs: [], active: null, expanded: new Set(), selected: null,
  git: null, gh: { signedIn: false }, view: 'explorer', term: null, termId: null,
};
let monaco, editor;

// ---------------- toasts & modals ----------------
function toast(msg, kind = '', ms = 3500) {
  const t = h('div', { class: 'toast ' + kind }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}
function modal(build) {
  const layer = $('#modal-layer');
  layer.innerHTML = '';
  layer.classList.remove('hidden');
  const box = h('div', { class: 'modal' });
  layer.append(box);
  const close = () => { layer.classList.add('hidden'); layer.innerHTML = ''; layer.onmousedown = null; document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); box.dispatchEvent(new Event('cancel')); close(); } };
  document.addEventListener('keydown', onKey, true);
  layer.onmousedown = (e) => { if (e.target === layer) { box.dispatchEvent(new Event('cancel')); close(); } };
  build(box, close);
  return close;
}
function ask(title, value = '', placeholder = '') {
  return new Promise((resolve) => {
    modal((box, close) => {
      const inp = h('input', { type: 'text', value, placeholder, spellcheck: 'false' });
      const ok = () => { const v = inp.value.trim(); close(); resolve(v || null); };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      box.addEventListener('cancel', () => resolve(null));
      box.append(h('h2', {}, title), inp,
        h('div', { class: 'btns' }, h('button', { onclick: () => { close(); resolve(null); } }, 'Cancel'), h('button', { class: 'primary', onclick: ok }, 'OK')));
      setTimeout(() => { inp.focus(); const dot = value.lastIndexOf('.'); inp.setSelectionRange(0, dot > 0 ? dot : value.length); }, 10);
    });
  });
}
function confirmBox(title, text, yes = 'Yes', no = 'Cancel', third) {
  return new Promise((resolve) => {
    modal((box, close) => {
      box.addEventListener('cancel', () => resolve(null));
      const b = (label, val, cls) => h('button', { class: cls || '', onclick: () => { close(); resolve(val); } }, label);
      box.append(h('h2', {}, title), h('p', { class: 'muted' }, text),
        h('div', { class: 'btns' }, third ? b(third, 'third') : null, b(no, null), b(yes, true, 'primary')));
    });
  });
}

// ---------------- Monaco ----------------
function loadMonaco() {
  return new Promise((resolve) => {
    window.require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
    window.require(['vs/editor/editor.main'], () => resolve(window.monaco));
  });
}
function defineTheme() {
  monaco.editor.defineTheme('scuttle-night', {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: 'comment', foreground: '6f6c8f', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'b49cff' },
      { token: 'string', foreground: '8ee6b8' },
      { token: 'number', foreground: 'ffb86b' },
      { token: 'type', foreground: '7fd3ff' },
      { token: 'delimiter', foreground: 'a7a4c4' },
    ],
    colors: {
      'editor.background': '#15151f', 'editor.foreground': '#e3e1f2', 'editorLineNumber.foreground': '#4b4868',
      'editorLineNumber.activeForeground': '#b9b6d6', 'editor.lineHighlightBackground': '#1f1f2e', 'editor.selectionBackground': '#4a3fa055',
      'editorCursor.foreground': '#8b7bff', 'editorIndentGuide.background1': '#26263a', 'editorWidget.background': '#1b1b28',
      'minimap.background': '#17171f', 'scrollbarSlider.background': '#3a3a5566',
    },
  });
}
function langFor(path) {
  const name = basename(path).toLowerCase();
  const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
  const extra = { '.mjs': 'javascript', '.cjs': 'javascript', '.gradle': 'groovy', '.mcmeta': 'json', '.toml': 'ini', '.properties': 'ini', '.lang': 'ini' };
  if (extra[ext]) return extra[ext];
  for (const l of monaco.languages.getLanguages()) {
    if ((l.filenames || []).map((f) => f.toLowerCase()).includes(name)) return l.id;
    if (ext && (l.extensions || []).includes(ext)) return l.id;
  }
  return 'plaintext';
}

// ---------------- tabs ----------------
function tabFor(path) { return state.tabs.find((t) => t.path === path); }
function isDirty(t) { return t.model && t.model.getAlternativeVersionId() !== t.savedVersion; }
async function openFile(path, opts = {}) {
  let t = tabFor(path);
  if (!t) {
    let res;
    try { res = await S.fs.readFile(path); } catch (e) { toast('Could not open: ' + e.message, 'err'); return; }
    t = { path };
    if (res.text !== undefined) {
      const uri = monaco.Uri.file(path);
      t.model = monaco.editor.getModel(uri) || monaco.editor.createModel(res.text, langFor(path), uri);
      t.savedVersion = t.model.getAlternativeVersionId();
      t.model.onDidChangeContent(() => renderTabs());
    } else t.nonText = res.binary ? 'This file looks binary, so Scuttle won\'t open it as text.' : 'This file is too big to open (over 20 MB).';
    state.tabs.push(t);
  }
  activate(t);
  if (opts.line && t.model) {
    editor.revealLineInCenter(opts.line);
    editor.setSelection(new monaco.Selection(opts.line, opts.col || 1, opts.line, (opts.col || 1) + (opts.len || 0)));
    editor.focus();
  }
}
function activate(t) {
  if (state.active && state.active.model) state.active.view = editor.saveViewState();
  state.active = t;
  $('#welcome').classList.toggle('hidden', !!t);
  $('#nonText').classList.toggle('hidden', !(t && t.nonText));
  if (t && t.nonText) $('#nonText').textContent = t.nonText;
  if (t && t.model) {
    editor.setModel(t.model);
    if (t.view) editor.restoreViewState(t.view);
    editor.focus();
    $('#sb-lang').textContent = t.model.getLanguageId();
  } else { editor.setModel(null); $('#sb-lang').textContent = ''; $('#sb-pos').textContent = ''; }
  state.selected = t ? t.path : state.selected;
  renderTabs(); markTreeSelection();
  updateTitle();
}
function renderTabs() {
  const bar = $('#tabs');
  bar.innerHTML = '';
  for (const t of state.tabs) {
    const el = h('div', { class: 'tab' + (t === state.active ? ' active' : '') + (isDirty(t) ? ' dirty' : ''), title: t.path },
      h('span', { class: 'ic' }, fileIcon(t.path)), h('span', { class: 'nm' }, basename(t.path)),
      h('span', { class: 'x', title: 'Close', onclick: (e) => { e.stopPropagation(); closeTab(t); } }, h('span', {}, '✕')));
    el.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t); } });
    el.addEventListener('click', () => activate(t));
    bar.append(el);
    if (t === state.active) setTimeout(() => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }), 0);
  }
  updateTitle();
}
async function closeTab(t) {
  if (!t) return;
  if (isDirty(t)) {
    const r = await confirmBox('Save changes?', `“${basename(t.path)}” has unsaved changes.`, 'Save', 'Cancel', "Don't save");
    if (r === null) return;
    if (r === true && !(await saveTab(t))) return;
  }
  const i = state.tabs.indexOf(t);
  state.tabs.splice(i, 1);
  if (t.model) t.model.dispose();
  if (state.active === t) activate(state.tabs[Math.min(i, state.tabs.length - 1)] || null);
  else renderTabs();
}
async function saveTab(t) {
  if (!t || !t.model) return false;
  try {
    await S.fs.writeFile(t.path, t.model.getValue());
    t.savedVersion = t.model.getAlternativeVersionId();
    renderTabs();
    petBus('happy');
    refreshGitSoon();
    return true;
  } catch (e) { toast('Save failed: ' + e.message, 'err'); return false; }
}
async function saveAll() { for (const t of state.tabs) if (isDirty(t)) await saveTab(t); }
function updateTitle() {
  const parts = [];
  if (state.active) parts.push((isDirty(state.active) ? '● ' : '') + basename(state.active.path));
  if (state.root) parts.push(basename(state.root));
  parts.push('Scuttle');
  $('#title-text').textContent = parts.join(' — ');
}
function fileIcon(p) {
  const e = (p.split('.').pop() || '').toLowerCase();
  return ({ js: '🟨', mjs: '🟨', cjs: '🟨', ts: '🟦', tsx: '🟦', jsx: '🟨', json: '🧾', md: '📝', html: '🌐', css: '🎨', scss: '🎨', py: '🐍',
    java: '☕', kt: '🟪', gradle: '🐘', toml: '⚙️', properties: '⚙️', yml: '⚙️', yaml: '⚙️', png: '🖼', jpg: '🖼', gif: '🖼', svg: '🖼',
    sh: '🐚', rs: '🦀', go: '🐹', c: '🔧', cpp: '🔧', h: '🔧', swift: '🐦', txt: '📄', lock: '🔒', zip: '📦', jar: '📦' }[e]) || '📄';
}

// ---------------- explorer ----------------
async function openFolder(dir) {
  if (!dir) dir = await S.fs.pickFolder();
  if (!dir) return;
  if (state.tabs.some(isDirty)) {
    const r = await confirmBox('Unsaved changes', 'Some files have unsaved changes. Save them before switching folders?', 'Save all', 'Cancel', "Don't save");
    if (r === null) return;
    if (r === true) await saveAll();
  }
  for (const t of state.tabs) if (t.model) t.model.dispose();
  state.tabs = []; activate(null);
  state.root = dir; state.expanded = new Set([dir]);
  const s = state.settings;
  const recent = [dir, ...((s.recent || []).filter((r) => r !== dir))].slice(0, 6);
  state.settings = await S.settings.set({ lastFolder: dir, recent });
  $('#ex-root-name').textContent = basename(dir);
  await renderTree();
  await refreshGit();
  restartTerminal();
  updateTitle(); renderRecent();
}
async function renderTree() {
  const tree = $('#tree');
  $('#ex-empty').classList.toggle('hidden', !!state.root);
  if (!state.root) { tree.innerHTML = ''; return; }
  const frag = document.createDocumentFragment();
  const gitMap = gitStatusMap();
  async function addDir(dir, depth) {
    let items;
    try { items = await S.fs.readDir(dir); } catch { return; }
    for (const it of items) {
      const open = state.expanded.has(it.path);
      const g = gitMap.get(it.path) || (it.dir && [...gitMap.keys()].some((k) => k.startsWith(it.path + SEP)) ? 'M' : '');
      const node = h('div', { class: 'node' + (g ? ' git-' + g : ''), 'data-path': it.path, style: `padding-left:${8 + depth * 14}px` },
        h('span', { class: 'tw' }, it.dir ? (open ? '▾' : '▸') : ''),
        h('span', { class: 'ic' }, it.dir ? (open ? '📂' : '📁') : fileIcon(it.name)),
        h('span', { class: 'nm' }, it.name));
      node.addEventListener('click', async () => {
        state.selected = it.path;
        if (it.dir) { open ? state.expanded.delete(it.path) : state.expanded.add(it.path); await renderTree(); }
        else { await openFile(it.path); }
        markTreeSelection();
      });
      node.addEventListener('contextmenu', (e) => { e.preventDefault(); state.selected = it.path; markTreeSelection(); treeMenu(it); });
      frag.append(node);
      if (it.dir && open) await addDir(it.path, depth + 1);
    }
  }
  await addDir(state.root, 0);
  tree.innerHTML = '';
  tree.append(frag);
  markTreeSelection();
}
function markTreeSelection() {
  $$('#tree .node').forEach((n) => n.classList.toggle('selected', n.dataset.path === state.selected));
}
function targetDir() {
  if (!state.selected || !state.root) return state.root;
  const n = $(`#tree .node[data-path="${CSS.escape(state.selected)}"]`);
  if (n && n.querySelector('.tw').textContent) return state.selected; // it's a folder
  return dirname(state.selected);
}
async function newFile(dir) {
  if (!state.root) {
    // untitled scratch file inside the home folder isn't great; ask for a folder first
    toast('Open a folder first, then make files in it 📂');
    return openFolder();
  }
  dir = dir || targetDir();
  const name = await ask('New file name', '', 'e.g. hello.js or src/notes.md');
  if (!name) return;
  const p = join(dir, name);
  try { await S.fs.createFile(p); } catch (e) { return toast(e.message, 'err'); }
  expandTo(p); await renderTree(); await openFile(p);
}
async function newFolder(dir) {
  if (!state.root) return openFolder();
  dir = dir || targetDir();
  const name = await ask('New folder name');
  if (!name) return;
  const p = join(dir, name);
  await S.fs.mkdir(p); state.expanded.add(p); expandTo(p); await renderTree();
}
function expandTo(p) { let d = dirname(p); while (d.startsWith(state.root)) { state.expanded.add(d); if (d === state.root) break; d = dirname(d); } }
function treeMenu(it) {
  modal((box, close) => {
    const act = (label, fn) => h('button', { style: 'display:block;width:100%;text-align:left;margin:4px 0', onclick: () => { close(); fn(); } }, label);
    box.append(h('h2', {}, (it.dir ? '📁 ' : '📄 ') + it.name),
      it.dir ? act('New file here…', () => newFile(it.path)) : null,
      it.dir ? act('New folder here…', () => newFolder(it.path)) : null,
      act('Rename…', async () => {
        const n = await ask('Rename to', it.name); if (!n || n === it.name) return;
        const np = join(dirname(it.path), n);
        try { await S.fs.rename(it.path, np); } catch (e) { return toast(e.message, 'err'); }
        const t = tabFor(it.path); if (t) { await closeTab(t); if (!it.dir) openFile(np); }
        renderTree();
      }),
      act('Show in Finder', () => S.app.reveal(it.path)),
      act('🗑 Move to Trash', async () => {
        const ok = await confirmBox('Move to Trash?', `“${it.name}” will go to the Trash (you can get it back from there).`, 'Move to Trash');
        if (!ok) return;
        await S.fs.trash(it.path);
        for (const t of [...state.tabs]) if (t.path === it.path || t.path.startsWith(it.path + SEP)) { t.savedVersion = t.model && t.model.getAlternativeVersionId(); await closeTab(t); }
        renderTree(); refreshGitSoon();
      }));
  });
}

// ---------------- quick open ----------------
async function quickOpen() {
  if (!state.root) return openFolder();
  const files = await S.fs.listFiles(state.root);
  modal((box, close) => {
    box.classList.add('palette');
    const inp = h('input', { type: 'text', placeholder: 'Type a file name…', spellcheck: 'false' });
    const list = h('div', { class: 'qo-list' });
    let shown = [], sel = 0;
    const score = (f, q) => {
      if (!q) return 1;
      const fl = f.toLowerCase(); const b = basename(fl);
      if (b.startsWith(q)) return 100 - b.length / 100;
      if (b.includes(q)) return 50 - b.length / 100;
      let i = 0; for (const c of fl) if (c === q[i]) i++;
      return i === q.length ? 10 - fl.length / 1000 : 0;
    };
    const draw = () => {
      const q = inp.value.toLowerCase().trim();
      shown = files.map((f) => [f, score(f, q)]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 60).map((x) => x[0]);
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      list.innerHTML = '';
      shown.forEach((f, i) => list.append(h('div', { class: 'qo-item' + (i === sel ? ' sel' : ''), onclick: () => { close(); openFile(join(state.root, f)); } },
        h('span', {}, fileIcon(f) + ' ' + basename(f)), h('span', { class: 'dir' }, dirname(f) === SEP ? '' : dirname(f)))));
    };
    inp.addEventListener('input', () => { sel = 0; draw(); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, shown.length - 1); draw(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
      if (e.key === 'Enter' && shown[sel]) { close(); openFile(join(state.root, shown[sel])); }
    });
    box.append(inp, list); draw(); setTimeout(() => inp.focus(), 10);
  });
}

// ---------------- search ----------------
let searchTimer;
function setupSearch() {
  const run = async () => {
    const q = $('#search-input').value;
    const out = $('#search-results'); out.innerHTML = '';
    if (!q || !state.root) { $('#search-summary').textContent = state.root ? '' : 'Open a folder to search it.'; return; }
    $('#search-summary').innerHTML = '<span class="spin">⟳</span> searching…';
    const res = await S.fs.search(state.root, q, { caseSensitive: $('#search-case').checked, regex: $('#search-regex').checked });
    if (res.error) { $('#search-summary').textContent = res.error; return; }
    const n = res.reduce((a, r) => a + r.hits.length, 0);
    $('#search-summary').textContent = n ? `${n} result${n > 1 ? 's' : ''} in ${res.length} file${res.length > 1 ? 's' : ''}` : 'No results 🤷';
    for (const r of res) {
      out.append(h('div', { class: 'res-file', title: r.rel, onclick: () => openFile(r.file) },
        h('span', {}, fileIcon(r.rel)), h('span', {}, basename(r.rel)), h('span', { class: 'muted small' }, dirname(r.rel) === SEP ? '' : dirname(r.rel)),
        h('span', { class: 'cnt' }, r.hits.length)));
      for (const hit of r.hits) {
        const start = Math.max(0, hit.col - 1 - 30);
        const pre = hit.text.slice(start, hit.col - 1), mid = hit.text.slice(hit.col - 1, hit.col - 1 + hit.len), post = hit.text.slice(hit.col - 1 + hit.len, hit.col + 120);
        out.append(h('div', { class: 'res-hit', onclick: () => openFile(r.file, { line: hit.line, col: hit.col, len: hit.len }),
          html: `<span class="ln">${hit.line}</span>${start ? '…' : ''}${esc(pre.trimStart())}<mark>${esc(mid)}</mark>${esc(post)}` }));
      }
    }
  };
  $('#search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(run, 280); });
  $('#search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  $('#search-case').addEventListener('change', run);
  $('#search-regex').addEventListener('change', run);
}

// ---------------- views / layout ----------------
function showView(v) {
  if (state.view === v && !$('#sidebar').classList.contains('collapsed')) { /* keep */ }
  state.view = v;
  $('#sidebar').classList.remove('collapsed');
  $$('.act').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach((s) => s.classList.toggle('hidden', s.id !== 'view-' + v));
  if (v === 'search') setTimeout(() => $('#search-input').focus(), 10);
  if (v === 'git') refreshGit();
  if (v === 'github') renderGitHub();
  if (v === 'pet') renderPetPanel();
  setTimeout(layout, 0);
}
function layout() { if (editor) editor.layout(); fitTerm(); }
function setupSashes() {
  const drag = (sash, onMove) => sash.addEventListener('mousedown', (e) => {
    e.preventDefault(); sash.classList.add('dragging');
    const move = (ev) => { onMove(ev); layout(); };
    const up = () => { sash.classList.remove('dragging'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });
  drag($('#sash-side'), (ev) => document.documentElement.style.setProperty('--side-w', Math.max(170, Math.min(600, ev.clientX - 48)) + 'px'));
  drag($('#sash-panel'), (ev) => document.documentElement.style.setProperty('--panel-h', Math.max(80, Math.min(innerHeight - 200, innerHeight - 24 - ev.clientY)) + 'px'));
  new ResizeObserver(layout).observe($('#editor-wrap'));
}
function toggleTerminal(force) {
  const p = $('#panel');
  const show = force ?? p.classList.contains('hidden');
  p.classList.toggle('hidden', !show);
  $('#sash-panel').classList.toggle('hidden', !show);
  if (show) { if (!state.termId) restartTerminal(); setTimeout(() => { fitTerm(); state.term && state.term.focus(); }, 30); }
  setTimeout(layout, 0);
}

// ---------------- terminal ----------------
let fit;
function setupTerminal() {
  state.term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: 13, cursorBlink: true, allowProposedApi: true,
    theme: { background: '#15151f', foreground: '#e3e1f2', cursor: '#8b7bff', selectionBackground: '#4a3fa088',
      black: '#1d1b2c', red: '#ff6b81', green: '#6be0b4', yellow: '#ffcf5c', blue: '#7fa8ff', magenta: '#c49cff', cyan: '#7fd3ff', white: '#e3e1f2',
      brightBlack: '#5c5a78' },
  });
  fit = new FitAddon.FitAddon();
  state.term.loadAddon(fit);
  state.term.open($('#terminal'));
  state.term.onData((d) => { if (state.termId) S.term.write(state.termId, d); if (!d.startsWith('\x1b')) typing.key(); });
  S.term.onData((id, d) => {
    if (id !== state.termId) return;
    state.term.write(d);
    if (/\b(error|failed|exception)\b/i.test(d) && !/0 errors?/i.test(d)) petBus('panic', 'terminal');
  });
  S.term.onExit((id) => { if (id === state.termId) { state.termId = null; state.term.write('\r\n\x1b[90m[shell ended — press ⟳ to start a new one]\x1b[0m\r\n'); } });
}
function fitTerm() {
  if (!fit || $('#panel').classList.contains('hidden')) return;
  try { fit.fit(); if (state.termId) S.term.resize(state.termId, state.term.cols, state.term.rows); } catch {}
}
async function restartTerminal() {
  if (!state.term) return;
  if (state.termId) { await S.term.kill(state.termId); state.termId = null; }
  state.term.reset();
  fitTerm();
  state.termId = await S.term.create(state.root, state.term.cols, state.term.rows);
}

// ---------------- git ----------------
let gitTimer;
function refreshGitSoon() { clearTimeout(gitTimer); gitTimer = setTimeout(refreshGit, 500); }
function gitStatusMap() {
  const m = new Map();
  if (!state.git || !state.git.files) return m;
  for (const f of state.git.files) {
    const c = f.xy === '??' ? 'U' : (f.xy.includes('D') ? 'D' : f.xy.includes('A') ? 'A' : 'M');
    m.set(f.abs.replace(/\/$/, ''), c);
  }
  return m;
}
async function refreshGit() {
  state.git = state.root ? await S.git.status(state.root) : null;
  const g = state.git;
  const n = g && g.files ? g.files.length : 0;
  $('#git-badge').textContent = n; $('#git-badge').classList.toggle('hidden', !n);
  $('#sb-branch').textContent = g && g.repo ? '⎇ ' + g.branch : '';
  $('#sb-sync').textContent = g && g.repo && (g.ahead || g.behind) ? `↑${g.ahead} ↓${g.behind}` : '';
  renderGitPanel();
  if (state.root) renderTree();
}
function renderGitPanel() {
  const body = $('#git-body'); body.innerHTML = '';
  const g = state.git;
  if (!state.root) { body.append(h('div', { class: 'empty-hint' }, 'Open a folder first.')); return; }
  if (!g || !g.repo) {
    body.append(h('div', { class: 'card' }, h('h3', {}, 'Not a git repo yet'), h('p', { class: 'muted' }, 'Turn this folder into a git repository to track changes and push to GitHub.'),
      h('button', { class: 'primary', onclick: async () => { const r = await S.git.init(state.root); toast(r.ok ? 'Git repo created ✨' : r.err, r.ok ? 'ok' : 'err'); refreshGit(); } }, 'Initialize Repository')));
    return;
  }
  const msg = h('textarea', { id: 'commit-msg', placeholder: `Message (what did you change?) — ⌘Enter to commit on "${g.branch}"`, spellcheck: 'true' });
  msg.value = state.commitDraft || '';
  msg.addEventListener('input', () => { state.commitDraft = msg.value; });
  const doCommit = async () => {
    const r = await S.git.commit(state.root, msg.value);
    if (r.ok) { toast('Committed ✅', 'ok'); state.commitDraft = ''; petBus('happy'); }
    else toast(r.err || r.out || 'Commit failed', 'err', 7000);
    refreshGit();
  };
  msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.metaKey) doCommit(); });
  const busy = (btn, fn) => async () => { const t = btn.textContent; btn.disabled = true; btn.innerHTML = '<span class="spin">⟳</span>'; try { await fn(); } finally { btn.disabled = false; btn.textContent = t; } };
  const pushBtn = h('button', {}, g.ahead ? `⬆ Push (${g.ahead})` : '⬆ Push');
  const pullBtn = h('button', {}, g.behind ? `⬇ Pull (${g.behind})` : '⬇ Pull');
  pushBtn.onclick = busy(pushBtn, async () => {
    if (!g.remote) return publishFlow();
    const r = await S.git.push(state.root);
    if (r.ok) { toast('Pushed 🚀', 'ok'); petBus('cheer'); } else { toast(gitErr(r), 'err', 9000); petBus('panic'); }
    refreshGit();
  });
  pullBtn.onclick = busy(pullBtn, async () => {
    const r = await S.git.pull(state.root);
    if (r.ok) { toast('Pulled ✅\n' + (r.out.trim().split('\n').pop() || ''), 'ok'); reloadCleanTabs(); }
    else toast(gitErr(r), 'err', 9000);
    refreshGit();
  });
  body.append(h('div', { class: 'pad' }, msg),
    h('div', { class: 'git-actions' }, h('button', { class: 'primary', onclick: doCommit }, '✔ Commit'), pushBtn, pullBtn),
    !g.remote ? h('div', { class: 'card' }, h('h3', {}, 'No GitHub remote yet'), h('p', { class: 'muted' }, 'Publish this folder as a new repo on your GitHub account.'),
      h('button', { class: 'primary', onclick: publishFlow }, '☁️ Publish to GitHub')) : h('div', { class: 'pad muted small' }, '🔗 ' + g.remote.replace(/^https:\/\/github\.com\//, '')),
    h('div', { class: 'section-title' }, `Changes (${g.files.length})`));
  if (!g.files.length) body.append(h('div', { class: 'empty-hint' }, 'Nothing changed. All clean! ✨'));
  for (const f of g.files) {
    const code = f.xy === '??' ? 'U' : f.xy.trim()[0];
    const parts = f.file.split('/'); const nm = parts.pop();
    body.append(h('div', { class: 'chg', title: f.file, onclick: () => code !== 'D' && openFile(f.abs) },
      h('span', { class: 'st ' + code }, code), h('span', {}, fileIcon(nm) + ' ' + nm), h('span', { class: 'dir' }, parts.join('/'))));
  }
}
function gitErr(r) {
  const e = (r.err || r.out || '').trim();
  if (/could not read Username|Authentication failed|403|401/i.test(e)) return 'GitHub said no 🔒 — sign in with GitHub first (top right), then try again.\n\n' + e.slice(0, 300);
  if (/non-fast-forward|rejected/i.test(e)) return 'Your GitHub copy has newer changes. Pull first, then push.\n\n' + e.slice(0, 300);
  return e.slice(0, 500) || 'Git failed';
}
async function reloadCleanTabs() {
  for (const t of state.tabs) if (t.model && !isDirty(t)) {
    const r = await S.fs.readFile(t.path).catch(() => null);
    if (r && r.text !== undefined && r.text !== t.model.getValue()) { t.model.setValue(r.text); t.savedVersion = t.model.getAlternativeVersionId(); }
  }
  renderTabs();
}
async function publishFlow() {
  if (!state.gh.signedIn) { toast('Sign in with GitHub first (top right) 🙂'); return showView('github'); }
  const name = await ask('Name for the new GitHub repo', basename(state.root).replace(/[^A-Za-z0-9._-]/g, '-'));
  if (!name) return;
  const priv = await confirmBox('Private or public?', 'A private repo is only visible to you. A public one anyone can see.', '🔒 Private', 'Cancel', '🌍 Public');
  if (priv === null) return;
  const st = await S.git.status(state.root);
  if (st.files.length && !(await S.git.commit(state.root, 'First commit')).ok && !st.ahead) { /* maybe nothing to commit */ }
  toast('Publishing… ☁️');
  try {
    const r = await S.git.publish(state.root, name, priv === true);
    if (r.ok) { toast('Published! 🎉 ' + r.url, 'ok', 6000); petBus('cheer'); } else toast(gitErr(r), 'err', 9000);
  } catch (e) { toast(e.message, 'err', 8000); }
  refreshGit();
}

// ---------------- GitHub ----------------
async function refreshAccount() {
  state.gh = await S.gh.state().catch(() => ({ signedIn: false }));
  const btn = $('#btn-account');
  btn.innerHTML = '';
  if (state.gh.signedIn && state.gh.login) btn.append(h('img', { src: state.gh.avatar, alt: '' }), h('span', {}, state.gh.login));
  else btn.append(h('span', { class: 'gh-mark' }), h('span', {}, 'Sign in with GitHub'));
  if (state.view === 'github') renderGitHub();
}
let repoCache = null;
async function renderGitHub() {
  const body = $('#gh-body'); body.innerHTML = '';
  const cfg = await S.config.get();
  if (!state.gh.signedIn) {
    if (!cfg.githubClientId) { body.append(setupCard(cfg)); return; }
    body.append(h('div', { class: 'card' }, h('h3', {}, 'Sign in with GitHub'),
      h('p', { class: 'muted' }, 'Your browser opens GitHub, you type a short code there, done. Scuttle never sees your password.'),
      h('button', { class: 'primary', onclick: login }, 'Sign in with GitHub')),
    h('div', { class: 'pad muted small' }, 'Client ID: ' + cfg.githubClientId + ' · ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); body.innerHTML = ''; body.append(setupCard(cfg)); } }, 'change')));
    return;
  }
  const g = state.gh;
  body.append(h('div', { class: 'me' }, h('img', { src: g.avatar }), h('div', {}, h('div', { style: 'font-weight:700' }, g.name || g.login), h('div', { class: 'muted small' }, '@' + g.login)),
    h('button', { style: 'margin-left:auto', onclick: async () => { await S.gh.logout(); repoCache = null; await refreshAccount(); renderGitHub(); toast('Signed out 👋'); } }, 'Sign out')));
  const filter = h('input', { type: 'text', placeholder: 'Filter your repos…', spellcheck: 'false' });
  const list = h('div', {});
  body.append(h('div', { class: 'pad' }, filter), h('div', { class: 'section-title' }, 'Your repositories'), list);
  const draw = () => {
    list.innerHTML = '';
    const q = filter.value.toLowerCase();
    for (const r of (repoCache || []).filter((r) => r.full.toLowerCase().includes(q))) {
      list.append(h('div', { class: 'repo' },
        h('div', { class: 'top' }, h('span', { class: 'nm', title: r.full }, r.name), r.private ? h('span', { class: 'lock' }, 'private') : null,
          h('button', { onclick: () => cloneRepo(r) }, 'Clone')),
        r.desc ? h('div', { class: 'desc', title: r.desc }, r.desc) : null,
        h('div', { class: 'muted small' }, [r.lang, r.stars ? '★ ' + r.stars : null, 'updated ' + new Date(r.updated).toLocaleDateString()].filter(Boolean).join(' · '))));
    }
    if (repoCache && !repoCache.length) list.append(h('div', { class: 'empty-hint' }, 'No repos yet. Publish one from Source Control!'));
  };
  filter.addEventListener('input', draw);
  if (!repoCache) {
    list.append(h('div', { class: 'empty-hint' }, h('span', { class: 'spin' }, '⟳'), ' loading repos…'));
    try { repoCache = await S.gh.repos(); } catch (e) { list.innerHTML = ''; list.append(h('div', { class: 'empty-hint' }, e.message)); return; }
  }
  draw();
}
function setupCard(cfg) {
  const inp = h('input', { type: 'text', placeholder: 'Paste your Client ID here (looks like Ov23li…)', spellcheck: 'false', value: cfg.githubClientId || '' });
  const save = async () => {
    try { await S.config.setClientId(inp.value); toast('Client ID saved ✅', 'ok'); renderGitHub(); } catch (e) { toast(e.message, 'err'); }
  };
  return h('div', { class: 'card' },
    h('h3', {}, '🔑 One-time setup'),
    h('p', { class: 'muted' }, 'GitHub needs to know about Scuttle once. It takes 2 minutes:'),
    h('ol', {},
      h('li', {}, 'Open ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); S.app.openExternal('https://github.com/settings/applications/new'); } }, 'github.com → New OAuth App'), '.'),
      h('li', {}, 'Application name: ', h('code', {}, 'Scuttle')),
      h('li', {}, 'Homepage URL: ', h('code', {}, 'https://github.com/jdj212223-ctrl')),
      h('li', {}, 'Callback URL: ', h('code', {}, 'http://127.0.0.1/callback'), ' (not used, GitHub just wants one)'),
      h('li', {}, 'Tick ✅ ', h('b', {}, 'Enable Device Flow'), ', then click ', h('b', {}, 'Register application'), '.'),
      h('li', {}, 'Copy the ', h('b', {}, 'Client ID'), ' and paste it below. (Don\'t make a client secret — not needed!)')),
    inp, h('div', { class: 'row' }, h('button', { class: 'primary', onclick: save }, 'Save Client ID')),
    h('p', { class: 'muted small' }, 'It gets saved in ', h('code', {}, 'config.json'), ' inside the Scuttle folder.'));
}
async function login() {
  let info;
  try { info = await S.gh.startLogin(); } catch (e) {
    if (e.message.includes('NO_CLIENT_ID')) { showView('github'); return toast('Paste your GitHub Client ID first 🔑'); }
    return toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err', 8000);
  }
  let closeFn;
  closeFn = modal((box, close) => {
    box.addEventListener('cancel', () => S.gh.cancelLogin());
    box.append(h('h2', {}, 'Sign in with GitHub'),
      h('p', { class: 'muted' }, 'Your browser just opened GitHub. Type this code there:'),
      h('div', { class: 'code-big' }, info.userCode),
      h('p', { class: 'muted small' }, h('span', { class: 'spin' }, '⟳'), ' waiting for you to approve on GitHub…'),
      h('div', { class: 'btns' },
        h('button', { onclick: () => navigator.clipboard.writeText(info.userCode).then(() => toast('Code copied 📋')) }, '📋 Copy code'),
        h('button', { onclick: () => S.app.openExternal(info.verificationUri) }, 'Open GitHub again'),
        h('button', { onclick: () => { S.gh.cancelLogin(); close(); } }, 'Cancel')));
  });
  try {
    const st = await S.gh.waitLogin();
    closeFn();
    await refreshAccount();
    toast(`Hi ${st.login}! You're signed in 🎉`, 'ok');
    petBus('cheer');
    showView('github');
  } catch (e) {
    closeFn();
    if (!/CANCELLED/.test(e.message)) toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err', 8000);
  }
}
async function cloneRepo(r) {
  const parent = await S.gh.pickCloneParent();
  if (!parent) return;
  toast(`Cloning ${r.full}… ⏬`);
  const res = await S.git.clone(r.clone, parent, r.name);
  if (!res.ok) return toast(gitErr(res), 'err', 9000);
  toast('Cloned! 🎉', 'ok');
  await openFolder(res.dest);
  showView('explorer');
}

// ---------------- typing tracker + pet ----------------
const typing = {
  lastKey: 0, active: 0, keys: 0, summoned: false,
  key() {
    const now = Date.now(); this.lastKey = now; this.keys++;
    if (pet) pet.activity();
    if (popped && now - (this.lastFwd || 0) > 3000) { this.lastFwd = now; S.pet.event({ type: 'activity' }); }
  },
  tick() {
    const s = state.settings && state.settings.pet;
    if (!s) return;
    const now = Date.now();
    if (now - this.lastKey < 5000) this.active++;                 // typed in the last 5 s → counts as coding
    else if (now - this.lastKey > 120000) this.active = 0;        // a 2-minute break resets it
    const need = Math.max(10, (s.summonMinutes || 2) * 60);
    if (s.enabled && !petOut && this.active >= need) summonPet();
    updatePetStatus(need);
  },
};
let pet = null, petOut = false, popped = false;
function petBus(kind, why) {
  if (kind === 'panic') {
    const t = Date.now(); if (petBus.lastPanic && t - petBus.lastPanic < 6000) return; petBus.lastPanic = t;
  }
  if (pet && petOut) pet.react(kind);
  if (popped) S.pet.event({ type: 'react', kind });
}
function petOpts() { const s = state.settings.pet; return { kind: s.kind, color: s.color, name: s.name, size: s.size, climb: s.climb }; }
function summonPet(manual) {
  const s = state.settings.pet;
  if (petOut) { if (manual) petBus('happy'); return; }
  petOut = true;
  if (s.popout) { popped = true; S.pet.popout(true).then(() => setTimeout(() => S.pet.event({ type: 'show', opts: petOpts() }), 400)); }
  else {
    if (!pet) {
      pet = new ScuttlePets.Pet($('#pet-layer'), petOpts());
      pet.on('menu', () => showView('pet'));
    } else pet.applyOpts(petOpts());
    pet.show();
  }
  if (!manual) toast(`${s.name} noticed you're coding a lot and came to keep you company 🐾`);
  updatePetStatus();
}
function dismissPet() {
  petOut = false; typing.active = 0;
  if (pet) pet.hide();
  if (popped) { popped = false; S.pet.popout(false); }
  updatePetStatus();
}
function updatePetStatus(need) {
  const s = state.settings && state.settings.pet; if (!s) return;
  need = need || Math.max(10, (s.summonMinutes || 2) * 60);
  const el = $('#sb-pet');
  if (!s.enabled) el.textContent = '';
  else if (petOut) el.textContent = `🐾 ${s.name} is here`;
  else el.textContent = `🐾 ${s.name} ${Math.min(100, Math.round((typing.active / need) * 100))}%`;
  const m = $('#pet-meter'); if (m) m.style.width = (petOut ? 100 : Math.min(100, (typing.active / need) * 100)) + '%';
}
async function savePet(patch, live = true) {
  state.settings = await S.settings.set({ pet: patch });
  if (live && pet) pet.applyOpts(petOpts());
  if (popped) S.pet.event({ type: 'opts', opts: petOpts() });
  drawWelcomePet(); updatePetStatus();
}
const SWATCHES = ['#7ad7a8', '#f2b866', '#dfe8ff', '#9aa7ff', '#4fb7e8', '#ff8fb1', '#ff7a6b', '#c49cff', '#ffe066', '#8a8a8a', '#3b3b4f'];
function renderPetPanel() {
  const body = $('#pet-body'); body.innerHTML = '';
  const s = state.settings.pet;
  const prevCanvas = h('canvas', {});
  const drawPrev = () => {
    const H = ScuttlePets.spriteHeight(s.kind);
    prevCanvas.width = 16; prevCanvas.height = H;
    prevCanvas.style.width = 16 * s.size * 1.2 + 'px'; prevCanvas.style.height = H * s.size * 1.2 + 'px';
    ScuttlePets.draw(prevCanvas.getContext('2d'), s.kind, s.color, 0, 'happy');
  };
  const kinds = h('div', { class: 'pet-kinds' });
  for (const [k, spec] of Object.entries(ScuttlePets.PETS)) {
    const c = h('canvas', { width: 16, height: ScuttlePets.spriteHeight(k) });
    ScuttlePets.draw(c.getContext('2d'), k, spec.defaultColor, 0, 'normal');
    kinds.append(h('button', { class: k === s.kind ? 'sel' : '', title: spec.label, onclick: async () => {
      const oldDefaultName = Object.values(ScuttlePets.PETS).some((p) => p.defaultName === s.name);
      await savePet({ kind: k, color: spec.defaultColor, ...(oldDefaultName ? { name: spec.defaultName } : {}) });
      renderPetPanel();
    } }, c, spec.label));
  }
  const name = h('input', { type: 'text', value: s.name, maxlength: 20, spellcheck: 'false' });
  name.addEventListener('change', () => savePet({ name: name.value.trim() || ScuttlePets.PETS[s.kind].defaultName }));
  const color = h('input', { type: 'color', value: s.color });
  color.addEventListener('input', () => { s.color = color.value; drawPrev(); });
  color.addEventListener('change', () => savePet({ color: color.value }).then(renderPetPanel));
  const sw = h('div', { class: 'swatches' }, color, ...SWATCHES.map((c) => h('button', { class: 'sw' + (c === s.color ? ' sel' : ''), style: `background:${c}`, title: c,
    onclick: () => savePet({ color: c }).then(renderPetPanel) })));
  const size = h('input', { type: 'range', min: 2, max: 8, step: 1, value: s.size });
  size.addEventListener('input', () => { s.size = +size.value; drawPrev(); });
  size.addEventListener('change', () => savePet({ size: +size.value }));
  const mins = h('input', { type: 'range', min: 0.5, max: 10, step: 0.5, value: s.summonMinutes });
  const minsLbl = h('span', {}, s.summonMinutes + ' min');
  mins.addEventListener('input', () => { minsLbl.textContent = mins.value + ' min'; });
  mins.addEventListener('change', () => savePet({ summonMinutes: +mins.value }));
  const chk = (key, label) => { const c = h('input', { type: 'checkbox' }); c.checked = !!s[key];
    c.addEventListener('change', async () => {
      await savePet({ [key]: c.checked });
      if (key === 'alwaysShow' && c.checked) summonPet(true);
      if (key === 'enabled' && !c.checked) dismissPet();
      if (key === 'popout' && petOut) { dismissPet(); summonPet(true); }
    });
    return h('label', { class: 'check' }, c, label); };
  body.append(
    h('div', { class: 'pet-preview' }, prevCanvas),
    h('div', { class: 'field' }, h('label', {}, 'Pick a buddy'), kinds),
    h('div', { class: 'field' }, h('label', {}, 'Name'), name),
    h('div', { class: 'field' }, h('label', {}, 'Colour'), sw),
    h('div', { class: 'field' }, h('label', {}, 'Size'), size),
    h('div', { class: 'field' }, h('label', {}, 'Shows up after typing for'), h("div", { class: "row" }, mins, h("span", { style: "white-space:nowrap" }, minsLbl))),
    h('div', { class: 'field' }, h('label', {}, 'Coding meter'), h('div', { class: 'meter' }, h('div', { id: 'pet-meter' }))),
    chk('enabled', 'Pet comes when I code a lot'),
    chk('alwaysShow', 'Always keep my pet out'),
    chk('climb', 'Let it crawl up the walls and ceiling 🧗'),
    chk('popout', 'Pop out: crawl across my whole desktop 🖥️'),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => summonPet(true) }, '🐾 Summon now'), h('button', { onclick: dismissPet }, '🏠 Send home')),
    h('p', { class: 'muted small' }, 'Tip: click your pet to pet it. It sleeps when you stop typing, gets happy when you save, panics at errors and cheers when you push to GitHub.'));
  drawPrev(); updatePetStatus();
}
function drawWelcomePet() {
  const s = state.settings.pet, c = $('#welcome-pet');
  c.height = ScuttlePets.spriteHeight(s.kind); c.style.height = c.height * 8 + 'px';
  ScuttlePets.draw(c.getContext('2d'), s.kind, s.color, 0, 'happy');
}
function renderRecent() {
  const box = $('#wl-recent'); box.innerHTML = '';
  const rec = (state.settings.recent || []).slice(0, 5);
  if (!rec.length) return;
  box.append(h('div', { class: 'muted small', style: 'margin-bottom:6px' }, 'Recent'));
  for (const r of rec) box.append(h('div', {}, h('a', { onclick: () => openFolder(r), title: r }, '📁 ' + basename(r))));
}

// ---------------- errors → panic ----------------
let lastErrCount = 0;
function watchMarkers() {
  monaco.editor.onDidChangeMarkers(() => {
    const m = editor.getModel(); if (!m) return;
    const n = monaco.editor.getModelMarkers({ resource: m.uri }).filter((x) => x.severity === monaco.MarkerSeverity.Error).length;
    if (n > lastErrCount) setTimeout(() => {
      const again = monaco.editor.getModelMarkers({ resource: m.uri }).filter((x) => x.severity === monaco.MarkerSeverity.Error).length;
      if (again >= n && again > 0) petBus('panic', 'error');
    }, 1500); // wait a bit so half-typed code doesn't scare the pet every second
    lastErrCount = n;
  });
}

// ---------------- boot ----------------
async function boot() {
  state.settings = await S.settings.get();
  monaco = await loadMonaco();
  defineTheme();
  editor = monaco.editor.create($('#editor'), {
    model: null, theme: 'scuttle-night', fontSize: state.settings.fontSize || 14, automaticLayout: false,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontLigatures: true, minimap: { enabled: true },
    smoothScrolling: true, cursorSmoothCaretAnimation: 'on', cursorBlinking: 'smooth', bracketPairColorization: { enabled: true },
    renderWhitespace: 'selection', scrollBeyondLastLine: false, padding: { top: 8 }, tabSize: 2,
  });
  editor.onKeyDown(() => typing.key());
  editor.onDidChangeCursorPosition((e) => { $('#sb-pos').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`; });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveTab(state.active));
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, quickOpen);
  watchMarkers();

  // wire UI
  $$('.act').forEach((b) => b.addEventListener('click', () => {
    if (state.view === b.dataset.view && !$('#sidebar').classList.contains('collapsed')) { $('#sidebar').classList.add('collapsed'); b.classList.remove('active'); setTimeout(layout, 0); }
    else showView(b.dataset.view);
  }));
  $('#ex-open').onclick = () => openFolder();
  $('#ex-newfile').onclick = () => newFile();
  $('#ex-newfolder').onclick = () => newFolder();
  $('#ex-refresh').onclick = () => { renderTree(); refreshGit(); };
  $('#git-refresh').onclick = refreshGit;
  $('#wl-open').onclick = () => openFolder();
  $('#wl-new').onclick = () => newFile();
  $('#wl-github').onclick = () => showView('github');
  $('#btn-account').onclick = () => (state.gh.signedIn ? showView('github') : (showView('github'), S.config.get().then((c) => c.githubClientId && login())));
  $('#btn-pet-quick').onclick = () => (petOut ? petBus('happy') : summonPet(true));
  $('#sb-term').onclick = () => toggleTerminal();
  $('#term-close').onclick = () => toggleTerminal(false);
  $('#term-new').onclick = restartTerminal;
  setupSearch(); setupSashes(); setupTerminal();
  document.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('#editor, #terminal')) return;
    if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter') typing.key();
  }, true);

  S.app.onMenu(async (cmd) => {
    const m = {
      openFolder: () => openFolder(), newFile: () => newFile(), quickOpen, save: () => saveTab(state.active), saveAll,
      closeTab: () => closeTab(state.active), toggleSidebar: () => { $('#sidebar').classList.toggle('collapsed'); setTimeout(layout, 0); },
      toggleTerminal: () => toggleTerminal(), 'view:explorer': () => showView('explorer'), 'view:search': () => showView('search'),
      'view:git': () => showView('git'), 'view:github': () => showView('github'), 'view:pet': () => showView('pet'),
      'pet:summon': () => summonPet(true), 'pet:dismiss': dismissPet,
      'pet:popout': async () => { await savePet({ popout: true }); dismissPet(); summonPet(true); },
    };
    if (m[cmd]) m[cmd]();
  });
  S.pet.onPopoutClosed(async () => { if (popped) { popped = false; petOut = false; await savePet({ popout: false }); summonPet(true); } });
  S.app.onFocus(() => { if (state.root) { refreshGit(); } });
  S.app.onBeforeClose(async () => {
    if (state.tabs.some(isDirty)) {
      const r = await confirmBox('Quit Scuttle?', 'You have unsaved changes.', 'Save all & quit', 'Cancel', "Quit without saving");
      if (r === null) return;
      if (r === true) await saveAll();
    }
    S.app.confirmClose();
  });

  setInterval(() => typing.tick(), 1000);
  drawWelcomePet(); renderRecent();
  toggleTerminal(false);
  showView('explorer');
  refreshAccount();
  if (state.settings.lastFolder && (await S.fs.exists(state.settings.lastFolder))) await openFolder(state.settings.lastFolder);
  else renderTree();
  if (state.settings.pet.enabled && state.settings.pet.alwaysShow) summonPet(true);
  window.__scuttle = { state, openFile, openFolder, summonPet, dismissPet, petBus, typing, toggleTerminal, saveTab, showView, get pet() { return pet; } };
}
boot().catch((e) => { console.error(e); document.body.append(h('pre', { style: 'color:#f88;padding:20px;position:fixed;top:40px;left:60px;z-index:999' }, 'Scuttle failed to start:\n' + e.stack)); });
