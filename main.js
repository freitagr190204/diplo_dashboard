// main.js
'use strict';

const {app, BrowserWindow, globalShortcut} = require('electron');
const path = require('path');
const {ipcMain} = require('electron');
const {execFile, spawn} = require('child_process');
const fs = require("node:fs/promises");
const { Server } = require('socket.io');
const io = require('socket.io-client');
const os = require('os');

const isDev = !app.isPackaged;

// Configuration: load games from a human-readable file in C:\Dashboard\Games
// File format (games.txt), one game per line:
//   Spacegame;C:\Dashboard\Games\Spacegame\start.bat
//   JumpAndRun;C:\Dashboard\Games\JumpAndRun\start.bat
// Lines starting with # or empty lines are ignored.
const GAMES_CONFIG_FILE = process.platform === 'win32'
  ? 'C:\\Dashboard\\Games\\games.txt'
  : null;

/** @type {{ name: string; batchPath: string; }[]} */
let GAMES = [];

// Error Handling
process.on('uncaughtException', (error) => {
  console.error("Unexpected error: ", error);
});

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    fullscreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      enableRemoteModule: false,
    }
  });

  mainWindow = win;

  if (isDev) {
    win.loadURL('http://localhost:4200');
  } else {
    // Angular 20 with @angular/build:application outputs to dist/angular20/browser
    win.loadFile(path.join(__dirname, 'dist', 'angular20', 'browser', 'index.html'));
  }
  
  // Close game when window closes
  win.on('close', () => {
    // Close the game process if running
    if (gameProcess) {
      console.log('Window closing - closing game process');
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T']);
      } else {
        gameProcess.kill('SIGTERM');
      }
      gameProcess = null;
    }
    
    // Notify the other PC to close their game
    if (isClient && clientSocket && clientSocket.connected) {
      clientSocket.emit('closeGame');
    } else if (isServer && serverSocket) {
      serverSocket.sockets.emit('closeGame');
    }
  });
  
  return win;
}

let serverSocket;
let clientSocket;
let gameProcess = null;
let isServer = false;
let isClient = false;
let connectionStatus = 'disconnected'; // disconnected, server, client
let gameFiles = [];
let mainWindow = null;
let processMonitorInterval = null;

const SERVER_IP = '192.168.10.1';
const CLIENT_IP = '192.168.10.2';
const SOCKET_PORT = 4203;

function getLocalIPv4() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return null;
}

function getRoleByIP() {
  const ip = getLocalIPv4();
  if (ip === SERVER_IP) return 'server';
  if (ip === CLIENT_IP) return 'client';
  return 'unknown';
}

function notifyGameSelected(gameIndex) {
  if (!mainWindow || !Array.isArray(GAMES)) {
    return;
  }
  if (!Number.isInteger(gameIndex) || gameIndex < 0 || gameIndex >= GAMES.length) {
    return;
  }
  const game = GAMES[gameIndex];
  try {
    mainWindow.webContents.send('gameSelected', {
      index: gameIndex,
      name: game?.name || '',
      batchPath: game?.batchPath || ''
    });
  } catch (e) {
    console.error('Failed to send gameSelected to renderer:', e);
  }
}

function notifyGameError(message) {
  if (!mainWindow) {
    return;
  }
  try {
    mainWindow.webContents.send('gameError', {
      message: message || 'Failed to start game.'
    });
  } catch (e) {
    console.error('Failed to send gameError to renderer:', e);
  }
}

// Helper function to close game and notify other PC
function closeGameAndNotify() {
  if (gameProcess) {
    console.log('Closing game process due to window close');
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T']);
    } else {
      gameProcess.kill('SIGTERM');
    }
    gameProcess = null;
  }
  
  // Notify the other PC
  if (isClient && clientSocket && clientSocket.connected) {
    clientSocket.emit('closeGame');
  } else if (isServer && serverSocket) {
    serverSocket.sockets.emit('closeGame');
  }
}

async function loadGamesConfig() {
  if (!GAMES_CONFIG_FILE) {
    console.warn('No games config file configured for this platform.');
    return;
  }
  try {
    const content = await fs.readFile(GAMES_CONFIG_FILE, 'utf-8');
    const lines = content.split(/\r?\n/);
    const parsed = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }
      const parts = line.split(';');
      if (parts.length < 2) {
        console.warn('Skipping invalid game line in config:', line);
        continue;
      }
      const name = parts[0].trim();
      const batchPath = parts.slice(1).join(';').trim();
      if (!name || !batchPath) {
        console.warn('Skipping invalid game entry (missing name or path):', line);
        continue;
      }
      parsed.push({ name, batchPath });
    }
    GAMES = parsed;
    console.log('Loaded games from config:', GAMES);
  } catch (e) {
    console.error('Failed to read games config file:', GAMES_CONFIG_FILE, e);
  }
}

