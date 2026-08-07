'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// Ponte minima. O token fica no processo principal; para ca so atravessam
// numeros, textos e uma severidade.
contextBridge.exposeInMainWorld('claudeWidget', {
  onState: cb => ipcRenderer.on('state', (_e, state) => cb(state)),
  refresh: () => ipcRenderer.send('refresh'),
  hide: () => ipcRenderer.send('hide'),
  toggleCompact: () => ipcRenderer.send('toggle-compact'),
  toggleTokens: () => ipcRenderer.send('toggle-tokens'),
  setTokenDays: days => ipcRenderer.send('set-token-days', days),
  setSource: source => ipcRenderer.send('set-source', source),
  togglePin: () => ipcRenderer.send('toggle-pin'),
  reportHeight: h => ipcRenderer.send('height', h)
})
