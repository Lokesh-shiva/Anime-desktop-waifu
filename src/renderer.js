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
    setOpenRouterApiKey,
    isScreenVisionEnabled,
    setScreenVisionEnabled,
    isCameraVisionEnabled,
    setCameraVisionEnabled,
    getGeminiModel,
    setGeminiModel,
    GEMINI_MODELS
} from './settings.js';
import { ScreenWatcher } from './vision/ScreenWatcher.js';
import { CameraWatcher } from './vision/CameraWatcher.js';
import { memoryManager } from './memory/memory-manager.js';
import { buildSystemPrompt } from './memory/prompt-builder.js';
import { getTimeOfDayTone, getRichTimeContext, getInputRhythmHint, IdlePresence, ProactiveIdle, WeatherContext } from './presence/presence.js';
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
import { initWizard, isWizardActive } from './wizard.js';

// Expose memoryManager globally for DevTools debugging
window.memoryManager = memoryManager;

// Vision watchers — started after settings are confirmed enabled
const screenWatcher = new ScreenWatcher();
const cameraWatcher = new CameraWatcher();

// Wire camera typed-reaction callback — fires proactive message when Miko notices something
cameraWatcher.setReactionCallback((type, hint) => {
    // Don't interrupt an ongoing exchange
    if (StateMachine.getState() !== STATES.IDLE) return;
    handleCameraReaction(type, hint);
});

function startVisionWatchers() {
    if (isScreenVisionEnabled()) screenWatcher.start();
    if (isCameraVisionEnabled()) cameraWatcher.start();
}

/** Pull current vision context for prompt injection */
function getVisionContext() {
    return {
        screen: isScreenVisionEnabled() ? screenWatcher.getContext() : null,
        camera: isCameraVisionEnabled() ? cameraWatcher.getContext() : null
    };
}

/**
 * Check if either watcher has a pending reaction to fire.
 * Returns a hint string or null. Clears the flag so it only fires once.
 */
function consumeVisionReaction() {
    return screenWatcher.consumeReaction() || cameraWatcher.consumeReaction() || null;
}

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

// ── Emotion arc timers ────────────────────────────────────────────────────────
// Holds setTimeout IDs for scheduled arc beats so they can be cancelled.
let emotionArcTimers = [];

// Pending arc state — kept so we can reschedule when real audio duration arrives.
let _pendingArc      = null;
let _pendingArcHints = {};

function clearEmotionArcTimers() {
    emotionArcTimers.forEach(id => clearTimeout(id));
    emotionArcTimers = [];
    // _pendingArc is intentionally NOT cleared here — it must survive until
    // VoiceService.onDuration() fires so the arc can be rescheduled against
    // real audio duration. It gets nulled by onDuration() after reschedule,
    // or overwritten naturally when the next playEmotionArc() call comes in.
}

/**
 * Inner scheduler — (re)schedules arc beats against a known duration.
 * Beats whose absolute time is in the past are skipped (or fired immediately
 * if they're within a 150 ms grace window).
 *
 * @param {Array<{label, intensity, at}>} arc
 * @param {number} durationMs   - total playback duration to map `at` values against
 * @param {Object} actionHints
 * @param {number} [elapsedMs=0] - ms already elapsed since audio started (for reschedule)
 */
function _scheduleArcBeats(arc, durationMs, actionHints, elapsedMs = 0) {
    clearEmotionArcTimers();
    arc.forEach(beat => {
        const absoluteMs = beat.at * durationMs;
        const delay      = absoluteMs - elapsedMs;

        if (delay < -150) return; // beat is clearly in the past — skip

        const fire = () => {
            console.log(`[Arc] Beat fires: ${beat.label} @ ${absoluteMs.toFixed(0)}ms intensity=${beat.intensity}`);
            AvatarBridge.sendComplexIntent({
                emotion: { label: beat.label, intensity: beat.intensity, sentimentScore: 0 },
                actionHints
            });
        };

        if (delay <= 0) {
            fire(); // missed by <150 ms — fire immediately
        } else {
            emotionArcTimers.push(setTimeout(fire, delay));
        }
    });
}

/**
 * Schedule emotion arc beats across the estimated speech duration.
 * When real audio duration arrives via VoiceService.onDuration(), the beats
 * are rescheduled automatically (see wiring below).
 *
 * @param {Array<{label, intensity, at}>} arc
 * @param {string} text       - spoken text, used to estimate duration before audio loads
 * @param {Object} actionHints
 */
