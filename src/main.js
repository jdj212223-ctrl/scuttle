// Scuttle main process: windows, files, terminal, git, GitHub, settings.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const store = require('./store');
const github = require('./github');
const git = require('./git');

app.setName('Scuttle');

let win = null;
let popout = null;
const ptys = new Map(); // id -> pty
let ptyCounter = 0;

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'assets', 'icon.png');

// ---------- windows ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#15151f',
    title: 'Scuttle',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    icon: fs.existsSync(ICON) ? ICON : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // keep the pet crawling even when the window is behind others
    },
  });
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  lockDown(win);
  win.on('focus', () => win.webContents.send('app:focus'));
  win.on('close', (e) => {
    if (win.__forceClose) return;
    e.preventDefault();
    win.webContents.send('app:before-close');
  });
  win.on('closed', () => {
    win = null;
    closePopout();
    for (const p of ptys.values()) try { p.kill(); } catch {}
    ptys.clear();
  });
}

function lockDown(w) {
  // Links open in the normal browser, never inside the app.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
}

function openPopout() {
  if (popout) return;
  const { workArea } = screen.getPrimaryDisplay();
  popout = new BrowserWindow({
    x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height,
    transparent: true, frame: false, hasShadow: false, resizable: false, movable: false,
    focusable: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  popout.setAlwaysOnTop(true, 'floating');
  popout.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  popout.setIgnoreMouseEvents(true, { forward: true });
  popout.loadFile(path.join(ROOT, 'renderer', 'popout.html'));
  lockDown(popout);
  popout.on('closed', () => { popout = null; if (win) win.webContents.send('pet:popout-closed'); });
}
function closePopout() { if (popout) { popout.destroy(); popout = null; } }

// ---------- menu ----------
function send(ch, ...a) { if (win) win.webContents.send(ch, ...a); }
function buildMenu() {
  const t = [
    { role: 'appMenu' },
    { label: 'File', submenu: [
      { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => send('menu', 'openFolder') },
      { label: 'New File', accelerator: 'CmdOrCtrl+N', click: () => send('menu', 'newFile') },
      { label: 'Quick Open…', accelerator: 'CmdOrCtrl+P', click: () => send('menu', 'quickOpen') },
      { type: 'separator' },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('menu', 'save') },
      { label: 'Save All', accelerator: 'CmdOrCtrl+Alt+S', click: () => send('menu', 'saveAll') },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('menu', 'closeTab') },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Explorer', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('menu', 'view:explorer') },
      { label: 'Search', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('menu', 'view:search') },
      { label: 'Source Control', accelerator: 'CmdOrCtrl+Shift+G', click: () => send('menu', 'view:git') },
      { label: 'GitHub', click: () => send('menu', 'view:github') },
      { label: 'Pet Settings', click: () => send('menu', 'view:pet') },
      { type: 'separator' },
      { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => send('menu', 'toggleSidebar') },
      { label: 'Toggle Terminal', accelerator: 'Ctrl+`', click: () => send('menu', 'toggleTerminal') },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' },
    ] },
    { label: 'Pet', submenu: [
      { label: 'Summon Pet Now', accelerator: 'CmdOrCtrl+Shift+K', click: () => send('menu', 'pet:summon') },
      { label: 'Send Pet Home', click: () => send('menu', 'pet:dismiss') },
      { label: 'Pop Out onto Desktop', click: () => send('menu', 'pet:popout') },
    ] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

// ---------- IPC: app / settings ----------
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => store.setSettings(patch));
ipcMain.handle('config:get', () => store.getConfig());
ipcMain.handle('config:setClientId', (_e, id) => store.setClientId(id));
ipcMain.handle('app:confirmClose', () => { if (win) { win.__forceClose = true; win.close(); } });
ipcMain.handle('app:openExternal', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('app:reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('app:platform', () => process.platform);

// ---------- IPC: files ----------
const IGNORE = new Set(['.git', 'node_modules', '.DS_Store', '.gradle', 'build', 'dist', 'out', '.idea', '.next', '__pycache__', '.venv']);

ipcMain.handle('fs:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('fs:readDir', async (_e, dir) => {
  const ents = await fsp.readdir(dir, { withFileTypes: true });
  return ents
    .filter((d) => d.name !== '.DS_Store' && d.name !== '.git')
    .map((d) => ({ name: d.name, path: path.join(dir, d.name), dir: d.isDirectory() }))
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
});
ipcMain.handle('fs:readFile', async (_e, p) => {
  const st = await fsp.stat(p);
  if (st.size > 20 * 1024 * 1024) return { tooBig: true, size: st.size };
  const buf = await fsp.readFile(p);
  if (buf.subarray(0, 8000).includes(0)) return { binary: true, size: st.size };
  return { text: buf.toString('utf8') };
});
ipcMain.handle('fs:writeFile', async (_e, p, text) => { await fsp.writeFile(p, text, 'utf8'); return true; });
ipcMain.handle('fs:exists', async (_e, p) => fs.existsSync(p));
ipcMain.handle('fs:mkdir', async (_e, p) => { await fsp.mkdir(p, { recursive: true }); return true; });
ipcMain.handle('fs:createFile', async (_e, p) => {
  if (fs.existsSync(p)) throw new Error('That file already exists');
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, '', 'utf8');
  return true;
});
ipcMain.handle('fs:rename', async (_e, a, b) => {
  if (fs.existsSync(b)) throw new Error('Something with that name already exists');
  await fsp.rename(a, b); return true;
});
ipcMain.handle('fs:trash', async (_e, p) => { await shell.trashItem(p); return true; });

async function walk(root, onFile, limit = 30000) {
  let count = 0;
  const stack = [root];
  while (stack.length && count < limit) {
    const dir = stack.pop();
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of ents) {
      if (IGNORE.has(d.name)) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) stack.push(full);
      else if (d.isFile()) { count++; if ((await onFile(full)) === false) return; }
    }
  }
}
ipcMain.handle('fs:listFiles', async (_e, root) => {
  const out = [];
  await walk(root, (f) => { out.push(path.relative(root, f)); });
  return out.sort();
});
ipcMain.handle('fs:search', async (_e, root, query, opts = {}) => {
  if (!query) return [];
  const results = [];
  let re;
  try {
    re = opts.regex ? new RegExp(query, opts.caseSensitive ? 'g' : 'gi')
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseSensitive ? 'g' : 'gi');
  } catch (err) { return { error: 'Bad pattern: ' + err.message }; }
  let total = 0;
  await walk(root, async (f) => {
    try {
      const st = await fsp.stat(f);
      if (st.size > 1024 * 1024) return;
      const buf = await fsp.readFile(f);
      if (buf.subarray(0, 8000).includes(0)) return;
      const lines = buf.toString('utf8').split('\n');
      const hits = [];
      lines.forEach((line, i) => {
        re.lastIndex = 0;
        const m = re.exec(line);
        if (m) hits.push({ line: i + 1, col: m.index + 1, len: m[0].length, text: line.slice(0, 300) });
      });
      if (hits.length) { results.push({ file: f, rel: path.relative(root, f), hits: hits.slice(0, 100) }); total += hits.length; }
      if (total > 3000) return false;
    } catch {}
  });
  return results;
});

