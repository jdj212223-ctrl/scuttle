// GitHub sign-in with the OAuth *device flow* (no client secret needed).
// The token never reaches the window: it is encrypted with Electron safeStorage
// (key kept in the macOS Keychain) and only used here in the main process.
const { app, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const UA = 'Scuttle-IDE';
let token = null;
let user = null;
let flow = null; // { device_code, interval, expires, cancelled }

function tokenFile() { return path.join(app.getPath('userData'), 'github-token.bin'); }

async function encryptionReady() {
  return typeof safeStorage.isAsyncEncryptionAvailable === 'function'
    ? safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
}
async function loadToken() {
  if (token) return token;
  try {
    if (!fs.existsSync(tokenFile()) || !(await encryptionReady())) return null;
    const res = await safeStorage.decryptStringAsync(fs.readFileSync(tokenFile()));
    token = res.result;
    if (res.shouldReEncrypt) await saveToken(token);
  } catch { token = null; }
  return token;
}
async function saveToken(t) {
  if (!(await encryptionReady())) throw new Error('Keychain encryption is not available');
  fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
  fs.writeFileSync(tokenFile(), await safeStorage.encryptStringAsync(t), { mode: 0o600 });
  token = t;
}

async function api(p, opts = {}) {
  const t = await loadToken();
  if (!t) throw new Error('Not signed in to GitHub');
  const r = await fetch('https://api.github.com' + p, {
    ...opts,
    headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + t, 'User-Agent': UA,
      'X-GitHub-Api-Version': '2022-11-28', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (r.status === 401) { await logout(); throw new Error('GitHub sign-in expired, please sign in again'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || ('GitHub said ' + r.status));
  return data;
}

async function state() {
  if (!(await loadToken())) return { signedIn: false };
  if (!user) {
    try { user = await api('/user'); } catch (e) { return { signedIn: !!token, error: e.message }; }
  }
  return { signedIn: true, login: user.login, name: user.name, avatar: user.avatar_url, url: user.html_url };
}

async function startDeviceFlow(clientId) {
  if (!clientId) throw new Error('NO_CLIENT_ID');
  const r = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: new URLSearchParams({ client_id: clientId, scope: 'repo read:user' }),
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 404) throw new Error("GitHub doesn't know that Client ID. Check you copied the whole thing (GitHub → Settings → Developer settings → OAuth Apps).");
  if (!r.ok || d.error) {
    if (d.error === 'device_flow_disabled') throw new Error('Device Flow is switched off. Tick "Enable Device Flow" in your GitHub OAuth App settings.');
    throw new Error(d.error_description || d.error || ('GitHub said ' + r.status));
  }
  flow = { clientId, device_code: d.device_code, interval: d.interval || 5, expires: Date.now() + d.expires_in * 1000, cancelled: false };
  shell.openExternal(d.verification_uri);
  return { userCode: d.user_code, verificationUri: d.verification_uri, expiresIn: d.expires_in };
}

async function waitForDeviceFlow() {
  const f = flow;
  if (!f) throw new Error('No sign-in in progress');
  while (!f.cancelled && Date.now() < f.expires) {
    await new Promise((res) => setTimeout(res, f.interval * 1000));
    if (f.cancelled) break;
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: new URLSearchParams({ client_id: f.clientId, device_code: f.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.access_token) {
      await saveToken(d.access_token);
      flow = null;
      user = null;
      return state();
    }
    if (d.error === 'authorization_pending') continue;
    if (d.error === 'slow_down') { f.interval = (d.interval || f.interval + 5); continue; }
    flow = null;
    if (d.error === 'access_denied') throw new Error('Sign-in was cancelled on GitHub');
    if (d.error === 'expired_token') throw new Error('The code expired, try again');
    throw new Error(d.error_description || d.error || 'Sign-in failed');
  }
  flow = null;
  throw new Error(f.cancelled ? 'CANCELLED' : 'The code expired, try again');
}
function cancelDeviceFlow() { if (flow) flow.cancelled = true; flow = null; }

async function logout() {
  token = null; user = null;
  try { fs.unlinkSync(tokenFile()); } catch {}
  return { signedIn: false };
}

async function repos() {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
    out.push(...batch.map((r) => ({ name: r.name, full: r.full_name, private: r.private, desc: r.description,
      url: r.html_url, clone: r.clone_url, updated: r.updated_at, lang: r.language, stars: r.stargazers_count })));
    if (batch.length < 100) break;
  }
  return out;
}
async function createRepo(name, priv) {
  return api('/user/repos', { method: 'POST', body: JSON.stringify({ name, private: !!priv, auto_init: false }) });
}
async function tokenOrNull() { return loadToken(); }
async function identity() {
  const s = await state().catch(() => ({}));
  if (!s.signedIn || !user) return null;
  return { name: user.name || user.login, email: `${user.id}+${user.login}@users.noreply.github.com` };
}

module.exports = { state, startDeviceFlow, waitForDeviceFlow, cancelDeviceFlow, logout, repos, createRepo, tokenOrNull, identity };
