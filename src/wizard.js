/**
 * First-launch Setup Wizard
 * Guides new users through API key setup and avatar selection.
 * Self-contained — injects its own styles, cleans up on completion.
 */

import {
    setCloudApiKey, setCloudProvider, setModelMode, MODEL_MODE,
    setOpenRouterApiKey,
    setElevenLabsApiKey, setVoiceEnabled, setTTSEngine, TTS_ENGINE,
    setGroqSttApiKey,
    setGeminiModel, setOpenRouterModel, setOllamaModel,
    hasCompletedSetup, setSetupCompleted
} from './settings.js';

// ─── Styles ───────────────────────────────────────────────────────────────────

const WIZARD_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,300;0,400;0,600;1,300;1,400&family=DM+Sans:wght@300;400;500&display=swap');

#wizard-overlay {
    position: fixed;
    inset: 0;
    z-index: 99999;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #080518;
    overflow: hidden;
    font-family: 'DM Sans', 'Segoe UI', sans-serif;
}

/* Animated star field */
#wizard-overlay::before {
    content: '';
    position: absolute;
    inset: 0;
    background-image:
        radial-gradient(1px 1px at 10% 20%, rgba(255,200,220,0.6) 0%, transparent 100%),
        radial-gradient(1px 1px at 30% 60%, rgba(180,200,255,0.5) 0%, transparent 100%),
        radial-gradient(1.5px 1.5px at 50% 15%, rgba(255,180,210,0.7) 0%, transparent 100%),
        radial-gradient(1px 1px at 70% 40%, rgba(160,210,255,0.5) 0%, transparent 100%),
        radial-gradient(2px 2px at 85% 75%, rgba(255,190,215,0.4) 0%, transparent 100%),
        radial-gradient(1px 1px at 20% 80%, rgba(200,180,255,0.5) 0%, transparent 100%),
        radial-gradient(1px 1px at 60% 85%, rgba(255,200,230,0.4) 0%, transparent 100%),
        radial-gradient(1.5px 1.5px at 90% 10%, rgba(180,220,255,0.6) 0%, transparent 100%),
        radial-gradient(1px 1px at 40% 45%, rgba(255,170,200,0.3) 0%, transparent 100%),
        radial-gradient(1px 1px at 75% 90%, rgba(200,200,255,0.4) 0%, transparent 100%);
    animation: wiz-twinkle 6s ease-in-out infinite alternate;
    pointer-events: none;
}

/* Ambient bloom */
#wizard-overlay::after {
    content: '';
    position: absolute;
    inset: 0;
    background:
        radial-gradient(ellipse 60% 40% at 20% 80%, rgba(255,100,150,0.07) 0%, transparent 70%),
        radial-gradient(ellipse 50% 50% at 80% 20%, rgba(100,150,255,0.07) 0%, transparent 70%);
    pointer-events: none;
}

@keyframes wiz-twinkle {
    0%   { opacity: 0.4; transform: scale(1); }
    100% { opacity: 1;   transform: scale(1.02); }
}

/* Card */
.wiz-card {
    position: relative;
    z-index: 1;
    width: 480px;
    max-width: calc(100vw - 32px);
    background: rgba(14, 10, 35, 0.92);
    border: 1px solid rgba(255, 140, 180, 0.15);
    border-radius: 20px;
    box-shadow:
        0 0 60px rgba(255, 100, 150, 0.08),
        0 0 120px rgba(100, 130, 255, 0.05),
        inset 0 1px 0 rgba(255, 200, 220, 0.08);
    padding: 40px 44px 36px;
    animation: wiz-card-in 0.6s cubic-bezier(0.16, 1, 0.3, 1) both;
}

@keyframes wiz-card-in {
    from { opacity: 0; transform: translateY(24px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0)   scale(1); }
}

/* Progress dots */
.wiz-dots {
    display: flex;
    gap: 7px;
    justify-content: center;
    margin-bottom: 36px;
}

.wiz-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: rgba(255, 140, 180, 0.2);
    transition: all 0.35s ease;
}

.wiz-dot.active {
    background: #ff85a8;
    box-shadow: 0 0 8px rgba(255, 133, 168, 0.6);
    transform: scale(1.3);
}

.wiz-dot.done {
    background: rgba(255, 133, 168, 0.45);
}

