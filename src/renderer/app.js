'use strict';

/* ==================================================================
   Sticky Todo — renderer
   Talks to the main process only through window.todo (preload).
   ================================================================== */

const api = window.todo;

// --- App data (mirrors main's state) ---
let tasks = [];
let settings = { theme: 'light', alwaysOnTop: false, startAtLogin: false };

// --- View state (renderer-only) ---
let currentTab = 'active';     // active | done | all
let currentFilter = 'all';     // all | week | urgent (urgent set via the strip)
let quickWhen = 'today';       // quick-add deadline chip: today | tomorrow | custom
let weekOffset = 0;            // for the "Week window" filter
let focusId = null;            // task being focused, or null
let focusMode = 'view';        // 'view' (read) | 'edit'
let showSettings = false;      // settings view open?
let showGithub = false;        // github panel open?
let showAbout = false;         // about/credits view open?
let githubData = null;         // last GitHub fetch result
let workId = null;             // task being focused on (focus session)
let workStart = 0;             // focus session start time (ms)
let workTimer = null;          // interval handle for the live timer
let compact = false;           // compact summary view (chrome stripped)
let prevTab = null;            // tab/filter to restore when leaving compact
let prevFilter = null;

let lastAction = null;         // for undo: { type, task }
let toastTimer = null;
let dragId = null;

/* ------------------------------------------------------------------ */
/* Element refs                                                         */
/* ------------------------------------------------------------------ */
const el = (id) => document.getElementById(id);
const strip = el('strip');
const taskList = el('taskList');
const emptyMsg = el('emptyMsg');
const listView = el('listView');
const focusView = el('focusView');
const focusBody = el('focusBody');
const focusFooter = el('focusFooter');
const settingsView = el('settingsView');
const githubView = el('githubView');
const githubBody = el('githubBody');
const aboutView = el('aboutView');
const weekNav = el('weekNav');
const weekLabel = el('weekLabel');
const quickAdd = el('quickAdd');
const qaChips = el('qaChips');
const stripText = el('stripText');
const toast = el('toast');
const toastMsg = el('toastMsg');

/* ------------------------------------------------------------------ */
/* Date helpers                                                         */
/* ------------------------------------------------------------------ */
function effectiveDeadline(task) {
  if (!task.deadline) return null;
  const time = task.deadlineTime ? task.deadlineTime : '23:59:59';
  const d = new Date(task.deadline + 'T' + time);
  return isNaN(d.getTime()) ? null : d;
}

