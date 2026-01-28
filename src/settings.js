/**
 * Settings Module
 * Centralized settings management with runtime switching
 * Persists to localStorage for instant access without restart
 */

// Storage keys
const STORAGE_KEYS = {
    MODEL_MODE: 'waifu_model_mode',
    CLOUD_API_KEY: 'waifu_cloud_api_key',
    VOICE_ENABLED: 'waifu_voice_enabled',
    TTS_ENGINE: 'waifu_tts_engine'
};

// Model selection modes
export const MODEL_MODE = Object.freeze({
    LOCAL_ONLY: 'local_only',           // Never use cloud
    CLOUD_PREFERRED: 'cloud_preferred', // Cloud first, fallback to local
    CLOUD_ONLY: 'cloud_only'            // Cloud only, fail if unavailable
});

// TTS Engine types
export const TTS_ENGINE = Object.freeze({
    SYSTEM: 'system',           // pyttsx3 (CPU)
    STYLE_TTS: 'styletts2'      // StyleTTS2 (GPU/Heavy CPU)
});

// Settings listeners for reactive updates
let listeners = [];

/**
 * Get current model mode
 * @returns {string} - One of MODEL_MODE values
 */
export function getModelMode() {
    const stored = localStorage.getItem(STORAGE_KEYS.MODEL_MODE);
    // Default to LOCAL_ONLY for safety
    if (!stored || !Object.values(MODEL_MODE).includes(stored)) {
        return MODEL_MODE.LOCAL_ONLY;
    }
    return stored;
}

/**
 * Set model mode at runtime
 * @param {string} mode - One of MODEL_MODE values
 */
export function setModelMode(mode) {
    if (!Object.values(MODEL_MODE).includes(mode)) {
        console.error('[Settings] Invalid mode:', mode);
        return;
    }
    localStorage.setItem(STORAGE_KEYS.MODEL_MODE, mode);
    notifyListeners({ type: 'mode', value: mode });
    console.log('[Settings] Mode changed to:', mode);
}

/**
 * Get cloud API key
 * @returns {string|null}
 */
export function getCloudApiKey() {
    return localStorage.getItem(STORAGE_KEYS.CLOUD_API_KEY) || null;
}

/**
 * Set cloud API key
 * @param {string} key
 */
export function setCloudApiKey(key) {
    if (key) {
        localStorage.setItem(STORAGE_KEYS.CLOUD_API_KEY, key);
    } else {
        localStorage.removeItem(STORAGE_KEYS.CLOUD_API_KEY);
    }
    notifyListeners({ type: 'apiKey', value: !!key });
    console.log('[Settings] API key', key ? 'set' : 'cleared');
}

/**
 * Check if cloud is configured (has API key)
 * @returns {boolean}
 */
export function isCloudConfigured() {
    return !!getCloudApiKey();
}

/**
 * Check if voice is enabled
 * @returns {boolean}
 */
export function isVoiceEnabled() {
    return localStorage.getItem(STORAGE_KEYS.VOICE_ENABLED) === 'true';
}

/**
 * Set voice enabled status
 * @param {boolean} enabled 
 */
export function setVoiceEnabled(enabled) {
    localStorage.setItem(STORAGE_KEYS.VOICE_ENABLED, enabled.toString());
    notifyListeners({ type: 'voice', value: enabled });
    console.log('[Settings] Voice', enabled ? 'enabled' : 'disabled');
}

/**
 * Get current TTS engine
 * @returns {string} - One of TTS_ENGINE values
 */
export function getTTSEngine() {
    const stored = localStorage.getItem(STORAGE_KEYS.TTS_ENGINE);
    if (!stored || !Object.values(TTS_ENGINE).includes(stored)) {
        return TTS_ENGINE.SYSTEM;
    }
    return stored;
}

/**
 * Set TTS engine
 * @param {string} engine - One of TTS_ENGINE values
 */
export function setTTSEngine(engine) {
    if (!Object.values(TTS_ENGINE).includes(engine)) {
        console.error('[Settings] Invalid TTS engine:', engine);
        return;
    }
    localStorage.setItem(STORAGE_KEYS.TTS_ENGINE, engine);
    notifyListeners({ type: 'ttsEngine', value: engine });
    console.log('[Settings] TTS Engine changed to:', engine);
}

/**
 * Check if cloud is configured (has API key)
 * @returns {boolean}
 */

/**
 * Subscribe to settings changes
 * @param {function({type: string, value: any}): void} callback
 * @returns {function(): void} - Unsubscribe function
 */
export function subscribe(callback) {
    listeners.push(callback);
    return () => {
        listeners = listeners.filter(l => l !== callback);
    };
}

/**
 * Notify all listeners
 * @param {{type: string, value: any}} change
 */
function notifyListeners(change) {
    listeners.forEach(l => l(change));
}

// Export settings object for convenience
export const Settings = {
    MODEL_MODE,
    TTS_ENGINE,
    getModelMode,
    setModelMode,
    getCloudApiKey,
    setCloudApiKey,
    isCloudConfigured,
    isVoiceEnabled,
    setVoiceEnabled,
    getTTSEngine,
    setTTSEngine,
    subscribe
};

export default Settings;
