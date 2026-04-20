const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, desktopCapturer, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let avatarWindow = null;
let tray = null;
let isQuitting = false;

// Dev mode: open devtools + expose debug UI. Auto-off in packaged builds.
// Override with `npm start -- --dev` or by setting WAIFU_DEV=1.
const isDev = !app.isPackaged
    || process.argv.includes('--dev')
    || process.env.WAIFU_DEV === '1';

// Default model path
const DEFAULT_MODEL_PATH = path.join(__dirname, '2D_Livemodel', 'tuzi_mian', 'tuzi mian.model3.json');

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 460,
        height: 700,
        minWidth: 380,
        minHeight: 500,
        resizable: true,
        frame: true,
        autoHideMenuBar: true,
        backgroundColor: '#080518',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

    // DevTools only in dev mode
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

    // Hide to tray instead of quitting when user clicks X
    mainWindow.on('close', (e) => {
        if (!isQuitting) {
            e.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        if (avatarWindow && !avatarWindow.isDestroyed()) {
            avatarWindow.close();
        }
    });
}

/**
 * Create the system tray icon and context menu
 */
function createTray() {
    // Try several candidate icon paths
    const iconCandidates = [
        path.join(__dirname, '2D_Livemodel', 'Elf', 'Elf', 'VT_Elf', 'icon.png'),
        path.join(__dirname, 'assets', 'tray-icon.png'),
    ];

    const iconPath = iconCandidates.find(p => fs.existsSync(p));
    let icon;
    if (iconPath) {
        icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    } else {
        // Minimal 1×1 transparent fallback so Tray() doesn't throw
        icon = nativeImage.createEmpty();
    }

    tray = new Tray(icon);
    tray.setToolTip('Waifu Assistant — Miko');

    // Build initial menu (avatar not yet created, so OFF)
    rebuildTrayMenu();

    // Left-click: toggle main window visibility
    tray.on('click', () => {
        if (mainWindow?.isVisible()) {
            mainWindow.hide();
        } else {
            mainWindow?.show();
            mainWindow?.focus();
        }
    });

    // Double-click: always show main window
    tray.on('double-click', () => {
        mainWindow?.show();
        mainWindow?.focus();
    });
}

/**
 * Actually quit — bypasses the hide-on-close override
 */
function forceQuit() {
    isQuitting = true;
    tray?.destroy();
    tray = null;
    app.quit();
}

// ── Avatar settings helpers ───────────────────────────────────────────────
// Thin wrappers around avatar-settings.json so every caller shares one path.
function _avatarSettingsPath() {
    return path.join(app.getPath('userData'), 'avatar-settings.json');
}
function loadAvatarSettings() {
    try {
        const p = _avatarSettingsPath();
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) { /* ignore */ }
    return {};
}
function saveAvatarSettings(updates) {
    try {
        const p = _avatarSettingsPath();
        const current = loadAvatarSettings();
        fs.writeFileSync(p, JSON.stringify({ ...current, ...updates }, null, 2));
    } catch (e) { console.error('[Main] Failed to save avatar settings:', e); }
}

/**
 * Rebuild the tray context menu so the Avatar toggle label stays in sync.
 * Called on creation and whenever the avatar window is shown/hidden/closed.
 */
function rebuildTrayMenu() {
    if (!tray) return;
    const avatarOn = avatarWindow && !avatarWindow.isDestroyed() && avatarWindow.isVisible();
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Show Miko',
            click: () => { mainWindow?.show(); mainWindow?.focus(); }
        },
        { type: 'separator' },
        {
            label: `Avatar: ${avatarOn ? 'ON  ✓' : 'OFF'}`,
            click: () => {
                if (avatarWindow && !avatarWindow.isDestroyed()) {
                    if (avatarWindow.isVisible()) {
                        avatarWindow.hide();
                    } else {
                        avatarWindow.show();
                    }
                } else {
                    createAvatarWindow();
                }
                // Rebuild after a tick so isVisible() reflects the new state
                setTimeout(rebuildTrayMenu, 80);
            }
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: forceQuit
        }
    ]);
    tray.setContextMenu(contextMenu);
}

/**
 * Create the avatar overlay window
 */