/* Step container */
.wiz-step {
    display: none;
    animation: wiz-step-in 0.4s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.wiz-step.visible {
    display: block;
}

@keyframes wiz-step-in {
    from { opacity: 0; transform: translateX(18px); }
    to   { opacity: 1; transform: translateX(0); }
}

/* Eyebrow tag */
.wiz-eyebrow {
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 2.5px;
    text-transform: uppercase;
    color: rgba(255, 133, 168, 0.6);
    margin-bottom: 10px;
}

/* Heading */
.wiz-heading {
    font-family: 'Crimson Pro', 'Palatino Linotype', Palatino, Georgia, serif;
    font-size: 28px;
    font-weight: 300;
    line-height: 1.25;
    color: #ffe4ef;
    margin: 0 0 10px;
    letter-spacing: -0.3px;
}

.wiz-heading em {
    font-style: italic;
    color: #ff9ec0;
}

/* Sub text */
.wiz-sub {
    font-size: 13px;
    color: rgba(200, 185, 215, 0.65);
    line-height: 1.6;
    margin-bottom: 28px;
}

/* Provider toggle */
.wiz-provider-tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 18px;
}

.wiz-provider-tab {
    flex: 1;
    padding: 9px 0;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 10px;
    color: rgba(200, 185, 215, 0.5);
    font-family: 'DM Sans', sans-serif;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
}

.wiz-provider-tab .tab-name { font-size: 13px; color: inherit; }
.wiz-provider-tab .tab-hint { font-size: 10px; opacity: 0.6; }

.wiz-provider-tab:hover {
    border-color: rgba(255, 133, 168, 0.2);
    color: rgba(255, 200, 220, 0.7);
}

.wiz-provider-tab.selected {
    background: rgba(255, 133, 168, 0.08);
    border-color: rgba(255, 133, 168, 0.35);
    color: #ff9ec0;
    box-shadow: 0 0 16px rgba(255, 133, 168, 0.1);
}

/* Input fields */
.wiz-field {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin-bottom: 16px;
}

.wiz-label {
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: rgba(200, 185, 215, 0.5);
}

.wiz-input {
    width: 100%;
    padding: 12px 16px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 10px;
    color: #e8d8f0;
    font-family: 'DM Sans', 'Segoe UI', sans-serif;
    font-size: 13px;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
    box-sizing: border-box;
}

.wiz-input::placeholder { color: rgba(200, 185, 215, 0.25); }

.wiz-input:focus {
    border-color: rgba(255, 133, 168, 0.4);
    box-shadow: 0 0 0 3px rgba(255, 133, 168, 0.07);
}

.wiz-input.has-value {
    border-color: rgba(255, 133, 168, 0.25);
}

/* Key hint link */
.wiz-key-hint {
    font-size: 11px;
    color: rgba(160, 180, 255, 0.5);
    margin-top: -10px;
    margin-bottom: 6px;
}

/* Avatar cards */
.wiz-avatar-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    margin-bottom: 24px;
}

.wiz-avatar-card {
    position: relative;
    padding: 22px 16px 18px;
    background: rgba(255, 255, 255, 0.03);
    border: 1.5px solid rgba(255, 255, 255, 0.07);
    border-radius: 14px;
    cursor: pointer;
    transition: all 0.25s ease;
    text-align: center;
    overflow: hidden;
}

.wiz-avatar-card::before {
    content: '';
    position: absolute;
    inset: 0;
    opacity: 0;
    transition: opacity 0.25s;
    border-radius: 14px;
}

.wiz-avatar-card.elf::before {
    background: radial-gradient(ellipse at 50% 0%, rgba(160, 230, 180, 0.1) 0%, transparent 70%);
}

.wiz-avatar-card.alexia::before {
    background: radial-gradient(ellipse at 50% 0%, rgba(255, 150, 200, 0.1) 0%, transparent 70%);
}

.wiz-avatar-card:hover::before,
.wiz-avatar-card.selected::before {
    opacity: 1;
}

.wiz-avatar-card:hover {
    transform: translateY(-2px);
}

.wiz-avatar-card.elf:hover,
.wiz-avatar-card.elf.selected {
    border-color: rgba(130, 220, 160, 0.4);
    box-shadow: 0 0 24px rgba(130, 220, 160, 0.08);
}

.wiz-avatar-card.alexia:hover,
.wiz-avatar-card.alexia.selected {
    border-color: rgba(255, 133, 168, 0.4);
    box-shadow: 0 0 24px rgba(255, 133, 168, 0.08);
}

