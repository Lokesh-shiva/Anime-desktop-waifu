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
    setCloudApiKey,
    getCloudProvider,
    setCloudProvider,
    getOpenRouterApiKey,
    setOpenRouterApiKey
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
    setElevenLabsVoiceId,
    getGroqSttApiKey,
    setGroqSttApiKey
} from './settings.js';
import { ELEVENLABS_VOICES, DEFAULT_VOICE_ID } from './voice/elevenlabs-adapter.js';

// Expose memoryManager globally for DevTools debugging
window.memoryManager = memoryManager;

// Character identity — soft, shy-feeling name. Make this a setting later if you want.
const CHARACTER_NAME = 'Miko';

// Soft emoji glyphs per emotion family, used as a tiny badge next to her name.
const EMOTION_GLYPHS = {
    shy: '◌', embarrassed: '◌', flustered: '◌', hesitant: '◌',
    happy: '✿', grateful: '✿', kind: '✿', tender: '✿', playful: '✦',
    calm: '·', longing: '◦', lonely: '◦', melancholic: '◦',
    curious: '?', surprised: '!', sad: '◦', anger: '×',
    neutral: ''
};

// ── Chat history ──────────────────────────────────────────────────────────────
// Keeps the full visible conversation so bubbles accumulate naturally.
// Each entry: { role: 'user'|'assistant', text, emotion? }
const chatHistory = [];
const CHAT_MAX = 40; // keep last 40 bubbles before trimming

function pushHistory(entry) {
    chatHistory.push(entry);
    if (chatHistory.length > CHAT_MAX) chatHistory.splice(0, 2); // trim oldest pair
}

function clearHistory() {
    chatHistory.length = 0;
}

/** Render a single user bubble HTML string */
function userBubbleHTML(text) {
    return `<div class="msg msg-user">
      <span class="msg-label">You</span>
      <p class="msg-text">${escapeHtml(text)}</p>
    </div>`;
}

/** Render a single assistant bubble HTML string */
function assistantBubbleHTML(text, emotion, fadeIn = false) {
    const emotionLabel = emotion?.label || 'neutral';
    const intensity    = emotion?.intensity ?? 0;
    const glyph        = EMOTION_GLYPHS[emotionLabel] || '';
    const showBadge    = glyph && emotionLabel !== 'neutral';
    return `<div class="msg msg-assistant${fadeIn ? ' msg-fade-in' : ''}" data-emotion="${escapeHtml(emotionLabel)}">
      <span class="msg-label">
        ${escapeHtml(CHARACTER_NAME)}
        ${showBadge ? `<span class="emotion-badge" title="${escapeHtml(emotionLabel)} · ${intensity.toFixed?.(2) ?? intensity}">${glyph} ${escapeHtml(emotionLabel)}</span>` : ''}
      </span>
      <p class="msg-text">${escapeHtml(text)}</p>
    </div>`;
}

/** Typing-indicator bubble (shown while LLM is thinking) */
const THINKING_BUBBLE_ID = 'miko-thinking-bubble';
function thinkingBubbleHTML() {
    return `<div id="${THINKING_BUBBLE_ID}" class="msg msg-assistant msg-thinking">
      <span class="msg-label">${escapeHtml(CHARACTER_NAME)}</span>
      <div class="typing-indicator" aria-label="${escapeHtml(CHARACTER_NAME)} is thinking">
        <span></span><span></span><span></span>
      </div>
    </div>`;
}

/** Re-render every entry in chatHistory into the response area */
function renderHistory() {
    responseArea.innerHTML = chatHistory.map(e =>
        e.role === 'user'
            ? userBubbleHTML(e.text)
            : assistantBubbleHTML(e.text, e.emotion)
    ).join('');
    responseArea.scrollTop = responseArea.scrollHeight;
}
// ─────────────────────────────────────────────────────────────────────────────

