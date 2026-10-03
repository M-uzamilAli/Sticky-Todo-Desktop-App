'use strict';

const fs = require('fs');
const path = require('path');
const { app, screen } = require('electron');

const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

const DEFAULT_STATE = {
  width: 270,   // first launch opens at the minimum size
  height: 370,
  x: undefined,
  y: undefined
};

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...parsed };
  } catch (err) {
    return { ...DEFAULT_STATE };
  }
}

// Only keep the saved position if it still lands on a visible display,
// otherwise the window could open off-screen after a monitor change.
function isVisibleOnSomeDisplay(bounds) {
  if (bounds.x === undefined || bounds.y === undefined) return true;
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    );
  });
}

function getInitialBounds() {
  const state = readState();
  const bounds = {
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y
  };
  if (!isVisibleOnSomeDisplay(bounds)) {
    bounds.x = undefined;
    bounds.y = undefined;
  }
  return bounds;
}

// Attach debounced persistence to a BrowserWindow.
function manage(win) {
  let timer = null;

  const save = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const b = win.getBounds();
    try {
      fs.writeFileSync(
        STATE_FILE,
        JSON.stringify({ width: b.width, height: b.height, x: b.x, y: b.y }, null, 2)
      );
    } catch (err) {
      // non-fatal: window position is a convenience, not critical data
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };

  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('close', save);
}

module.exports = { getInitialBounds, manage };
