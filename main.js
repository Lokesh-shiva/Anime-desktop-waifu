const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let avatarWindow = null;

// Default model path
const DEFAULT_MODEL_PATH = path.join(__dirname, '2D_Livemodel', 'tuzi mian.model3.json');

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 420,
        height: 320,
        resizable: false,
        frame: true,
        autoHideMenuBar: true,
        backgroundColor: '#1a1a2e',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

    // Open DevTools for debugging (remove in production)
    mainWindow.webContents.openDevTools({ mode: 'detach' });

    mainWindow.on('closed', () => {
        mainWindow = null;
        // Close avatar window when main window closes
        if (avatarWindow && !avatarWindow.isDestroyed()) {
            avatarWindow.close();
        }
    });
}

/**
 * Create the avatar overlay window
 */
function createAvatarWindow() {
    if (avatarWindow && !avatarWindow.isDestroyed()) {
        avatarWindow.show();
        return;
    }

    avatarWindow = new BrowserWindow({
        width: 400,
        height: 600,
        x: 50,
        y: 100,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: true,
        hasShadow: false,
        webPreferences: {
            preload: path.join(__dirname, 'avatar-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // Required for pixi.js
            webgl: true
        }
    });

    avatarWindow.loadFile(path.join(__dirname, 'src', 'avatar', 'avatar-window.html'));

    // Open DevTools for avatar window debugging
    avatarWindow.webContents.openDevTools({ mode: 'detach' });

    // Make window click-through (optional - user can toggle this)
    // avatarWindow.setIgnoreMouseEvents(true, { forward: true });

    avatarWindow.on('closed', () => {
        avatarWindow = null;
    });

    // Hide initially until model loads
    avatarWindow.once('ready-to-show', () => {
        avatarWindow.show();
    });
}

/**
 * Close the avatar window
 */
function closeAvatarWindow() {
    if (avatarWindow && !avatarWindow.isDestroyed()) {
        avatarWindow.close();
        avatarWindow = null;
    }
}

app.whenReady().then(() => {
    createWindow();
    startTTSServer();
});

/**
 * Forcefully kill the TTS server process
 */
function cleanupTTSServer() {
    if (ttsProcess) {
        console.log('[Main] Killing TTS server...');
        try {
            // On Windows, use taskkill for forceful termination
            if (process.platform === 'win32') {
                const { execSync } = require('child_process');
                try {
                    execSync(`taskkill /F /T /PID ${ttsProcess.pid}`, { stdio: 'ignore' });
                } catch (e) {
                    // Process might already be dead
                }
            } else {
                ttsProcess.kill('SIGKILL');
            }
        } catch (e) {
            console.error('[Main] Error killing TTS server:', e);
        }
        ttsProcess = null;
    }
}

app.on('window-all-closed', () => {
    cleanupTTSServer();
    app.quit();
});

app.on('before-quit', () => {
    cleanupTTSServer();
});

app.on('will-quit', () => {
    cleanupTTSServer();
});

// Handle Ctrl+C from terminal
process.on('SIGINT', () => {
    console.log('[Main] Received SIGINT. Cleaning up...');
    cleanupTTSServer();
    app.quit();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('[Main] Received SIGTERM. Cleaning up...');
    cleanupTTSServer();
    app.quit();
    process.exit(0);
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});

// ============================================
// Memory Persistence Handlers
// ============================================

const MEMORY_FILE = 'memory.json';
const userDataPath = app.getPath('userData');
const memoryPath = path.join(userDataPath, MEMORY_FILE);

ipcMain.handle('load-memory', async () => {
    try {
        if (fs.existsSync(memoryPath)) {
            const data = fs.readFileSync(memoryPath, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Failed to load memory:', error);
    }
    return null;
});

ipcMain.handle('save-memory', async (event, data) => {
    try {
        fs.writeFileSync(memoryPath, JSON.stringify(data, null, 2), 'utf-8');
        return true;
    } catch (error) {
        console.error('Failed to save memory:', error);
        return false;
    }
});

// ============================================
// Avatar Window Handlers
// ============================================

/**
 * Toggle avatar window on/off
 */
ipcMain.handle('toggle-avatar', async (event, enabled) => {
    console.log('[Main] Toggle avatar:', enabled);

    if (enabled) {
        createAvatarWindow();
    } else {
        closeAvatarWindow();
    }

    return enabled;
});

/**
 * Forward signals from main window to avatar window
 */
ipcMain.on('avatar-signal', (event, { channel, data }) => {
    if (avatarWindow && !avatarWindow.isDestroyed()) {
        avatarWindow.webContents.send(channel, data);
    }
});

/**
 * Get avatar model path
 */
ipcMain.handle('get-avatar-model-path', async () => {
    // Could be extended to read from settings file
    return DEFAULT_MODEL_PATH;
});

/**
 * Move avatar window
 */
ipcMain.on('avatar-move-window', (event, { x, y }) => {
    if (avatarWindow && !avatarWindow.isDestroyed()) {
        avatarWindow.setPosition(Math.round(x), Math.round(y));
    }
});

// ============================================
// TTS Server Handlers
// ============================================

let ttsProcess = null;
let ttsRetryCount = 0;
const TTS_PORT = 19765;
const TTS_MAX_RETRIES = 5;
const TTS_RETRY_DELAY_MS = 3000;

// Start TTS server on app ready with retry logic
function startTTSServer() {
    console.log('[Main] Starting TTS server...');
    const pythonCmd = 'python'; // Assume 'python' is in PATH and is 3.9+
    const scriptPath = path.join(__dirname, 'tts', 'tts_server.py');

    // Check if script exists
    if (!fs.existsSync(scriptPath)) {
        console.error('[Main] TTS server script not found at:', scriptPath);
        return;
    }

    ttsProcess = spawn(pythonCmd, [scriptPath, '--port', TTS_PORT.toString()], {
        stdio: ['ignore', 'pipe', 'pipe']
    });

    ttsProcess.stdout.on('data', (data) => {
        console.log('[TTS]', data.toString().trim());
    });

    ttsProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        // Uvicorn and logging module often output INFO to stderr
        if (msg.includes('INFO:') || msg.includes('WARNING:')) {
            console.log('[TTS]', msg);
        } else {
            console.error('[TTS Error]', msg);
        }
    });

    ttsProcess.on('close', (code) => {
        console.log(`[Main] TTS server exited with code ${code}`);
        ttsProcess = null;

        // Retry if exited with error and still have retries left
        if (code !== 0 && ttsRetryCount < TTS_MAX_RETRIES) {
            ttsRetryCount++;
            console.log(`[Main] Retrying TTS server in ${TTS_RETRY_DELAY_MS / 1000}s (attempt ${ttsRetryCount}/${TTS_MAX_RETRIES})...`);
            setTimeout(startTTSServer, TTS_RETRY_DELAY_MS);
        } else if (code !== 0) {
            console.error('[Main] TTS server failed to start after max retries');
        }
    });
}

/**
 * Request TTS synthesis
 */
ipcMain.handle('tts-synthesize', async (event, text, options) => {
    try {
        const response = await fetch(`http://127.0.0.1:${TTS_PORT}/synthesize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, ...options })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`TTS Server Error ${response.status}: ${errorText}`);
        }

        return await response.json();
    } catch (error) {
        console.error('[Main] TTS synthesis failed:', error);
        return { error: error.message };
    }
});

/**
 * Check TTS health
 */
ipcMain.handle('tts-health', async () => {
    try {
        const response = await fetch(`http://127.0.0.1:${TTS_PORT}/health`);
        return await response.json();
    } catch (error) {
        return { status: 'unavailable', error: error.message };
    }
});
