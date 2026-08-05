const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, desktopCapturer, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── GPU optimisation — must be called BEFORE app 'ready' ─────────────────────
// Forces Electron onto the discrete NVIDIA GPU instead of Intel integrated.
// Critical for smooth Live2D rendering on dual-GPU laptops (Optimus/MUX).
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-oop-rasterization');
// Force high-performance GPU on NVIDIA Optimus systems
app.commandLine.appendSwitch('force_high_performance_gpu');
// Disable frame rate throttling when window is in background / occluded
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('disable-gpu-vsync');

let mainWindow = null;
let avatarWindow = null;
let tray = null;
let isQuitting = false;

// Dev mode: open devtools + expose debug UI. Auto-off in packaged builds.
// Override with `npm start -- --dev` or by setting WAIFU_DEV=1.
const isDev = !app.isPackaged
    || process.argv.includes('--dev')
    || process.env.WAIFU_DEV === '1';

// In packaged builds, large assets (models, tts) live in process.resourcesPath
// (placed there via electron-builder extraResources). In dev, they're next to main.js.
const resourcesBase = app.isPackaged ? process.resourcesPath : __dirname;

// Default model path
const DEFAULT_MODEL_PATH = path.join(resourcesBase, '2D_Livemodel', 'tuzi_mian', 'tuzi mian.model3.json');

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

    // Start Discord bridge if configured, and forward batches to the renderer
    const discordConfig = loadDiscordConfig();
    discordBridge.onBatchReady((batch) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('discord-batch-ready', batch);
        }
    });
    if (discordConfig.enabled && discordConfig.token) {
        discordBridge.start(discordConfig.token);
    }

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
        path.join(resourcesBase, '2D_Livemodel', 'Elf', 'Elf', 'VT_Elf', 'icon.png'),
        path.join(resourcesBase, 'assets', 'tray-icon.png'),
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
 * Clamp a window's top-left position so its full bounds stay within the
 * work area of whichever display it's closest to. Prevents the frameless,
 * skipTaskbar avatar window (and its in-window settings gear) from ending
 * up somewhere the cursor can never reach.
 */
function clampToVisibleArea(x, y, width, height) {
    const display = screen.getDisplayNearestPoint({ x: x + width / 2, y: y + height / 2 });
    const wa = display.workArea;
    const maxX = wa.x + Math.max(0, wa.width - width);
    const maxY = wa.y + Math.max(0, wa.height - height);
    return {
        x: Math.min(Math.max(x, wa.x), maxX),
        y: Math.min(Math.max(y, wa.y), maxY)
    };
}

/**
 * Snap the avatar window back inside the visible work area if it has
 * drifted off-screen (e.g. from a stale saved position after an unplug of
 * a second monitor, or a drag that went too far). Safe to call any time.
 */
