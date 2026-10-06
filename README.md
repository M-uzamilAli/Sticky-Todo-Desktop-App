# Sticky Todo

**A glance surface for the day — not another task manager.**

A small, always-visible sticky note that keeps what you're working on *and* pulls in
your assigned **ClickUp** tasks and **GitHub** PRs & comments, so the answer to
"what do I need to do / what's waiting on me" is one glance away — never a context switch.

---

## Download

Grab the latest Windows installer from the
**[Releases page](https://github.com/M-uzamilAli/Sticky-Todo-Desktop-App/releases/latest)**
(`Sticky Todo Setup 1.0.3.exe`). Run it, and the app lives in your system tray.

---

## Why this exists

Every morning I'd sit down, scribble on a desktop sticky note what I needed to chase,
and within a day it was an unreadable pile — no order, no deadlines, nothing I could
actually act on. Worse, the things that *actually* drove my day lived elsewhere: my
**internship tasks in ClickUp** and my **pull requests and review comments on GitHub**.
Checking them meant opening tabs, logging in, and losing focus.

I looked for a fix and found plenty of full-blown task managers — heavy, multi-pane,
built for planning sprints. That's the opposite of what I needed. I didn't want to
*manage* tasks; I wanted to **glance** and know what's next.

So Sticky Todo is deliberately small. It stays pinned on screen (or in the tray),
holds my own quick notes with real deadlines, and surfaces my ClickUp assignments and
GitHub activity in the same little window. One look, and I know what's overdue, what's
due today, which PRs are green, and whether anyone's waiting on me.

## What makes it different

- **Glance-first, not CRUD-first.** Urgency, grouping, and a one-line status strip do
  the thinking; you just look.
- **Your real work, pulled in.** ClickUp tasks assigned to you and your GitHub PRs/
  comments live next to your personal notes — no tab-hopping.
- **Lives where you work.** Frameless, always-on-top, tray-only, global hotkey — it's a
  widget, not an app you "open."
- **Deliberately minimal.** No projects, no boards, no backlog grooming. Just today.

---

## Features

### The widget
- Frameless sticky-note window, rounded corners, drag bar
- Light / Dark / **System** themes — all colours in CSS variables
- **Always on top** toggle (📌)
- **Lock** (🔓) — freeze position & size so you can't nudge it
- **Compact view** (▢) — strips the chrome to a dense, all-tasks summary at a small fixed size
- **Minimize** (—) and **hide-to-tray** (✕)
- **Tray only** mode (default **on**) — no taskbar entry; the app lives in the system tray
- Global hotkey **Ctrl+Alt+T** to show/hide
- **Snap to screen corners** when dragged near one
- Fixed aspect ratio with sensible min/max so the layout never breaks
- Optional **start at login** (default **on**)
- Remembers window position & size between launches

### Tasks
- Full CRUD with a mandatory **deadline** (date required, time optional)
- Quick-add bar with **Today / Tomorrow / custom Date** chips (default Today)
- **Read view** (click a task): status badge, relative deadline (e.g. "in 15 days"),
  description, then an **Edit** form that auto-saves
- **Tabs**: Active / Done / All (with counts) · **Filters**: All / Week (with ‹ range › stepper)
- **Section headers**: Overdue / Today / This week / Later / Done
- Notification strip summarising urgency; **native desktop notifications** when a task
  becomes overdue or is due within an hour
- Animated complete, slide-out, **undo toast** (complete & delete), drag-to-reorder
- **Delete confirmation** so nothing vanishes by accident
- Keyboard: Enter add · Esc back · Delete removes focused · Ctrl+Z undo · Ctrl+1/2/3 tabs

### Focus mode
- A **Focus** button on any open task starts a session: the rest of the app **blurs out**,
  the single task takes over, and a **live timer** counts up — one thing at a time
- Works for your own tasks and imported ClickUp tasks; **Done** completes & exits, **Esc** leaves

### ClickUp (one-way import)
- Imports tasks **assigned to you** (open, across the whole workspace)
- Syncs on launch, every 10 min, and via the **ClickUp button** / Settings "Sync now"
- Imported tasks are read-only (open in ClickUp) but can be **marked done locally**,
  and that done-state **persists across syncs**

### GitHub (read-only panel)
- **My Pull Requests**, grouped by repo, with CI check + review-decision badges
- **For Me** — unread @mentions, comments, and review requests
- **Unread count badge** on the GitHub button; results are **cached** (re-fetched only
  when stale or via ↻); click any item to open it in your browser

### Security
- ClickUp & GitHub tokens are encrypted at rest with the OS keystore
  (Electron `safeStorage` → **DPAPI** on Windows), stored as `enc:…` — never plaintext

---

## Project layout

```
src/
  main/
    main.js          app lifecycle, window, tray, hotkey, notifications,
                     IPC, ClickUp sync, GitHub fetch, corner-snap, compact resize
    storage.js       atomic JSON read/write in userData + token encryption
    window-state.js  remember window position & size
  preload/
    preload.js       safe window.todo API over IPC (contextIsolation)
  renderer/
    index.html       the note UI + focus, settings, and GitHub views
    styles.css       tokens + light/dark themes, all components
    app.js           UI state, CRUD, filters, focus mode, settings, integrations
scripts/
  make-icons.js      generates placeholder build/icon.png & tray.png
build/
  icon.png           app + installer icon (generated)
  tray.png           tray icon (generated)
```

Data lives in the Electron **userData** folder — on Windows:
`%APPDATA%\sticky-todo\tasks.json` — written atomically (temp file + `fsync` + rename)
so it can't be corrupted mid-save. Window position/size is in `window-state.json`
alongside it.

---

## Run (development)

```bash
npm install
npm run make-icons   # first run only — generates placeholder icons
npm start
```

> Changes to the **renderer** (HTML/CSS/`app.js`) apply with **Ctrl+R**.
> Changes to the **main process** (`main.js`, `storage.js`, `window-state.js`,
> `preload.js`) need a full **quit + relaunch**.

---

## Build the Windows installer

```bash
npm install
npm run make-icons
npm run dist
```

The NSIS installer is produced in **`release/`** (e.g. `Sticky Todo Setup 1.0.3.exe`).
Build is configured for a smaller footprint: single `en-US` locale, `asar` packaging,
and maximum compression. Replace `build/icon.png` / `build/tray.png` with your own
256×256 / 32×32 PNGs to rebrand.

### Google Classroom credentials

Classroom import uses a Google OAuth **Desktop** client. The real credentials live
in `src/main/credentials.json`, which is git-ignored (so it never lands in the public
repo) but is still bundled into the packaged app. To build with Classroom enabled,
copy `src/main/credentials.example.json` to `src/main/credentials.json` and fill in
your own `clientId` / `clientSecret`. Without it, every other feature works and
Classroom stays disabled until you add credentials (or paste them in Settings).

---

## Connecting ClickUp

1. In ClickUp: **Settings → Apps → API Token → Generate** (a `pk_…` token).
2. In the app: **⚙ Settings → ClickUp**, paste the token, click **Sync now**.
3. A ClickUp button appears in the top bar for one-click re-syncs.

## Connecting GitHub

1. In GitHub: **Settings → Developer settings → Personal access tokens**.
   Classic token scopes: **repo** + **notifications**.
2. In the app: **⚙ Settings → GitHub**, paste the token.
3. A GitHub button appears in the top bar; click it for your PRs and comments.

---

## Task model

```jsonc
{
  "id": "uuid",
  "title": "string",
  "description": "string (optional)",
  "deadline": "YYYY-MM-DD",        // required for local tasks
  "deadlineTime": "HH:MM | null",  // optional
  "done": false,
  "createdAt": "ISO",
  "completedAt": "ISO | null"
  // imported tasks also carry: source:"clickup", clickupId, url, listName
}
```

You can hand-edit `tasks.json` directly (quit the app first, since it rewrites the file
on save and only reads it at launch).

---

## Tech notes

- `contextIsolation` on, `nodeIntegration` off, a strict CSP, and a preload bridge —
  the renderer only talks to the main process through `window.todo`.
- Single-instance lock; a second launch just reveals the window.
- Pure HTML/CSS/vanilla JS renderer; no frontend framework.

---

## Author

Made by **Muzamil Ali** — AI Engineer & Full-Stack Developer, CS student at
FAST-NUCES Karachi. (There's an in-app **About · Credits** page under Settings too.)

- Website: https://muzamilali.online
- GitHub: https://github.com/M-uzamilAli
- LinkedIn: https://www.linkedin.com/in/muzamil-ali-b771aa356

## License

MIT
