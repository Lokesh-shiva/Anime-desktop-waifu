/**
 * Avatar Window Renderer (Browser Version)
 * Entry point for the avatar window renderer process
 * Uses globally loaded PIXI and PIXI.live2d from script tags
 * 
 * Rules:
 * - Only receives signals
 * - Never sends data back
 * - Graceful failure if model is missing
 */

// Default model path
const DEFAULT_MODEL_PATH = '../2D_Livemodel/tuzi mian.model3.json';

// Animation timing configuration
const TIMING = {
    BLINK_INTERVAL_MIN: 2.0,
    BLINK_INTERVAL_MAX: 5.0,
    BLINK_DURATION: 0.15,
    BREATH_CYCLE: 4.0,
    MOUTH_CYCLE: 0.3,
    IDLE_SWAY_CYCLE: 6.0,
    IDLE_SWAY_AMPLITUDE: 3.0
};

// Common Live2D parameter IDs
const PARAM_IDS = {
    EYE_L_OPEN: 'ParamEyeLOpen',
    EYE_R_OPEN: 'ParamEyeROpen',
    EYE_L_SMILE: 'ParamEyeLSmile',
    EYE_R_SMILE: 'ParamEyeRSmile',
    EYE_BALL_X: 'ParamEyeBallX',
    EYE_BALL_Y: 'ParamEyeBallY',
    MOUTH_OPEN_Y: 'ParamMouthOpenY',
    MOUTH_FORM: 'ParamMouthForm',
    ANGLE_X: 'ParamAngleX',
    ANGLE_Y: 'ParamAngleY',
    ANGLE_Z: 'ParamAngleZ',
    BODY_ANGLE_X: 'ParamBodyAngleX',
    BODY_ANGLE_Y: 'ParamBodyAngleY',
    BODY_ANGLE_Z: 'ParamBodyAngleZ',
    BROW_L_Y: 'ParamBrowLY',
    BROW_R_Y: 'ParamBrowRY',
    BREATH: 'ParamBreath'
};

// State behaviors
const STATE_BEHAVIORS = {
    IDLE: {
        blinkEnabled: true,
        breathingEnabled: true,
        headSwayEnabled: true,
        mouthEnabled: false
    },
    THINKING: {
        blinkEnabled: false,
        breathingEnabled: true,
        headSwayEnabled: false,
        mouthEnabled: false,
        headTilt: { x: 0, y: 5, z: 8 }
    },
    RESPONDING: {
        blinkEnabled: true,
        breathingEnabled: true,
        headSwayEnabled: false,
        mouthEnabled: true
    }
};

// Tone expressions
const TONE_EXPRESSIONS = {
    calm: { eyeSmile: 0.2, browY: 0, mouthForm: 0.1 },
    neutral: { eyeSmile: 0, browY: 0, mouthForm: 0 },
    energetic: { eyeSmile: 0.4, browY: 0.2, mouthForm: 0.3 }
};

// State
let app = null;
let model = null;
let availableParams = new Set();
let isInitialized = false;
let initialModelWidth = 0;
let initialModelHeight = 0;

// Animation state
let animState = {
    blinkTimer: 0,
    nextBlinkTime: randomBlinkInterval(),
    isBlinking: false,
    breathPhase: 0,
    mouthPhase: 0,
    swayPhase: 0
};

// Current values for smooth interpolation
let targetValues = {};
let currentValues = {};

// Behavior flags
let behaviors = {
    blinkEnabled: true,
    breathingEnabled: true,
    headSwayEnabled: true,
    mouthEnabled: false
};

// Current state
let currentState = 'IDLE';
let currentTone = 'neutral';

// Cursor tracking state
let cursorPos = { x: 0.5, y: 0.5 }; // normalized 0-1
let targetCursorInfluence = { eyeX: 0, eyeY: 0, headX: 0, headY: 0 };
let currentCursorInfluence = { eyeX: 0, eyeY: 0, headX: 0, headY: 0 };
let cursorTrackingEnabled = true;

// Boop reaction state
let boopState = {
    isBooping: false,
    timer: 0,
    duration: 0.8,
    bouncePhase: 0
};

// Window drag state
let dragState = {
    enabled: false
};

