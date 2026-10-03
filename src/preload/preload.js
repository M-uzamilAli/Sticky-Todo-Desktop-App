'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The only surface the renderer can touch. No Node, no ipcRenderer directly.
contextBridge.exposeInMainWorld('todo', {
  // Reads
  getState: () => ipcRenderer.invoke('get-state'),

  // Task CRUD
  addTask: (task) => ipcRenderer.invoke('add-task', task),
  updateTask: (id, patch) => ipcRenderer.invoke('update-task', { id, patch }),
  deleteTask: (id) => ipcRenderer.invoke('delete-task', id),
  toggleDone: (id) => ipcRenderer.invoke('toggle-done', id),
  reorderTasks: (orderedIds) => ipcRenderer.invoke('reorder-tasks', orderedIds),

  // Settings
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', { key, value }),

  // Data management
  clearCompleted: () => ipcRenderer.invoke('clear-completed'),
  deleteAll: () => ipcRenderer.invoke('delete-all'),
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),

  // ClickUp
  syncClickup: () => ipcRenderer.invoke('sync-clickup'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // GitHub
  fetchGithub: () => ipcRenderer.invoke('fetch-github'),

  // Window controls
  minimize: () => ipcRenderer.send('win-minimize'),
  hide: () => ipcRenderer.send('win-hide'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('win-toggle-top'),
  setCompact: (on) => ipcRenderer.invoke('set-compact', on),

  // Main -> renderer broadcast when state changes (e.g. from tray menu)
  onStateChanged: (cb) => {
    const listener = (_e, s) => cb(s);
    ipcRenderer.on('state-changed', listener);
    return () => ipcRenderer.removeListener('state-changed', listener);
  }
});
