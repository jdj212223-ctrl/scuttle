// Settings live in the app's userData folder; the GitHub Client ID lives in config.json next to package.json.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const CONFIG = path.join(__dirname, '..', 'config.json');
const DEFAULTS = {
  lastFolder: null,
  fontSize: 14,
  pet: {
    enabled: true,      // summon a pet when you code a lot
    kind: 'blob',       // blob | cat | cloud | robot | crab
    color: '#9fcf7a',
    name: 'Gloop',
    size: 4,            // pixel size, 2..8
    summonMinutes: 2,   // minutes of steady typing before the pet shows up
    alwaysShow: false,  // keep the pet out all the time
    climb: true,        // allowed to crawl up the walls / along the ceiling
    popout: false,      // crawl across the whole desktop
  },
};

function file() { return path.join(app.getPath('userData'), 'settings.json'); }
function readJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }

function getSettings() {
  const s = readJSON(file(), {});
  const pet = { ...DEFAULTS.pet, ...(s.pet || {}) };
  // old cool-toned default colours -> the warm palette
  const OLD = { '#7ad7a8': '#9fcf7a', '#f2b866': '#f0a06a', '#dfe8ff': '#f3e6cf', '#9aa7ff': '#7ccbbf', '#4fb7e8': '#e8a0c4' };
  if (OLD[pet.color]) pet.color = OLD[pet.color];
  return { ...DEFAULTS, ...s, pet };
}
function setSettings(patch) {
  const cur = getSettings();
  const next = { ...cur, ...patch, pet: { ...cur.pet, ...((patch && patch.pet) || {}) } };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  return next;
}
function getConfig() {
  const c = readJSON(CONFIG, {});
  return { githubClientId: (c.githubClientId || '').trim(), configPath: CONFIG };
}
function setClientId(id) {
  const clean = String(id || '').trim();
  if (clean && !/^[A-Za-z0-9._-]{8,64}$/.test(clean)) throw new Error('That does not look like a Client ID');
  const c = readJSON(CONFIG, {});
  c.githubClientId = clean;
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2) + '\n');
  return getConfig();
}
module.exports = { getSettings, setSettings, getConfig, setClientId };