// Sentiment expressions for text-based reactions
const SENTIMENT_EXPRESSIONS = {
    // Basic emotions
    happy: { eyeSmile: 0.6, browY: 0.3, mouthForm: 0.5, mouthOpen: 0.2, eyeOpen: 1.0 },
    excited: { eyeSmile: 0.8, browY: 0.5, mouthForm: 0.7, mouthOpen: 0.4, eyeOpen: 1.1 },
    curious: { eyeSmile: 0.1, browY: 0.5, mouthForm: 0, mouthOpen: 0.15, eyeOpen: 1.1, headTilt: 8 },
    sad: { eyeSmile: -0.2, browY: -0.4, mouthForm: -0.4, mouthOpen: 0, eyeOpen: 0.7 },
    confused: { eyeSmile: 0, browY: 0.3, mouthForm: -0.2, mouthOpen: 0.1, eyeOpen: 0.9, headTilt: -5 },
    surprised: { eyeSmile: 0.2, browY: 0.7, mouthForm: 0.2, mouthOpen: 0.6, eyeOpen: 1.3 },
    neutral: { eyeSmile: 0, browY: 0, mouthForm: 0, mouthOpen: 0, eyeOpen: 1.0 },

    // Special reactions
    greeting: { eyeSmile: 0.7, browY: 0.4, mouthForm: 0.6, mouthOpen: 0.3, eyeOpen: 1.1, wave: true },
    farewell: { eyeSmile: 0.5, browY: 0.2, mouthForm: 0.4, mouthOpen: 0.1, eyeOpen: 0.9, wave: true },
    laugh: { eyeSmile: 1.0, browY: 0.3, mouthForm: 0.8, mouthOpen: 0.5, eyeOpen: 0.7, bounce: true },
    thinking: { eyeSmile: 0, browY: 0.2, mouthForm: 0.1, mouthOpen: 0, eyeOpen: 0.9, lookUp: true },
    love: { eyeSmile: 0.9, browY: 0.3, mouthForm: 0.6, mouthOpen: 0.2, eyeOpen: 0.8, blush: true },
    proud: { eyeSmile: 0.5, browY: 0.4, mouthForm: 0.5, mouthOpen: 0.1, eyeOpen: 1.0, headUp: true },
    embarrassed: { eyeSmile: 0.3, browY: -0.2, mouthForm: 0.2, mouthOpen: 0.1, eyeOpen: 0.8, blush: true, lookAway: true },
    playful: { eyeSmile: 0.6, browY: 0.3, mouthForm: 0.4, mouthOpen: 0.2, eyeOpen: 1.0, wink: true },
    concerned: { eyeSmile: 0, browY: -0.3, mouthForm: -0.2, mouthOpen: 0.1, eyeOpen: 1.0 },
    apologetic: { eyeSmile: 0.2, browY: -0.4, mouthForm: 0.1, mouthOpen: 0.1, eyeOpen: 0.9, headDown: true }
};

// Special animation state
let specialAnimState = {
    isPlaying: false,
    type: null,
    timer: 0,
    duration: 1.2
};

function randomBlinkInterval() {
    return TIMING.BLINK_INTERVAL_MIN +
        Math.random() * (TIMING.BLINK_INTERVAL_MAX - TIMING.BLINK_INTERVAL_MIN);
}

/**
 * Initialize the avatar
 */