// App Lifecycle
app.whenReady().then(async () => {
  await loadGamesConfig();
  createWindow();
  globalShortcut.register('Control+Shift+Q', () => {
    console.log('Ctrl+Shift+Q pressed - quitting');
    app.quit();
  });
});
app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  closeGameAndNotify();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.on('launchGame', async (event, gameIndex) => {
  // When called without a gameIndex, behave like \"random\" mode.
  // When a specific index is provided, both PCs launch the same game.
  if (isClient && clientSocket && clientSocket.connected) {
    console.log('Client: sending launch command request to server with index:', gameIndex);
    clientSocket.emit('launchGame', gameIndex);
  } else if (isServer && serverSocket) {
    const clientCount = serverSocket.sockets?.sockets?.size ?? 0;
    if (clientCount === 0) {
      notifyGameError('Kein Client verbunden. Zuerst den Launcher auf dem anderen PC (192.168.10.2) starten.');
      return;
    }
    if (!GAMES.length) {
      console.error('No games configured in GAMES array');
      return;
    }
    let indexToLaunch = gameIndex;
    if (!Number.isInteger(indexToLaunch)) {
      indexToLaunch = getRandomInt(0, GAMES.length);
    }
    if (indexToLaunch < 0 || indexToLaunch >= GAMES.length) {
      console.error('Invalid game index for launchGame:', indexToLaunch);
      return;
    }
    console.log(
      'Server: launching game as server with index',
      indexToLaunch,
      'name:',
      GAMES[indexToLaunch]?.name
    );
    notifyGameSelected(indexToLaunch);
    launchGame(indexToLaunch);
    // Broadcast to all clients so they launch the same game index
    serverSocket.sockets.emit('launchGame', indexToLaunch);
  } else {
    console.log('Not connected - attempting auto-connect and launch (handled in renderer)');
  }
});

