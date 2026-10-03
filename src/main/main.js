'use strict';

const path = require('path');
const crypto = require('crypto');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  globalShortcut,
  Notification,
  nativeImage,
  shell,
  screen
} = require('electron');

const storage = require('./storage');
const windowState = require('./window-state');

const HOTKEY = 'CommandOrControl+Alt+T';
const TICK_MS = 60 * 1000; // recompute urgency / notifications every minute

// Resizable, but kept to a sticky-note shape: a locked aspect ratio plus
// min/max bounds so the layout never gets too wide, narrow, tall or short.
const WIN_WIDTH = 300;
const WIN_HEIGHT = 410;
const WIN_ASPECT = WIN_WIDTH / WIN_HEIGHT;
const WIN_MIN = { width: 270, height: 370 };
const WIN_MAX = { width: 360, height: 490 };
let fullBounds = null; // remembers the normal size while in compact view

let mainWindow = null;
let tray = null;
let isQuitting = false;
let tickTimer = null;

// The single in-memory source of truth. All mutations go through here,
// then persist to disk and broadcast to the renderer.
let state = { tasks: [], settings: { ...storage.DEFAULT_SETTINGS } };

/* ------------------------------------------------------------------ */
/* State helpers                                                       */
/* ------------------------------------------------------------------ */

function persist() {
  state = storage.writeData(state);
}

function broadcast() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state-changed', state);
  }
}

function commit() {
  persist();
  broadcast();
}

function findTask(id) {
  return state.tasks.find((t) => t.id === id);
}

/* ------------------------------------------------------------------ */
/* Deadline / notification logic                                       */
/* ------------------------------------------------------------------ */

// A task stores deadline as "YYYY-MM-DD" plus an optional "HH:MM" time.
// With no time, the deadline is treated as the end of that day.
function effectiveDeadline(task) {
  if (!task.deadline) return null;
  const time = task.deadlineTime ? task.deadlineTime : '23:59:59';
  const d = new Date(task.deadline + 'T' + time);
  return isNaN(d.getTime()) ? null : d;
}

// Walk open tasks and fire a native notification the first time each one
// crosses into "due soon" (within 1h) or "overdue". Flags on the task make
// it fire once per task per state.
function runNotificationCheck() {
  if (!state.settings.notifications) return;
  const now = Date.now();
  let changed = false;

  for (const task of state.tasks) {
    if (task.done) continue;
    const due = effectiveDeadline(task);
    if (!due) continue;

    const diff = due.getTime() - now;

    if (diff <= 0) {
      if (!task.notifiedOverdue) {
        task.notifiedOverdue = true;
        changed = true;
        notify('Task overdue', task.title);
      }
    } else if (diff <= 60 * 60 * 1000) {
      if (!task.notifiedDueSoon) {
        task.notifiedDueSoon = true;
        changed = true;
        notify('Due within the hour', task.title);
      }
    }
  }

  if (changed) persist(); // flags changed; renderer doesn't need these
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => showWindow());
  n.show();
}

/* ------------------------------------------------------------------ */
/* ClickUp one-way sync (assigned, open tasks across the workspace)     */
/* ------------------------------------------------------------------ */
const CLICKUP_API = 'https://api.clickup.com/api/v2';
let lastClickUpError = null;

