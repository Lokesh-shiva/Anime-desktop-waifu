/**
 * Settings Module
 * Centralized settings management with runtime switching
 * Persists to localStorage for instant access without restart
 */

// Storage keys
const STORAGE_KEYS = {
    MODEL_MODE: 'waifu_model_mode',
    CLOUD_API_KEY: 'waifu_cloud_api_key',
    CLOUD_PROVIDER: 'waifu_cloud_provider',
    OPENROUTER_API_KEY: 'waifu_openrouter_api_key',
    VOICE_ENABLED: 'waifu_voice_enabled',
    TTS_ENGINE: 'waifu_tts_engine',
    ELEVENLABS_API_KEY: 'waifu_elevenlabs_api_key',
    ELEVENLABS_VOICE_ID: 'waifu_elevenlabs_voice_id'
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
    STYLE_TTS: 'styletts2',     // StyleTTS2 (GPU/Heavy CPU)
    ELEVEN_LABS: 'elevenlabs'   // ElevenLabs cloud API
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
 * Get current cloud provider ('gemini' or 'openrouter')
 * @returns {string}
 */
export function getCloudProvider() {
    const stored = localStorage.getItem(STORAGE_KEYS.CLOUD_PROVIDER);
    return stored || 'gemini'; // Default to Gemini for backward compat
}

/**
 * Set cloud provider
 * @param {string} provider - 'gemini' or 'openrouter'
 */
export function setCloudProvider(provider) {
    if (!['gemini', 'openrouter'].includes(provider)) {
        console.error('[Settings] Invalid cloud provider:', provider);
        return;
    }
    localStorage.setItem(STORAGE_KEYS.CLOUD_PROVIDER, provider);
    notifyListeners({ type: 'cloudProvider', value: provider });
    console.log('[Settings] Cloud provider changed to:', provider);
}

/**
 * Get OpenRouter API key
 * @returns {string|null}
 */
export function getOpenRouterApiKey() {
    return localStorage.getItem(STORAGE_KEYS.OPENROUTER_API_KEY) || null;
}

/**
 * Set OpenRouter API key
 * @param {string} key
 */
export function setOpenRouterApiKey(key) {
    if (key) {
        localStorage.setItem(STORAGE_KEYS.OPENROUTER_API_KEY, key);
    } else {
        localStorage.removeItem(STORAGE_KEYS.OPENROUTER_API_KEY);
    }
    notifyListeners({ type: 'openRouterApiKey', value: !!key });
    console.log('[Settings] OpenRouter API key', key ? 'set' : 'cleared');
}

/**
 * Get ElevenLabs API key
 * @returns {string|null}
 */
export function getElevenLabsApiKey() {
    return localStorage.getItem(STORAGE_KEYS.ELEVENLABS_API_KEY) || null;
}

/**
 * Set ElevenLabs API key
 * @param {string} key
 */
export function setElevenLabsApiKey(key) {
    if (key) {
        localStorage.setItem(STORAGE_KEYS.ELEVENLABS_API_KEY, key);
    } else {
        localStorage.removeItem(STORAGE_KEYS.ELEVENLABS_API_KEY);
    }
    notifyListeners({ type: 'elevenLabsApiKey', value: !!key });
    console.log('[Settings] ElevenLabs API key', key ? 'set' : 'cleared');
}

/**
 * Get selected ElevenLabs voice ID
 * @returns {string|null}
 */
export function getElevenLabsVoiceId() {
    return localStorage.getItem(STORAGE_KEYS.ELEVENLABS_VOICE_ID) || null;
}

/**
 * Set ElevenLabs voice ID
 * @param {string} voiceId
 */
export function setElevenLabsVoiceId(voiceId) {
    if (voiceId) {
        localStorage.setItem(STORAGE_KEYS.ELEVENLABS_VOICE_ID, voiceId);
    } else {
        localStorage.removeItem(STORAGE_KEYS.ELEVENLABS_VOICE_ID);
    }
    notifyListeners({ type: 'elevenLabsVoiceId', value: voiceId });
}

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
    getCloudProvider,
    setCloudProvider,
    getOpenRouterApiKey,
    setOpenRouterApiKey,
    getElevenLabsApiKey,
    setElevenLabsApiKey,
    getElevenLabsVoiceId,
    setElevenLabsVoiceId,
    subscribe
};

export default Settings;
