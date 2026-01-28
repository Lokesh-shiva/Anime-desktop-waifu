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
import { isVoiceEnabled, setVoiceEnabled, getTTSEngine, setTTSEngine } from './settings.js';

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
 * @param {string} response 
 */
function showResponse(response) {
    const userQuery = responseArea.querySelector('.user-text');
    responseArea.innerHTML = `
    ${userQuery ? userQuery.outerHTML : ''}
    <p class="response-text">${escapeHtml(response)}</p>
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
        const response = await BrainRouter.generate(query, { systemInstruction });

        // 6. Analyze sentiment and send to avatar
        const sentiment = analyzeSentiment(query, response);
        AvatarBridge.sendSentiment(sentiment);

        // 7. Update Memory (in background)
        memoryManager.addInteraction(query, response);

        StateMachine.transition(EVENTS.LLM_RESPONSE, response);
    } catch (error) {
        console.error('[Renderer] LLM error:', error);
        AvatarBridge.sendSentiment('confused');
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
        if (!e.target.checked) {
            VoiceService.stop();
        }
    });
}

// TTS Engine changes
ttsRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
        setTTSEngine(e.target.value);
    });
});

// Initialize
initSettings();
IdlePresence.init(presenceIndicator);
AvatarBridge.init();
updateUI(STATES.IDLE, null);
