/**
 * Renderer Process
 * Handles UI updates and user interaction
 * Wires up state machine and brain router
 */

import StateMachine, { STATES, EVENTS } from './state-machine.js';
import { BrainRouter } from './llm/brain-router.js';
import {
    MODEL_MODE,
    getModelMode,
    setModelMode,
    getCloudApiKey,
    setCloudApiKey
} from './settings.js';
import { memoryManager } from './memory/memory-manager.js';
import { buildSystemPrompt } from './memory/prompt-builder.js';
import { getTimeOfDayTone, getInputRhythmHint, IdlePresence } from './presence/presence.js';
import { AvatarBridge } from './avatar/avatar-bridge.js';
import { VoiceService } from './voice/voice-service.js';
import {
    isVoiceEnabled,
    setVoiceEnabled,
    getTTSEngine,
    setTTSEngine,
    TTS_ENGINE,
    getElevenLabsApiKey,
    setElevenLabsApiKey,
    getElevenLabsVoiceId,
    setElevenLabsVoiceId
} from './settings.js';
import { ELEVENLABS_VOICES, DEFAULT_VOICE_ID } from './voice/elevenlabs-adapter.js';

// Expose memoryManager globally for DevTools debugging
window.memoryManager = memoryManager;

// DOM Elements
const stateIndicator = document.getElementById('state-indicator');
const stateLabel = document.getElementById('state-label');
const responseArea = document.getElementById('response-area');
const userInput = document.getElementById('user-input');
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const modeRadios = document.querySelectorAll('input[name="model-mode"]');
const apiKeyInput = document.getElementById('api-key-input');
const apiKeyGroup = document.getElementById('api-key-group');
const presenceIndicator = document.getElementById('presence-indicator');
const avatarToggle = document.getElementById('avatar-toggle');
const voiceToggle = document.getElementById('voice-toggle');
const ttsRadios = document.querySelectorAll('input[name="tts-engine"]');
const voiceSettingsGroup = document.getElementById('voice-settings-group');
const elevenLabsGroup = document.getElementById('elevenlabs-settings-group');
const elevenLabsKeyInput = document.getElementById('elevenlabs-key-input');
const elevenLabsVoiceSelect = document.getElementById('elevenlabs-voice-select');
const modelSelect = document.getElementById('model-select');

// Typing rhythm tracking (for input sensitivity)
let keyTimestamps = [];

/**
 * Update UI based on state
 * @param {string} state 
 * @param {any} payload 
 */
function updateUI(state, payload) {
    // Broadcast state to avatar
    AvatarBridge.sendState(state);

    // Update indicator
    stateIndicator.className = 'indicator ' + state.toLowerCase();

    switch (state) {
        case STATES.IDLE:
            if (payload?.error) {
                stateLabel.textContent = 'Error';
                stateIndicator.className = 'indicator error';
                showError(payload.error);
            } else if (payload?.reset) {
                stateLabel.textContent = 'Ready';
                responseArea.innerHTML = '<p class="placeholder">Ask me anything...</p>';
            } else {
                stateLabel.textContent = 'Ready';
            }
            userInput.disabled = false;
            userInput.focus();
            // Show idle presence indicator
            IdlePresence.show();
            break;

        case STATES.THINKING:
            stateLabel.textContent = 'Thinking...';
            userInput.disabled = true;
            showUserQuery(payload);
            // Hide idle presence during activity
            IdlePresence.hide();
            break;

        case STATES.RESPONDING:
            stateLabel.textContent = 'Done';
            showResponse(payload);
            // Trigger voice if enabled
            if (isVoiceEnabled()) {
                VoiceService.speak(payload);
            }
            break;
    }
}

/**
 * Display user's query
 * @param {string} query 
 */
function showUserQuery(query) {
    responseArea.innerHTML = `
    <p class="user-text">You: ${escapeHtml(query)}</p>
    <p class="placeholder">...</p>
  `;
}

/**
 * Display assistant response
 * @param {Object} responseObj 
 */