async function cuGet(path, token) {
  const res = await fetch(CLICKUP_API + path, { headers: { Authorization: token } });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${txt.slice(0, 120)}`);
  }
  return res.json();
}

const pad2 = (n) => String(n).padStart(2, '0');

function mapClickUpTask(ct) {
  const dueMs = ct.due_date ? Number(ct.due_date) : null;
  let deadline = null;
  let deadlineTime = null;
  if (dueMs) {
    const d = new Date(dueMs);
    deadline = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    if (ct.due_date_time) deadlineTime = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  // Honour a local "done" mark so completed imports don't reappear as active.
  const localDone = (state.settings.clickupDone || {})[ct.id] || null;
  return {
    id: 'cu-' + ct.id,
    clickupId: ct.id,
    source: 'clickup',
    url: ct.url || null,
    listName: ct.list && ct.list.name ? ct.list.name : '',
    title: ct.name || 'Untitled',
    description: (ct.text_content || ct.description || '').trim(),
    deadline,
    deadlineTime,
    done: !!localDone,
    createdAt: ct.date_created ? new Date(Number(ct.date_created)).toISOString() : new Date().toISOString(),
    completedAt: localDone,
    notifiedDueSoon: true, // never fire desktop notifications for imported tasks
    notifiedOverdue: true
  };
}

async function fetchAssignedTasks(token) {
  const me = await cuGet('/user', token);
  const userId = me.user.id;
  const teams = (await cuGet('/team', token)).teams || [];
  const all = [];
  for (const team of teams) {
    for (let page = 0; page <= 50; page++) {
      const q = `/team/${team.id}/task?assignees[]=${userId}&include_closed=false&subtasks=true&page=${page}`;
      const data = await cuGet(q, token);
      const tasks = data.tasks || [];
      all.push(...tasks);
      if (data.last_page || tasks.length === 0) break;
    }
  }
  return all.map(mapClickUpTask);
}

/* ------------------------------------------------------------------ */
/* GitHub: my PRs (status) + notifications addressed to me             */
/* ------------------------------------------------------------------ */
const GH_API = 'https://api.github.com';
const GH_HEADERS = (token) => ({
  Authorization: 'Bearer ' + token,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'Sticky-Todo'   // GitHub requires a User-Agent
});

const PR_QUERY = `query {
  viewer {
    login
    pullRequests(first: 30, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        title number url isDraft
        repository { nameWithOwner }
        reviewDecision
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

// Convert a notifications subject API url to a browser url.
function ghHtmlUrl(apiUrl, repoFullName) {
  if (!apiUrl) return repoFullName ? `https://github.com/${repoFullName}` : 'https://github.com';
  return apiUrl
    .replace('https://api.github.com/repos', 'https://github.com')
    .replace('/pulls/', '/pull/');
}

async function fetchGitHub(token) {
  // PRs via GraphQL (checks + review decision in one call)
  const gqlRes = await fetch(GH_API + '/graphql', {
    method: 'POST',
    headers: { ...GH_HEADERS(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: PR_QUERY })
  });
  if (!gqlRes.ok) {
    const t = await gqlRes.text().catch(() => '');
    throw new Error(`HTTP ${gqlRes.status} ${t.slice(0, 120)}`);
  }
  const gql = await gqlRes.json();
  if (gql.errors) throw new Error(gql.errors[0].message);

  const prs = (gql.data.viewer.pullRequests.nodes || []).map((n) => ({
    title: n.title,
    number: n.number,
    url: n.url,
    draft: n.isDraft,
    repo: n.repository ? n.repository.nameWithOwner : '',
    review: n.reviewDecision || null,
    checks: (n.commits.nodes[0] && n.commits.nodes[0].commit.statusCheckRollup)
      ? n.commits.nodes[0].commit.statusCheckRollup.state
      : null
  }));

  // Notifications addressed to me (unread), filtered to comments/mentions/reviews
  const notifRes = await fetch(GH_API + '/notifications', { headers: GH_HEADERS(token) });
  let notifications = [];
  if (notifRes.ok) {
    const raw = await notifRes.json();
    const keep = ['mention', 'comment', 'review_requested', 'author', 'team_mention'];
    notifications = (raw || [])
      .filter((n) => keep.includes(n.reason))
      .map((n) => ({
        title: n.subject ? n.subject.title : '(notification)',
        type: n.subject ? n.subject.type : '',
        reason: n.reason,
        repo: n.repository ? n.repository.full_name : '',
        url: ghHtmlUrl(n.subject && n.subject.url, n.repository && n.repository.full_name),
        updatedAt: n.updated_at
      }));
  }

  return { ok: true, login: gql.data.viewer.login, prs, notifications };
}

async function getGitHub() {
  const token = state.settings.githubToken;
  if (!token) return { ok: false, error: 'No GitHub token set.' };
  try {
    return await fetchGitHub(token);
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// Replace the previous ClickUp tasks with a fresh pull; local tasks are untouched.
async function syncClickUp() {
  const token = state.settings.clickupToken;
  if (!token) return { ok: false, error: 'No ClickUp token set.' };
  try {
    const imported = await fetchAssignedTasks(token);
    state.tasks = state.tasks.filter((t) => t.source !== 'clickup').concat(imported);
    persist();
    broadcast();
    lastClickUpError = null;
    return { ok: true, count: imported.length };
  } catch (err) {
    lastClickUpError = String(err.message || err);
    return { ok: false, error: lastClickUpError };
  }
}

/* ------------------------------------------------------------------ */
/* Window + tray                                                       */
/* ------------------------------------------------------------------ */

function trayImage() {
  const img = nativeImage.createFromPath(path.join(__dirname, '../../build/tray.png'));
  return img.isEmpty() ? undefined : img;
}

function createWindow() {
  const bounds = windowState.getInitialBounds();

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: WIN_MIN.width,
    minHeight: WIN_MIN.height,
    maxWidth: WIN_MAX.width,
    maxHeight: WIN_MAX.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,          // avoid the native shadow doubling our CSS one (light edge artifact)
    resizable: !state.settings.locked,
    movable: !state.settings.locked,
    show: false,
    skipTaskbar: !!state.settings.hideFromTaskbar,
    alwaysOnTop: state.settings.alwaysOnTop,
    icon: path.join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setAspectRatio(WIN_ASPECT); // keep the sticky-note proportions while resizing
  windowState.manage(mainWindow);
  mainWindow.on('moved', snapToCorner);
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Re-assert on-top after the window is actually shown (construction-time
    // alwaysOnTop is unreliable for transparent windows on Windows).
    if (state.settings.alwaysOnTop) {
      mainWindow.setAlwaysOnTop(true, 'floating');
    }
  });

  // Closing the window hides it to the tray (unless the user turned that off).
  mainWindow.on('close', (e) => {
    if (!isQuitting && state.settings.minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
    } else if (!isQuitting) {
      isQuitting = true;
      app.quit();
    }
  });
}

// When the window is dragged near a screen corner, clamp it into that corner.
function snapToCorner() {
  if (!mainWindow || !state.settings.snapToCorners || state.settings.locked) return;
  const b = mainWindow.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const T = 48;  // how close to a corner before it snaps
  const M = 8;   // gap left between the window and the screen edges

  const nearLeft = (b.x - area.x) <= T;
  const nearRight = (area.x + area.width - (b.x + b.width)) <= T;
  const nearTop = (b.y - area.y) <= T;
  const nearBottom = (area.y + area.height - (b.y + b.height)) <= T;

  // Only snap at actual corners (near one vertical AND one horizontal edge).
  if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
    const x = Math.round(nearLeft ? area.x + M : area.x + area.width - b.width - M);
    const y = Math.round(nearTop ? area.y + M : area.y + area.height - b.height - M);
    if (b.x !== x || b.y !== y) mainWindow.setPosition(x, y, false);
  }
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

function createTray() {
  const img = trayImage();
  tray = img ? new Tray(img) : new Tray(nativeImage.createEmpty());
  tray.setToolTip('Sticky Todo');

  const menu = Menu.buildFromTemplate([
    { label: 'Show / Hide', click: toggleWindow },
    { type: 'separator' },
    {
      label: 'Always on top',
      type: 'checkbox',
      checked: state.settings.alwaysOnTop,
      click: (item) => applySetting('alwaysOnTop', item.checked)
    },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: state.settings.startAtLogin,
      click: (item) => applySetting('startAtLogin', item.checked)
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(menu);
  tray.on('click', toggleWindow);
}

/* ------------------------------------------------------------------ */
/* Settings side effects                                               */
/* ------------------------------------------------------------------ */

function applySetting(key, value) {
  state.settings[key] = value;

  if (key === 'alwaysOnTop' && mainWindow) {
    // 'floating' level is needed for transparent windows on Windows to actually stay on top.
    mainWindow.setAlwaysOnTop(!!value, 'floating');
  }
  if (key === 'startAtLogin') {
    app.setLoginItemSettings({ openAtLogin: !!value });
  }
  if (key === 'hotkeyEnabled') {
    applyHotkey(!!value);
  }
  if (key === 'locked' && mainWindow) {
    mainWindow.setMovable(!value);
    mainWindow.setResizable(!value);
  }
  if (key === 'hideFromTaskbar' && mainWindow) {
    mainWindow.setSkipTaskbar(!!value);
  }

  commit();
  return state;
}

function applyHotkey(enabled) {
  globalShortcut.unregister(HOTKEY);
  if (enabled) globalShortcut.register(HOTKEY, toggleWindow);
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('get-state', () => state);

  ipcMain.handle('add-task', (_e, input) => {
    const now = new Date().toISOString();
    const task = {
      id: crypto.randomUUID(),
      title: (input.title || '').trim(),
      description: input.description ? String(input.description) : '',
      deadline: input.deadline,          // "YYYY-MM-DD" (required, validated in renderer)
      deadlineTime: input.deadlineTime || null, // "HH:MM" | null
      done: false,
      createdAt: now,
      completedAt: null,
      notifiedDueSoon: false,
      notifiedOverdue: false
    };
    if (!task.title || !task.deadline) {
      return { error: 'Title and deadline are required.' };
    }
    state.tasks.push(task);
    persist();
    return state;
  });

  ipcMain.handle('update-task', (_e, { id, patch }) => {
    const task = findTask(id);
    if (!task) return state;
    const allowed = ['title', 'description', 'deadline', 'deadlineTime', 'order'];
    for (const key of allowed) {
      if (key in patch) task[key] = patch[key];
    }
    // Reset notification flags if the deadline moved into the future.
    if ('deadline' in patch || 'deadlineTime' in patch) {
      task.notifiedDueSoon = false;
      task.notifiedOverdue = false;
    }
    persist();
    return state;
  });

  ipcMain.handle('delete-task', (_e, id) => {
    state.tasks = state.tasks.filter((t) => t.id !== id);
    persist();
    return state;
  });

  ipcMain.handle('toggle-done', (_e, id) => {
    const task = findTask(id);
    if (!task) return state;
    task.done = !task.done;
    task.completedAt = task.done ? new Date().toISOString() : null;

    if (task.source === 'clickup') {
      // Persist the local done state so it survives the next sync.
      state.settings.clickupDone = state.settings.clickupDone || {};
      if (task.done) state.settings.clickupDone[task.clickupId] = task.completedAt;
      else delete state.settings.clickupDone[task.clickupId];
    } else if (!task.done) {
      task.notifiedDueSoon = false;
      task.notifiedOverdue = false;
    }
    persist();
    return state;
  });

  ipcMain.handle('reorder-tasks', (_e, orderedIds) => {
    // Persist a manual order within a deadline day.
    orderedIds.forEach((id, index) => {
      const task = findTask(id);
      if (task) task.order = index;
    });
    persist();
    return state;
  });

  ipcMain.handle('set-setting', (_e, { key, value }) => applySetting(key, value));

  // Data management
  ipcMain.handle('clear-completed', () => {
    state.tasks = state.tasks.filter((t) => !t.done);
    persist();
    return state;
  });

  ipcMain.handle('delete-all', () => {
    state.tasks = [];
    persist();
    return state;
  });

  ipcMain.handle('open-data-folder', () => {
    shell.showItemInFolder(storage.DATA_FILE);
  });

  ipcMain.handle('sync-clickup', () => syncClickUp());
  ipcMain.handle('fetch-github', () => getGitHub());
  ipcMain.handle('open-external', (_e, url) => {
    if (url) shell.openExternal(url);
  });

  // Compact view snaps the window to the base size; toggling back restores it.
  ipcMain.handle('set-compact', (_e, on) => {
    if (!mainWindow) return;
    if (on) {
      fullBounds = mainWindow.getBounds();
      mainWindow.setSize(WIN_MIN.width, WIN_MIN.height, false); // smallest size 270 × 370
      mainWindow.setResizable(false);                           // fixed while compact
    } else {
      mainWindow.setResizable(!state.settings.locked);
      const w = fullBounds ? fullBounds.width : WIN_WIDTH;
      const h = fullBounds ? fullBounds.height : WIN_HEIGHT;
      mainWindow.setSize(w, h, false);
    }
  });

  // Window controls
  ipcMain.on('win-minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.on('win-hide', () => mainWindow && mainWindow.hide());
  ipcMain.handle('win-toggle-top', () => {
    return applySetting('alwaysOnTop', !state.settings.alwaysOnTop).settings.alwaysOnTop;
  });
}

/* ------------------------------------------------------------------ */
/* App lifecycle                                                       */
/* ------------------------------------------------------------------ */

// Keep a single instance; a second launch just reveals the window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    state = storage.readData();

    // Keep the OS login-item setting in sync with saved preference.
    app.setLoginItemSettings({ openAtLogin: !!state.settings.startAtLogin });

    registerIpc();
    createWindow();
    createTray();

    applyHotkey(state.settings.hotkeyEnabled);

    runNotificationCheck();
    tickTimer = setInterval(runNotificationCheck, TICK_MS);

    // Pull ClickUp tasks on launch and every 10 minutes (if a token is set).
    if (state.settings.clickupToken) syncClickUp();
    setInterval(() => { if (state.settings.clickupToken) syncClickUp(); }, 10 * 60 * 1000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  // Don't quit when the window is hidden to the tray.
  app.on('window-all-closed', (e) => {
    // No-op: the app lives in the tray until the user quits explicitly.
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (tickTimer) clearInterval(tickTimer);
  });
}