ipcMain.on('closeGame', () => {
  if (gameProcess) {
    console.log('Closing game process');
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T']);
    } else {
      gameProcess.kill('SIGTERM');
    }
    gameProcess = null;
  }
  
  // Notify the other PC
  if (isClient && clientSocket && clientSocket.connected) {
    clientSocket.emit('closeGame');
  } else if (isServer && serverSocket) {
    serverSocket.sockets.emit('closeGame');
  }
});
ipcMain.handle('createWsServer', async (event, port) => {
  try {
    const portNum = parseInt(String(port), 10) || SOCKET_PORT;
    serverSocket = new Server(portNum, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });
    isServer = true;
    isClient = false;
    connectionStatus = 'server';
    
    serverSocket.on('connection', (cs) => {
      console.log('New client connected');

      cs.on('launchGame', (gameIndex) => {
        if (!GAMES.length) {
          console.error('No games configured in GAMES array');
          return;
        }
        let indexToLaunch = gameIndex;
        if (!Number.isInteger(indexToLaunch)) {
          indexToLaunch = getRandomInt(0, GAMES.length);
        }
        if (indexToLaunch < 0 || indexToLaunch >= GAMES.length) {
          console.error('Invalid game index requested by client:', indexToLaunch);
          return;
        }
        console.log(
          'Server: Launching game on server (batch file) with index',
          indexToLaunch,
          'name:',
          GAMES[indexToLaunch]?.name
        );
        notifyGameSelected(indexToLaunch);
        launchGame(indexToLaunch);
        // Broadcast to all clients
        serverSocket.sockets.emit('launchGame', indexToLaunch);
      });
      
      cs.on('closeGame', () => {
        console.log('Server: Client requested game close - closing server game and notifying all clients');
        if (gameProcess) {
          try {
            console.log('Server: Attempting to close game process with PID:', gameProcess.pid);
            if (process.platform === 'win32') {
              // On Windows, try kill first, then use taskkill as fallback
              try {
                gameProcess.kill('SIGTERM');
                // Give it a moment, then force kill if still running
                setTimeout(() => {
                  if (gameProcess) {
                    console.log('Server: Force killing game process with taskkill');
                    spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T'], { stdio: 'ignore' });
                  }
                }, 500);
              } catch (e) {
                console.log('Server: Using taskkill to close game');
                spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T'], { stdio: 'ignore' });
              }
            } else {
              gameProcess.kill('SIGTERM');
              setTimeout(() => {
                if (gameProcess) {
                  gameProcess.kill('SIGKILL');
                }
              }, 1000);
            }
          } catch (e) {
            console.error('Error closing game:', e);
          }
          gameProcess = null;
          // Clear monitoring interval
          if (processMonitorInterval) {
            clearInterval(processMonitorInterval);
            processMonitorInterval = null;
          }
          console.log('Server: Game process closed');
        }
        // Broadcast to all clients (including the one that sent it, but that's okay)
        serverSocket.sockets.emit('closeGame');
      });
      
      cs.on('disconnect', () => {
        console.log('Client disconnected');
      });
    });
    console.log('created server on port', port);
    return { success: true, port };
  } catch (error) {
    console.error('Error creating server:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('connectWithUrl', async (event, url) => {
  try {
    console.log('Connecting to', url);
    const urlWithProtocol = url.startsWith('http') ? url : `http://${url}`;
    clientSocket = io(urlWithProtocol, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5
    });
    
    isClient = true;
    isServer = false;
    connectionStatus = 'client';
    
    clientSocket.on('connect', () => {
      console.log('Connected to server');
    });
    
    clientSocket.on('launchGame', (gameIndex) => {
      console.log('Client: received launchGame command - launching client batch with index', gameIndex);
      notifyGameSelected(gameIndex);
      launchGame(gameIndex);
    });
    
    clientSocket.on('closeGame', () => {
      console.log('Client: received closeGame command - closing game');
      if (gameProcess) {
        try {
          console.log('Client: Attempting to close game process with PID:', gameProcess.pid);
          // Try to kill the process directly first
          if (process.platform === 'win32') {
            // On Windows, try kill first, then use taskkill as fallback
            try {
              gameProcess.kill('SIGTERM');
              // Give it a moment, then force kill if still running
              setTimeout(() => {
                if (gameProcess) {
                  console.log('Client: Force killing game process with taskkill');
                  spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T'], { stdio: 'ignore' });
                }
              }, 500);
            } catch (e) {
              console.log('Client: Using taskkill to close game');
              spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T'], { stdio: 'ignore' });
            }
          } else {
            gameProcess.kill('SIGTERM');
            setTimeout(() => {
              if (gameProcess) {
                gameProcess.kill('SIGKILL');
              }
            }, 1000);
          }
        } catch (e) {
          console.error('Error closing game:', e);
        }
        gameProcess = null;
        // Clear monitoring interval
        if (processMonitorInterval) {
          clearInterval(processMonitorInterval);
          processMonitorInterval = null;
        }
        console.log('Client: Game process closed');
      } else {
        console.log('Client: No game process to close');
      }
    });
    
    clientSocket.on('disconnect', () => {
      console.log('Disconnected from server');
      connectionStatus = 'disconnected';
    });
    
    clientSocket.on('connect_error', (error) => {
      console.error('Connection error:', error);
    });
    
    return {success: true, url };
  } catch (error) {
    console.error('Error connecting:', error);
    return {success: false, error: error.message };
  }
});