function dateStr(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function todayStr() {
  return dateStr(new Date());
}

function tomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return dateStr(d);
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Monday-based week range, shifted by `offset` weeks.
function weekRange(offset) {
  const now = new Date();
  const day = (now.getDay() + 6) % 7; // 0 = Monday
  const start = new Date(now);
  start.setDate(now.getDate() - day + offset * 7);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(d) {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function fullDate(d) {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// "15:30" -> "3:30 PM"
function to12h(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// A readable, relative day label: Today / Tomorrow / Yesterday / weekday / date.
function relativeDayLabel(due, now) {
  const diffDays = Math.round((startOfDay(due) - startOfDay(now)) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays === -1) return 'Yesterday';
  if (diffDays > 1 && diffDays < 7) return WEEKDAYS[due.getDay()];
  const sameYear = due.getFullYear() === now.getFullYear();
  return sameYear ? shortDate(due) : fullDate(due);
}

// "Today, 3:59 PM" / "Tomorrow" / "Oct 12, 2027"
function relativeDeadline(task) {
  const due = effectiveDeadline(task);
  if (!due) return 'No deadline';
  const dayLabel = relativeDayLabel(due, new Date());
  return task.deadlineTime ? `${dayLabel}, ${to12h(task.deadlineTime)}` : dayLabel;
}

// Compact deadline for list rows: { text, cls } where cls is '', 'today' or 'overdue'.
function listDeadline(task) {
  const due = effectiveDeadline(task);
  if (!due) return { text: 'No deadline', cls: '' };
  const now = new Date();
  const diff = due.getTime() - now.getTime();

  if (diff < 0) {
    const mins = Math.floor(-diff / 60000);
    let text;
    if (mins < 60) text = `${Math.max(1, mins)} min overdue`;
    else if (mins < 1440) text = `${Math.floor(mins / 60)}h overdue`;
    else {
      const days = Math.floor(mins / 1440);
      text = `${days} day${days > 1 ? 's' : ''} overdue`;
    }
    return { text, cls: 'overdue' };
  }

  const diffDays = Math.round((startOfDay(due) - startOfDay(now)) / 86400000);
  const time = task.deadlineTime ? ' ' + to12h(task.deadlineTime) : '';
  if (diffDays === 0) return { text: 'Today' + time, cls: 'today' };
  if (diffDays === 1) return { text: 'Tomorrow' + time, cls: '' };
  if (diffDays >= 2 && diffDays <= 6) return { text: `in ${diffDays} days`, cls: '' };
  const sameYear = due.getFullYear() === now.getFullYear();
  return { text: sameYear ? shortDate(due) : fullDate(due), cls: '' };
}

// Short relative phrase for the focus deadline line: "in 15 days", "today",
// "tomorrow", "2 days overdue". Empty when there's nothing useful to add.
function relPhrase(task) {
  const due = effectiveDeadline(task);
  if (!due) return '';
  const diff = due.getTime() - Date.now();
  if (diff < 0) {
    const mins = Math.floor(-diff / 60000);
    if (mins < 60) return `${Math.max(1, mins)} min overdue`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h overdue`;
    const days = Math.floor(mins / 1440);
    return `${days} day${days > 1 ? 's' : ''} overdue`;
  }
  const diffDays = Math.round((startOfDay(due) - startOfDay(new Date())) / 86400000);
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  if (diffDays >= 2) return `in ${diffDays} days`;
  return '';
}

// Which section a task belongs to in the grouped list.
function sectionOf(task) {
  if (task.done) return 'Done';
  const u = urgency(task);
  if (u === 'overdue') return 'Overdue';
  if (u === 'today') return 'Today';
  const due = effectiveDeadline(task);
  if (due && due <= weekRange(0).end) return 'This week';
  return 'Later';
}

const SECTION_ORDER = ['Overdue', 'Today', 'This week', 'Later', 'Done'];

// Classify an open task's urgency for accents/sorting.
function urgency(task) {
  const due = effectiveDeadline(task);
  if (!due) return 'future';
  const now = new Date();
  if (due.getTime() < now.getTime()) return 'overdue';
  const todayStart = startOfToday();
  const todayEnd = new Date(todayStart);
  todayEnd.setHours(23, 59, 59, 999);
  if (due.getTime() <= todayEnd.getTime()) return 'today';
  return 'future';
}

function formatCompleted(task) {
  if (!task.completedAt) return '';
  const d = new Date(task.completedAt);
  return `Done ${shortDate(d)}`;
}

/* ------------------------------------------------------------------ */
/* Filtering + sorting                                                  */
/* ------------------------------------------------------------------ */
function passesTab(task) {
  if (currentTab === 'active') return !task.done;
  if (currentTab === 'done') return task.done;
  return true; // all
}

function passesFilter(task) {
  if (currentFilter === 'all') return true;
  if (currentFilter === 'urgent') {
    return !task.done && (urgency(task) === 'overdue' || urgency(task) === 'today');
  }
  const due = effectiveDeadline(task);
  if (!due) return false;
  const range = weekRange(weekOffset);
  return due >= range.start && due <= range.end;
}

function sortTasks(list) {
  return list.slice().sort((a, b) => {
    if (currentTab === 'done' || (a.done && b.done)) {
      // Done tasks: most recently completed first.
      return new Date(b.completedAt || 0) - new Date(a.completedAt || 0);
    }
    // Open tasks: overdue first, then nearest deadline (ascending time).
    const da = effectiveDeadline(a);
    const db = effectiveDeadline(b);
    const ta = da ? da.getTime() : Infinity;
    const tb = db ? db.getTime() : Infinity;
    if (ta !== tb) return ta - tb;
    // Same deadline moment: honour manual drag order, then creation time.
    const oa = a.order ?? Infinity;
    const ob = b.order ?? Infinity;
    if (oa !== ob) return oa - ob;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });
}

function visibleTasks() {
  return sortTasks(tasks.filter((t) => passesTab(t) && passesFilter(t)));
}

/* ------------------------------------------------------------------ */
/* Rendering                                                            */
/* ------------------------------------------------------------------ */
function render() {
  // Default everything hidden, then reveal the active view.
  listView.hidden = true;
  focusView.hidden = true;
  settingsView.hidden = true;
  githubView.hidden = true;
  aboutView.hidden = true;
  quickAdd.hidden = true;

  if (showAbout) {
    aboutView.hidden = false;
  } else if (showGithub) {
    githubView.hidden = false;
    renderGithub();
  } else if (showSettings) {
    settingsView.hidden = false;
    renderSettings();
  } else if (focusId && tasks.some((t) => t.id === focusId)) {
    focusView.hidden = false;
    renderFocus();
  } else {
    focusId = null;
    listView.hidden = false;
    quickAdd.hidden = false;
    renderList();
  }
  renderStrip();
  renderChrome();

  // The focus overlay floats above whatever view is active.
  el('workOverlay').hidden = !(workId && tasks.some((t) => t.id === workId));
}

/* ------------------------------------------------------------------ */
/* Focus session (work on one task, blur the rest, live timer)         */
/* ------------------------------------------------------------------ */
function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`;
}

function updateWorkTimer() {
  el('workTimer').textContent = fmtElapsed(Date.now() - workStart);
}

function startWork(id) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  workId = id;
  workStart = Date.now();
  el('workTitle').textContent = t.title;
  updateWorkTimer();
  clearInterval(workTimer);
  workTimer = setInterval(updateWorkTimer, 1000);
  render();
}

function stopWork() {
  workId = null;
  clearInterval(workTimer);
  workTimer = null;
  render();
}

async function finishWork() {
  const id = workId;
  stopWork();
  if (!id) return;
  const s = await api.toggleDone(id);
  if (s && !s.error) { tasks = s.tasks; settings = s.settings; }
  lastAction = { type: 'toggle', id };
  render();
  showToast('Completed');
}

// Theme can be explicit or follow the OS.
function effectiveTheme() {
  if (settings.theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return settings.theme;
}

function renderChrome() {
  const theme = effectiveTheme();
  document.documentElement.setAttribute('data-theme', theme);
  el('themeBtn').textContent = theme === 'dark' ? '☀️' : '🌙';
  el('pinBtn').classList.toggle('is-on', !!settings.alwaysOnTop);

  // Lock reflects in the button and disables the titlebar drag region.
  el('lockBtn').textContent = settings.locked ? '🔒' : '🔓';
  el('lockBtn').classList.toggle('is-on', !!settings.locked);
  el('lockBtn').title = settings.locked ? 'Unlock position' : 'Lock position';
  document.body.classList.toggle('locked', !!settings.locked);

  // Integration buttons appear only when configured
  el('syncBtn').hidden = !settings.clickupToken;
  el('githubBtn').hidden = !settings.githubToken;

  // Unread "For Me" count badge on the GitHub button
  const ghCount = (githubData && githubData.ok && githubData.notifications)
    ? githubData.notifications.length : 0;
  const ghBadgeEl = el('githubBadge');
  ghBadgeEl.textContent = ghCount > 99 ? '99+' : String(ghCount);
  ghBadgeEl.hidden = ghCount === 0;

  // Compact summary view
  el('note').classList.toggle('compact', compact);
  el('compactBtn').classList.toggle('is-on', compact);
  el('compactBtn').title = compact ? 'Full view' : 'Compact view';

  // Tab counts
  el('countActive').textContent = tasks.filter((t) => !t.done).length || '';
  el('countDone').textContent = tasks.filter((t) => t.done).length || '';
  el('countAll').textContent = tasks.length || '';

  // Filter pills reflect state ('urgent' highlights none)
  document.querySelectorAll('.filter').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.filter === currentFilter));

  // Week range stepper
  weekNav.hidden = currentFilter !== 'week';
  if (currentFilter === 'week') {
    const r = weekRange(weekOffset);
    weekLabel.textContent = `${shortDate(r.start)} – ${shortDate(r.end)}`;
  }
}

function renderStrip() {
  const open = tasks.filter((t) => !t.done);
  let overdue = 0, today = 0;
  for (const t of open) {
    const u = urgency(t);
    if (u === 'overdue') overdue++;
    else if (u === 'today') today++;
  }

  const parts = [];
  if (overdue) parts.push(`${overdue} overdue`);
  if (today) parts.push(`${today} due today`);

  strip.classList.remove('is-overdue', 'is-today', 'is-clickable');
  if (overdue) strip.classList.add('is-overdue', 'is-clickable');
  else if (today) strip.classList.add('is-today', 'is-clickable');

  stripText.textContent = parts.length ? parts.join(' · ') : 'All clear';
}

function renderList() {
  taskList.innerHTML = '';
  const list = visibleTasks();

  if (!list.length) {
    taskList.hidden = true;
    emptyMsg.hidden = false;
    emptyMsg.textContent = emptyMessage();
    return;
  }
  taskList.hidden = false;
  emptyMsg.hidden = true;

  // Group into sections (Overdue / Today / This week / Later / Done).
  const groups = {};
  for (const t of list) (groups[sectionOf(t)] ||= []).push(t);

  for (const section of SECTION_ORDER) {
    const items = groups[section];
    if (!items || !items.length) continue;
    const head = document.createElement('div');
    head.className = 'section-head';
    head.textContent = section;
    taskList.appendChild(head);
    for (const task of items) taskList.appendChild(buildTaskRow(task));
  }
}

function emptyMessage() {
  if (currentFilter === 'urgent') return 'Nothing urgent right now.';
  if (currentFilter === 'week') return 'Nothing due this week.';
  if (currentTab === 'done') return 'No completed tasks yet.';
  if (currentTab === 'active') return 'Nothing due — add a task below.';
  return 'No tasks yet — add one below.';
}

function buildTaskRow(task) {
  const row = document.createElement('div');
  row.className = 'task';
  row.dataset.id = task.id;

  const isCU = task.source === 'clickup';
  const u = task.done ? 'done' : urgency(task);
  if (u === 'overdue') row.classList.add('overdue');  // red accent
  if (u === 'today') row.classList.add('today');      // amber accent
  if (task.done) row.classList.add('done');
  if (isCU) row.classList.add('imported');

  // Checkbox (works for local and imported tasks; imported "done" persists via the sync map)
  const lead = document.createElement('button');
  lead.className = 'check' + (task.done ? ' checked' : '');
  lead.setAttribute('aria-label', task.done ? 'Mark not done' : 'Mark done');
  const box = document.createElement('span');
  box.className = 'check-box';
  lead.appendChild(box);
  lead.addEventListener('click', (e) => {
    e.stopPropagation();
    onToggle(task, row);
  });

  // Main
  const main = document.createElement('div');
  main.className = 'task-main';
  const title = document.createElement('div');
  title.className = 'task-title';
  title.textContent = task.title;
  const meta = document.createElement('div');
  if (task.done) {
    meta.className = 'task-meta';
    meta.textContent = formatCompleted(task);
  } else {
    const d = listDeadline(task);
    meta.className = 'task-meta' + (d.cls ? ' ' + d.cls : '');
    meta.textContent = isCU ? (d.text + ' · ClickUp') : d.text;
  }
  main.append(title, meta);

  row.append(lead, main);

  // Drag grip (local open tasks only; revealed on hover via CSS)
  if (!task.done && !isCU) {
    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = '⠿';
    grip.title = 'Drag to reorder';
    row.appendChild(grip);
    enableDrag(row, grip, task);
  }

  // Whole row opens focus mode
  row.addEventListener('click', () => enterFocus(task.id));
  return row;
}

function renderFocus() {
  const task = tasks.find((t) => t.id === focusId);
  if (!task) { focusId = null; render(); return; }
  el('backBtn').textContent = '‹ Back';
  if (focusMode === 'edit') buildEditForm(task);
  else buildSummary(task);
}

// Read-only summary — three zones: info card, pinned actions, dim footer.
function buildSummary(task) {
  focusBody.innerHTML = '';
  focusFooter.innerHTML = '';
  const u = task.done ? 'done' : urgency(task);
  const isCU = task.source === 'clickup';

  /* ---- Zone 1: info card (title → deadline → description) ---- */
  const card = document.createElement('div');
  card.className = 'fx-card';

  const h = document.createElement('h2');
  h.className = 'sum-title';
  h.textContent = task.title;

  // Deadline line: dim label + value, with the single status badge at the end.
  const dueLine = document.createElement('div');
  dueLine.className = 'fx-deadline';

  const lbl = document.createElement('span');
  lbl.className = 'fx-deadline-label';
  lbl.textContent = task.done ? 'Was due' : 'Due';

  const due = effectiveDeadline(task);
  let dateText = 'No deadline';
  if (due) {
    const now = new Date();
    const datePart = due.getFullYear() === now.getFullYear() ? shortDate(due) : fullDate(due);
    const timePart = task.deadlineTime ? ' ' + to12h(task.deadlineTime) : '';
    dateText = datePart + timePart;
    if (!task.done) { const rp = relPhrase(task); if (rp) dateText += ' · ' + rp; }
  }
  const val = document.createElement('span');
  val.className = 'fx-deadline-val' + (!task.done && (u === 'overdue' || u === 'today') ? ' ' + u : '');
  val.textContent = dateText;

  const chip = document.createElement('span');
  chip.className = 'focus-chip ' + u;
  chip.textContent = task.done ? 'Done'
    : u === 'overdue' ? 'Overdue'
    : u === 'today' ? 'Due today'
    : 'Upcoming';

  dueLine.append(lbl, val);
  card.append(chip, h, dueLine); // badge above the title

  // Description. Imported tasks are read-only, so no clickable placeholder.
  const hasDesc = task.description && task.description.trim();
  if (hasDesc) {
    const desc = document.createElement('p');
    desc.className = 'fx-desc';
    desc.textContent = task.description;
    card.append(desc);
  } else if (!isCU) {
    const ph = document.createElement('button');
    ph.className = 'fx-desc-empty';
    ph.textContent = 'Add a description';
    ph.addEventListener('click', () => {
      focusMode = 'edit';
      render();
      const ta = focusBody.querySelector('textarea');
      if (ta) ta.focus();
    });
    card.append(ph);
  }

  // Source line for imported tasks.
  if (isCU) {
    const src = document.createElement('div');
    src.className = 'fx-source';
    src.textContent = task.listName ? `ClickUp · ${task.listName}` : 'ClickUp';
    card.append(src);
  }

  focusBody.append(card);

  /* ---- Zone 2: pinned action bar ---- */
  const actions = document.createElement('div');
  actions.className = 'fx-actions';
  let extraRow = null; // optional second action row (Focus layout)

  // Done toggle (shared by local and ClickUp tasks)
  const doneBtn = document.createElement('button');
  doneBtn.textContent = task.done ? 'Mark not done' : 'Mark done';
  doneBtn.addEventListener('click', async () => {
    const wasDone = task.done;
    const s = await api.toggleDone(task.id);
    if (s && !s.error) { tasks = s.tasks; settings = s.settings; }
    lastAction = { type: 'toggle', id: task.id };
    render();
    showToast(wasDone ? 'Marked not done' : 'Completed');
  });

  // Secondary: Open (ClickUp) or Edit (local)
  const secondBtn = document.createElement('button');
  secondBtn.className = 'btn-quiet';
  if (isCU) {
    secondBtn.textContent = 'Open';
    secondBtn.title = 'Open in ClickUp';
    secondBtn.addEventListener('click', () => { if (task.url) api.openExternal(task.url); });
  } else {
    secondBtn.textContent = 'Edit';
    secondBtn.addEventListener('click', () => { focusMode = 'edit'; render(); });
  }

  if (!task.done) {
    // Focus is the headline action; Mark done + (Edit/Open) sit on a second row.
    const focusBtn = document.createElement('button');
    focusBtn.className = 'btn-focus';
    focusBtn.textContent = 'Focus';
    focusBtn.addEventListener('click', () => startWork(task.id));
    actions.append(focusBtn);

    doneBtn.className = 'btn-done';
    extraRow = document.createElement('div');
    extraRow.className = 'fx-actions';
    extraRow.append(doneBtn, secondBtn);
  } else {
    doneBtn.className = 'btn-primary';
    actions.append(doneBtn, secondBtn);
  }

  /* ---- Zone 3: dim footer ---- */
  const footer = document.createElement('div');
  footer.className = 'fx-footer';

  const added = document.createElement('span');
  added.className = 'fx-added';
  if (isCU) {
    added.textContent = 'Managed in ClickUp';
  } else {
    let addedText = 'Added ' + shortDate(new Date(task.createdAt));
    if (task.done && task.completedAt) addedText += ' · Done ' + shortDate(new Date(task.completedAt));
    added.textContent = addedText;
  }
  footer.append(added);

  if (!isCU) {
    const del = document.createElement('button');
    del.className = 'fx-delete';
    del.textContent = 'Delete';
    del.addEventListener('click', () => onDelete(task));
    footer.append(del);
  }

  focusFooter.append(actions);
  if (extraRow) focusFooter.append(extraRow);
  focusFooter.append(footer);
}

// Editable form — reached via the Edit button; edits auto-save.
function buildEditForm(task) {
  focusBody.innerHTML = '';
  focusFooter.innerHTML = '';   // edit form has its own controls in the body

  const mk = (labelText, input) => {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const label = document.createElement('label');
    label.textContent = labelText;
    wrap.append(label, input);
    return wrap;
  };

  // Title
  const titleIn = document.createElement('input');
  titleIn.type = 'text';
  titleIn.value = task.title;
  titleIn.maxLength = 200;
  titleIn.addEventListener('input', () => autoSave(task.id, { title: titleIn.value.trim() }));

  // Description
  const descIn = document.createElement('textarea');
  descIn.value = task.description || '';
  descIn.placeholder = 'Add a description…';
  descIn.addEventListener('input', () => autoSave(task.id, { description: descIn.value }));

  // Deadline date + time
  const dateIn = document.createElement('input');
  dateIn.type = 'date';
  dateIn.value = task.deadline || '';
  const timeIn = document.createElement('input');
  timeIn.type = 'time';
  timeIn.value = task.deadlineTime || '';

  const saveDeadline = () => {
    if (!dateIn.value) return; // deadline is mandatory; ignore empty
    autoSave(task.id, { deadline: dateIn.value, deadlineTime: timeIn.value || null });
  };
  dateIn.addEventListener('change', saveDeadline);
  timeIn.addEventListener('change', saveDeadline);

  const dateField = mk('Deadline', dateIn);
  const timeField = mk('Time (optional)', timeIn);
  const row = document.createElement('div');
  row.className = 'field-row';
  row.append(dateField, timeField);

  // Delete
  const del = document.createElement('button');
  del.className = 'danger';
  del.textContent = 'Delete task';
  del.addEventListener('click', () => onDelete(task));

  focusBody.append(
    mk('Title', titleIn),
    mk('Description', descIn),
    row,
    del
  );
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */
async function refresh(newState) {
  if (newState && !newState.error) {
    tasks = newState.tasks;
    settings = newState.settings;
  }
  render();
}

let autoSaveTimers = {};
function autoSave(id, patch) {
  clearTimeout(autoSaveTimers[id]);
  autoSaveTimers[id] = setTimeout(async () => {
    const s = await api.updateTask(id, patch);
    // Update local copy without a full re-render (avoids stealing input focus).
    if (s && !s.error) { tasks = s.tasks; settings = s.settings; renderStrip(); }
  }, 300);
}

async function onToggle(task, li) {
  // Animate the checkbox, then let the row slide out of the Active list.
  const wasDone = task.done;
  const s = await api.toggleDone(task.id);
  if (!s || s.error) return;

  if (!wasDone && currentTab === 'active') {
    li.querySelector('.check').classList.add('checked');
    li.classList.add('done');
    li.classList.add('leaving');
    setTimeout(() => refresh(s), 260);
  } else {
    refresh(s);
  }

  lastAction = { type: 'toggle', id: task.id };
  showToast(wasDone ? 'Marked not done' : 'Completed');
}

async function onDelete(task) {
  if (!window.confirm(`Delete "${task.title}"?`)) return;
  lastAction = { type: 'delete', task: { ...task } };
  focusId = null;
  const s = await api.deleteTask(task.id);
  refresh(s);
  showToast('Task deleted');
}

// Resolve the deadline from the selected quick-add chip.
function quickDeadline() {
  if (quickWhen === 'tomorrow') return tomorrowStr();
  if (quickWhen === 'custom') return el('qaDate').value || todayStr();
  return todayStr();
}

function setQuickWhen(when) {
  quickWhen = when;
  qaChips.querySelectorAll('.chip[data-when]').forEach((c) =>
    c.classList.toggle('is-active', c.dataset.when === when));
  qaChips.querySelector('.chip-cal').classList.toggle('is-active', when === 'custom');
}

async function addFromQuickAdd(e) {
  e.preventDefault();
  const title = el('qaTitle').value.trim();
  if (!title) { el('qaTitle').focus(); return; }

  const deadline = quickDeadline();              // always valid (defaults to today)
  const time = el('qaTime').value || null;

  const s = await api.addTask({ title, deadline, deadlineTime: time });
  if (s && !s.error) {
    el('qaTitle').value = '';
    refresh(s);
    el('qaTitle').focus();   // keep focus so several can be added in a row
  }
}

/* ------------------------------------------------------------------ */
/* Focus mode navigation                                               */
/* ------------------------------------------------------------------ */
function enterFocus(id) {
  focusId = id;
  focusMode = 'view';   // always open in read mode first
  render();
}
function exitFocus() {
  focusId = null;
  focusMode = 'view';
  render();
}
// Back: from edit -> read view; from read view -> list.
function focusBack() {
  if (focusMode === 'edit') { focusMode = 'view'; render(); }
  else exitFocus();
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */
function openSettings() { showSettings = true; showGithub = false; showAbout = false; focusId = null; render(); }
function closeSettings() { showSettings = false; render(); }
function openAbout() { showAbout = true; showSettings = false; showGithub = false; focusId = null; render(); }
function closeAbout() { showAbout = false; openSettings(); } // About is reached from Settings

function renderSettings() {
  setSegment('setTheme', settings.theme);
  setSegment('setDefaultDeadline', settings.defaultDeadline);
  setSegment('setDefaultTab', settings.defaultTab);

  el('setAlwaysOnTop').checked = !!settings.alwaysOnTop;
  el('setStartAtLogin').checked = !!settings.startAtLogin;
  el('setMinimizeToTray').checked = !!settings.minimizeToTray;
  el('setHotkey').checked = !!settings.hotkeyEnabled;
  el('setLocked').checked = !!settings.locked;
  el('setSnap').checked = !!settings.snapToCorners;
  el('setHideTaskbar').checked = !!settings.hideFromTaskbar;
  el('setNotifications').checked = !!settings.notifications;
  el('setClickupToken').value = settings.clickupToken || '';
}

function setSegment(containerId, value) {
  document.querySelectorAll('#' + containerId + ' .seg').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.value === value));
}

function bindSegment(containerId, cb) {
  document.querySelectorAll('#' + containerId + ' .seg').forEach((b) =>
    b.addEventListener('click', () => cb(b.dataset.value)));
}

// Persist a setting, sync local state, and re-render.
async function applySettingAndRender(key, value) {
  const s = await api.setSetting(key, value);
  if (s && !s.error) { tasks = s.tasks; settings = s.settings; }
  render();
}

/* ------------------------------------------------------------------ */
/* GitHub panel                                                        */
/* ------------------------------------------------------------------ */
const GH_STALE_MS = 5 * 60 * 1000; // re-fetch only if the cache is older than this
let githubFetchedAt = 0;
let githubLoading = false;

function openGithub() {
  showGithub = true;
  showSettings = false;
  showAbout = false;
  focusId = null;
  render();  // shows cached data instantly (or a loading message if none yet)
  // Only hit the API when there's no cache or it's stale.
  if (!githubData || Date.now() - githubFetchedAt > GH_STALE_MS) loadGithub();
}
function closeGithub() { showGithub = false; render(); }

async function loadGithub() {
  if (githubLoading) return;
  githubLoading = true;
  const r = await api.fetchGithub();
  githubLoading = false;
  githubData = r;
  if (r && r.ok) githubFetchedAt = Date.now();
  if (showGithub) renderGithub();
  renderChrome(); // refresh the unread badge
}

function renderGithub() {
  githubBody.innerHTML = '';
  if (!githubData) {
    githubBody.append(ghMessage('Loading…'));
    return;
  }
  if (!githubData.ok) {
    githubBody.append(ghMessage('GitHub error: ' + githubData.error));
    return;
  }

  const prs = githubData.prs || [];
  const notifs = githubData.notifications || [];

  // My Pull Requests, grouped by repository.
  const prSection = document.createElement('div');
  prSection.className = 'gh-section';
  const prHead = document.createElement('div');
  prHead.className = 'gh-section-head';
  prHead.textContent = 'My Pull Requests';
  prSection.append(prHead);

  if (!prs.length) {
    prSection.append(ghMessage('No open PRs'));
  } else {
    const byRepo = {};
    for (const pr of prs) (byRepo[pr.repo] = byRepo[pr.repo] || []).push(pr);
    Object.keys(byRepo).sort().forEach((repo) => {
      const label = document.createElement('div');
      label.className = 'gh-repo';
      label.textContent = repo;
      prSection.append(label);
      byRepo[repo].forEach((pr) => prSection.append(buildPrRow(pr)));
    });
  }
  githubBody.append(prSection);

  githubBody.append(ghSection('For Me',
    notifs.length ? notifs.map(buildNotifRow) : [ghMessage('Nothing new')]));
}

function ghSection(title, rows) {
  const wrap = document.createElement('div');
  wrap.className = 'gh-section';
  const h = document.createElement('div');
  h.className = 'gh-section-head';
  h.textContent = title;
  wrap.append(h, ...rows);
  return wrap;
}

function ghMessage(text) {
  const p = document.createElement('p');
  p.className = 'gh-empty';
  p.textContent = text;
  return p;
}

function ghBadge(text, kind) {
  const b = document.createElement('span');
  b.className = 'gh-badge ' + kind;
  b.textContent = text;
  return b;
}

function buildPrRow(pr) {
  const row = document.createElement('div');
  row.className = 'gh-item';
  row.addEventListener('click', () => api.openExternal(pr.url));

  const title = document.createElement('div');
  title.className = 'gh-title';
  title.textContent = pr.title;

  const meta = document.createElement('div');
  meta.className = 'gh-meta';
  meta.textContent = `#${pr.number}`;

  const badges = document.createElement('div');
  badges.className = 'gh-badges';
  if (pr.draft) badges.append(ghBadge('Draft', 'neutral'));

  if (pr.checks === 'SUCCESS') badges.append(ghBadge('✓ Checks', 'ok'));
  else if (pr.checks === 'FAILURE' || pr.checks === 'ERROR') badges.append(ghBadge('✗ Checks', 'bad'));
  else if (pr.checks === 'PENDING' || pr.checks === 'EXPECTED') badges.append(ghBadge('• Checks', 'pending'));

  if (pr.review === 'APPROVED') badges.append(ghBadge('Approved', 'ok'));
  else if (pr.review === 'CHANGES_REQUESTED') badges.append(ghBadge('Changes requested', 'bad'));
  else if (pr.review === 'REVIEW_REQUIRED') badges.append(ghBadge('Review pending', 'pending'));

  row.append(title, meta, badges);
  return row;
}

const GH_REASON = {
  mention: 'Mentioned you',
  team_mention: 'Team mention',
  comment: 'New comment',
  review_requested: 'Review requested',
  author: 'Update on your thread'
};

function buildNotifRow(n) {
  const row = document.createElement('div');
  row.className = 'gh-item';
  row.addEventListener('click', () => api.openExternal(n.url));

  const title = document.createElement('div');
  title.className = 'gh-title';
  title.textContent = n.title;

  const meta = document.createElement('div');
  meta.className = 'gh-meta';
  meta.textContent = n.repo;

  const badges = document.createElement('div');
  badges.className = 'gh-badges';
  badges.append(ghBadge(GH_REASON[n.reason] || n.reason, 'neutral'));

  row.append(title, meta, badges);
  return row;
}

/* ------------------------------------------------------------------ */
/* Undo toast                                                          */
/* ------------------------------------------------------------------ */
function showToast(message) {
  toastMsg.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}

function hideToast() {
  toast.classList.remove('show');
}

async function doUndo() {
  if (!lastAction) return;
  if (lastAction.type === 'toggle') {
    const s = await api.toggleDone(lastAction.id);
    refresh(s);
  } else if (lastAction.type === 'delete') {
    const s = await api.addTask({
      title: lastAction.task.title,
      description: lastAction.task.description,
      deadline: lastAction.task.deadline,
      deadlineTime: lastAction.task.deadlineTime
    });
    refresh(s);
  }
  lastAction = null;
  hideToast();
}

/* ------------------------------------------------------------------ */
/* Drag to reorder (within same deadline day)                          */
/* ------------------------------------------------------------------ */
function sameDay(a, b) {
  return a.deadline === b.deadline;
}

function enableDrag(li, grip, task) {
  grip.setAttribute('draggable', 'true');

  grip.addEventListener('dragstart', (e) => {
    dragId = task.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  grip.addEventListener('dragend', () => {
    dragId = null;
    li.classList.remove('dragging');
    document.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
  });

  li.addEventListener('dragover', (e) => {
    if (!dragId || dragId === task.id) return;
    const src = tasks.find((t) => t.id === dragId);
    if (!src || !sameDay(src, task)) return; // only reorder within the same day
    e.preventDefault();
    li.classList.add('drop-target');
  });
  li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    li.classList.remove('drop-target');
    if (!dragId || dragId === task.id) return;
    const src = tasks.find((t) => t.id === dragId);
    if (!src || !sameDay(src, task)) return;
    reorderWithinDay(src, task);
  });
}

async function reorderWithinDay(src, target) {
  // Build the new order for the group sharing this deadline day.
  const group = visibleTasks().filter((t) => t.deadline === target.deadline && !t.done);
  const ids = group.map((t) => t.id).filter((id) => id !== src.id);
  const targetIndex = ids.indexOf(target.id);
  ids.splice(targetIndex, 0, src.id);
  const s = await api.reorderTasks(ids);
  refresh(s);
}

/* ------------------------------------------------------------------ */
/* Tabs / filters wiring                                               */
/* ------------------------------------------------------------------ */
function setTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.tab === tab));
  if (currentFilter === 'urgent') currentFilter = 'all'; // leave the strip's urgent view
  focusId = null;
  render();
}

function setFilter(filter) {
  if (filter === 'week' && currentFilter !== 'week') weekOffset = 0; // start on this week
  currentFilter = filter;
  render();
}

// Clicking the strip shows just the urgent tasks (overdue + due today).
function showUrgent() {
  const hasUrgent = tasks.some((t) => !t.done &&
    (urgency(t) === 'overdue' || urgency(t) === 'today'));
  if (!hasUrgent) return;
  currentTab = 'active';
  document.querySelectorAll('.tab').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.tab === 'active'));
  currentFilter = 'urgent';
  focusId = null;
  render();
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */
function wire() {
  // Window controls
  el('compactBtn').addEventListener('click', () => {
    compact = !compact;
    if (compact) {
      // Compact shows ALL tasks; remember the current tab/filter to restore later.
      prevTab = currentTab;
      prevFilter = currentFilter;
      currentTab = 'all';
      currentFilter = 'all';
      showSettings = false;
      showGithub = false;
      showAbout = false;
      focusId = null;
    } else {
      currentTab = prevTab || 'active';
      currentFilter = prevFilter || 'all';
      document.querySelectorAll('.tab').forEach((b) =>
        b.classList.toggle('is-active', b.dataset.tab === currentTab));
    }
    api.setCompact(compact);
    render();
  });
  el('minBtn').addEventListener('click', () => {
    // With no taskbar entry, minimize would vanish the window — hide to tray instead.
    if (settings.hideFromTaskbar) api.hide();
    else api.minimize();
  });
  el('closeBtn').addEventListener('click', () => api.hide());
  el('pinBtn').addEventListener('click', async () => {
    await api.toggleAlwaysOnTop();
    const s = await api.getState();
    refresh(s);
  });
  el('themeBtn').addEventListener('click', async () => {
    const next = settings.theme === 'dark' ? 'light' : 'dark';
    const s = await api.setSetting('theme', next);
    refresh(s);
  });
  el('lockBtn').addEventListener('click', () => applySettingAndRender('locked', !settings.locked));
  el('syncBtn').addEventListener('click', async () => {
    showToast('Syncing…');
    const r = await api.syncClickup();
    if (r && r.ok) {
      const s = await api.getState();
      if (s && !s.error) { tasks = s.tasks; settings = s.settings; }
      render();
      showToast(`Synced ${r.count} task${r.count === 1 ? '' : 's'}`);
    } else {
      showToast('Sync failed');
    }
  });

  // Tabs
  document.querySelectorAll('.tab').forEach((b) =>
    b.addEventListener('click', () => setTab(b.dataset.tab)));

  // Filters
  document.querySelectorAll('.filter').forEach((b) =>
    b.addEventListener('click', () => setFilter(b.dataset.filter)));
  el('weekPrev').addEventListener('click', () => { weekOffset--; render(); });
  el('weekNext').addEventListener('click', () => { weekOffset++; render(); });
  el('weekLabel').addEventListener('click', () => { weekOffset = 0; render(); });

  // Strip -> show all urgent tasks
  strip.addEventListener('click', showUrgent);

  // Quick-add
  el('quickAdd').addEventListener('submit', addFromQuickAdd);
  // Reveal the deadline chips while the add bar is in use; hide when it's idle.
  quickAdd.addEventListener('focusin', () => { qaChips.hidden = false; });
  quickAdd.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!quickAdd.contains(document.activeElement) && !el('qaTitle').value.trim()) {
        qaChips.hidden = true;
      }
    }, 120);
  });
  qaChips.querySelectorAll('.chip[data-when]').forEach((c) =>
    c.addEventListener('click', () => { setQuickWhen(c.dataset.when); el('qaTitle').focus(); }));
  el('qaDate').addEventListener('change', () => { if (el('qaDate').value) setQuickWhen('custom'); });

  // Focus back
  el('backBtn').addEventListener('click', focusBack);

  // Settings open/close
  el('settingsBtn').addEventListener('click', openSettings);
  el('settingsBack').addEventListener('click', closeSettings);

  // About / Credits
  el('btnAbout').addEventListener('click', openAbout);
  el('aboutBack').addEventListener('click', closeAbout);
  document.querySelectorAll('.about-link').forEach((b) =>
    b.addEventListener('click', () => api.openExternal(b.dataset.url)));

  // GitHub panel
  el('githubBtn').addEventListener('click', openGithub);
  el('githubBack').addEventListener('click', closeGithub);
  el('githubRefresh').addEventListener('click', () => { githubData = null; renderGithub(); loadGithub(); });
  el('setGithubToken').addEventListener('change', (e) =>
    applySettingAndRender('githubToken', e.target.value.trim()));

  // Settings — segments
  bindSegment('setTheme', (v) => applySettingAndRender('theme', v));
  bindSegment('setDefaultDeadline', (v) => applySettingAndRender('defaultDeadline', v));
  bindSegment('setDefaultTab', (v) => applySettingAndRender('defaultTab', v));

  // Settings — toggles
  el('setAlwaysOnTop').addEventListener('change', (e) => applySettingAndRender('alwaysOnTop', e.target.checked));
  el('setStartAtLogin').addEventListener('change', (e) => applySettingAndRender('startAtLogin', e.target.checked));
  el('setMinimizeToTray').addEventListener('change', (e) => applySettingAndRender('minimizeToTray', e.target.checked));
  el('setHotkey').addEventListener('change', (e) => applySettingAndRender('hotkeyEnabled', e.target.checked));
  el('setLocked').addEventListener('change', (e) => applySettingAndRender('locked', e.target.checked));
  el('setSnap').addEventListener('change', (e) => applySettingAndRender('snapToCorners', e.target.checked));
  el('setHideTaskbar').addEventListener('change', (e) => applySettingAndRender('hideFromTaskbar', e.target.checked));
  el('setNotifications').addEventListener('change', (e) => applySettingAndRender('notifications', e.target.checked));

  // Settings — data management
  el('btnClearCompleted').addEventListener('click', async () => {
    const s = await api.clearCompleted();
    refresh(s);
  });
  el('btnOpenFolder').addEventListener('click', () => api.openDataFolder());

  // Settings — ClickUp
  el('setClickupToken').addEventListener('change', (e) =>
    applySettingAndRender('clickupToken', e.target.value.trim()));
  el('btnSyncClickup').addEventListener('click', async () => {
    const status = el('clickupStatus');
    status.textContent = 'Syncing…';
    const r = await api.syncClickup();
    if (r && r.ok) {
      const s = await api.getState();
      if (s && !s.error) { tasks = s.tasks; settings = s.settings; }
      render();
      status.textContent = `Imported ${r.count} task${r.count === 1 ? '' : 's'} from ClickUp.`;
    } else {
      status.textContent = 'Sync failed: ' + (r ? r.error : 'unknown error');
    }
  });
  el('btnDeleteAll').addEventListener('click', async () => {
    if (window.confirm('Delete all tasks? This cannot be undone.')) {
      const s = await api.deleteAll();
      refresh(s);
    }
  });

  // Toast undo / dismiss
  el('toastUndo').addEventListener('click', doUndo);
  el('toastClose').addEventListener('click', hideToast);

  // Focus session overlay
  el('workDone').addEventListener('click', finishWork);
  el('workExit').addEventListener('click', stopWork);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);

    if (e.key === 'Escape') {
      if (workId) stopWork();
      else if (showAbout) closeAbout();
      else if (showGithub) closeGithub();
      else if (showSettings) closeSettings();
      else if (focusId) focusBack();
      return;
    }

    if (e.key === 'Delete' && focusId && !typing) {
      const t = tasks.find((x) => x.id === focusId);
      if (t && t.source !== 'clickup') onDelete(t); // imported tasks can't be deleted locally
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      doUndo();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && ['1', '2', '3'].includes(e.key)) {
      e.preventDefault();
      setTab(['active', 'done', 'all'][Number(e.key) - 1]);
    }
  });

  // React to state pushed from main (e.g. tray menu toggles). Never rebuild the
  // edit form from under the user's cursor — just refresh the ambient chrome.
  api.onStateChanged((s) => {
    tasks = s.tasks;
    settings = s.settings;
    if (focusMode === 'edit' && focusId) { renderStrip(); renderChrome(); }
    else render();
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */
async function init() {
  wire();
  el('qaDate').value = todayStr(); // start the custom date picker at today

  const s = await api.getState();
  if (s && !s.error) { tasks = s.tasks; settings = s.settings; }

  // Apply saved defaults
  currentTab = settings.defaultTab || 'active';
  document.querySelectorAll('.tab').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.tab === currentTab));
  quickWhen = settings.defaultDeadline || 'today';
  setQuickWhen(quickWhen);

  // Re-render if the OS theme flips while we're following it.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme === 'system') renderChrome();
  });

  render();
  el('qaTitle').focus();

  // Prime the GitHub badge in the background, then keep it fresh.
  if (settings.githubToken) loadGithub();
  setInterval(() => { if (settings.githubToken) loadGithub(); }, GH_STALE_MS);
}

init();