function createAvatarWindow() {
    if (avatarWindow && !avatarWindow.isDestroyed()) {
        avatarWindow.show();
        rebuildTrayMenu();
        return;
    }

    // Restore last saved window bounds, fall back to sensible defaults
    const saved = loadAvatarSettings();
    const winX      = typeof saved.windowX      === 'number' ? saved.windowX      : 50;
    const winY      = typeof saved.windowY      === 'number' ? saved.windowY      : 100;
    const winWidth  = typeof saved.windowWidth  === 'number' ? saved.windowWidth  : 400;
    const winHeight = typeof saved.windowHeight === 'number' ? saved.windowHeight : 600;

    avatarWindow = new BrowserWindow({
        width:  winWidth,
        height: winHeight,
        x: winX,
        y: winY,
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

    // DevTools only in dev mode
    if (isDev) avatarWindow.webContents.openDevTools({ mode: 'detach' });

    // Persist window position and size whenever the user moves or resizes
    const _saveBounds = () => {
        if (!avatarWindow || avatarWindow.isDestroyed()) return;
        const [x, y]         = avatarWindow.getPosition();
        const [width, height] = avatarWindow.getSize();
        saveAvatarSettings({ windowX: x, windowY: y, windowWidth: width, windowHeight: height });
    };
    avatarWindow.on('moved',   _saveBounds);
    avatarWindow.on('resized', _saveBounds);

    avatarWindow.on('show',   () => rebuildTrayMenu());
    avatarWindow.on('hide',   () => rebuildTrayMenu());
    avatarWindow.on('closed', () => { avatarWindow = null; rebuildTrayMenu(); });

    // Hide initially until model loads
    avatarWindow.once('ready-to-show', () => {
        avatarWindow.show();
        rebuildTrayMenu();
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
    createTray();
    startTTSServer();

    // Global hotkey — Ctrl+Alt+A — activate PTT from anywhere
    const hotkeyRegistered = globalShortcut.register('Control+Alt+A', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            // Also pop window into view when hotkey triggers
            if (!mainWindow.isVisible()) {
                mainWindow.show();
                mainWindow.focus();
            }
            mainWindow.webContents.send('wake:activate');
        }
    });

    if (!hotkeyRegistered) {
        console.warn('[Main] Failed to register global hotkey Control+Alt+A — may be in use by another app');
    } else {
        console.log('[Main] Global hotkey Control+Alt+A registered');
    }
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
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
    // App lives in the system tray — don't quit when all windows close.
    // Quit only via tray menu or ipcMain 'quit-app'.
    // (On macOS this event fires when the last window closes but dock icon keeps app alive anyway.)
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
    // macOS: re-show window when dock icon clicked
    if (mainWindow === null) {
        createWindow();
    } else {
        mainWindow.show();
        mainWindow.focus();
    }
});

// Renderer requests a real quit (from the × button inside settings)
ipcMain.on('quit-app', () => forceQuit());

// Dev mode flag — lets the renderer hide debug UI in production builds
ipcMain.handle('is-dev', () => isDev);

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
 * Handle capabilities report from avatar
 */
ipcMain.on('avatar-capabilities', (event, caps) => {
    // Forward to main window
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('avatar-capabilities', caps);
    }
});

/**
 * Get avatar model path from settings
 */
ipcMain.handle('get-avatar-model-path', async () => {
    try {
        const settingsPath = path.join(userDataPath, 'avatar-settings.json');
        if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
            if (settings.currentModelPath && fs.existsSync(settings.currentModelPath)) {
                return settings.currentModelPath;
            }
        }
    } catch (e) {
        console.error('[Main] Failed to load avatar settings:', e);
    }
    return DEFAULT_MODEL_PATH;
});

/**
 * Discover loose expression files (.exp3.json) in the model's directory
 * since some VTube models don't declare them in the model3.json FileReferences.
 */
ipcMain.handle('get-model-expressions', async (event, modelPathStr) => {
    try {
        let dirPath = modelPathStr;
        if (modelPathStr.startsWith('file://')) {
            const url = require('url');
            dirPath = url.fileURLToPath(modelPathStr);
        }

        // If the path points to the json file, get its directory
        if (fs.statSync(dirPath).isFile()) {
            dirPath = path.dirname(dirPath);
        }

        const files = fs.readdirSync(dirPath);
        const exps = files.filter(f => f.endsWith('.exp3.json'));

        // Also check an "Expression" or "expressions" subfolder
        const subfolders = ['Expression', 'expressions', 'Expressions'];
        for (const sub of subfolders) {
            const subPath = path.join(dirPath, sub);
            if (fs.existsSync(subPath) && fs.statSync(subPath).isDirectory()) {
                const subFiles = fs.readdirSync(subPath);
                subFiles.filter(f => f.endsWith('.exp3.json')).forEach(f => {
                    exps.push(path.join(sub, f).replace(/\\\\/g, '/'));
                });
            }
        }

        return exps;
    } catch (e) {
        console.warn(`[Main] Failed to discover expressions for ${modelPathStr}:`, e.message);
        return [];
    }
});

