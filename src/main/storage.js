'use strict';

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const TOKEN_KEYS = ['clickupToken', 'githubToken', 'classroomClientSecret', 'classroomRefreshToken'];

// Encrypt a token with the OS keystore (DPAPI on Windows). Prefixed so we can
// tell encrypted values from legacy plaintext and migrate transparently.
function encToken(v) {
  if (!v || typeof v !== 'string' || v.startsWith('enc:')) return v || '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(v).toString('base64');
    }
  } catch (err) { /* fall through to plaintext */ }
  return v;
}

function decToken(v) {
  if (!v || typeof v !== 'string') return '';
  if (!v.startsWith('enc:')) return v; // legacy plaintext — migrated on next write
  try {
    return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
  } catch (err) {
    return '';
  }
}

// Data lives in the per-user app data folder so it survives reinstalls/updates.
const DATA_DIR = app.getPath('userData');
const DATA_FILE = path.join(DATA_DIR, 'tasks.json');

const DEFAULT_SETTINGS = {
  theme: 'light',             // 'light' | 'dark' | 'system'
  accent: '#caa63a',          // brand accent color
  alwaysOnTop: false,
  startAtLogin: true,
  minimizeToTray: true,       // closing the window hides it instead of quitting
  hotkeyEnabled: true,        // global Ctrl+Alt+T show/hide
  locked: false,              // freeze window position & size
  snapToCorners: true,        // snap to the nearest screen corner when dragged there
  hideFromTaskbar: true,      // default: live only in the system tray (no taskbar entry)
  notifications: true,        // native desktop notifications
  defaultDeadline: 'today',   // quick-add default: 'today' | 'tomorrow'
  defaultTab: 'active',       // tab shown on launch: 'active' | 'all'
  clickupToken: '',           // ClickUp personal API token (pk_…); empty = disabled
  clickupDone: {},            // clickupId -> completedAt ISO (local "done" that survives syncs)
  githubToken: '',            // GitHub Personal Access Token; empty = disabled
  classroomClientId: '',      // Google OAuth client id (desktop app)
  classroomClientSecret: '',  // Google OAuth client secret (encrypted)
  classroomRefreshToken: '',  // Google OAuth refresh token (encrypted); empty = not connected
  classroomDone: {}           // classroom courseWork id -> completedAt ISO (local done)
};

const DEFAULT_DATA = {
  tasks: [],
  settings: { ...DEFAULT_SETTINGS }
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// Read the data file. On any problem (missing/corrupt) fall back to defaults
// so the app always starts cleanly.
function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) };
    // Decrypt tokens into memory (API calls need the plaintext).
    for (const k of TOKEN_KEYS) settings[k] = decToken(settings[k]);
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      settings
    };
  } catch (err) {
    return { tasks: [], settings: { ...DEFAULT_SETTINGS } };
  }
}

// Atomic write: write to a temp file, then rename over the real file.
// rename() is atomic on the same volume, so a crash mid-write can never
// leave a half-written tasks.json behind.
function writeData(data) {
  ensureDir();
  const payload = {
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) }
  };
  // Write an encrypted-token copy to disk, but keep the returned copy plaintext
  // (the main process reuses it for live API calls).
  const diskPayload = {
    tasks: payload.tasks,
    settings: { ...payload.settings }
  };
  for (const k of TOKEN_KEYS) diskPayload.settings[k] = encToken(diskPayload.settings[k]);

  const tmp = DATA_FILE + '.' + process.pid + '.tmp';
  const json = JSON.stringify(diskPayload, null, 2);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd); // flush to disk before the rename
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, DATA_FILE);
  return payload;
}

module.exports = {
  DATA_FILE,
  DEFAULT_DATA,
  DEFAULT_SETTINGS,
  readData,
  writeData
};