ipcMain.handle('stopWsServer', async (event, port) => {
  if (serverSocket){
    serverSocket.close();
    serverSocket = null;
    isServer = false;
    connectionStatus = 'disconnected';
    console.log('stopping server');
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('disconnect', async (event) => {
  if(clientSocket){
    console.log('disconnecting from server');
    clientSocket.close();
    clientSocket = null;
    isClient = false;
    connectionStatus = 'disconnected';
  }
  return { success: true };
});

ipcMain.handle('getConnectionStatus', async () => {
  return { status: connectionStatus, isServer, isClient };
});

ipcMain.on('quitApp', () => {
  app.quit();
});

ipcMain.handle('getLocalNetworkInfo', async () => {
  const ip = getLocalIPv4();
  const role = getRoleByIP();
  return { ip: ip || 'unknown', role };
});

ipcMain.handle('autoConnect', async (event, targetUrl, port) => {
  const portNum = parseInt(String(port), 10) || SOCKET_PORT;
  const roleByIP = getRoleByIP();
  const serverUrl = `http://${SERVER_IP}:${portNum}`;

  const setupClientListeners = () => {
    clientSocket.on('connect', () => console.log('Connected to server'));
    clientSocket.on('launchGame', (gameIndex) => {
      console.log('Client: received launchGame with index', gameIndex);
      notifyGameSelected(gameIndex);
      launchGame(gameIndex);
    });
    clientSocket.on('closeGame', () => {
      if (gameProcess) {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T']);
        } else {
          gameProcess.kill('SIGTERM');
        }
        gameProcess = null;
      }
    });
    clientSocket.on('disconnect', () => { connectionStatus = 'disconnected'; });
    clientSocket.on('connect_error', (err) => console.error('Connection error:', err));
  };

  const setupServerListeners = () => {
    serverSocket.on('connection', (cs) => {
      console.log('New client connected');
      cs.on('launchGame', (gameIndex) => {
        if (!GAMES.length) return;
        let idx = Number.isInteger(gameIndex) ? gameIndex : getRandomInt(0, GAMES.length);
        if (idx < 0 || idx >= GAMES.length) return;
        notifyGameSelected(idx);
        launchGame(idx);
        serverSocket.sockets.emit('launchGame', idx);
      });
      cs.on('closeGame', () => {
        if (gameProcess) {
          try {
            if (process.platform === 'win32') {
              spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T'], { stdio: 'ignore' });
            } else {
              gameProcess.kill('SIGTERM');
            }
          } catch (e) {}
          gameProcess = null;
          if (processMonitorInterval) {
            clearInterval(processMonitorInterval);
            processMonitorInterval = null;
          }
        }
        serverSocket.sockets.emit('closeGame');
      });
      cs.on('disconnect', () => console.log('Client disconnected'));
    });
  };

  if (roleByIP === 'server') {
    try {
      serverSocket = new Server(portNum, { cors: { origin: '*', methods: ['GET', 'POST'] } });
      isServer = true;
      isClient = false;
      connectionStatus = 'server';
      setupServerListeners();
      console.log('Server created on port', portNum, '(this PC is 192.168.10.1)');
      return { success: true, role: 'server', port: portNum };
    } catch (e) {
      console.error('Error creating server:', e);
      return { success: false, error: e.message };
    }
  }

  if (roleByIP === 'client') {
    return new Promise((resolve) => {
      clientSocket = io(serverUrl, {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 5,
        timeout: 5000
      });
      isClient = true;
      isServer = false;
      connectionStatus = 'client';
      setupClientListeners();

      const onConnect = () => {
        clientSocket.off('connect', onConnect);
        clientSocket.off('connect_error', onError);
        resolve({ success: true, role: 'client', url: serverUrl });
      };
      const onError = (err) => {
        clientSocket.off('connect', onConnect);
        clientSocket.off('connect_error', onError);
        clientSocket.close();
        clientSocket = null;
        isClient = false;
        connectionStatus = 'disconnected';
        resolve({ success: false, error: err?.message || 'Could not reach server (192.168.10.1). Check network and firewall.' });
      };

      clientSocket.once('connect', onConnect);
      clientSocket.once('connect_error', onError);

      setTimeout(() => {
        if (clientSocket && !clientSocket.connected) {
          clientSocket.off('connect', onConnect);
          clientSocket.off('connect_error', onError);
          clientSocket.close();
          clientSocket = null;
          isClient = false;
          connectionStatus = 'disconnected';
          resolve({ success: false, error: 'Connection timeout. Is the server PC (192.168.10.1) running?' });
        }
      }, 6000);
    });
  }

  const urlWithProtocol = targetUrl.startsWith('http') ? targetUrl : `http://${targetUrl}`;
  const testSocket = io(urlWithProtocol, { timeout: 2000, reconnection: false });
  return new Promise((resolve) => {
    let resolved = false;
    const connectAsClient = () => {
      clientSocket = io(urlWithProtocol, { reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: 5 });
      isClient = true;
      isServer = false;
      connectionStatus = 'client';
      setupClientListeners();
      resolve({ success: true, role: 'client', url: targetUrl });
    };
    const createAsServer = () => {
      try {
        serverSocket = new Server(portNum, { cors: { origin: '*', methods: ['GET', 'POST'] } });
        isServer = true;
        isClient = false;
        connectionStatus = 'server';
        setupServerListeners();
        resolve({ success: true, role: 'server', port: portNum });
      } catch (e) {
        resolve({ success: false, error: e.message });
      }
    };
    testSocket.on('connect', () => {
      if (resolved) return;
      resolved = true;
      testSocket.close();
      connectAsClient();
    });
    testSocket.on('connect_error', () => {
      if (resolved) return;
      resolved = true;
      testSocket.close();
      createAsServer();
    });
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      testSocket.close();
      createAsServer();
    }, 2500);
  });
});

ipcMain.handle('getGames', async () => {
  return GAMES;
});

