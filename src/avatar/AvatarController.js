/**
 * Avatar Controller
 * The central orchestrator for the avatar process.
 * 
 * Rules:
 * - Only ONE system writes to Live2D parameters per frame.
 * - Blends DesiredParameterState from IdleAnimator, MotionIntentMapper, and MouthSync.
 * - Handles model reloading completely to prevent Pixi memory leaks.
 */

import { CapabilityRegistry } from './CapabilityRegistry.js';
import { EmotionMapper } from './EmotionMapper.js';
import { MotionIntentMapper } from './MotionIntentMapper.js';
import { MouthSync } from './MouthSync.js';
import { IdleAnimator } from './IdleAnimator.js';
import { GazeAnimator } from './GazeAnimator.js';
import { PARAM_IDS } from './avatar-config.js';

export class AvatarController {
    constructor(live2dRenderer) {
        this.renderer = live2dRenderer; // Still needed for actual PIXI/Live2D execution
        this.isEnabled = true;

        // Sub-systems
        this.registry = new CapabilityRegistry();
        this.emotionMapper = new EmotionMapper(this.registry);
        this.intentMapper = new MotionIntentMapper(this.registry);
        this.mouthSync = new MouthSync();
        this.idleAnimator = new IdleAnimator(this.registry);
        this.gazeAnimator = new GazeAnimator(this.registry);
        this.cursorInfluence = {};
        this.emotionParams = {};

        this.activeEmotion = null;

        // Emotion persistence/decay ─────────────────────────────────────────────
        // After the final arc beat, each emotion lingers for a label-specific
        // duration before transitioning back to neutral. Heavy emotions linger
        // longer; high-energy ones snap back quickly.
        this._decayTimer = null;

        // How long (ms) each emotion holds before fading to neutral.
        // Emotions not listed use _DEFAULT_DECAY_MS.
        this._EMOTION_DECAY_MS = {
            longing:     8000,
            lonely:      8000,
            tender:      7000,
            sad:         7000,
            melancholic: 7000,
            calm:        6000,
            kind:        5000,
            shy:         4500,
            grateful:    4500,
            happy:       4000,
            curious:     3500,
            playful:     2500,
            embarrassed: 3500,
            flustered:   2500,
            confused:    3000,
            anger:       2000,
            excited:     1500,
            surprised:   1200,
            neutral:        0,  // no linger — snap to rest immediately
        };
        this._DEFAULT_DECAY_MS = 3000;
        // ────────────────────────────────────────────────────────────────────────

        // Keep a reference to the bound tick function so we can add/remove it cleanly
        this.boundTick = this._onTick.bind(this);
        this.isLooping = false;
    }

    /**
     * Start the animation and parameter blending loop
     */
    startLoop() {
        if (!this.isLooping && this.renderer && this.renderer.app) {
            this.renderer.app.ticker.add(this.boundTick);
            this.isLooping = true;
        }
    }

    /**
     * Stop the animation loop
     */
    stopLoop() {
        if (this.isLooping && this.renderer && this.renderer.app) {
            this.renderer.app.ticker.remove(this.boundTick);
            this.isLooping = false;
        }
    }

