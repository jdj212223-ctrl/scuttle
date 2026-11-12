// Small git helpers. Auth for github.com is passed through environment config
// (never written into .git/config and never shown on the command line).
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

function authEnv(token) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (token) {
    const basic = Buffer.from('x-access-token:' + token).toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = 'AUTHORIZATION: basic ' + basic;
  }
  return env;
}
function run(cwd, args, env, timeout = 120000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: env || { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 32 * 1024 * 1024, timeout },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, out: String(stdout), err: String(stderr) }));
  });
}
function clean(r, token) {
  // never leak a token in an error message
  const scrub = (s) => (token ? s.split(token).join('***') : s);
  return { ...r, out: scrub(r.out), err: scrub(r.err) };
}

async function status(cwd) {
  if (!cwd) return { repo: false };
  const top = await run(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { repo: false };
  const r = await run(cwd, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']);
  if (!r.ok) return { repo: true, error: r.err };
  const parts = r.out.split('\0').filter(Boolean);
  let branch = '?', ahead = 0, behind = 0, upstream = null;
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith('## ')) {
      const h = p.slice(3);
      const m = h.match(/^(?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?/);
      if (m) { branch = m[1]; upstream = m[2] || null;
        if (m[3]) { const a = m[3].match(/ahead (\d+)/); const b = m[3].match(/behind (\d+)/); ahead = a ? +a[1] : 0; behind = b ? +b[1] : 0; } }
      continue;
    }
    const xy = p.slice(0, 2), file = p.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // skip the "from" name
    files.push({ xy, file, abs: path.join(top.out.trim(), file) });
  }
  const remote = await run(cwd, ['remote', 'get-url', 'origin']);
  return { repo: true, root: top.out.trim(), branch, upstream, ahead, behind, files, remote: remote.ok ? remote.out.trim() : null };
}
async function init(cwd) { return run(cwd, ['init', '-b', 'main']); }

async function commitAll(cwd, msg, ident) {
  if (!msg || !msg.trim()) return { ok: false, err: 'Write a commit message first' };
  const add = await run(cwd, ['add', '-A']);
  if (!add.ok) return add;
  const env = { ...process.env };
  const email = await run(cwd, ['config', 'user.email']);
  if (!email.out.trim() && ident) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = ident.name;
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = ident.email;
  }
  return run(cwd, ['commit', '-m', msg], env);
}
async function push(cwd, token, setUpstream) {
  const st = await status(cwd);
  const args = ['push'];
  if (setUpstream || !st.upstream) args.push('-u', 'origin', st.branch);
  return clean(await run(cwd, args, authEnv(token), 300000), token);
}
async function pull(cwd, token) { return clean(await run(cwd, ['pull', '--ff-only'], authEnv(token), 300000), token); }
async function clone(url, parent, name, token) {
  const dest = path.join(parent, name);
  if (fs.existsSync(dest)) return { ok: false, err: `A folder called "${name}" is already there`, dest };
  const r = clean(await run(parent, ['clone', url, name], authEnv(token), 600000), token);
  return { ...r, dest };
}
async function setOrigin(cwd, url) {
  const has = await run(cwd, ['remote', 'get-url', 'origin']);
  return run(cwd, has.ok ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url]);
}
async function headVersion(cwd, rel) {
  const r = await run(cwd, ['show', 'HEAD:' + rel]);
  return r.ok ? r.out : null;
}
module.exports = { status, init, commitAll, push, pull, clone, setOrigin, headVersion };