function resetAvatarPositionIfOffscreen() {
    if (!avatarWindow || avatarWindow.isDestroyed()) return;
    const [x, y] = avatarWindow.getPosition();
    const [width, height] = avatarWindow.getSize();
    const clamped = clampToVisibleArea(x, y, width, height);
    if (clamped.x !== x || clamped.y !== y) {
        avatarWindow.setPosition(clamped.x, clamped.y);
        saveAvatarSettings({ windowX: clamped.x, windowY: clamped.y });
    }
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
        {
            label: 'Reset Avatar Position',
            click: () => {
                if (!avatarWindow || avatarWindow.isDestroyed()) {
                    createAvatarWindow();
                    return;
                }
                const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
                const wa = display.workArea;
                const [width, height] = avatarWindow.getSize();
                const x = wa.x + 50;
                const y = wa.y + 100;
                avatarWindow.setPosition(x, y);
                saveAvatarSettings({ windowX: x, windowY: y });
                avatarWindow.show();
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
    const winWidth  = typeof saved.windowWidth  === 'number' ? saved.windowWidth  : 400;
    const winHeight = typeof saved.windowHeight === 'number' ? saved.windowHeight : 600;
    const rawX = typeof saved.windowX === 'number' ? saved.windowX : 50;
    const rawY = typeof saved.windowY === 'number' ? saved.windowY : 100;
    // Clamp in case the saved position drifted off-screen (monitor unplugged,
    // dragged past the edge in a prior session) — keeps the settings gear reachable.
    const { x: winX, y: winY } = clampToVisibleArea(rawX, rawY, winWidth, winHeight);

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

    // After a drag finishes (native app-region drag fires 'moved' repeatedly
    // while dragging, then goes quiet), snap back on-screen if the window was
    // dragged past the edge — otherwise the gear icon becomes unreachable.
    let _moveEndTimer = null;
    avatarWindow.on('moved', () => {
        clearTimeout(_moveEndTimer);
        _moveEndTimer = setTimeout(resetAvatarPositionIfOffscreen, 250);
    });

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
    startSidecarServer();

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

/**
 * Forcefully kill the GPT-SoVITS sidecar process
 */
function cleanupSidecar() {
    if (sidecarProcess) {
        console.log('[Main] Killing GPT-SoVITS sidecar...');
        try {
            if (process.platform === 'win32') {
                const { execSync } = require('child_process');
                try {
                    execSync(`taskkill /F /T /PID ${sidecarProcess.pid}`, { stdio: 'ignore' });
                } catch (e) {
                    // Process might already be dead
                }
            } else {
                sidecarProcess.kill('SIGKILL');
            }
        } catch (e) {
            console.error('[Main] Error killing GPT-SoVITS sidecar:', e);
        }
        sidecarProcess = null;
    }
}

app.on('window-all-closed', () => {
    // App lives in the system tray — don't quit when all windows close.
    // Quit only via tray menu or ipcMain 'quit-app'.
    // (On macOS this event fires when the last window closes but dock icon keeps app alive anyway.)
});

app.on('before-quit', () => {
    cleanupTTSServer();
    cleanupSidecar();
});

app.on('will-quit', () => {
    cleanupTTSServer();
    cleanupSidecar();
});

// Handle Ctrl+C from terminal
process.on('SIGINT', () => {
    console.log('[Main] Received SIGINT. Cleaning up...');
    cleanupTTSServer();
    cleanupSidecar();
    app.quit();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('[Main] Received SIGTERM. Cleaning up...');
    cleanupTTSServer();
    cleanupSidecar();
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

// App version
ipcMain.handle('get-app-version', () => app.getVersion());

// Auto-launch (Windows login item)
ipcMain.handle('get-auto-launch', () => {
    return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('set-auto-launch', (_, enabled) => {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return enabled;
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
// Discord Chat Bridge
// ============================================

const discordBridge = require('./src/discord/discord-bridge.js');

const DISCORD_CONFIG_FILE = 'discord-config.json';
const discordConfigPath = path.join(userDataPath, DISCORD_CONFIG_FILE);

function loadDiscordConfig() {
    try {
        if (fs.existsSync(discordConfigPath)) {
            return JSON.parse(fs.readFileSync(discordConfigPath, 'utf-8'));
        }
    } catch (error) {
        console.error('[Main] Failed to load Discord config:', error);
    }
    return { token: '', enabled: false };
}

function saveDiscordConfigToDisk(config) {
    fs.writeFileSync(discordConfigPath, JSON.stringify(config, null, 2), 'utf-8');
}

ipcMain.handle('get-discord-config', async () => {
    const config = loadDiscordConfig();
    return { token: config.token || '', enabled: !!config.enabled };
});

ipcMain.handle('save-discord-config', async (event, config) => {
    try {
        saveDiscordConfigToDisk(config);
        discordBridge.stop();
        if (config.enabled && config.token) {
            discordBridge.start(config.token);
        }
        return true;
    } catch (error) {
        console.error('[Main] Failed to save Discord config:', error);
        return false;
    }
});

ipcMain.handle('discord-send-response', async (event, channelId, text) => {
    await discordBridge.sendResponse(channelId, text);
});

ipcMain.handle('discord-mark-free', async () => {
    discordBridge.markFree();
});

ipcMain.handle('discord-get-status', async () => {
    return discordBridge.getStatus();
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
    const modelsDir = path.join(resourcesBase, '2D_Livemodel');
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

let sidecarProcess = null;
let sidecarRetryCount = 0;
const SIDECAR_PORT = 9881;
const SIDECAR_MAX_RETRIES = 5;
const SIDECAR_RETRY_DELAY_MS = 3000;

// Kill any stale process on TTS_PORT (e.g. orphaned from a previous run)
function killPortStalker() {
    if (process.platform !== 'win32') return;
    try {
        const { spawnSync } = require('child_process');
        const netstat = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
        if (!netstat.stdout) return;
        for (const line of netstat.stdout.split('\n')) {
            if (line.includes(`:${TTS_PORT} `) && line.includes('LISTEN')) {
                const parts = line.trim().split(/\s+/);
                const pid = parseInt(parts[parts.length - 1], 10);
                if (pid > 4) {
                    spawnSync('taskkill', ['/F', '/PID', String(pid)]);
                    console.log(`[Main] Killed stale process on port ${TTS_PORT} (pid=${pid})`);
                }
                break;
            }
        }
    } catch (_) { /* No stale process — ignore */ }
}

// Kill any stale process on SIDECAR_PORT (same pattern as killPortStalker)
function killSidecarPortStalker() {
    if (process.platform !== 'win32') return;
    try {
        const { spawnSync } = require('child_process');
        const netstat = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
        if (!netstat.stdout) return;
        for (const line of netstat.stdout.split('\n')) {
            if (line.includes(`:${SIDECAR_PORT} `) && line.includes('LISTEN')) {
                const parts = line.trim().split(/\s+/);
                const pid = parseInt(parts[parts.length - 1], 10);
                if (pid > 4) {
                    spawnSync('taskkill', ['/F', '/PID', String(pid)]);
                    console.log(`[Main] Killed stale process on port ${SIDECAR_PORT} (pid=${pid})`);
                }
                break;
            }
        }
    } catch (_) { /* No stale process — ignore */ }
}

// Start TTS server on app ready with retry logic
function startTTSServer() {
    killPortStalker();
    console.log('[Main] Starting TTS server...');
    const ttsDir    = path.join(resourcesBase, 'tts');
    const scriptPath = path.join(ttsDir, 'tts_server.py');

    // Prefer venv python (keeps deps isolated), fall back to system python
    const venvPython = process.platform === 'win32'
        ? path.join(ttsDir, '.venv', 'Scripts', 'python.exe')
        : path.join(ttsDir, '.venv', 'bin', 'python');
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : 'python';
    console.log('[Main] Using Python:', pythonCmd);

    // Check if script exists
    if (!fs.existsSync(scriptPath)) {
        console.error('[Main] TTS server script not found at:', scriptPath);
        return;
    }

    ttsProcess = spawn(pythonCmd, [scriptPath, '--port', TTS_PORT.toString()], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Force UTF-8 on Windows — default cp1252 crashes when Python tries to
        // log Japanese characters (UnicodeEncodeError in loguru → server exit 1)
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
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

// Start GPT-SoVITS sidecar on app ready with retry logic
function startSidecarServer() {
    killSidecarPortStalker();
    console.log('[Main] Starting GPT-SoVITS sidecar...');
    const sidecarDir    = path.join(resourcesBase, 'tts', 'gpt-sovits');
    const scriptPath    = path.join(sidecarDir, 'run_sidecar.py');

    if (!fs.existsSync(scriptPath)) {
        console.log('[Main] GPT-SoVITS sidecar not installed — skipping (MioTTS/SAPI5 remain available)');
        return;
    }

    const venvPython = process.platform === 'win32'
        ? path.join(sidecarDir, '.venv', 'Scripts', 'python.exe')
        : path.join(sidecarDir, '.venv', 'bin', 'python');
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : 'python';
    console.log('[Main] Using Python for sidecar:', pythonCmd);

    sidecarProcess = spawn(pythonCmd, [scriptPath, '-a', '127.0.0.1', '-p', SIDECAR_PORT.toString()], {
        cwd: sidecarDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });

    sidecarProcess.stdout.on('data', (data) => {
        console.log('[Sidecar]', data.toString().trim());
    });

    sidecarProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg.includes('INFO:') || msg.includes('WARNING:')) {
            console.log('[Sidecar]', msg);
        } else {
            console.error('[Sidecar Error]', msg);
        }
    });

    sidecarProcess.on('close', (code) => {
        console.log(`[Main] GPT-SoVITS sidecar exited with code ${code}`);
        sidecarProcess = null;

        if (code !== 0 && sidecarRetryCount < SIDECAR_MAX_RETRIES) {
            sidecarRetryCount++;
            console.log(`[Main] Retrying GPT-SoVITS sidecar in ${SIDECAR_RETRY_DELAY_MS / 1000}s (attempt ${sidecarRetryCount}/${SIDECAR_MAX_RETRIES})...`);
            setTimeout(startSidecarServer, SIDECAR_RETRY_DELAY_MS);
        } else if (code !== 0) {
            console.error('[Main] GPT-SoVITS sidecar failed to start after max retries — MioTTS/SAPI5 remain available');
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