// DOM Elements
const stateIndicator = document.getElementById('state-indicator');
const stateLabel = document.getElementById('state-label');
const responseArea = document.getElementById('response-area');
const userInput = document.getElementById('user-input');
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const modeRadios = document.querySelectorAll('input[name="model-mode"]');
const cloudProviderRadios = document.querySelectorAll('input[name="cloud-provider"]');
const cloudProviderGroup = document.getElementById('cloud-provider-group');
const apiKeyInput = document.getElementById('api-key-input');
const apiKeyGroup = document.getElementById('api-key-group');
const openRouterKeyInput = document.getElementById('openrouter-key-input');
const openRouterKeyGroup = document.getElementById('openrouter-key-group');
const presenceIndicator = document.getElementById('presence-indicator');
const avatarToggle = document.getElementById('avatar-toggle');
const voiceToggle = document.getElementById('voice-toggle');
const ttsRadios = document.querySelectorAll('input[name="tts-engine"]');
const voiceSettingsGroup = document.getElementById('voice-settings-group');
const elevenLabsGroup = document.getElementById('elevenlabs-settings-group');
const elevenLabsKeyInput = document.getElementById('elevenlabs-key-input');
const elevenLabsVoiceSelect = document.getElementById('elevenlabs-voice-select');
const modelSelect = document.getElementById('model-select');
const groqSttKeyInput = document.getElementById('groq-stt-key-input');

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
                clearHistory();
                responseArea.innerHTML = `<p class="placeholder">${CHARACTER_NAME} is here. say something soft…</p>`;
            } else {
                stateLabel.textContent = 'Ready';
            }
            userInput.disabled = false;
            userInput.focus();
            // Show idle presence indicator
            IdlePresence.show();
            break;

        case STATES.THINKING:
            stateLabel.textContent = `${CHARACTER_NAME} is thinking…`;
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
                const spoken = typeof payload === 'string' ? payload : (payload?.text || '');
                const emotion = payload?.emotion || null;
                if (spoken) VoiceService.speak(spoken, emotion);
            }
            break;
    }
}

/**
 * Push user bubble into history and append a typing indicator at the bottom.
 * Does NOT wipe previous messages — conversation accumulates naturally.
 * @param {string} query
 */
function showUserQuery(query) {
    pushHistory({ role: 'user', text: query });
    // Render all history + a fresh thinking bubble at the end
    responseArea.innerHTML =
        chatHistory.map(e =>
            e.role === 'user'
                ? userBubbleHTML(e.text)
                : assistantBubbleHTML(e.text, e.emotion)
        ).join('') + thinkingBubbleHTML();
    responseArea.scrollTop = responseArea.scrollHeight;
}

/**
 * Replace the thinking bubble with Miko's actual response, then lock it into
 * history so it persists across future exchanges.
 * @param {Object|string} responseObj
 */
function showResponse(responseObj) {
    const text     = typeof responseObj === 'object' ? (responseObj.text || '') : String(responseObj || '');
    const emotion  = (typeof responseObj === 'object' && responseObj.emotion) ? responseObj.emotion : null;

    pushHistory({ role: 'assistant', text, emotion });

    // Re-render full history — last bubble gets fade-in, rest are static
    responseArea.innerHTML = chatHistory.map((e, i) => {
        const isLast = i === chatHistory.length - 1;
        return e.role === 'user'
            ? userBubbleHTML(e.text)
            : assistantBubbleHTML(e.text, e.emotion, isLast);
    }).join('');
    responseArea.scrollTop = responseArea.scrollHeight;
}

/**
 * Display error message inline (does not clear chat history)
 * @param {string|Error} error
 */
function showError(error) {
    const message = error instanceof Error ? error.message : String(error);
    // Remove any stale thinking bubble then append error as a soft assistant note
    const thinking = document.getElementById(THINKING_BUBBLE_ID);
    if (thinking) thinking.remove();
    const el = document.createElement('p');
    el.className = 'error-text';
    el.textContent = message;
    responseArea.appendChild(el);
    responseArea.scrollTop = responseArea.scrollHeight;
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

        // 4. Build System Prompt with Memory + Presence + recent turns
        const systemInstruction = buildSystemPrompt(
            memoryContext,
            presenceHints,
            memoryManager.recentMessages   // last ~6 turns for in-context continuity
        );

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
 * (kept for backward compat, but now superseded by updateCloudVisibility)
 */
function updateApiKeyVisibility() {
    // Moved logic to updateCloudVisibility
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

    // Set cloud provider
    const currentProvider = getCloudProvider();
    cloudProviderRadios.forEach(radio => {
        radio.checked = radio.value === currentProvider;
    });

    // Populate cloud API keys
    if (apiKeyInput) {
        apiKeyInput.value = getCloudApiKey() || '';
    }
    if (openRouterKeyInput) {
        openRouterKeyInput.value = getOpenRouterApiKey() || '';
    }

    // Populate Groq STT key
    if (groqSttKeyInput) {
        groqSttKeyInput.value = getGroqSttApiKey() || '';
    }

    // Show ElevenLabs subgroup only when engine = elevenlabs and voice is on
    updateElevenLabsVisibility();
    updateCloudVisibility();
}

function updateElevenLabsVisibility() {
    if (!elevenLabsGroup) return;
    const show = isVoiceEnabled() && getTTSEngine() === TTS_ENGINE.ELEVEN_LABS;
    elevenLabsGroup.classList.toggle('hidden', !show);
}

/**
 * Show/hide cloud provider and API key fields based on mode
 */
function updateCloudVisibility() {
    const mode = getModelMode();
    const isCloudMode = mode !== MODEL_MODE.LOCAL_ONLY;

    // Show cloud provider group if cloud is enabled
    if (cloudProviderGroup) {
        cloudProviderGroup.classList.toggle('hidden', !isCloudMode);
    }

    // Show appropriate API key field
    const provider = getCloudProvider();
    if (apiKeyGroup) {
        apiKeyGroup.classList.toggle('hidden', !isCloudMode || provider !== 'gemini');
    }
    if (openRouterKeyGroup) {
        openRouterKeyGroup.classList.toggle('hidden', !isCloudMode || provider !== 'openrouter');
    }
}

/**
 * Handle mode change
 */
function handleModeChange(e) {
    setModelMode(e.target.value);
    updateCloudVisibility();
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

// Cloud provider changes
cloudProviderRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
        setCloudProvider(e.target.value);
        updateCloudVisibility();
    });
});