.wiz-avatar-emoji {
    font-size: 32px;
    margin-bottom: 10px;
    display: block;
    filter: drop-shadow(0 0 8px currentColor);
}

.wiz-avatar-name {
    font-family: 'Crimson Pro', Georgia, serif;
    font-size: 17px;
    font-weight: 400;
    color: #e8d8f0;
    margin-bottom: 4px;
}

.wiz-avatar-desc {
    font-size: 11px;
    color: rgba(200, 185, 215, 0.45);
    line-height: 1.5;
}

.wiz-avatar-badge {
    display: inline-block;
    margin-top: 8px;
    padding: 2px 8px;
    border-radius: 20px;
    font-size: 9px;
    font-weight: 500;
    letter-spacing: 1px;
    text-transform: uppercase;
}

.wiz-avatar-card.elf .wiz-avatar-badge {
    background: rgba(130, 220, 160, 0.1);
    color: rgba(130, 220, 160, 0.7);
    border: 1px solid rgba(130, 220, 160, 0.2);
}

.wiz-avatar-card.alexia .wiz-avatar-badge {
    background: rgba(255, 133, 168, 0.1);
    color: rgba(255, 133, 168, 0.7);
    border: 1px solid rgba(255, 133, 168, 0.2);
}

.wiz-avatar-card.selected .wiz-avatar-name { color: #fff; }

/* Checkmark for selected */
.wiz-avatar-card .wiz-check {
    position: absolute;
    top: 10px;
    right: 12px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #ff85a8;
    display: none;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    color: #fff;
    box-shadow: 0 0 10px rgba(255, 133, 168, 0.5);
}

.wiz-avatar-card.selected .wiz-check { display: flex; }

/* Buttons row */
.wiz-actions {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-top: 8px;
}

.wiz-btn-primary {
    flex: 1;
    padding: 13px 24px;
    background: linear-gradient(135deg, #ff85a8 0%, #e06090 100%);
    border: none;
    border-radius: 11px;
    color: #fff;
    font-family: 'DM Sans', sans-serif;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    box-shadow: 0 4px 20px rgba(255, 133, 168, 0.25);
    letter-spacing: 0.2px;
}

.wiz-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 6px 28px rgba(255, 133, 168, 0.35);
}

.wiz-btn-primary:active { transform: translateY(0); }
.wiz-btn-primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
}

.wiz-btn-skip {
    padding: 13px 18px;
    background: transparent;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 11px;
    color: rgba(200, 185, 215, 0.4);
    font-family: 'DM Sans', sans-serif;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s;
}

.wiz-btn-skip:hover {
    border-color: rgba(255,255,255,0.15);
    color: rgba(200, 185, 215, 0.65);
}

/* Done step */
.wiz-done-glow {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(255,133,168,0.2) 0%, transparent 70%);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 32px;
    margin: 0 auto 24px;
    animation: wiz-pulse 2.5s ease-in-out infinite;
}

@keyframes wiz-pulse {
    0%, 100% { box-shadow: 0 0 20px rgba(255,133,168,0.15); }
    50%       { box-shadow: 0 0 40px rgba(255,133,168,0.3); }
}

