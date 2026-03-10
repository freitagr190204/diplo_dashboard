const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Random game launch (existing behaviour)
  launchGame: () => ipcRenderer.send('launchGame'),
  launchRandomGame: () => ipcRenderer.send('launchGame'),

  // Launch a specific game by index (manual mode)
  launchGameByIndex: (index) => ipcRenderer.send('launchGame', index),

  // Games metadata for the UI
  getGames: () => ipcRenderer.invoke('getGames'),

  // Notify renderer when a game was selected/launched (random or manual)
  onGameSelected: (callback) => {
    ipcRenderer.on('gameSelected', (_event, payload) => {
      if (typeof callback === 'function') {
        callback(payload);
      }
    });
  },

  // Notify renderer when a game failed to start
  onGameError: (callback) => {
    ipcRenderer.on('gameError', (_event, payload) => {
      if (typeof callback === 'function') {
        callback(payload);
      }
    });
  },

  closeGame: () => ipcRenderer.send('closeGame'),
  createServerWithPort: (port) => ipcRenderer.invoke('createWsServer', port),
  stopWsServer: () => ipcRenderer.invoke('stopWsServer'),
  connectWithUrl: (url) => ipcRenderer.invoke('connectWithUrl', url),
  disconnectFromServer: () => ipcRenderer.invoke('disconnect'),
  getConnectionStatus: () => ipcRenderer.invoke('getConnectionStatus'),
  getLocalNetworkInfo: () => ipcRenderer.invoke('getLocalNetworkInfo'),
  autoConnect: (targetUrl, port) => ipcRenderer.invoke('autoConnect', targetUrl, port),
  quitApp: () => ipcRenderer.send('quitApp'),
});