// Gemini API key changes (debounced)
let apiKeyTimeout;
if (apiKeyInput) {
    apiKeyInput.addEventListener('input', (e) => {
        clearTimeout(apiKeyTimeout);
        apiKeyTimeout = setTimeout(() => handleApiKeyChange(e), 500);
    });
}

// OpenRouter API key changes (debounced)
let openRouterKeyTimeout;
if (openRouterKeyInput) {
    openRouterKeyInput.addEventListener('input', (e) => {
        clearTimeout(openRouterKeyTimeout);
        openRouterKeyTimeout = setTimeout(() => {
            setOpenRouterApiKey(e.target.value.trim());
        }, 500);
    });
}

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

// Groq STT API key (debounced)
let groqSttKeyTimeout;
if (groqSttKeyInput) {
    groqSttKeyInput.addEventListener('input', (e) => {
        clearTimeout(groqSttKeyTimeout);
        groqSttKeyTimeout = setTimeout(() => {
            setGroqSttApiKey(e.target.value.trim());
        }, 500);
    });
}

// ElevenLabs voice selection
if (elevenLabsVoiceSelect) {
    elevenLabsVoiceSelect.addEventListener('change', (e) => {
        setElevenLabsVoiceId(e.target.value);
    });
}

// ElevenLabs test button — calls API directly with a short sample string
const elevenLabsTestBtn = document.getElementById('elevenlabs-test-btn');
const elevenLabsTestStatus = document.getElementById('elevenlabs-test-status');
if (elevenLabsTestBtn) {
    elevenLabsTestBtn.addEventListener('click', async () => {
        const setStatus = (msg, color = '#ccc') => {
            if (elevenLabsTestStatus) {
                elevenLabsTestStatus.textContent = msg;
                elevenLabsTestStatus.style.color = color;
            }
            console.log('[EL-Test]', msg);
        };

        const apiKey = getElevenLabsApiKey();
        if (!apiKey) {
            setStatus('No API key set.', '#f88');
            return;
        }
        const voiceId = getElevenLabsVoiceId() || DEFAULT_VOICE_ID;

        elevenLabsTestBtn.disabled = true;
        setStatus(`Calling API (voice ${voiceId.slice(0, 8)}…)`, '#8cf');

        try {
            const { synthesize } = await import('./voice/elevenlabs-adapter.js');
            const t0 = performance.now();
            const result = await synthesize('Hello, this is a test.', { apiKey, voiceId });
            const elapsed = Math.round(performance.now() - t0);

            if (result.error) {
                setStatus(`FAIL (${elapsed}ms): ${result.error}`, '#f88');
                return;
            }
            if (!result.audio) {
                setStatus(`FAIL (${elapsed}ms): no audio returned`, '#f88');
                return;
            }

            setStatus(`OK (${elapsed}ms, ${result.audio.length} b64 chars) — playing…`, '#8f8');
            const audio = new Audio(`data:${result.mimeType || 'audio/mpeg'};base64,${result.audio}`);
            audio.onended = () => setStatus(`Playback finished (${elapsed}ms latency)`, '#8f8');
            audio.onerror = (e) => setStatus(`Playback error: ${e?.message || 'unknown'}`, '#f88');
            await audio.play();
        } catch (e) {
            setStatus(`Exception: ${e.message}`, '#f88');
        } finally {
            elevenLabsTestBtn.disabled = false;
        }
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

// ─── Push-to-Talk (MediaRecorder + Groq Whisper) ────────────────────────────
//
// Web Speech API fails in Electron with a "network" error because Chromium
// needs a private Google API key that Electron builds don't ship with.
// Solution: record with MediaRecorder, POST to Groq's Whisper endpoint.
// Free tier at console.groq.com — ~300ms transcription latency.

const micBtn = document.getElementById('mic-btn');

const ptt = {
    mediaRecorder: null,
    chunks: [],
    isListening: false,
    aborted: false,
    stream: null,

    /** Start recording */
    async start() {
        if (this.isListening) return;

        const apiKey = getGroqSttApiKey();
        if (!apiKey) {
            console.warn('[PTT] No Groq STT API key set — open Settings to add one');
            micBtn?.classList.add('error');
            setTimeout(() => micBtn?.classList.remove('error'), 1500);
            return;
        }

        try {
            this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            console.error('[PTT] Mic access denied:', err);
            micBtn?.classList.add('error');
            setTimeout(() => micBtn?.classList.remove('error'), 1500);
            return;
        }

        this.chunks = [];
        this.aborted = false;
        this.isListening = true;
        micBtn?.classList.add('listening');

        // Prefer webm/opus; fall back to whatever is supported
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : MediaRecorder.isTypeSupported('audio/webm')
                ? 'audio/webm'
                : '';

        this.mediaRecorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : {});
        this.mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) this.chunks.push(e.data);
        };
        this.mediaRecorder.onstop = () => this._onStop();
        this.mediaRecorder.start();
        console.log('[PTT] Recording…', mimeType || 'default codec');
    },

    /** Stop and transcribe */
    stop() {
        if (!this.isListening || !this.mediaRecorder) return;
        this.isListening = false;
        micBtn?.classList.remove('listening');
        try { this.mediaRecorder.stop(); } catch (_) {}
        this._releaseStream();
    },

    /** Abort — discard recording */
    abort() {
        if (!this.isListening && !this.mediaRecorder) return;
        this.aborted = true;
        this.isListening = false;
        micBtn?.classList.remove('listening');
        try { this.mediaRecorder?.stop(); } catch (_) {}
        this._releaseStream();
        console.log('[PTT] Aborted');
    },

    _releaseStream() {
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
        }
    },

    async _onStop() {
        if (this.aborted || this.chunks.length === 0) return;

        const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type: mimeType });
        this.chunks = [];

        // Need at least ~0.2s of audio to be worth sending
        if (blob.size < 2000) {
            console.log('[PTT] Audio too short, skipping');
            return;
        }

        micBtn?.classList.add('listening'); // keep glow during transcription
        console.log('[PTT] Transcribing', blob.size, 'bytes via Groq…');

        try {
            const transcript = await transcribeWithGroq(blob, mimeType);
            console.log('[PTT] Transcript:', transcript);
            if (transcript) {
                userInput.value = transcript;
                handleSubmit();
            }
        } catch (err) {
            console.error('[PTT] Transcription failed:', err);
            micBtn?.classList.add('error');
            setTimeout(() => micBtn?.classList.remove('error'), 1500);
        } finally {
            micBtn?.classList.remove('listening');
        }
    }
};