async function init() {
    if (isInitialized) return;

    console.log('[Avatar] Initializing...');

    const container = document.getElementById('avatar-container');
    if (!container) {
        console.error('[Avatar] Container not found');
        return;
    }

    // Check for required globals
    if (typeof PIXI === 'undefined') {
        console.error('[Avatar] PIXI not loaded');
        return;
    }

    console.log('[Avatar] PIXI version:', PIXI.VERSION);

    // Get Live2DModel from pixi-live2d-display
    const Live2DModel = PIXI.live2d?.Live2DModel;
    if (!Live2DModel) {
        console.error('[Avatar] Live2DModel not available');
        console.log('[Avatar] PIXI.live2d:', PIXI.live2d);
        return;
    }

    console.log('[Avatar] Creating PIXI app...');

    // Create PIXI app - v7 uses constructor with options
    try {
        app = new PIXI.Application({
            backgroundAlpha: 0,
            resizeTo: container,
            antialias: true,
            resolution: window.devicePixelRatio || 1,
            autoDensity: true
        });
    } catch (e) {
        console.error('[Avatar] PIXI Application creation failed:', e);
        return;
    }

    // PIXI v7 uses app.view
    const canvas = app.view;
    if (canvas) {
        container.appendChild(canvas);
    } else {
        console.error('[Avatar] No canvas available');
        return;
    }

    console.log('[Avatar] PIXI app created');

    // Load model
    const modelPath = await getModelPath();
    if (!modelPath) {
        console.warn('[Avatar] No model path, showing empty');
        isInitialized = true;
        return;
    }

    try {
        console.log('[Avatar] Loading model:', modelPath);

        // Register ticker
        Live2DModel.registerTicker(PIXI.Ticker);

        model = await Live2DModel.from(modelPath, {
            autoInteract: false,
            autoUpdate: true
        });

        if (!model) {
            console.warn('[Avatar] Model failed to load');
            isInitialized = true;
            return;
        }

        console.log('[Avatar] Model loaded successfully');

        // Discover available parameters
        discoverParameters();

        // Store initial dimensions for scaling - use internal model for stability
        initialModelWidth = model.internalModel.width;
        initialModelHeight = model.internalModel.height;

        console.log('[Avatar] Initial dimensions:', initialModelWidth, initialModelHeight);

        // Position and scale model
        fitModelToView(container);

        // Init UI
        initUI();

        // Add to stage
        app.stage.addChild(model);

        // Start animation loop
        app.ticker.add(onTick);

        isInitialized = true;
        console.log('[Avatar] Ready');

    } catch (error) {
        console.error('[Avatar] Failed to load model:', error);
        isInitialized = true;
    }
}

async function getModelPath() {
    let path = DEFAULT_MODEL_PATH;

    if (window.avatarAPI?.getModelPath) {
        try {
            const p = await window.avatarAPI.getModelPath();
            if (p) path = p;
        } catch (e) {
            console.warn('[Avatar] Could not get model path:', e.message);
        }
    }

    // Convert Windows path to file:// URL
    // D:/folder/file.json -> file:///D:/folder/file.json
    if (path && !path.startsWith('file://') && !path.startsWith('http')) {
        path = 'file:///' + path.replace(/\\/g, '/');
    }

    console.log('[Avatar] Model path:', path);
    return path;
}

function discoverParameters() {
    availableParams.clear();

    if (!model?.internalModel?.coreModel) {
        console.warn('[Avatar] Cannot discover parameters - no coreModel');
        return;
    }

    try {
        const coreModel = model.internalModel.coreModel;

        // Cubism 4 uses _parameterIds array
        if (coreModel._parameterIds) {
            coreModel._parameterIds.forEach(id => availableParams.add(id));
            console.log('[Avatar] Discovered', availableParams.size, 'parameters via _parameterIds');
            return;
        }

        // Fallback: try to get parameter count and iterate
        const paramCount = coreModel.getParameterCount?.() || 0;
        if (paramCount > 0 && coreModel.getParameterId) {
            for (let i = 0; i < paramCount; i++) {
                const paramId = coreModel.getParameterId(i);
                availableParams.add(paramId);
            }
            console.log('[Avatar] Discovered', availableParams.size, 'parameters via getParameterId');
            return;
        }

        // Another fallback: use model's settings
        if (model.internalModel?.settings?.parameterIds) {
            model.internalModel.settings.parameterIds.forEach(id => availableParams.add(id));
            console.log('[Avatar] Discovered', availableParams.size, 'parameters via settings');
            return;
        }

        // Last resort: assume common parameters exist
        console.log('[Avatar] Using default parameter set');
        Object.values(PARAM_IDS).forEach(id => availableParams.add(id));

    } catch (e) {
        console.warn('[Avatar] Parameter discovery failed:', e.message);
        // Use default parameters as fallback
        Object.values(PARAM_IDS).forEach(id => availableParams.add(id));
    }
}

function hasParameter(paramId) {
    // With fallback, assume all common params might exist
    return availableParams.has(paramId) || availableParams.size === 0;
}

function setParameter(paramId, value, immediate = false) {
    if (immediate) {
        currentValues[paramId] = value;
        applyParameter(paramId, value);
    } else {
        targetValues[paramId] = value;
    }
}

