const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('avatarAPI', {
    // Signal listeners
    onStateChange: (callback) => {
        ipcRenderer.on('avatar:state', (_, data) => callback(data));
    },
    onToneHint: (callback) => {
        ipcRenderer.on('avatar:tone', (_, data) => callback(data));
    },
    onTypingRhythm: (callback) => {
        ipcRenderer.on('avatar:rhythm', (_, data) => callback(data));
    },
    onResponseTiming: (callback) => {
        ipcRenderer.on('avatar:response', (_, data) => callback(data));
    },
    onSentiment: (callback) => {
        ipcRenderer.on('avatar:sentiment', (_, data) => callback(data));
    },
    onMouthAmplitude: (callback) => {
        ipcRenderer.on('avatar:mouth-amplitude', (_, data) => callback(data));
    },
    onExternalMouthControl: (callback) => {
        ipcRenderer.on('avatar:mouth-control', (_, data) => callback(data));
    },

    // Configuration
    getModelPath: () => ipcRenderer.invoke('get-avatar-model-path'),
    moveWindow: (pos) => ipcRenderer.send('avatar-move-window', pos)
});
