const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbitDesktop', {
  isDesktop: true,
  platform: process.platform,
  openQQLogin: () => ipcRenderer.invoke('orbit-open-qq-login'),
  clearQQLogin: () => ipcRenderer.invoke('orbit-clear-qq-login'),
});

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('desktop-shell-root');
  document.body.classList.add('desktop-shell');
});