// ---------- IPC: terminal ----------
let pty = null;
function loadPty() {
  if (pty) return pty;
  pty = require('node-pty');
  return pty;
}
ipcMain.handle('term:create', (_e, cwd, cols, rows) => {
  const id = ++ptyCounter;
  const shellPath = process.env.SHELL || '/bin/zsh';
  const p = loadPty().spawn(shellPath, ['-l'], {
    name: 'xterm-256color', cols: cols || 80, rows: rows || 24,
    cwd: cwd && fs.existsSync(cwd) ? cwd : app.getPath('home'),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Scuttle' },
  });
  ptys.set(id, p);
  p.onData((d) => { if (win) win.webContents.send('term:data', id, d); });
  p.onExit(({ exitCode }) => { ptys.delete(id); if (win) win.webContents.send('term:exit', id, exitCode); });
  return id;
});
ipcMain.on('term:write', (_e, id, d) => { const p = ptys.get(id); if (p) p.write(d); });
ipcMain.on('term:resize', (_e, id, c, r) => { const p = ptys.get(id); if (p && c > 0 && r > 0) try { p.resize(c, r); } catch {} });
ipcMain.handle('term:kill', (_e, id) => { const p = ptys.get(id); if (p) { p.kill(); ptys.delete(id); } });

// ---------- IPC: git ----------
ipcMain.handle('git:status', (_e, cwd) => git.status(cwd));
ipcMain.handle('git:init', (_e, cwd) => git.init(cwd));
ipcMain.handle('git:commit', async (_e, cwd, msg) => git.commitAll(cwd, msg, await github.identity()));
ipcMain.handle('git:push', async (_e, cwd) => git.push(cwd, await github.tokenOrNull()));
ipcMain.handle('git:pull', async (_e, cwd) => git.pull(cwd, await github.tokenOrNull()));
ipcMain.handle('git:diffFile', (_e, cwd, rel) => git.headVersion(cwd, rel));
ipcMain.handle('git:clone', async (_e, url, parent, name) => git.clone(url, parent, name, await github.tokenOrNull()));
ipcMain.handle('git:publish', async (_e, cwd, repoName, priv) => {
  const repo = await github.createRepo(repoName, priv);
  await git.setOrigin(cwd, repo.clone_url);
  const r = await git.push(cwd, await github.tokenOrNull(), true);
  return { ...r, url: repo.html_url };
});

// ---------- IPC: GitHub ----------
ipcMain.handle('gh:state', () => github.state());
ipcMain.handle('gh:startLogin', async () => github.startDeviceFlow(store.getConfig().githubClientId));
ipcMain.handle('gh:waitLogin', async () => github.waitForDeviceFlow());
ipcMain.handle('gh:cancelLogin', () => github.cancelDeviceFlow());
ipcMain.handle('gh:logout', () => github.logout());
ipcMain.handle('gh:repos', () => github.repos());
ipcMain.handle('gh:pickCloneParent', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Where should the repo go?', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// ---------- IPC: pet pop-out ----------
ipcMain.handle('pet:popout', (_e, on) => { if (on) openPopout(); else closePopout(); return !!popout; });
ipcMain.on('pet:event', (_e, ev) => { if (popout) popout.webContents.send('pet:event', ev); });
ipcMain.on('pet:mouse', (e, inside) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && w === popout) w.setIgnoreMouseEvents(!inside, { forward: true });
});
ipcMain.on('pet:popoutHome', () => { closePopout(); send('pet:popout-closed'); });

// ---------- start ----------
app.whenReady().then(() => {
  if (process.platform === 'darwin' && fs.existsSync(ICON) && app.dock) app.dock.setIcon(nativeImage.createFromPath(ICON));
  buildMenu();
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