function showResponse(responseObj) {
    const userQuery = responseArea.querySelector('.user-text');
    const text = typeof responseObj === 'object' ? responseObj.text : responseObj;

    responseArea.innerHTML = `
    ${userQuery ? userQuery.outerHTML : ''}
    <p class="response-text">${escapeHtml(text)}</p>
  `;
}

/**
 * Display error message
 * @param {string|Error} error 
 */
function showError(error) {
    const message = error instanceof Error ? error.message : String(error);
    responseArea.innerHTML = `<p class="error-text">${escapeHtml(message)}</p>`;
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text 
 * @returns {string}
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Handle user input submission
 */
async function handleSubmit() {
    const query = userInput.value.trim();
    if (!query) return;

    userInput.value = '';

    // Transition to THINKING - this will disable input
    const accepted = StateMachine.transition(EVENTS.USER_INPUT, query);
    if (!accepted) return;

    // Call Brain Router (handles all model selection internally)
    try {
        // 1. Get Memory Context
        const memoryContext = memoryManager.getContext();

        // 2. Build Presence Hints (ephemeral, not stored)
        const presenceHints = {
            timeOfDay: getTimeOfDayTone(),
            inputRhythm: getInputRhythmHint(keyTimestamps)
        };
        // Clear timestamps after use
        keyTimestamps = [];

        // 3. Broadcast presence hints to avatar
        AvatarBridge.sendToneHint(presenceHints.timeOfDay);
        AvatarBridge.sendTypingRhythm(presenceHints.inputRhythm);

        // 4. Build System Prompt with Memory + Presence
        const systemInstruction = buildSystemPrompt(memoryContext, presenceHints);

        // 5. Generate Response
        const responseObj = await BrainRouter.generate(query, { systemInstruction });

        // 6. Send complex intent to avatar
        AvatarBridge.sendComplexIntent({
            emotion: responseObj.emotion,
            actionHints: responseObj.actionHints
        });

        // 7. Update Memory (in background)
        memoryManager.addInteraction(query, responseObj.text);

        StateMachine.transition(EVENTS.LLM_RESPONSE, responseObj);
    } catch (error) {
        console.error('[Renderer] LLM error:', error);
        AvatarBridge.sendComplexIntent({
            emotion: { label: 'confused', intensity: 0.8 }
        });
        StateMachine.transition(EVENTS.LLM_ERROR, error);
    }
}

/**
 * Enhanced sentiment analyzer for avatar expressions
 * Analyzes both user query and AI response to determine avatar mood
 * @param {string} query - User message
 * @param {string} response - AI response
 * @returns {string} sentiment type
 */
function analyzeSentiment(query, response) {
    const queryLower = query.toLowerCase();
    const responseLower = response.toLowerCase();
    const text = queryLower + ' ' + responseLower;

    // === USER MESSAGE PATTERNS (higher priority) ===

    // Greetings - user says hi/hello
    if (/^(hi|hello|hey|yo|hiya|greetings|good morning|good afternoon|good evening|sup)\b/i.test(query.trim())) {
        return 'greeting';
    }

    // Farewells - user says bye
    if (/^(bye|goodbye|see you|later|gotta go|cya|take care|goodnight|good night)\b/i.test(query.trim())) {
        return 'farewell';
    }

    // Laughter patterns
    if (/\b(haha|hehe|lol|lmao|rofl|😂|🤣|😆)\b/i.test(query) || /!{3,}/i.test(query)) {
        return 'laugh';
    }

    // Love/affection patterns
    if (/\b(i love you|love you|you're the best|you're amazing|adore you|❤|💕|😍)\b/i.test(query)) {
        return 'love';
    }

    // Playful/teasing
    if (/\b(hehe|tease|joking|kidding|just kidding|jk|😜|😏|wink)\b/i.test(query)) {
        return 'playful';
    }

    // === EXCITED PATTERNS ===
    if (/!{2,}|wow|amazing|awesome|fantastic|incredible|yay|hooray|omg|oh my god/i.test(text)) {
        return 'excited';
    }

    // === RESPONSE PATTERNS ===

    // AI apologizing
    if (/\b(i'm sorry|i apologize|my apologies|forgive me|my mistake)\b/i.test(responseLower)) {
        return 'apologetic';
    }

    // AI expressing pride/accomplishment
    if (/\b(great job|well done|proud of you|excellent work|you did it|congrat)/i.test(responseLower)) {
        return 'proud';
    }

    // AI thinking/processing
    if (/\b(let me think|hmm|let's see|thinking about|considering)\b/i.test(responseLower)) {
        return 'thinking';
    }

    // Concerned response
    if (/\b(are you okay|hope you're|take care|worried about|concerned)\b/i.test(responseLower)) {
        return 'concerned';
    }

    // === GENERAL PATTERNS ===

    // Happy patterns
    if (/thank|great|good|happy|love|nice|wonderful|glad|pleased|enjoy|perfect|yay/i.test(text)) {
        return 'happy';
    }

    // Curious patterns (questions)
    if (/\?|how|what|why|where|when|who|could you|can you|tell me|explain/i.test(queryLower)) {
        return 'curious';
    }

    // Surprised patterns
    if (/really\?|seriously|no way|unexpected|surprise|whoa|wait what/i.test(text)) {
        return 'surprised';
    }

    // Sad patterns in response
    if (/sorry|sad|unfortunately|can't help|cannot|unable|fail|wrong|bad news|problem/i.test(responseLower)) {
        return 'sad';
    }

    // Confused patterns
    if (/confused|unclear|don't understand|not sure|i'm not certain|complicated|complex/i.test(text)) {
        return 'confused';
    }

    // Embarrassed (user apologizing or awkward)
    if (/\b(sorry|my bad|oops|awkward|embarrassing)\b/i.test(queryLower)) {
        return 'embarrassed';
    }

    // Explicit gesture triggers for testing
    if (/\b(wave|waving)\b/i.test(query)) return 'greeting';
    if (/\b(blush|blushing|shy)\b/i.test(query)) return 'love';
    if (/\b(shrug|shrugging)\b/i.test(query)) return 'confused';

    return 'neutral';
}

/**
 * Toggle settings panel visibility
 */
function toggleSettings() {
    settingsPanel.classList.toggle('hidden');
}

/**
 * Update API key field visibility based on mode
 */
function updateApiKeyVisibility() {
    const mode = getModelMode();
    const needsCloud = mode !== MODEL_MODE.LOCAL_ONLY;
    apiKeyGroup.classList.toggle('hidden', !needsCloud);
}

/**
 * Initialize settings UI with current values
 */
function initSettings() {
    // Set current mode
    const currentMode = getModelMode();
    modeRadios.forEach(radio => {
        radio.checked = radio.value === currentMode;
    });

    // Set API key (masked display)
    const apiKey = getCloudApiKey();
    if (apiKey) {
        apiKeyInput.value = apiKey;
    }

    // Show/hide API key field
    updateApiKeyVisibility();

    // Set avatar toggle state
    if (avatarToggle) {
        avatarToggle.checked = AvatarBridge.isEnabled();
    }

    // Set voice toggle state
    if (voiceToggle) {
        voiceToggle.checked = isVoiceEnabled();
    }

    // Set TTS engine
    const currentEngine = getTTSEngine();
    ttsRadios.forEach(radio => {
        radio.checked = radio.value === currentEngine;
    });

    // Show/hide based on voice enabled
    if (voiceSettingsGroup) {
        voiceSettingsGroup.classList.toggle('hidden', !isVoiceEnabled());
    }

    // Populate ElevenLabs voice dropdown
    if (elevenLabsVoiceSelect) {
        elevenLabsVoiceSelect.innerHTML = '';
        for (const v of ELEVENLABS_VOICES) {
            const opt = document.createElement('option');
            opt.value = v.id;
            opt.textContent = v.name;
            elevenLabsVoiceSelect.appendChild(opt);
        }
        elevenLabsVoiceSelect.value = getElevenLabsVoiceId() || DEFAULT_VOICE_ID;
    }

    // Populate ElevenLabs API key
    if (elevenLabsKeyInput) {
        elevenLabsKeyInput.value = getElevenLabsApiKey() || '';
    }

    // Show ElevenLabs subgroup only when engine = elevenlabs and voice is on
    updateElevenLabsVisibility();
}

function updateElevenLabsVisibility() {
    if (!elevenLabsGroup) return;
    const show = isVoiceEnabled() && getTTSEngine() === TTS_ENGINE.ELEVEN_LABS;
    elevenLabsGroup.classList.toggle('hidden', !show);
}

/**
 * Handle mode change
 */
function handleModeChange(e) {
    setModelMode(e.target.value);
    updateApiKeyVisibility();
}

/**
 * Handle API key change
 */
function handleApiKeyChange(e) {
    const key = e.target.value.trim();
    setCloudApiKey(key);
}

// Subscribe to state changes
StateMachine.subscribe(updateUI);

// Handle Enter key + track typing rhythm
userInput.addEventListener('keydown', (e) => {
    // Track keystrokes for input sensitivity (presence feature)
    keyTimestamps.push(Date.now());
    if (keyTimestamps.length > 10) keyTimestamps.shift(); // Keep last 10

    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
    }
});

// Settings toggle
settingsBtn.addEventListener('click', toggleSettings);

// Close settings when clicking outside
document.addEventListener('click', (e) => {
    if (!settingsPanel.contains(e.target) && !settingsBtn.contains(e.target)) {
        settingsPanel.classList.add('hidden');
    }
});

// Mode radio changes
modeRadios.forEach(radio => {
    radio.addEventListener('change', handleModeChange);
});

// API key changes (debounced)
let apiKeyTimeout;
apiKeyInput.addEventListener('input', (e) => {
    clearTimeout(apiKeyTimeout);
    apiKeyTimeout = setTimeout(() => handleApiKeyChange(e), 500);
});

// Avatar toggle
if (avatarToggle) {
    avatarToggle.addEventListener('change', (e) => {
        AvatarBridge.setEnabled(e.target.checked);
    });
}

// Voice toggle
if (voiceToggle) {
    voiceToggle.addEventListener('change', (e) => {
        setVoiceEnabled(e.target.checked);
        if (voiceSettingsGroup) {
            voiceSettingsGroup.classList.toggle('hidden', !e.target.checked);
        }
        updateElevenLabsVisibility();
        if (!e.target.checked) {
            VoiceService.stop();
        }
    });
}

// TTS Engine changes
ttsRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
        setTTSEngine(e.target.value);
        updateElevenLabsVisibility();
    });
});

