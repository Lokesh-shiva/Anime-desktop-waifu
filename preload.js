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
    onAvatarCapabilities: (callback) => ipcRenderer.on('avatar-capabilities', (_, caps) => callback(caps))
});