    /**
     * Re-initializes everything when a new model loads
     * Prevents Pixi memory leaks
     * @param {Live2DModel} newModel 
     * @param {string} modelPath
     */
    async onModelLoaded(newModel, modelPath) {
        this.stopLoop();

        // Detect capabilities
        const caps = await this.registry.discover(newModel, modelPath);

        // Pass updated registry to subsystems
        this.emotionMapper.setRegistry(this.registry);
        this.intentMapper.setRegistry(this.registry);
        this.idleAnimator.setRegistry(this.registry);
        this.gazeAnimator.setRegistry(this.registry);

        console.log('[AvatarController] Capabilities Rebuilt:', Object.keys(caps).filter(k => caps[k]));

        // Clear emotion params on new model
        this.emotionParams = {};
        this.currentEmotionValues = {};
        this.transitionStartValues = {};
        this.transitionProgress = 1.0; // 1.0 = complete (no transition)
        this.transitionStartTime = 0;

        // CRITICAL: Monkey-patch the model's internal update to inject our
        // emotion parameter overrides AFTER the motion/expression/physics
        // pipeline runs. Without this, pixi-live2d-display's internal update
        // resets params like ParamEyeLSmile, ParamMouthForm, etc. every frame,
        // overwriting our manual writes from the ticker.
        //
        // We implement SMOOTH TRANSITIONS using time-based linear interpolation
        // with ease-in-out-cubic easing over a fixed duration.
        if (newModel.internalModel) {
            const originalUpdate = newModel.internalModel.update.bind(newModel.internalModel);
            const controller = this;
            const TRANSITION_DURATION_MS = 800; // Smooth 0.8 second transition

            // Ease-in-out cubic for natural-feeling transitions
            const easeInOutCubic = (t) => {
                return t < 0.5
                    ? 4 * t * t * t
                    : 1 - Math.pow(-2 * t + 2, 3) / 2;
            };

            newModel.internalModel.update = function (dt, now) {
                // Let the original pipeline run (motions, expressions, physics)
                originalUpdate(dt, now);

                // Calculate transition progress (0 to 1)
                if (controller.transitionProgress < 1.0) {
                    const elapsed = performance.now() - controller.transitionStartTime;
                    controller.transitionProgress = Math.min(1.0, elapsed / TRANSITION_DURATION_MS);
                }
                const t = easeInOutCubic(controller.transitionProgress);

                // Collect all param IDs from both start and target
                const allParamIds = new Set([
                    ...Object.keys(controller.emotionParams),
                    ...Object.keys(controller.transitionStartValues)
                ]);

                if (allParamIds.size === 0) return;

                const coreModel = this.coreModel;
                if (!coreModel || !coreModel.setParameterValueById) return;

                for (const paramId of allParamIds) {
                    const startVal = controller.transitionStartValues[paramId] ?? 0;
                    const endVal = controller.emotionParams[paramId] ?? 0;

                    // Linearly interpolate with easing
                    const value = startVal + (endVal - startVal) * t;

                    // Store current value for next transition
                    controller.currentEmotionValues[paramId] = value;

                    // Apply to core model
                    if (Math.abs(value) > 0.001 || Math.abs(endVal) > 0.001) {
                        try {
                            coreModel.setParameterValueById(paramId, value);
                        } catch (e) { /* param not found on this model, skip */ }
                    }
                }

                // Clean up completed zero-value transitions
                if (controller.transitionProgress >= 1.0) {
                    for (const paramId of Object.keys(controller.currentEmotionValues)) {
                        if (Math.abs(controller.currentEmotionValues[paramId]) < 0.001 &&
                            !(paramId in controller.emotionParams)) {
                            delete controller.currentEmotionValues[paramId];
                            delete controller.transitionStartValues[paramId];
                        }
                    }
                }
            };
            console.log('[AvatarController] Patched model.internalModel.update for smooth emotion transitions');
        }

        // Restart loop
        this.startLoop();
    }

    onModelUnloaded() {
        this.stopLoop();
        this.registry.reset();
        this.activeEmotion = null;
    }

    /**
     * Set overall enabled state
     */
    setEnabled(enabled) {
        this.isEnabled = enabled;
        if (!enabled) {
            this.mouthSync.stop();
        }
    }

    /**
     * Handle state change from brain
     * @param {'IDLE' | 'THINKING' | 'RESPONDING'} state 
     */
    handleStateChange(state) {
        if (!this.isEnabled) return;
        console.log('[AvatarController] State mapped:', state);

        this.intentMapper.setAIState(state);

        if (state === 'THINKING') {
            // Cancel any pending decay — a new response is incoming and will set
            // its own emotion, so we don't want neutral to fire mid-flight.
            if (this._decayTimer) {
                clearTimeout(this._decayTimer);
                this._decayTimer = null;
            }
        }

        if (state !== 'RESPONDING') {
            this.mouthSync.stop();
        }
    }

    /**
     * Handle typing rhythm from brain
     */
    handleTypingRhythm(rhythm) {
        if (!this.isEnabled) return;
        this.intentMapper.setTypingRhythm(rhythm);
    }