// ElevenLabs API key (debounced)
let elevenLabsKeyTimeout;
if (elevenLabsKeyInput) {
    elevenLabsKeyInput.addEventListener('input', (e) => {
        clearTimeout(elevenLabsKeyTimeout);
        elevenLabsKeyTimeout = setTimeout(() => {
            setElevenLabsApiKey(e.target.value.trim());
        }, 500);
    });
}

// ElevenLabs voice selection
if (elevenLabsVoiceSelect) {
    elevenLabsVoiceSelect.addEventListener('change', (e) => {
        setElevenLabsVoiceId(e.target.value);
    });
}

// Model Select
if (modelSelect) {
    modelSelect.addEventListener('change', async (e) => {
        const path = e.target.value;
        if (path) {
            console.log('[Renderer] Switching model to:', path);
            const result = await window.electronAPI.changeAvatarModel(path);
            if (!result.success) {
                console.error('[Renderer] Failed to switch model:', result.error);
                // Maybe show a toast
            }
        }
    });
}

// Debug Emotion Triggers — bypass AvatarBridge to avoid enabled-flag blocking
['happy', 'sad', 'crying', 'angry', 'dark', 'playful', 'surprised', 'embarrassed', 'excited', 'sleepy', 'smug', 'love', 'confused', 'scared', 'disgusted', 'determined', 'curious', 'neutral'].forEach(emo => {
    const btn = document.getElementById(`btn-dbg-${emo}`);
    if (btn) {
        btn.addEventListener('click', () => {
            const intent = { emotion: { label: emo, intensity: 1.0 } };
            console.log(`[Debug] Sending emotion directly via IPC:`, emo, intent);
            // Send via bridge if enabled
            AvatarBridge.sendComplexIntent(intent);
            // ALSO send directly via IPC, bypassing bridge enabled flag
            if (window.electronAPI?.sendToAvatar) {
                window.electronAPI.sendToAvatar('avatar:intent', intent);
                console.log(`[Debug] Sent via direct IPC`);
            } else {
                console.warn(`[Debug] window.electronAPI.sendToAvatar not available!`);
            }
        });
    }
});