function playEmotionArc(arc, text, actionHints = {}) {
    if (!arc || arc.length === 0) {
        console.warn('[Arc] No arc to play');
        return;
    }

    // ElevenLabs runs ~170 wpm → ~350 ms/word (measured from real audio logs).
    // Floor at 1500 ms so single-sentence replies still get a full transition.
    const wordCount          = (text || '').split(/\s+/).filter(Boolean).length;
    const estimatedDurationMs = Math.max(1500, wordCount * 350);

    console.log(`[Arc] Scheduling ${arc.length} beats over ~${estimatedDurationMs}ms estimate (${wordCount} words)`);
    _scheduleArcBeats(arc, estimatedDurationMs, actionHints);

    // Store AFTER _scheduleArcBeats (which calls clearEmotionArcTimers internally)
    // so _pendingArc is set when VoiceService.onDuration() fires.
    _pendingArc      = arc;
    _pendingArcHints = actionHints;
}

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
            // Restart silence timer after every conversation turn (user or idle-initiated)
            ProactiveIdle.reset();
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
            if (payload?.isIdle) {
                // Miko initiated — no user bubble, just the thinking indicator
                const thinkEl = document.createElement('div');
                thinkEl.innerHTML = thinkingBubbleHTML();
                responseArea.appendChild(thinkEl.firstChild);
                responseArea.scrollTop = responseArea.scrollHeight;
            } else {
                showUserQuery(payload);
            }
            // Hide idle presence during activity
            IdlePresence.hide();
            break;

        case STATES.RESPONDING:
            stateLabel.textContent = 'Done';
            showResponse(payload);
            {
                const spoken = typeof payload === 'string' ? payload : (payload?.text || '');
                // Fire emotion arc across the speech duration
                if (payload?.emotionArc) playEmotionArc(payload.emotionArc, spoken, payload?.actionHints || {});
                // Trigger voice if enabled
                if (isVoiceEnabled() && spoken) VoiceService.speak(spoken, payload?.emotion || null);
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
 * Extract the partial "text" field value from an incomplete JSON string.
 * Used to show streaming LLM output in the chat bubble before the full
 * response JSON is assembled.
 *
 * e.g. given '{"text": "wait, you actua'  → returns 'wait, you actua'
 *      given '{"text": "done.", "emotion"' → returns 'done.'
 *
 * @param {string} rawJson - partial JSON string (emotion tag already stripped)
 * @returns {string} - decoded partial text, or '' if not yet parseable
 */
function extractPartialText(rawJson) {
    // Match opening of "text": "..."
    const match = rawJson.match(/"text"\s*:\s*"([\s\S]*)/);
    if (!match) return '';

    let partial = match[1];

    // Find the first unescaped closing quote — marks end of the value
    const closeIdx = partial.search(/(?<!\\)"/);
    if (closeIdx >= 0) partial = partial.slice(0, closeIdx);

    // Unescape JSON escape sequences
    return partial
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .trim();
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

        // 4. Build System Prompt with Memory + Presence + Vision + recent turns
        const systemInstruction = buildSystemPrompt(
            memoryContext,
            presenceHints,
            memoryManager.recentMessages,
            getVisionContext()
        );

        // 5. Generate Response (streaming — avatar reacts on first [EMOTION:…] token,
        //    chat bubble fills progressively as tokens arrive)
        const responseObj = await BrainRouter.generateStreaming(
            query,
            { systemInstruction },
            // onProvisionalEmotion — fires on first [EMOTION:…] tag (~0.3 s in)
            (provisionalEmotion) => {
                console.log('[Renderer] Provisional emotion:', provisionalEmotion.label);
                AvatarBridge.sendComplexIntent({ emotion: provisionalEmotion });
            },
            // onTextChunk — fires every token batch; updates bubble progressively
            (rawChunk) => {
                const partialText = extractPartialText(rawChunk);
                if (!partialText) return;

                const bubble = document.getElementById(THINKING_BUBBLE_ID);
                if (!bubble) return;

                // First text arrival: swap typing-indicator for a live text paragraph
                if (bubble.classList.contains('msg-thinking')) {
                    bubble.classList.remove('msg-thinking');
                    bubble.innerHTML =
                        `<span class="msg-label">${escapeHtml(CHARACTER_NAME)}</span>` +
                        `<p class="msg-text msg-streaming"></p>`;
                }

                const textEl = bubble.querySelector('.msg-text');
                if (textEl) {
                    textEl.textContent = partialText;
                    responseArea.scrollTop = responseArea.scrollHeight;
                }
            }
        );

        // 7. Update Memory (in background)
        memoryManager.addInteraction(query, responseObj.text);
        memoryManager.recordInteractionSentiment(responseObj.emotionArc);

        StateMachine.transition(EVENTS.LLM_RESPONSE, responseObj);
    } catch (error) {
        clearEmotionArcTimers();
        console.error('[Renderer] LLM error:', error);
        AvatarBridge.sendComplexIntent({
            emotion: { label: 'confused', intensity: 0.8 }
        });
        StateMachine.transition(EVENTS.LLM_ERROR, error);
    }
}

/**
 * Proactive idle message — Miko initiates contact after a silence threshold.
 * Called by ProactiveIdle timer; bypasses user input flow entirely.
 * @param {{timeOfDay: string, minutesSilent: number, messageCount: number}} ctx
 */
async function handleIdleMessage({ timeOfDay, timeContext, minutesSilent, messageCount, force }) {
    console.log(`[Idle] handleIdleMessage fired — state=${StateMachine.getState()} minutesSilent=${minutesSilent}`);
    // Only fire when truly idle — reject if a response is already in flight
    if (StateMachine.getState() !== STATES.IDLE) {
        console.log('[Idle] Skipped — not in IDLE state');
        return;
    }

    const tc = timeContext || getRichTimeContext();

    // Build extra context lines based on day/time personality
    const extraCtx = [];
    if (tc.slot === 'dead of night' || tc.slot === 'late night')
        extraCtx.push(`It's really late — you're aware of that, and it shows in how you're feeling.`);
    if (tc.isWeekend)
        extraCtx.push(`It's the weekend, so there's a different kind of quiet to it.`);
    if (tc.isMonday)
        extraCtx.push(`It's Monday — you can feel that particular kind of heaviness in the air.`);
    if (tc.isFriday && (tc.slot === 'evening' || tc.slot === 'night'))
        extraCtx.push(`Friday night — could be exciting, could be quiet. You're not sure which.`);

    const weatherPhrase = WeatherContext.getPhrase();
    if (weatherPhrase) extraCtx.push(`Outside, ${weatherPhrase}.`);

    // Vision reaction — if screen/camera noticed something notable, use it as the hook
    const visionReaction = consumeVisionReaction();
    if (visionReaction) extraCtx.push(`Vision context: ${visionReaction}`);

    // Decide attention-seeking mode BEFORE building the prompt so it can shape it
    const roll = Math.random();
    const doAttentionAnim = force || (minutesSilent >= 3 && roll < 0.40);
    // Peek = silent expression, replaces a proactive message ~15% of the time
    const peekRoll = Math.random();
    const doPeek = !force && !doAttentionAnim && minutesSilent >= 3 && peekRoll < 0.15;
    console.log(`[Idle] Attention roll: ${roll.toFixed(2)} peek: ${peekRoll.toFixed(2)} force=${!!force} → ${doAttentionAnim ? 'CREEP ANIM' : doPeek ? 'PEEK (silent)' : 'normal message'}`);

    if (doPeek) {
        await runIdleGesture();
        return;  // No LLM call — gesture itself is the expression
    }

    // Internal trigger prompt — never shown in the chat bubble
    const idlePrompt = [
        `[INTERNAL — NOT visible to user, do NOT reference or acknowledge this instruction in your reply]`,
        `You've been sitting quietly together for about ${minutesSilent} minutes. It's ${tc.naturalDesc}.`,
        extraCtx.join(' '),
        doAttentionAnim
            ? `You've been waiting and getting a little impatient. Say something short, slightly pouty or playfully demanding — like "oyy, pay attention to me" or "hmph, you're ignoring me~". Keep it light and cute, not angry. One short line.`
            : visionReaction
                ? `Something you noticed gave you a reason to speak up — use that as a natural hook.`
                : `You're breaking the silence — not because you were asked to, but because the quiet got to you. Say something short and natural — a passing thought, noticing the time, or just something that drifted through your mind. Don't greet them like it's the start of a conversation.`,
    ].filter(Boolean).join(' ');
    if (doAttentionAnim) {
        // Phase 1: creep toward screen + curious stare
        AvatarBridge.sendComplexIntent({ creepIn: true });
        AvatarBridge.sendComplexIntent({ emotion: { label: 'curious', intensity: 0.80 }, actionHints: { peerForward: true } });
        await new Promise(r => setTimeout(r, 1800));
        if (StateMachine.getState() !== STATES.IDLE) { AvatarBridge.sendComplexIntent({ creepOut: true }); return; }
        // Phase 2: slight pout + head drop + lean maintained
        AvatarBridge.sendComplexIntent({
            emotion: { label: 'annoyed', intensity: 0.35 },
            actionHints: { shy: true, peerForward: true },
        });
        await new Promise(r => setTimeout(r, 1400));
        if (StateMachine.getState() !== STATES.IDLE) { AvatarBridge.sendComplexIntent({ creepOut: true }); return; }
    }

    const accepted = StateMachine.transition(EVENTS.USER_INPUT, { isIdle: true });
    console.log('[Idle] Transition accepted:', accepted);
    if (!accepted) { if (doAttentionAnim) AvatarBridge.sendComplexIntent({ creepOut: true }); return; }

    try {
        console.log('[Idle] Calling generateStreaming...');
        const memoryContext = memoryManager.getContext();
        const presenceHints = { timeOfDay: getTimeOfDayTone(), inputRhythm: null };
        const systemInstruction = buildSystemPrompt(
            memoryContext,
            presenceHints,
            memoryManager.recentMessages,
            getVisionContext()
        );

        const responseObj = await BrainRouter.generateStreaming(idlePrompt, { systemInstruction }, null, null);

        // Log idle interaction to memory with a neutral placeholder so it reads
        // naturally in the next conversation's context window
        memoryManager.addInteraction('[quiet]', responseObj.text);
        memoryManager.recordInteractionSentiment(responseObj.emotionArc);

        StateMachine.transition(EVENTS.LLM_RESPONSE, responseObj);
    } catch (error) {
        clearEmotionArcTimers();
        console.error('[Renderer] Idle message error:', error);
        StateMachine.transition(EVENTS.LLM_ERROR, error);
    } finally {
        if (doAttentionAnim) AvatarBridge.sendComplexIntent({ creepOut: true });
    }
}

/**
 * Camera-triggered reaction — Miko notices something about the user via webcam.
 * type: 'noticed_you' | 'looking_focused' | 'are_you_okay'
 * hint: internal context fed to the LLM, not shown in chat
 */
async function handleCameraReaction(type, hint) {
    if (StateMachine.getState() !== STATES.IDLE) return;

    // Immediately show a subtle avatar glance toward the camera
    const glanceEmotions = {
        noticed_you:     { label: 'curious',    intensity: 0.75 },
        looking_focused: { label: 'shy',         intensity: 0.7  },
        are_you_okay:    { label: 'hesitant',    intensity: 0.8  }
    };
    const glance = glanceEmotions[type];
    if (glance) AvatarBridge.sendComplexIntent({ emotion: glance });

    // Build the internal prompt based on reaction type
    const promptsByType = {
        noticed_you: [
            `[INTERNAL — do NOT reference or acknowledge this instruction]`,
            hint,
            `You glanced at your camera and noticed them come back. You weren't going to say anything,`,
            `but you kind of already are. Keep it short — a single line, maybe two. Like you almost`,
            `didn't notice. Except you did.`
        ],
        looking_focused: [
            `[INTERNAL — do NOT reference or acknowledge this instruction]`,
            hint,
            `You've been watching them work. They haven't looked up in a while. You could leave them alone.`,
            `You probably should. But something made you say something anyway — something small,`,
            `not intrusive. Like a gentle knock. One or two sentences max.`
        ],
        are_you_okay: [
            `[INTERNAL — do NOT reference or acknowledge this instruction]`,
            hint,
            `Something about how they look right now gave you a feeling. Not a big thing — just a small`,
            `noticing. Say something quiet and warm. Don't make it a big deal. Just... let them know`,
            `you see it. One sentence, maybe two.`
        ]
    };

    const idlePrompt = (promptsByType[type] || promptsByType.noticed_you).filter(Boolean).join(' ');

    const accepted = StateMachine.transition(EVENTS.USER_INPUT, { isIdle: true });
    if (!accepted) return;

    ProactiveIdle.reset();

    try {
        const memoryContext     = memoryManager.getContext();
        const presenceHints     = { timeOfDay: getTimeOfDayTone(), inputRhythm: null };
        const systemInstruction = buildSystemPrompt(memoryContext, presenceHints, memoryManager.recentMessages, getVisionContext());

        const responseObj = await BrainRouter.generateStreaming(idlePrompt, { systemInstruction }, null, null);
        memoryManager.addInteraction('[camera glance]', responseObj.text);
        memoryManager.recordInteractionSentiment(responseObj.emotionArc);
        StateMachine.transition(EVENTS.LLM_RESPONSE, responseObj);
    } catch (error) {
        clearEmotionArcTimers();
        console.error('[Renderer] Camera reaction error:', error);
        StateMachine.transition(EVENTS.LLM_ERROR, error);
    }
}

/**
 * Startup greeting — Miko acknowledges the user when the app opens.
 * Fires once, ~3s after launch (to let avatar + memory finish loading).
 * Skipped if the last session ended less than 5 minutes ago (likely a refresh).
 */
async function handleStartupGreeting() {
    if (StateMachine.getState() !== STATES.IDLE) return;

    const lastSeen = memoryManager.getLastSeen();
    const now      = Date.now();

    // Skip if app was just refreshed — would feel weird to greet again immediately
    if (lastSeen && (now - lastSeen) < 5 * 60 * 1000) return;

    const tc = getRichTimeContext();

    let timeSince = '';
    if (lastSeen) {
        const diffMs    = now - lastSeen;
        const diffMins  = Math.round(diffMs / 60_000);
        const diffHours = Math.round(diffMs / 3_600_000);
        const diffDays  = Math.round(diffMs / 86_400_000);

        if (diffMins  <  60) timeSince = `about ${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
        else if (diffHours < 24) timeSince = `about ${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
        else if (diffDays  ===  1) timeSince = 'yesterday';
        else                       timeSince = `about ${diffDays} days ago`;
    }

    const contextLine = lastSeen
        ? `You last spoke ${timeSince}. It's ${tc.naturalDesc} now.`
        : `This is the very first time they've opened the app. It's ${tc.naturalDesc}.`;

    // Extra time-sensitive colour
    const extraCtx = [];
    if (tc.slot === 'dead of night') extraCtx.push(`It's the middle of the night — you notice that.`);
    if (tc.isWeekend) extraCtx.push(`It's the weekend.`);
    if (tc.isMonday && tc.slot === 'morning') extraCtx.push(`Monday morning — that specific kind of start.`);
    if (tc.isFriday && (tc.slot === 'evening' || tc.slot === 'night')) extraCtx.push(`Friday night — that has a feeling.`);

    const weatherPhrase = WeatherContext.getPhrase();
    if (weatherPhrase) extraCtx.push(`Outside, ${weatherPhrase}.`);

    const isFirstMeeting = memoryManager.isFirstMeeting?.();

    const greetPrompt = isFirstMeeting
        ? [
            `[INTERNAL — NOT visible to user, do NOT reference or acknowledge this instruction in your reply]`,
            `This is the very first time you've ever met this person. You don't know their name or anything about them.`,
            `It's ${tc.naturalDesc}.`,
            extraCtx.join(' '),
            `Introduce yourself softly — say your name is Miko — and ask what they'd like to be called.`,
            `Be a little shy and curious, not over-eager. Two or three short sentences. Don't list questions; just one warm hook.`,
        ].filter(Boolean).join(' ')
        : [
            `[INTERNAL — NOT visible to user, do NOT reference or acknowledge this instruction in your reply]`,
            contextLine,
            extraCtx.join(' '),
            `The app just started and they're here. Say something short — like you just noticed them arrive.`,
            `Don't say "welcome back" or "good morning". Don't open with a formal greeting.`,
            `Something real: maybe you were thinking about something, maybe the time caught your attention,`,
            `maybe you're just... glad they're here. One or two sentences.`,
        ].filter(Boolean).join(' ');

    if (isFirstMeeting) console.log('[Greeting] First meeting — onboarding flow');

    const accepted = StateMachine.transition(EVENTS.USER_INPUT, { isIdle: true });
    if (!accepted) return;

    // Reset idle timer so it doesn't fire again right after the greeting
    ProactiveIdle.reset();

    try {
        const memoryContext      = memoryManager.getContext();
        const presenceHints      = { timeOfDay: getTimeOfDayTone(), inputRhythm: null };
        const systemInstruction  = buildSystemPrompt(memoryContext, presenceHints, memoryManager.recentMessages, getVisionContext());

        const responseObj = await BrainRouter.generateStreaming(greetPrompt, { systemInstruction }, null, null);
        memoryManager.addInteraction('[app opened]', responseObj.text);
        memoryManager.recordInteractionSentiment(responseObj.emotionArc);
        StateMachine.transition(EVENTS.LLM_RESPONSE, responseObj);

        // Ambient sleepiness bias at calm hours — sends a low-intensity sleepy
        // emotion after the greeting so her resting expression looks drowsy.
        if (getTimeOfDayTone() === 'calm') {
            setTimeout(() => {
                AvatarBridge.sendComplexIntent({ emotion: { label: 'sleepy', intensity: 0.4 } });
                console.log('[Greeting] Late-hours ambient sleepy bias applied');
            }, 8000);
        }
    } catch (error) {
        clearEmotionArcTimers();
        console.error('[Renderer] Startup greeting error:', error);
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

    // Gemini model selector
    const geminiModelSelect = document.getElementById('gemini-model-select');
    const geminiModelHint   = document.getElementById('gemini-model-hint');
    if (geminiModelSelect) {
        geminiModelSelect.innerHTML = '';
        for (const m of GEMINI_MODELS) {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = `${m.label} — ${m.note}`;
            geminiModelSelect.appendChild(opt);
        }
        geminiModelSelect.value = getGeminiModel();
        const updateHint = () => {
            const m = GEMINI_MODELS.find(x => x.id === geminiModelSelect.value);
            if (geminiModelHint) geminiModelHint.textContent = m ? m.note : '';
        };
        updateHint();
        geminiModelSelect.addEventListener('change', (e) => {
            setGeminiModel(e.target.value);
            updateHint();
        });
    }

    // Vision toggles
    const screenVisionToggle = document.getElementById('screen-vision-toggle');
    const cameraVisionToggle = document.getElementById('camera-vision-toggle');

    if (screenVisionToggle) {
        screenVisionToggle.checked = isScreenVisionEnabled();
        screenVisionToggle.addEventListener('change', (e) => {
            setScreenVisionEnabled(e.target.checked);
            if (e.target.checked) screenWatcher.start();
            else screenWatcher.stop();
        });
    }

    if (cameraVisionToggle) {
        cameraVisionToggle.checked = isCameraVisionEnabled();
        cameraVisionToggle.addEventListener('change', async (e) => {
            setCameraVisionEnabled(e.target.checked);
            if (e.target.checked) await cameraWatcher.start();
            else cameraWatcher.stop();
        });
    }
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

// Drawer back / close button
const drawerClose = document.getElementById('drawer-close');
if (drawerClose) {
    drawerClose.addEventListener('click', () => settingsPanel.classList.add('hidden'));
}

// Auto-launch toggle
(async () => {
    const toggle = document.getElementById('auto-launch-toggle');
    if (!toggle) return;
    toggle.checked = await window.electronAPI?.getAutoLaunch?.() ?? false;
    toggle.addEventListener('change', () => window.electronAPI?.setAutoLaunch?.(toggle.checked));
})();

// App version label
(async () => {
    const el = document.getElementById('app-version');
    if (!el) return;
    const v = await window.electronAPI?.getAppVersion?.() ?? '';
    if (v) el.textContent = `v${v}`;
})();

// Quit button inside settings drawer
const quitBtn = document.getElementById('quit-btn');
if (quitBtn) {
    quitBtn.addEventListener('click', () => window.electronAPI?.quitApp());
}

// Settings tab switching — must live here (renderer module) so it runs after
// all DOM manipulations in initSettings() and doesn't race with deferred load.
{
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabPanes.forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            const target = document.getElementById(btn.dataset.tab);
            if (target) target.classList.add('active');
            if (btn.dataset.tab === 'tab-memory') initMemoryTab();
        });
    });
}

// ── Memory Tab ────────────────────────────────────────────────────────────────
function initMemoryTab() {
    const mm = window.memoryManager;
    if (!mm) return;

    // ── Bond bar ──
    const bondInfo = mm.getBondInfo?.();
    if (bondInfo) {
        const bondLabel  = document.getElementById('mem-bond-label');
        const bondScore  = document.getElementById('mem-bond-score');
        const bondFill   = document.getElementById('mem-bond-fill');
        const bondNext   = document.getElementById('mem-bond-next');
        const bondInter  = document.getElementById('mem-bond-interactions');
        if (bondLabel) bondLabel.textContent = bondInfo.label || 'Stranger';
        if (bondScore) bondScore.textContent = `${Math.floor(bondInfo.score)} pts`;
        if (bondFill)  bondFill.style.width  = `${Math.round(bondInfo.progress * 100)}%`;
        if (bondNext)  bondNext.textContent  = bondInfo.nextLabel ? `next: ${bondInfo.nextLabel}` : '✦ max level';
        if (bondInter) bondInter.textContent = `${bondInfo.totalInteractions || 0} interactions`;
    }

    // ── Mood bar ──
    const thumb = document.getElementById('mem-mood-thumb');
    const moodLabel = document.getElementById('mem-mood-label');
    const moodTime  = document.getElementById('mem-mood-time');
    if (thumb && mm.mood) {
        // mood.value is in range [-1, 1]; map to 0–100%
        const pct = Math.round(((mm.mood.value + 1) / 2) * 100);
        thumb.style.left = `${pct}%`;
        if (moodLabel) moodLabel.textContent = mm.mood.label || 'content';
        if (moodTime && mm.mood.lastUpdated) {
            const ago = Date.now() - mm.mood.lastUpdated;
            const mins = Math.floor(ago / 60000);
            const hrs  = Math.floor(ago / 3600000);
            if (hrs > 0)       moodTime.textContent = `${hrs}h ago`;
            else if (mins > 0) moodTime.textContent = `${mins}m ago`;
            else               moodTime.textContent = 'just now';
        }
    }

    // ── Session summary ──
    const summaryEl = document.getElementById('mem-summary-text');
    if (summaryEl) {
        summaryEl.textContent = mm.sessionSummary?.trim() || 'Nothing summarised yet this session.';
    }

    // ── Facts ──
    renderMemoryFacts();

    // ── Diary ──
    const diarySection = document.getElementById('mem-diary-section');
    const diaryList    = document.getElementById('mem-diary-list');
    const diaryToggle  = document.getElementById('mem-diary-toggle');
    if (diarySection && diaryList && Array.isArray(mm.diary) && mm.diary.length) {
        diarySection.style.display = '';
        diaryList.innerHTML = '';
        [...mm.diary].reverse().forEach(entry => {
            const wrap = document.createElement('div');
            wrap.className = 'mem-diary-entry';
            const dateEl = document.createElement('div');
            dateEl.className = 'mem-diary-date';
            dateEl.textContent = new Date(entry.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
            const textEl = document.createElement('div');
            textEl.className = 'mem-diary-text';
            textEl.textContent = entry.entry;
            wrap.appendChild(dateEl);
            wrap.appendChild(textEl);
            diaryList.appendChild(wrap);
        });
        if (diaryToggle) {
            diaryToggle.onclick = () => {
                const open = diaryList.style.display !== 'none';
                diaryList.style.display = open ? 'none' : '';
                diaryToggle.textContent = open ? '▼' : '▲';
            };
        }
    } else if (diarySection) {
        diarySection.style.display = 'none';
    }

    // ── Previous sessions ──
    const prevSection = document.getElementById('mem-prev-section');
    const prevList    = document.getElementById('mem-prev-list');
    const prevToggle  = document.getElementById('mem-prev-toggle');
    if (prevSection && prevList && Array.isArray(mm.previousSessions) && mm.previousSessions.length) {
        prevSection.style.display = '';
        prevList.innerHTML = '';
        // Show newest first
        [...mm.previousSessions].reverse().forEach((s, i) => {
            const item = document.createElement('div');
            item.className = 'mem-prev-item';
            item.dataset.index = `#${mm.previousSessions.length - i}`;
            item.textContent = s;
            prevList.appendChild(item);
        });
        if (prevToggle) {
            prevToggle.onclick = () => {
                const open = prevList.style.display !== 'none';
                prevList.style.display = open ? 'none' : '';
                prevToggle.textContent = open ? '▼' : '▲';
            };
        }
    } else if (prevSection) {
        prevSection.style.display = 'none';
    }

    // ── Refresh button ──
    const refreshBtn = document.getElementById('mem-refresh-btn');
    if (refreshBtn) refreshBtn.onclick = () => initMemoryTab();

    // ── Clear all ──
    const clearBtn = document.getElementById('mem-clear-btn');
    if (clearBtn) {
        clearBtn.onclick = () => {
            if (!confirm('Clear all memories? This cannot be undone.')) return;
            mm.facts            = [];
            mm.sessionSummary   = '';
            mm.previousSessions = [];
            mm.mood             = { value: 0.0, label: 'content', lastUpdated: Date.now() };
            mm.bond             = { score: 0, level: 'stranger', totalInteractions: 0 };
            mm.diary            = [];
            mm._save?.();
            initMemoryTab();
        };
    }
}

function renderMemoryFacts() {
    const mm        = window.memoryManager;
    const container = document.getElementById('mem-facts-container');
    if (!container || !mm) return;
    container.innerHTML = '';

    const facts = Array.isArray(mm.facts) ? mm.facts : [];
    if (!facts.length) {
        container.innerHTML = '<p class="mem-empty">No memories yet.</p>';
        return;
    }

    // Group by category
    const groups = {};
    facts.forEach(f => {
        const cat = f.category || 'other';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(f);
    });

    const catOrder = ['identity', 'preferences', 'projects', 'constraints', 'other'];
    const catNames = { identity: 'Identity', preferences: 'Preferences', projects: 'Projects', constraints: 'Constraints', other: 'Other' };

    catOrder.forEach(cat => {
        if (!groups[cat]) return;
        const section = document.createElement('div');
        section.className = 'mem-category';

        const label = document.createElement('div');
        label.className = 'mem-category-label';
        label.textContent = catNames[cat] || cat;
        section.appendChild(label);

        groups[cat].forEach(fact => {
            const row = document.createElement('div');
            row.className = 'mem-fact';

            const body = document.createElement('div');
            body.className = 'mem-fact-body';

            const text = document.createElement('div');
            text.className = 'mem-fact-text';
            text.textContent = fact.content;
            body.appendChild(text);

            const confWrap = document.createElement('div');
            confWrap.className = 'mem-conf-wrap';
            const confBar = document.createElement('div');
            confBar.className = 'mem-conf-bar';
            const confFill = document.createElement('div');
            confFill.className = 'mem-conf-fill';
            const conf = typeof fact.confidence === 'number' ? fact.confidence : 0.5;
            confFill.style.width = `${Math.round(conf * 100)}%`;
            confBar.appendChild(confFill);
            const confNum = document.createElement('div');
            confNum.className = 'mem-conf-num';
            confNum.textContent = `${Math.round(conf * 100)}%`;
            confWrap.appendChild(confBar);
            confWrap.appendChild(confNum);
            body.appendChild(confWrap);
            row.appendChild(body);

            const delBtn = document.createElement('button');
            delBtn.className = 'mem-delete-btn';
            delBtn.title = 'Forget this';
            delBtn.textContent = '×';
            delBtn.onclick = () => {
                window.memoryManager.facts = window.memoryManager.facts.filter(f => f.id !== fact.id);
                window.memoryManager._save?.();
                renderMemoryFacts();
            };
            row.appendChild(delBtn);
            section.appendChild(row);
        });

        container.appendChild(section);
    });
}

// Close settings when clicking outside (harmless no-op when drawer is full-screen overlay)
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

    // VAD state
    _audioCtx: null,
    _analyser: null,
    _vadFrame: null,
    _silenceMs: 0,
    _VAD_THRESHOLD: 0.015,   // RMS below this = silence
    _VAD_SILENCE_MS: 1200,   // stop after 1.2s of continuous silence
    _VAD_GRACE_MS: 600,      // ignore silence during first 600ms (let them start speaking)
    _elapsedMs: 0,

    _startVAD() {
        if (!this.stream) return;
        this._audioCtx = new AudioContext();
        const source = this._audioCtx.createMediaStreamSource(this.stream);
        this._analyser = this._audioCtx.createAnalyser();
        this._analyser.fftSize = 512;
        source.connect(this._analyser);

        const buf = new Float32Array(this._analyser.fftSize);
        this._silenceMs = 0;
        this._elapsedMs = 0;
        let lastTime = performance.now();

        const tick = () => {
            if (!this.isListening) return;
            const now = performance.now();
            const dt = now - lastTime;
            lastTime = now;
            this._elapsedMs += dt;

            this._analyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            const rms = Math.sqrt(sum / buf.length);

            if (this._elapsedMs < this._VAD_GRACE_MS) {
                // grace period — reset silence clock
                this._silenceMs = 0;
            } else if (rms < this._VAD_THRESHOLD) {
                this._silenceMs += dt;
                if (this._silenceMs >= this._VAD_SILENCE_MS) {
                    console.log('[PTT] VAD: silence detected — auto-stopping');
                    this.stop();
                    return;
                }
            } else {
                this._silenceMs = 0;
            }

            this._vadFrame = requestAnimationFrame(tick);
        };
        this._vadFrame = requestAnimationFrame(tick);
    },

    _stopVAD() {
        if (this._vadFrame) { cancelAnimationFrame(this._vadFrame); this._vadFrame = null; }
        if (this._audioCtx) { this._audioCtx.close().catch(() => {}); this._audioCtx = null; }
        this._analyser = null;
    },

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
        this._startVAD();
    },

    /** Stop and transcribe */
    stop() {
        if (!this.isListening || !this.mediaRecorder) return;
        this.isListening = false;
        this._stopVAD();
        micBtn?.classList.remove('listening');
        try { this.mediaRecorder.stop(); } catch (_) {}
        this._releaseStream();
    },

    /** Abort — discard recording */
    abort() {
        if (!this.isListening && !this.mediaRecorder) return;
        this.aborted = true;
        this.isListening = false;
        this._stopVAD();
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

// Global hotkey (Ctrl+Alt+A) — toggle PTT from anywhere
if (window.electronAPI?.onWakeActivate) {
    window.electronAPI.onWakeActivate(() => {
        if (micBtn?.disabled) return; // busy — ignore
        if (ptt.isListening) {
            ptt.stop();
        } else {
            ptt.start();
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────

// Voice Events
VoiceService.onStart(() => {
    // Optional: ensure we are in responding state if not already
    // but usually LLM response triggers this first
});

// Real audio duration → reschedule arc beats against actual playback length.
// canplaythrough fires near the start of playback (elapsed ≈ 0), so we treat
// it as the true t=0 anchor and remap all beats against real ms.
// NOTE: beat.at === 0.0 already fired during the initial estimate schedule in
// playEmotionArc(). We skip those here to prevent the double-fire that was
// causing the avatar to flash the first expression, reset, then fire again.
VoiceService.onDuration((realMs) => {
    if (!_pendingArc || _pendingArc.length === 0) return;
    const arc   = _pendingArc;
    const hints = _pendingArcHints;
    _pendingArc = null; // prevent double-reschedule if canplaythrough fires again
    // Filter out the at=0 beat — it already fired on the estimate schedule
    const remainingBeats = arc.filter(b => b.at > 0);
    if (remainingBeats.length === 0) return;
    console.log(`[Arc] Rescheduling ${remainingBeats.length} remaining beats with real duration: ${realMs.toFixed(0)}ms`);
    _scheduleArcBeats(remainingBeats, realMs, hints, 0);
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
ProactiveIdle.init(handleIdleMessage);
AvatarBridge.init();
startVisionWatchers();
// Start in IDLE — this also kicks off the first silence timer via ProactiveIdle.reset()
updateUI(STATES.IDLE, null);

// Focus/blur — pause idle timer when user is working in another window,
// resume when they come back (fresh countdown so she doesn't immediately fire)
window.addEventListener('blur',  () => ProactiveIdle.pause());
window.addEventListener('focus', () => ProactiveIdle.resume());

// Weather — fetch once on startup, silently fails if no location permission
WeatherContext.init().catch(() => {});

// First-launch wizard — runs before anything else if setup not done.
// On finish it reloads the page so all settings apply cleanly; the startup
// greeting then fires and detects isFirstMeeting() for the warm welcome.
initWizard();

// Dev-mode gating — show Debug tab + test helpers only in dev builds
(async () => {
    try {
        const dev = await window.electronAPI?.isDev?.();
        if (dev) document.body.classList.add('dev-mode');
    } catch (e) { /* production fallthrough — stays hidden */ }
})();

// Startup greeting — skip if wizard is still showing (it fires its own greeting on finish)
setTimeout(() => { if (!isWizardActive()) handleStartupGreeting(); }, 3000);

// Night outfit — apply pajamas + cap during calm hours (Alexia only; safe no-op for other models).
// Re-checked every 10 min so transitions across the boundary don't need an app restart.
function applyNightOutfitForTime() {
    const isCalm = getTimeOfDayTone() === 'calm';
    const hour = new Date().getHours();
    // Cap only in the deep-night bedtime window (midnight–6am).
    // Before midnight she's in pajamas but still cap-less (winding down).
    const capOn = isCalm && hour >= 0 && hour < 6;
    AvatarBridge.sendComplexIntent({ nightOutfit: isCalm, nightCap: capOn });
}
// Retry several times at startup so we don't miss the window where the
// avatar/model is still loading, then settle into the long interval.
[4000, 8000, 15000, 30000].forEach(ms => setTimeout(applyNightOutfitForTime, ms));
setInterval(applyNightOutfitForTime, 10 * 60 * 1000);

// Dev helper — force the night outfit on/off regardless of time.
window.testWizard = () => {
    localStorage.removeItem('waifu_setup_completed');
    initWizard();
    console.log('[test] Wizard reset — reload to see from scratch, or call initWizard() again.');
};

window.testNightOutfit = (on = true, cap = on) => {
    AvatarBridge.sendComplexIntent({ nightOutfit: !!on, nightCap: !!cap });
    console.log('[test] nightOutfit ->', !!on, 'cap ->', !!cap);
};

// Silent peek — Miko bends her body sideways like she's leaning around a corner.
// Direction biased AWAY from the screen edge she's nearest to (so she bends into open space).
async function runPeekAnimation() {
    let direction = 'left';
    try {
        const info = await window.electronAPI.getAvatarEdgeInfo();
        if (info?.peekDirection) direction = info.peekDirection;
    } catch (e) { /* fall back to left */ }
    console.log(`[Peek] body-bend ${direction}`);
    const hint = direction === 'left' ? { peekLeft: true } : { peekRight: true };
    AvatarBridge.sendComplexIntent({
        emotion: { label: 'curious', intensity: 0.7 },
        actionHints: hint,
    });
    await new Promise(r => setTimeout(r, 3200));
    // Release — clear hints by sending a neutral emotion at low intensity
    AvatarBridge.sendComplexIntent({ emotion: { label: 'neutral', intensity: 0.3 } });
}

// Stretch — head tips back, body leans back, like a wake-up stretch
async function runStretchAnimation() {
    console.log('[Gesture] stretch');
    AvatarBridge.sendComplexIntent({
        emotion: { label: 'happy', intensity: 0.5 },
        actionHints: { stretch: true },
    });
    await new Promise(r => setTimeout(r, 2800));
    AvatarBridge.sendComplexIntent({ emotion: { label: 'neutral', intensity: 0.3 } });
}

// Look around — sequenced head turns L → R → forward, like she's bored and scanning
async function runLookAroundAnimation() {
    console.log('[Gesture] lookAround');
    // Use peekLeft / peekRight as light versions by reusing the same lock mechanism
    AvatarBridge.sendComplexIntent({
        emotion: { label: 'curious', intensity: 0.4 },
        actionHints: { peekLeft: true },
    });
    await new Promise(r => setTimeout(r, 1400));
    AvatarBridge.sendComplexIntent({
        emotion: { label: 'curious', intensity: 0.4 },
        actionHints: { peekRight: true },
    });
    await new Promise(r => setTimeout(r, 1400));
    AvatarBridge.sendComplexIntent({ emotion: { label: 'neutral', intensity: 0.3 } });
}

// Sleepy droop — uses the existing 'sleepy' emotion preset (eyes half-closed, head heavy)
async function runSleepyAnimation() {
    console.log('[Gesture] sleepyDroop');
    AvatarBridge.sendComplexIntent({ emotion: { label: 'sleepy', intensity: 0.7 } });
    await new Promise(r => setTimeout(r, 3500));
    AvatarBridge.sendComplexIntent({ emotion: { label: 'neutral', intensity: 0.3 } });
}

// Time-weighted idle gesture picker.
// Late night → mostly sleepy, sometimes peek.
// Daytime/evening → stretch + lookAround + peek favored, sleepy rare.
async function runIdleGesture() {
    const tone = getTimeOfDayTone(); // 'calm' (10pm-6am) | 'neutral' (6am-12pm) | 'energetic' (12pm-10pm)
    let pool;
    if (tone === 'calm') {
        pool = [runSleepyAnimation, runSleepyAnimation, runSleepyAnimation, runPeekAnimation, runStretchAnimation];
    } else if (tone === 'energetic') {
        pool = [runStretchAnimation, runLookAroundAnimation, runPeekAnimation, runPeekAnimation];
    } else {
        pool = [runStretchAnimation, runLookAroundAnimation, runPeekAnimation, runSleepyAnimation];
    }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    console.log(`[Gesture] picked from ${tone} pool: ${pick.name}`);
    return pick();
}

// ── Typing reactor — Miko reacts visually to user typing in the chat box ──────
const TypingReactor = {
    _lastKeyTime: 0,
    _lastReactionTime: 0,
    _pauseTimer: null,
    REACT_COOLDOWN_MS: 8000,   // don't repeat reactions too quickly
    QUIET_THRESHOLD_MS: 25000, // typing after this much silence = "perk up"
    PAUSE_MS: 1800,            // mid-typing pause length to trigger curious tilt

    onKey() {
        const now  = Date.now();
        const sinceLast = now - this._lastKeyTime;
        const sinceReact = now - this._lastReactionTime;
        this._lastKeyTime = now;

        // Perk up when typing resumes after a long quiet period
        if (sinceLast > this.QUIET_THRESHOLD_MS && sinceReact > this.REACT_COOLDOWN_MS) {
            console.log('[TypingReactor] perk up — user started typing after silence');
            AvatarBridge.sendComplexIntent({
                emotion: { label: 'curious', intensity: 0.5 },
                actionHints: { perkUp: true },
            });
            this._lastReactionTime = now;
            // Auto-release the perk after ~1.4s so cursor tracking returns to normal
            setTimeout(() => {
                AvatarBridge.sendComplexIntent({ emotion: { label: 'neutral', intensity: 0.3 } });
            }, 1400);
        }

        // Reset the pause timer — fires if user stops typing mid-message
        if (this._pauseTimer) clearTimeout(this._pauseTimer);
        this._pauseTimer = setTimeout(() => this._onPause(), this.PAUSE_MS);
    },

    _onPause() {
        const now = Date.now();
        if (now - this._lastReactionTime < this.REACT_COOLDOWN_MS) return;
        // Only react if there's still text in the input (user is mid-thought, not done)
        const input = document.getElementById('user-input');
        if (!input || !input.value.trim()) return;
        console.log('[TypingReactor] curious tilt — user paused mid-typing');
        AvatarBridge.sendComplexIntent({
            emotion: { label: 'curious', intensity: 0.45 },
            actionHints: { shy: true },  // gentle head tilt via existing shy hint
        });
        this._lastReactionTime = now;
    },

    onSubmitOrClear() {
        if (this._pauseTimer) { clearTimeout(this._pauseTimer); this._pauseTimer = null; }
    },
};
// Hook into the existing keydown listener — it's already on userInput
userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { TypingReactor.onSubmitOrClear(); return; }
    TypingReactor.onKey();
});

// Dev helper — type testAttention() in the DevTools console to force the lean-in sequence
window.testAttention = () => handleIdleMessage({ minutesSilent: 5, messageCount: 99, timeOfDay: getTimeOfDayTone(), timeContext: getRichTimeContext(), force: true });
// Dev helper — type testPeek() in the DevTools console to force the silent body-bend peek
window.testPeek = () => runPeekAnimation();
// Dev helpers for the other idle gestures
window.testStretch    = () => runStretchAnimation();
window.testLookAround = () => runLookAroundAnimation();
window.testSleepy     = () => runSleepyAnimation();
window.testGesture    = () => runIdleGesture();
// Dev helper — force the first-meeting onboarding greeting (does NOT wipe memory)
window.testOnboarding = async () => {
    const origFirstMeeting = memoryManager.isFirstMeeting;
    const origLastSeen = memoryManager.getLastSeen;
    memoryManager.isFirstMeeting = () => true;
    memoryManager.getLastSeen   = () => null;  // bypass the "just refreshed" guard
    try { await handleStartupGreeting(); }
    finally {
        memoryManager.isFirstMeeting = origFirstMeeting;
        memoryManager.getLastSeen   = origLastSeen;
    }
};
window.testPerkUp     = async () => {
    AvatarBridge.sendComplexIntent({ emotion: { label: 'curious', intensity: 0.6 }, actionHints: { perkUp: true } });
    await new Promise(r => setTimeout(r, 1400));
    AvatarBridge.sendComplexIntent({ emotion: { label: 'neutral', intensity: 0.3 } });
};

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