    /**
     * Process complex intent object from AI
     * @param {Object} intent 
     */
    handleComplexIntent(intent) {
        if (!this.isEnabled || !intent) return;

        console.log('[AvatarController] Received intent:', intent);

        if (intent.emotion) {
            this.activeEmotion = intent.emotion;
            const result = this.emotionMapper.mapEmotion(intent.emotion);
            console.log('[AvatarController] Mapped emotion result:', result);

            if (!result) {
                this._startTransition({});
                return;
            }

            const label = (intent.emotion.label || intent.emotion.emotionLabel || '').toLowerCase();
            const intensity = intent.emotion.intensity || 0.8;

            // Base emotion parameter preset
            let paramPreset = this.emotionMapper._getParameterPreset(label, intensity) || {};

            // Merge actionHints overlay on top — adds reactive bonus effects
            // (blush, ear droop, sparkle, etc.) without overwriting core expression
            if (intent.actionHints && typeof intent.actionHints === 'object') {
                const hintOverlay = this._buildActionHintOverlay(intent.actionHints);
                const activeHints = Object.entries(intent.actionHints)
                    .filter(([, v]) => v).map(([k]) => k);
                if (activeHints.length) {
                    console.log('[AvatarController] ActionHints active:', activeHints.join(', '));
                    paramPreset = { ...paramPreset, ...hintOverlay };
                }
            }

            if (Object.keys(paramPreset).length > 0) {
                console.log('[AvatarController] Starting smooth transition with', Object.keys(paramPreset).length, 'params');
                this._startTransition(paramPreset);
            }

            // Switch blink rhythm and gaze target to match this emotion
            this.idleAnimator.setBlinkProfile(label);
            this.gazeAnimator.setEmotion(label, intensity);

            // Schedule automatic return to neutral after the emotion-specific linger time.
            // Each arc beat resets the timer, so decay only fires after the final beat.
            this._scheduleDecay(label);

            // Play a matching motion if the model has one for this emotion.
            // Fire-and-forget — fails silently when no motions exist (e.g. VT_ELF).
            this._tryPlayMotion(label);

            // Also try expression file as optional bonus
            if (result.type === 'expression' && this.renderer.model) {
                console.log('[AvatarController] Also trying file expression:', result.name);
                try {
                    if (typeof this.renderer.model.expression === 'function') {
                        this.renderer.model.expression(result.name);
                    } else if (this.renderer.model.internalModel?.motionManager?.expressionManager) {
                        this.renderer.model.internalModel.motionManager.expressionManager.setExpression(result.name);
                    }
                } catch (e) {
                    console.warn('[AvatarController] Expression file failed:', e.message);
                }
            }
        }
    }

    /**
     * Build a parameter overlay from actionHints booleans.
     * These are additive reactive effects layered ON TOP of the base emotion preset.
     * They do not override core eye/mouth/brow params — only "bonus" reactive params.
     * @param {Object} hints - { shy, flustered, embarrassed, grateful, hesitant, kind }
     * @returns {Object} paramId → value map
     */
    _buildActionHintOverlay(hints) {
        const overlay = {};
        const caps = this.registry.capabilities;

        // shy / hesitant → gentle head tilt (gaze handled by GazeAnimator)
        if (hints.shy || hints.hesitant) {
            if (caps.hasAngleZ) overlay[PARAM_IDS.ANGLE_Z] = -6;
        }

        // flustered / embarrassed → max blush, elf ear droop, sweat drops, skirt puff
        if (hints.flustered || hints.embarrassed) {
            if (caps.hasCheek) overlay[PARAM_IDS.CHEEK] = 1.0;
            if (this.registry.hasParam(PARAM_IDS.ELF_EAR))   overlay[PARAM_IDS.ELF_EAR]   = -0.5;
            if (this.registry.hasParam(PARAM_IDS.SWEAT_VIS))  overlay[PARAM_IDS.SWEAT_VIS]  = 1.0;
            if (this.registry.hasParam(PARAM_IDS.SKIRT_EXPAND)) overlay[PARAM_IDS.SKIRT_EXPAND] = 0.6;
        }

        // grateful / kind → eye smile + sparkle overlay
        if (hints.grateful || hints.kind) {
            if (caps.hasEyeSmile) {
                overlay[PARAM_IDS.EYE_L_SMILE] = 0.65;
                overlay[PARAM_IDS.EYE_R_SMILE] = 0.65;
            }
            if (this.registry.hasParam(PARAM_IDS.HAPPY_VIS)) overlay[PARAM_IDS.HAPPY_VIS] = 1.0;
            if (this.registry.hasParam(PARAM_IDS.ELF_EAR))   overlay[PARAM_IDS.ELF_EAR]   = 0.3;
        }

        return overlay;
    }

    /**
     * Emotion → motion group priority list.
     * Each entry is an array of group names tried in order — first one present in the
     * loaded model wins. All names are case-sensitive as authored in the model3.json.
     * Falls back silently when none of the groups exist (e.g. VT_ELF).
     */
    static get EMOTION_MOTION_MAP() {
        return {
            shy:         ['Shy', 'Hesitate', 'LookDown', 'Look_Down'],
            embarrassed: ['Shy', 'Embarrassed', 'Hesitate'],
            hesitant:    ['Hesitate', 'Shy', 'LookDown'],
            sad:         ['Sad', 'Cry', 'Sorrow'],
            lonely:      ['Sad', 'Sorrow'],
            longing:     ['Sad', 'LookDown', 'Sorrow'],
            happy:       ['Happy', 'Cheer', 'Excited', 'Joy'],
            excited:     ['Excited', 'Cheer', 'Happy'],
            playful:     ['Playful', 'Tease', 'Happy'],
            surprised:   ['Surprised', 'Shock', 'Surprise'],
            grateful:    ['Happy', 'Cheer', 'Bow'],
            kind:        ['Happy', 'Gentle', 'Bow'],
            tender:      ['Gentle', 'Happy', 'Bow'],
            anger:       ['Angry', 'Anger', 'Stamp'],
            disgusted:   ['Angry', 'Disgust'],
            curious:     ['Think', 'Curious', 'LookAround'],
            // Generic fallbacks for models with simple group names
            neutral:     ['Idle', 'Neutral'],
        };
    }