/**
 * Load available models into dropdown
 */
async function loadModels() {
    if (!modelSelect) return;

    try {
        const models = await window.electronAPI.getAvailableModels();
        const currentPath = await window.electronAPI.getAvatarModelPath();

        modelSelect.innerHTML = '';

        if (models.length === 0) {
            const option = document.createElement('option');
            option.text = "No models found";
            modelSelect.add(option);
            modelSelect.disabled = true;
            return;
        }

        models.forEach(model => {
            const option = document.createElement('option');
            option.value = model.path;
            option.text = model.name;
            option.selected = (model.path === currentPath) || (model.path.replace(/\\/g, '/') === currentPath.replace('file:///', ''));
            modelSelect.add(option);
        });

    } catch (e) {
        console.error('[Renderer] Failed to load models:', e);
        modelSelect.innerHTML = '<option disabled>Error loading models</option>';
    }
}

// Voice Events
VoiceService.onStart(() => {
    // Optional: ensure we are in responding state if not already
    // but usually LLM response triggers this first
});

VoiceService.onEnd(() => {
    if (getModelMode() !== MODEL_MODE.LOCAL_ONLY) { // For cloud, or just generally
        // Transition back to IDLE when speech ends
        // We use updateUI directly or state machine transition?
        // StateMachine transition logs event, better.
        // But we don't have a specific event for "SPEECH_END" in state-machine.js usually?
        // Let's just force updateUI(STATES.IDLE) or check if we can add an event.
        // Actually, let's just stick to updateUI(STATES.IDLE) for now as a "reset"
        updateUI(STATES.IDLE);
    } else {
        // Local mode might behave differently? No, same logic.
        updateUI(STATES.IDLE);
    }
});