.wiz-summary {
    list-style: none;
    padding: 0;
    margin: 0 0 28px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.wiz-summary li {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: rgba(200, 185, 215, 0.65);
    padding: 10px 14px;
    background: rgba(255,255,255,0.03);
    border-radius: 9px;
    border: 1px solid rgba(255,255,255,0.05);
}

.wiz-summary li .sum-icon { font-size: 14px; }
.wiz-summary li .sum-label { flex: 1; }
.wiz-summary li .sum-val {
    font-size: 11px;
    color: rgba(255, 133, 168, 0.7);
    font-weight: 500;
}

/* Error message */
.wiz-error {
    font-size: 12px;
    color: rgba(255, 120, 120, 0.8);
    margin-top: -8px;
    margin-bottom: 10px;
    display: none;
}

.wiz-error.visible { display: block; }
`;

// ─── Wizard state ─────────────────────────────────────────────────────────────

let state = {
    step: 0,
    llmProvider: 'gemini',   // 'gemini' | 'openrouter'
    llmKey: '',
    elevenLabsKey: '',
    groqKey: '',
    avatarPath: null,
    avatarName: null,
    availableModels: [],
    active: false,
    onFinishCallback: null
};

/** Returns true while the wizard overlay is visible — lets renderer suppress the normal startup greeting */
export function isWizardActive() { return state.active; }

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * @param {Object} [opts]
 * @param {Function} [opts.onFinish] - called after wizard closes; receives { avatarName }
 */
export async function initWizard({ onFinish } = {}) {
    if (hasCompletedSetup()) return;
    state.onFinishCallback = onFinish || null;
    state.active = true;

    // Inject styles
    const style = document.createElement('style');
    style.textContent = WIZARD_CSS;
    document.head.appendChild(style);

    // Load available models
    try {
        state.availableModels = await window.electronAPI?.getAvailableModels?.() || [];
    } catch (e) {
        state.availableModels = [];
    }

    // Build overlay
    const overlay = document.getElementById('wizard-overlay');
    if (!overlay) return;
    overlay.innerHTML = buildOverlayHTML();
    overlay.style.display = 'flex';

    // Wire events
    wireEvents(overlay);

    // Show step 0
    showStep(overlay, 0);
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

function buildOverlayHTML() {
    const models = state.availableModels;
    const elfModel = models.find(m => m.name.toLowerCase().includes('elf') || m.path?.toLowerCase().includes('elf'));
    const alexiaModel = models.find(m => m.name.toLowerCase().includes('alexia'));

    const elfPath = elfModel?.path || '';
    const alexiaPath = alexiaModel?.path || '';

    return `
    <div class="wiz-card">
        <button data-action="dev-close" title="Close (dev only)" style="position:absolute;top:14px;right:16px;background:none;border:none;color:rgba(255,255,255,0.2);font-size:18px;cursor:pointer;line-height:1;padding:4px 6px;border-radius:6px;transition:color 0.2s" onmouseover="this.style.color='rgba(255,255,255,0.5)'" onmouseout="this.style.color='rgba(255,255,255,0.2)'">✕</button>
        <div class="wiz-dots">
            <div class="wiz-dot" data-dot="0"></div>
            <div class="wiz-dot" data-dot="1"></div>
            <div class="wiz-dot" data-dot="2"></div>
            <div class="wiz-dot" data-dot="3"></div>
            <div class="wiz-dot" data-dot="4"></div>
        </div>

        <!-- Step 0: Welcome -->
        <div class="wiz-step" data-step="0">
            <div class="wiz-eyebrow">First Launch</div>
            <h1 class="wiz-heading">Hello,<br><em>nice to meet you.</em></h1>
            <p class="wiz-sub">I'm your AI companion. Before we begin, let's take a minute to set things up — it'll only take a moment.</p>
            <div class="wiz-actions">
                <button class="wiz-btn-primary" data-action="next">Let's begin →</button>
            </div>
        </div>

        <!-- Step 1: LLM API key -->
        <div class="wiz-step" data-step="1">
            <div class="wiz-eyebrow">Step 1 of 4</div>
            <h1 class="wiz-heading">Your <em>AI brain</em></h1>
            <p class="wiz-sub">Choose a provider and paste your API key. Gemini is recommended — it's powerful and has a generous free tier.</p>
            <div class="wiz-provider-tabs">
                <button class="wiz-provider-tab selected" data-provider="gemini">
                    <span class="tab-name">Gemini</span>
                    <span class="tab-hint">Recommended</span>
                </button>
                <button class="wiz-provider-tab" data-provider="openrouter">
                    <span class="tab-name">OpenRouter</span>
                    <span class="tab-hint">Any model</span>
                </button>
                <button class="wiz-provider-tab" data-provider="ollama">
                    <span class="tab-name">Ollama</span>
                    <span class="tab-hint">Local · no key</span>
                </button>
            </div>
            <div id="llm-key-field" class="wiz-field">
                <label class="wiz-label" id="llm-key-label">Gemini API Key</label>
                <input class="wiz-input" id="llm-key-input" type="password" placeholder="Paste your API key here…" autocomplete="off" />
            </div>
            <div class="wiz-key-hint" id="llm-key-hint">
                Get a free key at <span style="color:rgba(180,200,255,0.7)">aistudio.google.com</span>
            </div>
            <div id="llm-ollama-hint" style="display:none;font-size:12px;color:rgba(160,220,180,0.7);margin-bottom:16px;line-height:1.5">
                Make sure Ollama is running locally (<span style="opacity:0.8">ollama serve</span>) with at least one model pulled.
            </div>
            <div class="wiz-field" style="margin-top:4px">
                <label class="wiz-label">Model ID <span style="opacity:0.4;font-size:9px;letter-spacing:0">(leave blank for default)</span></label>
                <input class="wiz-input" id="llm-model-input" type="text" placeholder="gemini-2.5-flash" autocomplete="off" spellcheck="false" />
            </div>
            <div class="wiz-key-hint" id="llm-model-hint" style="margin-bottom:4px">
                e.g. <span style="color:rgba(180,200,255,0.7)">gemini-2.5-pro</span>, <span style="color:rgba(180,200,255,0.7)">gemma-3-27b-it</span>
            </div>
            <div class="wiz-error" id="llm-error">Please enter your API key to continue.</div>
            <div class="wiz-actions">
                <button class="wiz-btn-skip" data-action="back">← Back</button>
                <button class="wiz-btn-primary" data-action="next">Continue →</button>
            </div>
        </div>

        <!-- Step 2: Voice & Listening -->
        <div class="wiz-step" data-step="2">
            <div class="wiz-eyebrow">Step 2 of 4</div>
            <h1 class="wiz-heading">Voice &amp; <em>Listening</em></h1>
            <p class="wiz-sub">Optional but lovely. ElevenLabs gives me a beautiful voice. Groq lets me hear you speak.</p>
            <div class="wiz-field">
                <label class="wiz-label">ElevenLabs API Key <span style="opacity:0.4;font-size:9px;letter-spacing:0">(TTS · optional)</span></label>
                <input class="wiz-input" id="elevenlabs-key-input" type="password" placeholder="sk-…" autocomplete="off" />
            </div>
            <div class="wiz-key-hint">Get a key at <span style="color:rgba(180,200,255,0.7)">elevenlabs.io</span></div>
            <div class="wiz-field" style="margin-top:6px">
                <label class="wiz-label">Groq API Key <span style="opacity:0.4;font-size:9px;letter-spacing:0">(STT · optional)</span></label>
                <input class="wiz-input" id="groq-key-input" type="password" placeholder="gsk_…" autocomplete="off" />
            </div>
            <div class="wiz-key-hint" style="margin-bottom:20px">Get a free key at <span style="color:rgba(180,200,255,0.7)">console.groq.com</span></div>
            <div class="wiz-actions">
                <button class="wiz-btn-skip" data-action="back">← Back</button>
                <button class="wiz-btn-skip" data-action="next" style="flex:0.6">Skip</button>
                <button class="wiz-btn-primary" data-action="save-voice">Save &amp; Continue →</button>
            </div>
        </div>

        <!-- Step 3: Avatar picker -->
        <div class="wiz-step" data-step="3">
            <div class="wiz-eyebrow">Step 3 of 4</div>
            <h1 class="wiz-heading">Choose your <em>companion</em></h1>
            <p class="wiz-sub">You can always switch later from the settings.</p>
            <div class="wiz-avatar-grid">
                <div class="wiz-avatar-card elf" data-avatar="elf" data-path="${elfPath}">
                    <div class="wiz-check">✓</div>
                    <span class="wiz-avatar-emoji">🧝</span>
                    <div class="wiz-avatar-name">Elf</div>
                    <div class="wiz-avatar-desc">Gentle &amp; expressive. Pointy ears that droop when sad.</div>
                    <div class="wiz-avatar-badge">Recommended</div>
                </div>
                <div class="wiz-avatar-card alexia" data-avatar="alexia" data-path="${alexiaPath}">
                    <div class="wiz-check">✓</div>
                    <span class="wiz-avatar-emoji">🌸</span>
                    <div class="wiz-avatar-name">Alexia</div>
                    <div class="wiz-avatar-desc">Lively &amp; detailed. Even changes into pajamas at night.</div>
                    <div class="wiz-avatar-badge">Recommended</div>
                </div>
            </div>
            <div class="wiz-error" id="avatar-error">Please choose a companion to continue.</div>
            <div class="wiz-actions">
                <button class="wiz-btn-skip" data-action="back">← Back</button>
                <button class="wiz-btn-primary" data-action="next">Continue →</button>
            </div>
        </div>

        <!-- Step 4: Done -->
        <div class="wiz-step" data-step="4">
            <div class="wiz-done-glow">✨</div>
            <div class="wiz-eyebrow" style="text-align:center">All set!</div>
            <h1 class="wiz-heading" style="text-align:center;margin-bottom:18px">You're <em>ready to go</em></h1>
            <ul class="wiz-summary" id="wiz-summary"></ul>
            <div class="wiz-actions">
                <button class="wiz-btn-primary" data-action="finish">Open the app →</button>
            </div>
        </div>
    </div>`;
}

// ─── Step rendering ───────────────────────────────────────────────────────────

function showStep(overlay, step) {
    state.step = step;

    // Update dots
    overlay.querySelectorAll('.wiz-dot').forEach((dot, i) => {
        dot.classList.toggle('active', i === step);
        dot.classList.toggle('done', i < step);
    });

    // Show correct step
    overlay.querySelectorAll('.wiz-step').forEach(el => {
        el.classList.remove('visible');
        const s = parseInt(el.dataset.step, 10);
        if (s === step) {
            el.classList.add('visible');
        }
    });
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

function wireEvents(overlay) {
    overlay.addEventListener('click', async (e) => {
        // Provider tabs
        const providerTab = e.target.closest('[data-provider]');
        if (providerTab) {
            selectProvider(overlay, providerTab.dataset.provider);
            return;
        }

        // Avatar cards
        const avatarCard = e.target.closest('[data-avatar]');
        if (avatarCard) {
            selectAvatar(overlay, avatarCard);
            return;
        }

        // Action buttons
        const actionBtn = e.target.closest('[data-action]');
        if (!actionBtn) return;

        switch (actionBtn.dataset.action) {
            case 'next':       handleNext(overlay); break;
            case 'back':       showStep(overlay, state.step - 1); break;
            case 'save-voice': handleSaveVoice(overlay); break;
            case 'finish':     handleFinish(overlay); break;
            case 'dev-close':
                state.active = false;
                overlay.style.transition = 'opacity 0.3s ease';
                overlay.style.opacity = '0';
                setTimeout(() => { overlay.style.display = 'none'; overlay.innerHTML = ''; }, 300);
                break;
        }
    });

    // Live input styling
    overlay.addEventListener('input', (e) => {
        if (e.target.classList.contains('wiz-input')) {
            e.target.classList.toggle('has-value', e.target.value.trim().length > 0);
        }
    });
}

function selectProvider(overlay, provider) {
    state.llmProvider = provider;
    overlay.querySelectorAll('.wiz-provider-tab').forEach(t => {
        t.classList.toggle('selected', t.dataset.provider === provider);
    });
    const label      = overlay.querySelector('#llm-key-label');
    const hint       = overlay.querySelector('#llm-key-hint');
    const keyField   = overlay.querySelector('#llm-key-field');
    const ollamaHint = overlay.querySelector('#llm-ollama-hint');

    const modelInput = overlay.querySelector('#llm-model-input');
    const modelHint  = overlay.querySelector('#llm-model-hint');

    if (provider === 'ollama') {
        keyField.style.display   = 'none';
        hint.style.display       = 'none';
        ollamaHint.style.display = 'block';
        if (modelInput) modelInput.placeholder = 'phi4-mini:3.8b';
        if (modelHint)  modelHint.innerHTML = 'Run <span style="color:rgba(180,200,255,0.7)">ollama list</span> to see available models';
    } else {
        keyField.style.display   = '';
        hint.style.display       = '';
        ollamaHint.style.display = 'none';
        if (provider === 'gemini') {
            label.textContent = 'Gemini API Key';
            hint.innerHTML = 'Get a free key at <span style="color:rgba(180,200,255,0.7)">aistudio.google.com</span>';
            if (modelInput) modelInput.placeholder = 'gemini-2.5-flash';
            if (modelHint)  modelHint.innerHTML = 'e.g. <span style="color:rgba(180,200,255,0.7)">gemini-2.5-pro</span>, <span style="color:rgba(180,200,255,0.7)">gemma-3-27b-it</span>';
        } else {
            label.textContent = 'OpenRouter API Key';
            hint.innerHTML = 'Get a key at <span style="color:rgba(180,200,255,0.7)">openrouter.ai/keys</span>';
            if (modelInput) modelInput.placeholder = 'google/gemma-4-31b-it:free';
            if (modelHint)  modelHint.innerHTML = 'Browse models at <span style="color:rgba(180,200,255,0.7)">openrouter.ai/models</span>';
        }
    }
}

function selectAvatar(overlay, card) {
    overlay.querySelectorAll('.wiz-avatar-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    state.avatarPath = card.dataset.path;
    state.avatarName = card.dataset.avatar;
    overlay.querySelector('#avatar-error')?.classList.remove('visible');
}

// ─── Step actions ─────────────────────────────────────────────────────────────

function handleNext(overlay) {
    const step = state.step;

    if (step === 1) {
        const keyInput = overlay.querySelector('#llm-key-input');
        const key = keyInput?.value.trim();
        // Ollama needs no key — skip validation
        if (state.llmProvider !== 'ollama' && !key) {
            overlay.querySelector('#llm-error')?.classList.add('visible');
            return;
        }
        overlay.querySelector('#llm-error')?.classList.remove('visible');
        state.llmKey = key;

        // Save model ID if provided
        const modelId = overlay.querySelector('#llm-model-input')?.value.trim();

        // Save LLM key / mode / model
        if (state.llmProvider === 'ollama') {
            setModelMode(MODEL_MODE.LOCAL_ONLY);
            if (modelId) setOllamaModel(modelId);
        } else if (state.llmProvider === 'gemini') {
            setCloudProvider('gemini');
            setCloudApiKey(key);
            setModelMode(MODEL_MODE.CLOUD_PREFERRED);
            if (modelId) setGeminiModel(modelId);
        } else {
            setCloudProvider('openrouter');
            setOpenRouterApiKey(key);
            setModelMode(MODEL_MODE.CLOUD_PREFERRED);
            if (modelId) setOpenRouterModel(modelId);
        }
    }

    if (step === 3) {
        // Validate avatar chosen
        if (!state.avatarPath) {
            overlay.querySelector('#avatar-error')?.classList.add('visible');
            return;
        }
        // Apply avatar
        applyAvatarChoice();
        // Build summary
        buildSummary(overlay);
    }

    showStep(overlay, step + 1);
}

function handleSaveVoice(overlay) {
    const elKey   = overlay.querySelector('#elevenlabs-key-input')?.value.trim();
    const groqKey = overlay.querySelector('#groq-key-input')?.value.trim();

    if (elKey) {
        setElevenLabsApiKey(elKey);
        setVoiceEnabled(true);
        setTTSEngine(TTS_ENGINE.ELEVEN_LABS);
        state.elevenLabsKey = elKey;
    }
    if (groqKey) {
        setGroqSttApiKey(groqKey);
        state.groqKey = groqKey;
    }

    showStep(overlay, state.step + 1);
}

async function applyAvatarChoice() {
    if (!state.avatarPath) return;
    try {
        await window.electronAPI?.changeAvatarModel?.(state.avatarPath);
    } catch (e) {
        console.warn('[Wizard] Could not switch avatar model:', e);
    }
}

function buildSummary(overlay) {
    const el = overlay.querySelector('#wiz-summary');
    if (!el) return;

    const providerLabel = state.llmProvider === 'gemini' ? 'Gemini'
        : state.llmProvider === 'ollama' ? 'Ollama (local)'
        : 'OpenRouter';
    const avatarLabel   = state.avatarName
        ? state.avatarName.charAt(0).toUpperCase() + state.avatarName.slice(1)
        : '—';

    const rows = [
        { icon: '🧠', label: 'AI Brain', val: providerLabel + ' · configured' },
        { icon: '🎙️', label: 'Voice', val: state.elevenLabsKey ? 'ElevenLabs · configured' : 'System TTS' },
        { icon: '👂', label: 'Listening', val: state.groqKey ? 'Groq STT · configured' : 'Not configured' },
        { icon: '🌸', label: 'Companion', val: avatarLabel }
    ];

    el.innerHTML = rows.map(r => `
        <li>
            <span class="sum-icon">${r.icon}</span>
            <span class="sum-label">${r.label}</span>
            <span class="sum-val">${r.val}</span>
        </li>
    `).join('');
}

function handleFinish(overlay) {
    setSetupCompleted();
    state.active = false;

    // Enable the avatar window so it shows immediately on reload
    localStorage.setItem('avatar_enabled', 'true');

    overlay.style.transition = 'opacity 0.6s ease';
    overlay.style.opacity = '0';
    setTimeout(() => {
        // Reload the app so all saved settings (LLM mode, keys, voice, model)
        // are picked up cleanly by every subsystem. The startup greeting will
        // detect isFirstMeeting() === true and show a warm welcome automatically.
        location.reload();
    }, 600);
}