    /**
     * Try to play a motion that matches the given emotion label.
     * Checks the model's discovered motion groups and plays the first match.
     * No-ops silently when the model has no motions or no matching group.
     * @param {string} label - Emotion label
     */
    async _tryPlayMotion(label) {
        const motionGroups = this.registry.getCapabilities().motionGroups;
        if (!motionGroups || Object.keys(motionGroups).length === 0) return;

        const candidates = AvatarController.EMOTION_MOTION_MAP[label] || [];
        for (const groupName of candidates) {
            if (motionGroups[groupName]) {
                console.log(`[AvatarController] Playing motion: ${groupName} for emotion: ${label}`);
                await this.renderer.playMotion(groupName);
                return;
            }
        }
    }

    /**
     * Schedule an automatic return to neutral after the emotion-specific linger time.
     * Cancels any previously scheduled decay so only the most recent emotion's
     * timer is active — arc beats naturally reset it as they fire.
     * @param {string} label - Emotion label just applied
     */
    _scheduleDecay(label) {
        if (this._decayTimer) {
            clearTimeout(this._decayTimer);
            this._decayTimer = null;
        }

        const delayMs = this._EMOTION_DECAY_MS[label] ?? this._DEFAULT_DECAY_MS;
        if (delayMs <= 0) return; // neutral — no hold needed

        this._decayTimer = setTimeout(() => {
            this._decayTimer = null;
            console.log(`[AvatarController] Emotion decay: ${label} held ${delayMs}ms → returning to neutral`);
            this.idleAnimator.setBlinkProfile(null);
            this.gazeAnimator.setEmotion(null);
            this._startTransition({});
        }, delayMs);
    }

    /**
     * Start a smooth transition from current emotion values to new target params
     * @param {Object} newParams - Target parameter values
     */
    _startTransition(newParams) {
        // Collect all params involved in this transition
        const allParamIds = new Set([
            ...Object.keys(this.currentEmotionValues),
            ...Object.keys(this.emotionParams),
            ...Object.keys(newParams)
        ]);

        // Read ACTUAL current parameter values from the core model.
        // This is critical because the internal pipeline (motions, physics)
        // sets params like ParamEyeLOpen=1.0 that we don't track in
        // currentEmotionValues. Without this, transitions would start
        // from 0 instead of the model's actual displayed value, causing
        // instant jumps (e.g., eyes snapping shut instead of slowly closing).
        let coreModel = null;
        try {
            coreModel = this.renderer.model?.internalModel?.coreModel;
        } catch (e) { /* no core model available */ }

        this.transitionStartValues = {};
        for (const paramId of allParamIds) {
            if (paramId in this.currentEmotionValues) {
                // We've been managing this param — use our tracked value
                this.transitionStartValues[paramId] = this.currentEmotionValues[paramId];
            } else {
                // First time touching this param — read its REAL value from the model
                const realValue = this._readCoreParamValue(coreModel, paramId);
                this.transitionStartValues[paramId] = realValue;
            }
        }

        // Set new target
        this.emotionParams = newParams;

        // Reset transition timer
        this.transitionProgress = 0.0;
        this.transitionStartTime = performance.now();
        console.log('[AvatarController] Transition started:', Object.keys(newParams).length, 'target params');
    }

    /**
     * Read the actual current value of a parameter from the core model.
     * Uses multiple API approaches with smart fallback defaults.
     * @param {Object} coreModel - The Live2D core model
     * @param {string} paramId - The parameter ID to read
     * @returns {number} The current parameter value
     */
    _readCoreParamValue(coreModel, paramId) {
        if (!coreModel) return this._getParamDefault(paramId);

        // Try 1: Direct API (Cubism 4 CubismModelSettingsJson wrapping)
        if (typeof coreModel.getParameterValueById === 'function') {
            try {
                const val = coreModel.getParameterValueById(paramId);
                if (typeof val === 'number' && !isNaN(val)) return val;
            } catch (e) { /* param might not exist */ }
        }

        // Try 2: Internal arrays (Cubism 4 core model internals)
        if (coreModel._parameterIds && coreModel._parameterValues) {
            const idx = coreModel._parameterIds.indexOf(paramId);
            if (idx >= 0) {
                return coreModel._parameterValues[idx];
            }
        }

        // Try 3: Cubism framework model wrapper
        if (coreModel._model && coreModel._model.parameters) {
            const params = coreModel._model.parameters;
            if (params.ids) {
                const idx = params.ids.indexOf(paramId);
                if (idx >= 0 && params.values) {
                    return params.values[idx];
                }
            }
        }

        // Fallback: use smart defaults based on param name
        return this._getParamDefault(paramId);
    }

