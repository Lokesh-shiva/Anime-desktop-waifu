const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Memory persistence
    loadMemory: () => ipcRenderer.invoke('load-memory'),
    saveMemory: (data) => ipcRenderer.invoke('save-memory', data),

    // Avatar control
    sendToAvatar: (channel, data) => ipcRenderer.send('avatar-signal', { channel, data }),
    toggleAvatar: (enabled) => ipcRenderer.invoke('toggle-avatar', enabled),

    // TTS control
    ttsSynthesize: (text, options) => ipcRenderer.invoke('tts-synthesize', text, options),
    ttsHealth: () => ipcRenderer.invoke('tts-health'),

    // Model Management
    getAvailableModels: () => ipcRenderer.invoke('get-available-models'),
    changeAvatarModel: (path) => ipcRenderer.invoke('change-avatar-model', path),
    getAvatarModelPath: () => ipcRenderer.invoke('get-avatar-model-path'),
    onAvatarCapabilities: (callback) => ipcRenderer.on('avatar-capabilities', (_, caps) => callback(caps)),

    // Global hotkey wake event
    onWakeActivate: (callback) => ipcRenderer.on('wake:activate', () => callback()),

    // Screen capture (desktopCapturer runs in main process)
    captureScreen: () => ipcRenderer.invoke('capture-screen'),

    // Quit the app from renderer
    quitApp: () => ipcRenderer.send('quit-app'),

    // Avatar edge info — returns which side the window is closer to ('left' | 'right')
    getAvatarEdgeInfo: () => ipcRenderer.invoke('avatar-edge-info'),

    // Dev-mode flag — renderer uses this to gate debug UI
    isDev: () => ipcRenderer.invoke('is-dev'),

    // App version + auto-launch
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
    setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),

    // Discord chat bridge
    getDiscordConfig: () => ipcRenderer.invoke('get-discord-config'),
    saveDiscordConfig: (config) => ipcRenderer.invoke('save-discord-config', config),
    onDiscordBatchReady: (callback) => ipcRenderer.on('discord-batch-ready', (_, batch) => callback(batch)),
    sendDiscordResponse: (channelId, text) => ipcRenderer.invoke('discord-send-response', channelId, text),
    discordMarkFree: () => ipcRenderer.invoke('discord-mark-free'),
    playDiscordVoiceAudio: (base64Audio) => ipcRenderer.invoke('discord-play-voice-audio', base64Audio),
    getDiscordStatus: () => ipcRenderer.invoke('discord-get-status')
});