/**
 * List available models recursively
 */
ipcMain.handle('get-available-models', async () => {
    const modelsDir = path.join(__dirname, '2D_Livemodel');
    const models = [];

    if (!fs.existsSync(modelsDir)) return models;

    function findModels(dir) {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            // Files in current dir
            const fileNames = entries.filter(e => e.isFile()).map(e => e.name);
            const modelFile = fileNames.find(f => f.endsWith('.model3.json'));

            if (modelFile) {
                models.push({
                    name: path.basename(dir), // Use ultimate folder name
                    path: path.join(dir, modelFile),
                    preview: fileNames.find(f => f.match(/preview|icon|cover/i) && f.match(/\.png|\.jpg/i))
                        ? path.join(dir, fileNames.find(f => f.match(/preview|icon|cover/i) && f.match(/\.png|\.jpg/i)))
                        : null
                });
            }

            // Recurse into subdirectories
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    findModels(path.join(dir, entry.name));
                }
            }
        } catch (e) {
            console.error('[Main] Failed to scan dir:', dir, e);
        }
    }

    findModels(modelsDir);
    return models;
});

/**
 * Change avatar model
 */
ipcMain.handle('change-avatar-model', async (event, modelPath) => {
    console.log('[Main] Switching model to:', modelPath);

    // Validate path
    if (!fs.existsSync(modelPath)) {
        return { success: false, error: 'Model file not found' };
    }

    // Save preference
    try {
        const settingsPath = path.join(userDataPath, 'avatar-settings.json');
        const settings = fs.existsSync(settingsPath)
            ? JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
            : {};

        settings.currentModelPath = modelPath;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    } catch (e) {
        console.error('[Main] Failed to save avatar preference:', e);
    }

    // Notify avatar window to reload
    if (avatarWindow && !avatarWindow.isDestroyed()) {
        avatarWindow.webContents.send('avatar-load-model', modelPath);
        return { success: true };
    }

    return { success: false, error: 'Avatar window not active' };
});

/**
 * Move avatar window
 */
ipcMain.on('avatar-move-window', (event, { x, y }) => {
    if (avatarWindow && !avatarWindow.isDestroyed()) {
        avatarWindow.setPosition(Math.round(x), Math.round(y));
    }
});

/**
 * Returns which side the avatar window is closer to on its current display.
 * Used by the renderer to decide which way to bend during a peek (away from the edge).
 * @returns {{ peekDirection: 'left' | 'right' }}
 */
ipcMain.handle('avatar-edge-info', async () => {
    if (!avatarWindow || avatarWindow.isDestroyed()) return { peekDirection: 'left' };
    const [x, y]   = avatarWindow.getPosition();
    const [w, h]   = avatarWindow.getSize();
    const display  = screen.getDisplayMatching({ x, y, width: w, height: h });
    const wa       = display.workArea;
    const center   = x + w / 2;
    const distLeft  = center - wa.x;
    const distRight = (wa.x + wa.width) - center;
    // Bend AWAY from the closer edge so the peek motion goes toward open space
    return { peekDirection: distLeft < distRight ? 'right' : 'left' };
});

/**
 * Persist model zoom scale (called by renderer after wheel zoom settles)
 */
ipcMain.handle('save-avatar-transform', async (event, data) => {
    if (data && typeof data.scale === 'number') {
        saveAvatarSettings({ modelScale: data.scale });
    }
    return true;
});

/**
 * Load saved model zoom scale for the renderer on startup
 */
ipcMain.handle('load-avatar-transform', async () => {
    const settings = loadAvatarSettings();
    return { scale: typeof settings.modelScale === 'number' ? settings.modelScale : 1.0 };
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

/**
 * Screen capture — returns base64 JPEG of the primary screen at 720p.
 * desktopCapturer must run in the main process (renderer sandbox blocks it).
 */
ipcMain.handle('capture-screen', async () => {
    try {
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 1280, height: 720 }
        });
        if (!sources.length) return null;
        return sources[0].thumbnail.toJPEG(55).toString('base64');
    } catch (e) {
        console.error('[Main] Screen capture failed:', e.message);
        return null;
    }
});