    /**
     * Get a sensible default value for a parameter we can't read
     * @param {string} paramId
     * @returns {number}
     */
    _getParamDefault(paramId) {
        // Eyes are normally open
        if (paramId.includes('EyeLOpen') || paramId.includes('EyeROpen')) return 1.0;
        // Mouth is normally closed
        if (paramId.includes('MouthOpen')) return 0;
        // Everything else defaults to 0
        return 0;
    }

    /**
     * Handle mouth amplitude for voice sync
     */
    handleMouthAmplitude(amplitude) {
        if (!this.isEnabled) return;
        this.mouthSync.setAmplitude(amplitude);
    }

    /**
     * Handle live cursor tracking inputs
     * @param {Object} influence - Map of param ID to value
     */
    setCursorInfluence(influence) {
        if (!this.isEnabled) return;
        this.cursorInfluence = influence || {};
    }


    /**
     * The single frame tick that blends all parameters
     */
    _onTick(delta) {
        if (!this.isEnabled || !this.renderer.model) return;

        // Delta time in seconds (Pixi delta is usually ~1 at 60fps)
        const dt = delta / 60;

        // 1. Get Intents
        const intentState = this.intentMapper.getDesiredState();

        // 2. Adjust Idle intensity based on emotions and states
        let idleIntensity = 1.0;
        if (this.activeEmotion) idleIntensity = 0.5; // Reduce idle if emotional

        this.idleAnimator.setOverrides({
            pauseIdleBlink: intentState.pauseIdleBlink,
            pauseIdleSway: intentState.pauseIdleSway,
            pauseIdleBreath: intentState.pauseIdleBreath
        }, idleIntensity);

        // 3. Get Subsystem states
        const idleState = this.idleAnimator.update(dt);
        const gazeState = this.gazeAnimator.update(dt);
        const mouthState = this.mouthSync.update(dt);

        // 4. Blend Parameters
        const finalParams = {};

        // Base Idle (Lowest priority)
        Object.assign(finalParams, idleState.parameters);

        // Intent overrides (High priority)
        Object.assign(finalParams, intentState.parameters);

        // Mouth overrides (Absolute priority if speaking)
        if (this.mouthSync.isActive()) {
            Object.assign(finalParams, mouthState.parameters);
        }

        // NOTE: Emotion params are NOT blended here. They are applied by the
        // monkey-patched internalModel.update (see onModelLoaded) which runs
        // AFTER the Live2D pipeline. Writing them here would overwrite the
        // smooth eased transition with the final target value every frame,
        // causing instant snapping instead of gradual interpolation.

        // Gaze — emotion-driven eye direction + micro-wander (medium priority)
        // Applied before cursor so cursor tracking can still override if desired.
        Object.assign(finalParams, gazeState);

        // Live cursor tracking overwrites (Additive/Absolute based on intent)
        Object.assign(finalParams, this.cursorInfluence);

        // 5. Apply to Renderer
        const isSpeaking = this.mouthSync.isActive();

        for (const [paramId, value] of Object.entries(finalParams)) {
            // Skip params that are currently being transitioned by the emotion system
            // to prevent overwriting the smooth interpolation.
            // EXCEPTION: MOUTH_OPEN_Y always wins when voice is playing — emotion
            // presets (surprised, anger, etc.) that set MOUTH_OPEN_Y would otherwise
            // freeze the mouth shut during TTS playback.
            if (paramId in this.emotionParams || paramId in this.transitionStartValues) {
                const isMouthParam = paramId === 'ParamMouthOpenY';
                const isCursorOverride = Object.prototype.hasOwnProperty.call(this.cursorInfluence, paramId);
                if (!isCursorOverride && !(isMouthParam && isSpeaking)) {
                    continue;
                }
            }

            const isImmediate = Object.prototype.hasOwnProperty.call(this.cursorInfluence, paramId);
            this.renderer.setParameter(paramId, value, isImmediate);
        }
    }
}