function applyParameter(paramId, value) {
    if (!model?.internalModel?.coreModel) return;

    try {
        const coreModel = model.internalModel.coreModel;

        // Cubism 4 API
        if (coreModel.setParameterValueById) {
            coreModel.setParameterValueById(paramId, value);
            return;
        }

        // Alternative: find parameter index and set by index
        if (coreModel._parameterIds && coreModel.setParameterValueByIndex) {
            const index = coreModel._parameterIds.indexOf(paramId);
            if (index >= 0) {
                coreModel.setParameterValueByIndex(index, value);
            }
        }
    } catch (e) {
        // Silently ignore - parameter might not exist
    }
}

function fitModelToView(container) {
    if (!model || !app) return;

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    // Use internal dimensions (unscaled) as the source of truth
    const width = initialModelWidth || model.internalModel.width;
    const height = initialModelHeight || model.internalModel.height;

    // Calculate scale to fit container
    const scale = Math.min(
        containerWidth / width,
        containerHeight / height
    ) * 0.9;

    model.scale.set(scale);
    console.log(`[Avatar] Resize: Container ${containerWidth}x${containerHeight}, Scale ${scale}`);
    model.x = containerWidth / 2;
    model.y = containerHeight;
    model.anchor.set(0.5, 1);
}

function onTick(delta) {
    if (!model) return;

    const dt = delta / 60;

    // Smooth interpolation
    interpolateValues(dt);

    // Interactive features
    updateCursorTracking(dt);
    updateBoop(dt);
    updateSpecialAnim(dt);

    // Auto behaviors
    if (behaviors.blinkEnabled) updateBlink(dt);
    if (behaviors.breathingEnabled) updateBreathing(dt);
    if (behaviors.headSwayEnabled) updateHeadSway(dt);
    if (behaviors.mouthEnabled) updateMouthSync(dt);
}

function interpolateValues(dt) {
    const speed = 8.0;

    for (const [paramId, target] of Object.entries(targetValues)) {
        const current = currentValues[paramId] ?? target;
        const diff = target - current;

        if (Math.abs(diff) < 0.001) {
            currentValues[paramId] = target;
        } else {
            currentValues[paramId] = current + diff * Math.min(1, speed * dt);
        }

        applyParameter(paramId, currentValues[paramId]);
    }
}

function updateBlink(dt) {
    animState.blinkTimer += dt;

    if (animState.isBlinking) {
        const progress = animState.blinkTimer / TIMING.BLINK_DURATION;

        if (progress >= 1) {
            animState.isBlinking = false;
            animState.blinkTimer = 0;
            animState.nextBlinkTime = randomBlinkInterval();
            setParameter(PARAM_IDS.EYE_L_OPEN, 1, true);
            setParameter(PARAM_IDS.EYE_R_OPEN, 1, true);
        } else {
            const eyeOpen = progress < 0.5
                ? 1 - (progress * 2)
                : (progress - 0.5) * 2;
            setParameter(PARAM_IDS.EYE_L_OPEN, eyeOpen, true);
            setParameter(PARAM_IDS.EYE_R_OPEN, eyeOpen, true);
        }
    } else if (animState.blinkTimer >= animState.nextBlinkTime) {
        animState.isBlinking = true;
        animState.blinkTimer = 0;
    }
}

function updateBreathing(dt) {
    animState.breathPhase += dt / TIMING.BREATH_CYCLE * Math.PI * 2;
    if (animState.breathPhase > Math.PI * 2) animState.breathPhase -= Math.PI * 2;

    const breathValue = (Math.sin(animState.breathPhase) + 1) / 2;
    setParameter(PARAM_IDS.BREATH, breathValue, true);
}

function updateHeadSway(dt) {
    animState.swayPhase += dt / TIMING.IDLE_SWAY_CYCLE * Math.PI * 2;
    if (animState.swayPhase > Math.PI * 2) animState.swayPhase -= Math.PI * 2;

    const swayValue = Math.sin(animState.swayPhase) * TIMING.IDLE_SWAY_AMPLITUDE;
    setParameter(PARAM_IDS.ANGLE_Z, swayValue, true);
}