/**
 * Send audio blob to Groq's Whisper API and return transcript string.
 * @param {Blob} audioBlob
 * @param {string} mimeType
 * @returns {Promise<string>}
 */
async function transcribeWithGroq(audioBlob, mimeType) {
    const apiKey = getGroqSttApiKey();
    if (!apiKey) throw new Error('No Groq STT API key');

    // Determine file extension from mime type
    const ext = mimeType.includes('mp4') ? 'm4a'
               : mimeType.includes('ogg') ? 'ogg'
               : 'webm';

    const formData = new FormData();
    formData.append('file', audioBlob, `audio.${ext}`);
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', 'en');
    formData.append('response_format', 'json');

    const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: formData
    });

    if (!resp.ok) {
        const err = await resp.text().catch(() => resp.statusText);
        throw new Error(`Groq STT ${resp.status}: ${err}`);
    }

    const data = await resp.json();
    return (data.text || '').trim();
}

// Mic button — hold to speak
if (micBtn) {
    micBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (!micBtn.disabled) ptt.start();
    });
    micBtn.addEventListener('mouseup', () => ptt.stop());
    micBtn.addEventListener('mouseleave', () => ptt.stop());

    micBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        if (!micBtn.disabled) ptt.start();
    }, { passive: false });
    micBtn.addEventListener('touchend', () => ptt.stop());
}

// Space bar push-to-talk — only when text input is NOT focused
document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && document.activeElement !== userInput && !e.repeat) {
        e.preventDefault();
        if (micBtn && !micBtn.disabled) ptt.start();
    }
});
document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && document.activeElement !== userInput) {
        ptt.stop();
    }
});
document.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') ptt.abort();
});

// Disable mic while Miko is thinking/responding
StateMachine.subscribe((state) => {
    if (!micBtn) return;
    const busy = state === 'THINKING' || state === 'RESPONDING';
    micBtn.disabled = busy;
    if (busy) ptt.abort();
});

// ─────────────────────────────────────────────────────────────────────────────

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