async function launchGame(gameIndex){
  // Close existing game if running
  if (gameProcess) {
    console.log('Closing existing game before launching new one');
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', gameProcess.pid, '/F', '/T']);
    } else {
      gameProcess.kill('SIGTERM');
    }
    gameProcess = null;
  }

  // Decide which batch/script to run based on current role and game index
  let command;
  let args = [];

  if (process.platform === 'win32') {
    if (!Number.isInteger(gameIndex) || gameIndex < 0 || gameIndex >= GAMES.length) {
      console.error('Invalid game index for launchGame:', gameIndex);
      notifyGameError('Invalid game configuration. Please check games.txt (index out of range).');
      return;
    }
    const game = GAMES[gameIndex];
    if (!game) {
      console.error('No game configuration found for index:', gameIndex);
      notifyGameError('No game found for the selected entry. Please check games.txt.');
      return;
    }

    if (!game.batchPath) {
      console.error('Batch path is not configured for game index', gameIndex);
      notifyGameError('No start script configured for this game. Please check games.txt.');
      return;
    }

    // Both PCs run the same start.bat for the selected game.
    // One PC's start.bat should start the server version, the other PC's start.bat the client version.
    console.log('Launching batch for game:', game.name, 'path:', game.batchPath, 'role:', isServer ? 'server' : (isClient ? 'client' : 'unknown'));
    command = 'cmd.exe';
    args = ['/c', game.batchPath];

    if (!isServer && !isClient) {
      console.error('Cannot launch game: instance is neither server nor client');
      return;
    }
  } else {
    console.error('Batch-file based launch is currently only implemented for Windows');
    return;
  }

  gameProcess = spawn(command, args, {
    detached: false
  });
  console.log('Launched game process with PID:', gameProcess.pid);
  
  gameProcess.on('error', (error) => {
    console.error("Error running executable:", error);
    notifyGameError(error?.message || 'Could not start the game process. Please check the start.bat path.');
    gameProcess = null;
  });
  
  gameProcess.on('exit', (code, signal) => {
    console.log(`Game process exited with code ${code} and signal ${signal}`);
    const wasGameProcess = gameProcess;
    gameProcess = null;
    
    // Clear monitoring interval
    if (processMonitorInterval) {
      clearInterval(processMonitorInterval);
      processMonitorInterval = null;
    }
    
    // Notify the other PC that game closed
    if (isClient && clientSocket && clientSocket.connected) {
      console.log('Client: Game closed - notifying server');
      clientSocket.emit('closeGame');
    } else if (isServer && serverSocket) {
      console.log('Server: Game closed - notifying all clients');
      serverSocket.sockets.emit('closeGame');
    }
  });
  
  // Monitor process on Windows - check if game process still exists
  if (process.platform === 'win32') {
    // Clear any existing monitor
    if (processMonitorInterval) {
      clearInterval(processMonitorInterval);
    }
    
    processMonitorInterval = setInterval(() => {
      if (gameProcess) {
        try {
          // Try to check if process exists - on Windows, this throws if process doesn't exist
          process.kill(gameProcess.pid, 0);
        } catch (e) {
          // Process doesn't exist - game was closed externally
          console.log('Game process no longer exists (detected by monitor) - notifying other PC');
          const wasGameProcess = gameProcess;
          gameProcess = null;
          if (processMonitorInterval) {
            clearInterval(processMonitorInterval);
            processMonitorInterval = null;
          }
          
          // Notify the other PC to close their game
          if (isClient && clientSocket && clientSocket.connected) {
            console.log('Client: Game closed externally - notifying server');
            clientSocket.emit('closeGame');
          } else if (isServer && serverSocket) {
            console.log('Server: Game closed externally - notifying all clients');
            serverSocket.sockets.emit('closeGame');
          }
        }
      } else {
        if (processMonitorInterval) {
          clearInterval(processMonitorInterval);
          processMonitorInterval = null;
        }
      }
    }, 300); // Check every 300ms for faster detection
  }
}


function getRandomInt(min, max) {
  const minCeiled = Math.ceil(min);
  const maxFloored = Math.floor(max);
  return Math.floor(Math.random() * (maxFloored - minCeiled) + minCeiled); // The maximum is exclusive and the minimum is inclusive
}
async function getFilesOfGameDirectory(){
  // Game directory path
  let directory;
  if (process.platform === 'win32') {
    directory = 'C:\\Temp\\games';
  } else {
    directory = path.join(os.homedir(), '.local');
  }
  
  const files = [];
  try {
    const directoryFiles = await fs.readdir(directory);
    for (const file of directoryFiles) {
      const fullPath = path.join(directory, file);
      try {
        const stats = await fs.stat(fullPath);
        if (stats.isFile() && fullPath.endsWith(".exe")) {
          console.log('adding File', fullPath);
          files.push(fullPath);
        }
      } catch (e) {
        // Skip files that can't be accessed
      }
    }
  } catch (e) {
    console.error('Error reading directory:', e);
  }
  
  gameFiles = files;
  return files;
}