function updateMouthSync(dt) {
    animState.mouthPhase += dt / TIMING.MOUTH_CYCLE * Math.PI * 2;
    if (animState.mouthPhase > Math.PI * 2) animState.mouthPhase -= Math.PI * 2;

    const mouthOpen = (Math.sin(animState.mouthPhase) + 1) / 2 * 0.7;
    setParameter(PARAM_IDS.MOUTH_OPEN_Y, mouthOpen, true);
}

// State handling
function setState(state) {
    if (state === currentState) return;

    console.log('[Avatar] State:', currentState, '→', state);
    currentState = state;

    const behavior = STATE_BEHAVIORS[state];
    if (!behavior) return;

    behaviors.blinkEnabled = behavior.blinkEnabled;
    behaviors.breathingEnabled = behavior.breathingEnabled;
    behaviors.headSwayEnabled = behavior.headSwayEnabled;
    behaviors.mouthEnabled = behavior.mouthEnabled;

    if (state === 'THINKING' && behavior.headTilt) {
        setParameter(PARAM_IDS.ANGLE_X, behavior.headTilt.x);
        setParameter(PARAM_IDS.ANGLE_Y, behavior.headTilt.y);
        setParameter(PARAM_IDS.ANGLE_Z, behavior.headTilt.z);
    } else if (state === 'IDLE') {
        setParameter(PARAM_IDS.ANGLE_X, 0);
        setParameter(PARAM_IDS.ANGLE_Y, 0);
    }

    if (state === 'RESPONDING') {
        applyToneExpression(currentTone);
    } else {
        applyNeutralExpression();
    }
}

function setTone(tone) {
    if (!tone || tone === currentTone) return;

    console.log('[Avatar] Tone:', currentTone, '→', tone);
    currentTone = tone;

    if (currentState === 'RESPONDING') {
        applyToneExpression(tone);
    }
}

function setTypingRhythm(rhythm) {
    if (currentState !== 'IDLE') return;

    let normalizedRhythm = 'normal';
    if (rhythm === 'playful' || rhythm === 'fast') {
        normalizedRhythm = 'fast';
    } else if (rhythm === 'gentle' || rhythm === 'slow') {
        normalizedRhythm = 'slow';
    }

    console.log('[Avatar] Rhythm:', normalizedRhythm);

    if (normalizedRhythm === 'fast') {
        setParameter(PARAM_IDS.ANGLE_Z, -5);
        setParameter(PARAM_IDS.EYE_BALL_Y, 0.2);
    } else if (normalizedRhythm === 'slow') {
        setParameter(PARAM_IDS.ANGLE_Z, 0);
        setParameter(PARAM_IDS.EYE_BALL_Y, 0);
    }
}

function applyToneExpression(tone) {
    const expr = TONE_EXPRESSIONS[tone] || TONE_EXPRESSIONS.neutral;

    setParameter(PARAM_IDS.EYE_L_SMILE, expr.eyeSmile);
    setParameter(PARAM_IDS.EYE_R_SMILE, expr.eyeSmile);
    setParameter(PARAM_IDS.BROW_L_Y, expr.browY);
    setParameter(PARAM_IDS.BROW_R_Y, expr.browY);
    setParameter(PARAM_IDS.MOUTH_FORM, expr.mouthForm);
}

function applyNeutralExpression() {
    setParameter(PARAM_IDS.EYE_L_SMILE, 0);
    setParameter(PARAM_IDS.EYE_R_SMILE, 0);
    setParameter(PARAM_IDS.BROW_L_Y, 0);
    setParameter(PARAM_IDS.BROW_R_Y, 0);
    setParameter(PARAM_IDS.MOUTH_FORM, 0);
    setParameter(PARAM_IDS.MOUTH_OPEN_Y, 0);
}

// ================================
// Cursor Tracking
// ================================