// Initialize
initSettings();
loadModels();
IdlePresence.init(presenceIndicator);
AvatarBridge.init();
// Start in IDLE
updateUI(STATES.IDLE, null);

// Listen for Capabilities
if (window.electronAPI && window.electronAPI.onAvatarCapabilities) {
    window.electronAPI.onAvatarCapabilities((caps) => {
        renderCapabilities(caps);
    });
}

/**
 * Render capability badges
 */
function renderCapabilities(caps) {
    const container = document.getElementById('model-capabilities');
    if (!container) return;

    container.classList.remove('hidden');
    container.innerHTML = '';

    // Badges config
    const badges = [
        { key: 'canBlink', label: '👁️ Blink' },
        { key: 'canSmile', label: '😊 Smile' },
        { key: 'canMoveArmL', label: '👋 Arms' },
        { key: 'canBlush', label: '😳 Blush' },
        { key: 'canShrug', label: '🤷 Shrug' },
        { key: 'canMoveHandL', label: '✋ Hands' },
        { key: 'hasPhysics', label: '🍃 Physics' }
    ];

    // Special logic to merge Arm/Hand L/R
    const hasArms = caps.canMoveArmL || caps.canMoveArmR;
    const hasHands = caps.canMoveHandL || caps.canMoveHandR;

    addBadge(container, '👁️ Blink', caps.canBlink);
    addBadge(container, '😊 Smile', caps.canSmile);
    addBadge(container, '👋 Wave/Arms', hasArms);
    addBadge(container, '✋ Hands', hasHands);
    addBadge(container, '🤷 Shrug', caps.canShrug);
    addBadge(container, '😳 Blush', caps.canBlush);
    addBadge(container, '🍃 Physics', caps.hasPhysics);
}

function addBadge(container, label, active) {
    if (!active) return;
    const badge = document.createElement('span');
    badge.className = 'cap-badge active';
    badge.textContent = label;
    container.appendChild(badge);
}