function updateCursorTracking(dt) {
    // Don't track cursor during boop or special animations
    if (!cursorTrackingEnabled || boopState.isBooping || specialAnimState.isPlaying) return;

    // Normalize cursor position to -1 to 1 range (centered)
    const normX = (cursorPos.x - 0.5) * 2;
    const normY = (cursorPos.y - 0.5) * 2;

    // Calculate target influences
    // Eyes move more than head for natural look
    targetCursorInfluence.eyeX = normX * 1.0;  // Full range for eyes
    targetCursorInfluence.eyeY = -normY * 0.8; // Inverted Y for correct up/down
    targetCursorInfluence.headX = normX * 12;  // Head moves in degrees
    targetCursorInfluence.headY = -normY * 8;  // Inverted Y

    // Smooth interpolation
    const speed = 5.0;
    currentCursorInfluence.eyeX += (targetCursorInfluence.eyeX - currentCursorInfluence.eyeX) * speed * dt;
    currentCursorInfluence.eyeY += (targetCursorInfluence.eyeY - currentCursorInfluence.eyeY) * speed * dt;
    currentCursorInfluence.headX += (targetCursorInfluence.headX - currentCursorInfluence.headX) * speed * dt;
    currentCursorInfluence.headY += (targetCursorInfluence.headY - currentCursorInfluence.headY) * speed * dt;

    // Apply to eye parameters (only if no expression override)
    setParameter(PARAM_IDS.EYE_BALL_X, currentCursorInfluence.eyeX, true);
    setParameter(PARAM_IDS.EYE_BALL_Y, currentCursorInfluence.eyeY, true);

    // Apply head tracking (subtle, only when no special anim)
    setParameter(PARAM_IDS.ANGLE_X, currentCursorInfluence.headX, true);
    setParameter(PARAM_IDS.ANGLE_Y, currentCursorInfluence.headY, true);
}

function handleMouseDown(e) {
    if (e.button !== 0) return; // Only left click

    // Only drag if enabled
    if (dragState.enabled) {
        dragState.isDragging = true;
        dragState.offsetX = e.clientX;
        dragState.offsetY = e.clientY;
        dragState.hasMoved = false;
    }
}

function handleMouseUp(e) {
    dragState.isDragging = false;
}

function handleMouseMove(e) {
    const container = document.getElementById('avatar-container');
    if (!container) return;

    const rect = container.getBoundingClientRect();
    cursorPos.x = (e.clientX - rect.left) / rect.width;
    cursorPos.y = (e.clientY - rect.top) / rect.height;
}

// ================================
// Boop Interaction
// ================================

function triggerBoop() {
    if (boopState.isBooping) return;

    console.log('[Avatar] Boop!');
    boopState.isBooping = true;
    boopState.timer = 0;
    boopState.bouncePhase = 0;

    // Immediate surprised reaction - wide eyes, raised brows, open mouth
    setParameter(PARAM_IDS.EYE_L_OPEN, 1.3, true);  // Eyes wide open
    setParameter(PARAM_IDS.EYE_R_OPEN, 1.3, true);
    setParameter(PARAM_IDS.EYE_L_SMILE, 0, true);   // Not smiling yet
    setParameter(PARAM_IDS.EYE_R_SMILE, 0, true);
    setParameter(PARAM_IDS.BROW_L_Y, 0.8, true);    // Raised eyebrows
    setParameter(PARAM_IDS.BROW_R_Y, 0.8, true);
    setParameter(PARAM_IDS.MOUTH_OPEN_Y, 0.6, true); // Open mouth (surprised)
    setParameter(PARAM_IDS.MOUTH_FORM, 0.3, true);   // Slight o-shape
    setParameter(PARAM_IDS.EYE_BALL_Y, 0.2, true);   // Eyes slightly up
}

function updateBoop(dt) {
    if (!boopState.isBooping) return;

    boopState.timer += dt;
    boopState.bouncePhase += dt * 15; // Fast bounce

    // Bounce effect on body
    const bounce = Math.sin(boopState.bouncePhase) * Math.exp(-boopState.timer * 5) * 5;
    setParameter(PARAM_IDS.BODY_ANGLE_Y, bounce, true);

    // Transition to happy expression
    const progress = boopState.timer / boopState.duration;
    if (progress > 0.3) {
        const smileProgress = Math.min(1, (progress - 0.3) / 0.3);
        setParameter(PARAM_IDS.EYE_L_SMILE, smileProgress * 0.8, true);
        setParameter(PARAM_IDS.EYE_R_SMILE, smileProgress * 0.8, true);
        setParameter(PARAM_IDS.MOUTH_FORM, smileProgress * 0.5, true);
    }

    // End boop
    if (boopState.timer >= boopState.duration) {
        boopState.isBooping = false;
        setParameter(PARAM_IDS.BODY_ANGLE_Y, 0, true);
        // Return to current state expression
        if (currentState === 'IDLE') {
            applyNeutralExpression();
        }
    }
}

function handleClick(e) {
    // If dragging is enabled, clicking does NOT boop (unless we want it to?)
    // User requested "either dragging ... or boop"
    if (dragState.enabled) return;

    triggerBoop();
}

// ================================
// UI Handling
// ================================

function initUI() {
    const toggleBtn = document.getElementById('mode-toggle');
    const resetBtn = document.getElementById('reset-btn');

    if (toggleBtn) {
        updateToggleText(toggleBtn);
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dragState.enabled = !dragState.enabled;
            updateToggleText(toggleBtn);

            // Toggle Drag Mode
            if (dragState.enabled) {
                document.body.classList.add('drag-mode');
                document.body.style.cursor = 'default'; // cursor handling by OS
            } else {
                document.body.classList.remove('drag-mode');
                document.body.style.cursor = 'default';
            }
        });
    }

    if (resetBtn) {
        resetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (window.avatarAPI?.moveWindow) {
                // Reset to top-leftish
                window.avatarAPI.moveWindow({ x: 50, y: 100 });
            }
        });
    }
}

function updateToggleText(btn) {
    btn.textContent = dragState.enabled ? '✅ Drag Mode' : '❌ Drag Mode (Interact)';
    btn.style.color = dragState.enabled ? '#88ff88' : '#cccccc';
}

// ================================
// Sentiment-Based Reactions
// ================================

function applySentiment(sentiment) {
    const expr = SENTIMENT_EXPRESSIONS[sentiment] || SENTIMENT_EXPRESSIONS.neutral;

    console.log('[Avatar] Sentiment:', sentiment, expr);

    // Apply base expression with immediate flag for instant feedback
    setParameter(PARAM_IDS.EYE_L_SMILE, expr.eyeSmile, true);
    setParameter(PARAM_IDS.EYE_R_SMILE, expr.eyeSmile, true);
    setParameter(PARAM_IDS.BROW_L_Y, expr.browY, true);
    setParameter(PARAM_IDS.BROW_R_Y, expr.browY, true);
    setParameter(PARAM_IDS.MOUTH_FORM, expr.mouthForm, true);

    if (expr.mouthOpen !== undefined) {
        setParameter(PARAM_IDS.MOUTH_OPEN_Y, expr.mouthOpen, true);
    }

    if (expr.eyeOpen !== undefined) {
        setParameter(PARAM_IDS.EYE_L_OPEN, expr.eyeOpen, true);
        setParameter(PARAM_IDS.EYE_R_OPEN, expr.eyeOpen, true);
    }

    // Handle special animations
    if (expr.wave || expr.bounce || expr.wink || expr.lookUp || expr.lookAway || expr.headTilt || expr.headUp || expr.headDown) {
        triggerSpecialAnim(sentiment, expr);
    } else {
        // For non-animated expressions, set a temporary hold
        specialAnimState.isPlaying = true;
        specialAnimState.type = sentiment;
        specialAnimState.timer = 0;
        specialAnimState.duration = 3.0; // Hold expression for 3 seconds
    }
}

function triggerSpecialAnim(type, expr) {
    specialAnimState.isPlaying = true;
    specialAnimState.type = type;
    specialAnimState.timer = 0;
    specialAnimState.duration = 2.5;  // Longer duration for more visible animations

    console.log('[Avatar] Special anim:', type);

    // Immediate special effects
    if (expr.headTilt) {
        setParameter(PARAM_IDS.ANGLE_Z, expr.headTilt, true);
    }
    if (expr.headUp) {
        setParameter(PARAM_IDS.ANGLE_Y, 12, true);
    }
    if (expr.headDown) {
        setParameter(PARAM_IDS.ANGLE_Y, -10, true);
    }
    if (expr.lookUp) {
        setParameter(PARAM_IDS.EYE_BALL_Y, 0.6, true);
    }
    if (expr.lookAway) {
        setParameter(PARAM_IDS.EYE_BALL_X, 0.8, true);
        setParameter(PARAM_IDS.ANGLE_X, -18, true);
    }
    if (expr.wink) {
        // Wink left eye
        setParameter(PARAM_IDS.EYE_L_OPEN, 0.1, true);
    }
}

function updateSpecialAnim(dt) {
    if (!specialAnimState.isPlaying) return;

    specialAnimState.timer += dt;
    const progress = specialAnimState.timer / specialAnimState.duration;
    const expr = SENTIMENT_EXPRESSIONS[specialAnimState.type];

    // Handle non-animated expressions (just holding)
    if (!expr) {
        if (specialAnimState.timer >= specialAnimState.duration) {
            specialAnimState.isPlaying = false;
            specialAnimState.type = null;
            // Return to neutral
            applyNeutralExpression();
        }
        return;
    }

    // Wave animation (body sway + head nod)
    if (expr.wave) {
        const wavePhase = progress * Math.PI * 6;  // More waves
        const waveAmount = Math.sin(wavePhase) * Math.exp(-progress * 1.5) * 12;  // Bigger sway
        setParameter(PARAM_IDS.BODY_ANGLE_X, waveAmount, true);
        // Add a friendly head nod
        const nodAmount = Math.sin(progress * Math.PI * 4) * Math.exp(-progress * 2) * 8;
        setParameter(PARAM_IDS.ANGLE_Y, nodAmount, true);
    }

    // Bounce animation (body bob)
    if (expr.bounce) {
        const bouncePhase = progress * Math.PI * 8;  // More bounces
        const bounceAmount = Math.abs(Math.sin(bouncePhase)) * Math.exp(-progress * 2) * 8;
        setParameter(PARAM_IDS.BODY_ANGLE_Y, bounceAmount, true);
    }

    // Wink - restore eye after a bit
    if (expr.wink && progress > 0.3) {
        setParameter(PARAM_IDS.EYE_L_OPEN, 1.0, true);
    }

    // End special animation
    if (specialAnimState.timer >= specialAnimState.duration) {
        specialAnimState.isPlaying = false;
        specialAnimState.type = null;

        // Reset special positions
        setParameter(PARAM_IDS.BODY_ANGLE_X, 0);
        setParameter(PARAM_IDS.BODY_ANGLE_Y, 0);
        setParameter(PARAM_IDS.ANGLE_Z, 0);
    }
}

// Setup IPC listeners
if (window.avatarAPI) {
    window.avatarAPI.onStateChange(setState);
    window.avatarAPI.onToneHint(setTone);
    window.avatarAPI.onTypingRhythm(setTypingRhythm);
    window.avatarAPI.onResponseTiming((timing) => {
        if (timing?.isComplete) {
            behaviors.mouthEnabled = false;
            setParameter(PARAM_IDS.MOUTH_OPEN_Y, 0);
        }
    });

    // Sentiment-based reactions
    if (window.avatarAPI.onSentiment) {
        window.avatarAPI.onSentiment(applySentiment);
    }

    // Mouth sync
    if (window.avatarAPI.onMouthAmplitude) {
        window.avatarAPI.onMouthAmplitude((amp) => {
            // Need a way to access renderer instance or update logic directly
            // Since this runs in browser context, we can add a global handler or update params directly
            // For now, let's update a global mouth amplitude target
            setExternalMouth(amp);
        });
    }

    if (window.avatarAPI.onExternalMouthControl) {
        window.avatarAPI.onExternalMouthControl((active) => {
            behaviors.mouthEnabled = !active; // Disable internal if external is active
            if (!active) {
                setParameter(PARAM_IDS.MOUTH_OPEN_Y, 0, true);
            }
        });
    }
}

function setExternalMouth(amplitude) {
    const scaled = Math.min(1, Math.max(0, amplitude)) * 0.8;
    setParameter(PARAM_IDS.MOUTH_OPEN_Y, scaled, true);
}

// Mouse event listeners for cursor tracking and boop
document.addEventListener('mousemove', handleMouseMove);
document.addEventListener('click', handleClick);

// Resize handling
window.addEventListener('resize', () => {
    if (model && app) {
        const container = document.getElementById('avatar-container');
        fitModelToView(container);
    }
});

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    init().catch(err => console.error('[Avatar] Init failed:', err));
});
