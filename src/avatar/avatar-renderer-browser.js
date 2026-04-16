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
const DEFAULT_MODEL_PATH = '../2D_Livemodel/tuzi_mian/tuzi mian.model3.json';

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

import { AvatarController } from './AvatarController.js';

// State
let app = null;
let model = null;
let isInitialized = false;
let initialModelWidth = 0;
let initialModelHeight = 0;

// Central Orchestrator
let avatarController = null;

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

// Window drag state
let dragState = {
    enabled: false
};

// Zoom state
let zoomState = {
    enabled: false,
    currentScale: 1.0,
    minScale: 0.3,
    maxScale: 3.0,
    zoomStep: 0.08
};

// ============================================
// Core Engine & Model Management
// ============================================

const Live2DRendererProxy = {
    app: null,
    model: null,
    setParameter(paramId, targetValue, immediate) {
        if (!model?.internalModel?.coreModel) return;
        try {
            const coreModel = model.internalModel.coreModel;
            // Immediate set bypassing our legacy interpolator
            if (coreModel.setParameterValueById) {
                coreModel.setParameterValueById(paramId, targetValue);
            }
        } catch (e) { }
    }
};

async function init() {
    if (isInitialized) return;

    console.log('[Avatar] Initializing Engine...');

    const container = document.getElementById('avatar-container');
    if (!container) return;

    // init PIXI App
    try {
        app = new PIXI.Application({
            backgroundAlpha: 0,
            resizeTo: window,
            resolution: window.devicePixelRatio || 1,
            autoDensity: true
        });
        container.appendChild(app.view);

        Live2DRendererProxy.app = app;
        avatarController = new AvatarController(Live2DRendererProxy);

        // Add core interactive ticker (mouse/drags)
        app.ticker.add(onCoreTick);

        // Setup listener for model changing
        if (window.avatarAPI?.onLoadModel) {
            window.avatarAPI.onLoadModel((path) => {
                loadModel(path);
            });
        }

    } catch (e) {
        console.error('[Avatar] Engine init failed:', e);
        return;
    }

    // Load initial model
    const path = await getModelPath();
    await loadModel(path);

    initUI();
    isInitialized = true;
}

function initUI() {
    const modeToggle = document.getElementById('mode-toggle');
    const zoomToggle = document.getElementById('zoom-toggle');
    const resetBtn = document.getElementById('reset-btn');
    if (modeToggle) {
        modeToggle.textContent = 'Drag Mode: OFF';
        modeToggle.addEventListener('click', () => {
            dragState.enabled = !dragState.enabled;
            modeToggle.textContent = `Drag Mode: ${dragState.enabled ? 'ON' : 'OFF'}`;
            document.getElementById('avatar-container').className = dragState.enabled ? 'drag-mode' : '';
        });
    }
    if (zoomToggle) {
        zoomToggle.textContent = 'Zoom Mode: OFF';
        zoomToggle.addEventListener('click', () => {
            zoomState.enabled = !zoomState.enabled;
            zoomToggle.textContent = `Zoom Mode: ${zoomState.enabled ? 'ON' : 'OFF'}`;
            console.log('[Avatar] Zoom mode:', zoomState.enabled ? 'ON' : 'OFF');
        });
    }
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (model && app) {
                model.x = app.renderer.width / 2;
                model.y = app.renderer.height;
                // Also reset zoom
                zoomState.currentScale = 1.0;
                const container = document.getElementById('avatar-container');
                fitModelToView(container);
            }
        });
    }
}

async function loadModel(modelPath) {
    if (!app) return;

    if (modelPath && !modelPath.startsWith('file://') && !modelPath.startsWith('http')) {
        modelPath = 'file:///' + modelPath.replace(/\\/g, '/');
    }

    console.log('[Avatar] Loading model...', modelPath);

    // Unload existing
    if (model) {
        app.stage.removeChild(model);
        model.destroy({ children: true, texture: true, baseTexture: true });
        model = null;
    }

    if (!modelPath) {
        console.warn('[Avatar] No path provided for loadModel');
        return;
    }

    try {
        const Live2DModel = PIXI.live2d.Live2DModel;
        Live2DModel.registerTicker(PIXI.Ticker);

        model = await Live2DModel.from(modelPath, {
            autoInteract: false,
            autoUpdate: true
        });

        if (!model) throw new Error('Model creation failed');

        // Assign to proxy for AvatarController
        Live2DRendererProxy.model = model;

        // Success
        console.log('[Avatar] Model loaded.');

        // Detect Capabilities using the new structured system
        await avatarController.onModelLoaded(model, modelPath);

        // Position
        initialModelWidth = model.internalModel.width;
        initialModelHeight = model.internalModel.height;
        fitModelToView(document.getElementById('avatar-container'));

        app.stage.addChild(model);

        // Tell main window
        if (window.avatarAPI?.sendCapabilities) {
            const caps = avatarController.registry.getCapabilities();
            window.avatarAPI.sendCapabilities(caps);
        }
    } catch (e) {
        console.error('[Avatar] Failed to load model:', e);
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

function fitModelToView(container) {
    if (!model || !app) return;

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    // Use internal dimensions (unscaled) as the source of truth
    const width = initialModelWidth || model.internalModel.width;
    const height = initialModelHeight || model.internalModel.height;

    // Calculate scale to fit container, then apply zoom multiplier
    const baseScale = Math.min(
        containerWidth / width,
        containerHeight / height
    ) * 0.9;
    const finalScale = baseScale * zoomState.currentScale;

    model.scale.set(finalScale);
    model.x = containerWidth / 2;

    // Face-centered zoom: at zoom=1.0, model bottom is at container bottom.
    // As zoom increases, shift the model DOWN so the face (at ~25% from top
    // of model) stays centered in the viewport.
    if (zoomState.currentScale <= 1.0) {
        model.y = containerHeight;
    } else {
        // The face is roughly at 25% from the top of the model.
        // At higher zoom, we want the face position to align with the 
        // center of the container.
        const scaledHeight = height * finalScale;
        const faceY = 0.25 * scaledHeight; // Face position from top of scaled model
        // Model anchor is (0.5, 1), so model.y is the bottom edge position.
        // The face in screen coords = model.y - scaledHeight + faceY
        // We want this to equal containerHeight / 2
        // model.y = containerHeight / 2 + scaledHeight - faceY
        model.y = containerHeight / 2 + scaledHeight - faceY;
    }
    model.anchor.set(0.5, 1);
}

function onCoreTick(delta) {
    if (!model) return;

    const dt = delta / 60;
    updateCursorTracking(dt);
}

// State handling
function setState(state) {
    avatarController.handleStateChange(state);
}

function setTone(tone) {
    // Only kept for backwards compatibility if needed, though AvatarController uses handlesComplexIntent
}

function setTypingRhythm(rhythm) {
    avatarController.handleTypingRhythm(rhythm);
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
    if (!cursorTrackingEnabled) return;

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

    const bodyX = currentCursorInfluence.headX * 0.5; // Body moves half as much as head
    const bodyY = currentCursorInfluence.headY * 0.5;
    const bodyZ = currentCursorInfluence.headX * 0.2; // Slight tilt based on X looking

    // Dispatch to AvatarController so they get blended properly without being overwritten
    if (avatarController) {
        avatarController.setCursorInfluence({
            [PARAM_IDS.EYE_BALL_X]: currentCursorInfluence.eyeX,
            [PARAM_IDS.EYE_BALL_Y]: currentCursorInfluence.eyeY,
            [PARAM_IDS.ANGLE_X]: currentCursorInfluence.headX,
            [PARAM_IDS.ANGLE_Y]: currentCursorInfluence.headY,
            [PARAM_IDS.ANGLE_Z]: currentCursorInfluence.headX * 0.3,
            [PARAM_IDS.BODY_ANGLE_X]: bodyX,
            [PARAM_IDS.BODY_ANGLE_Y]: bodyY,
            [PARAM_IDS.BODY_ANGLE_Z]: bodyZ
        });
    }

    // Force physics update to catch up with immediate manual parameter setting
    if (model.internalModel && model.internalModel.motionManager && model.internalModel.motionManager.physics) {
        model.internalModel.motionManager.physics.evaluate(model.internalModel.coreModel, dt);
    }
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
// Click / Boop Reactions
// ================================

// Region layout (normalized Y from top):
//   head:  0.00 – 0.38
//   body:  0.38 – 0.72
//   skirt: 0.72 – 1.00
//
// Each reaction: { label, intensity, actionHints }
// A reaction may define an optional `followUp` for a two-beat mini-arc.
const CLICK_REACTIONS = {
    head: [
        { label: 'embarrassed', intensity: 0.88, actionHints: { embarrassed: true } },
        { label: 'shy',         intensity: 0.82, actionHints: { shy: true } },
        { label: 'flustered',   intensity: 0.85, actionHints: { flustered: true } },
        { label: 'surprised',   intensity: 0.90, actionHints: {} },
    ],
    body: [
        { label: 'surprised',   intensity: 0.85, actionHints: {},               followUp: { label: 'flustered', intensity: 0.75, actionHints: { flustered: true } } },
        { label: 'flustered',   intensity: 0.80, actionHints: { flustered: true } },
        { label: 'playful',     intensity: 0.78, actionHints: {} },
        { label: 'shy',         intensity: 0.75, actionHints: { shy: true } },
    ],
    skirt: [
        { label: 'embarrassed', intensity: 0.92, actionHints: { embarrassed: true } },
        { label: 'surprised',   intensity: 0.88, actionHints: {},               followUp: { label: 'embarrassed', intensity: 0.80, actionHints: { embarrassed: true } } },
        { label: 'flustered',   intensity: 0.90, actionHints: { flustered: true } },
    ],
};

function _pickReaction(region) {
    const pool = CLICK_REACTIONS[region];
    return pool[Math.floor(Math.random() * pool.length)];
}

function handleAvatarClick(normX, normY) {
    if (!avatarController || !model) return;

    // Ignore if currently thinking/responding — Miko is busy
    const aiState = avatarController.intentMapper?.aiState;
    if (aiState === 'THINKING' || aiState === 'RESPONDING') return;

    // Determine region
    let region = 'body';
    if (normY < 0.38)      region = 'head';
    else if (normY > 0.72) region = 'skirt';

    const reaction = _pickReaction(region);
    console.log(`[Avatar] Click on ${region} → ${reaction.label} @ ${reaction.intensity}`);

    // Fire first beat immediately
    avatarController.handleComplexIntent({
        emotion: { label: reaction.label, intensity: reaction.intensity },
        actionHints: reaction.actionHints
    });

    // Optional follow-up beat after 900ms (simulates a two-beat reaction arc)
    if (reaction.followUp) {
        setTimeout(() => {
            if (avatarController) {
                avatarController.handleComplexIntent({
                    emotion: { label: reaction.followUp.label, intensity: reaction.followUp.intensity },
                    actionHints: reaction.followUp.actionHints
                });
            }
        }, 900);
    }
}

// Boop detection via pointerdown/pointerup — avoids PIXI's click-swallow issue.
// pointerdown records position; pointerup fires reaction if movement < 6px.
let _boopStart = null;

document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('#ui-layer')) return;
    _boopStart = { x: e.clientX, y: e.clientY };
});

document.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('#ui-layer')) { _boopStart = null; return; }
    if (!_boopStart) return;

    const dx = e.clientX - _boopStart.x;
    const dy = e.clientY - _boopStart.y;
    _boopStart = null;

    // If moved more than 6px it was a drag, not a click
    if (Math.sqrt(dx * dx + dy * dy) > 6) return;

    const container = document.getElementById('avatar-container');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const normX = (e.clientX - rect.left) / rect.width;
    const normY = (e.clientY - rect.top) / rect.height;

    handleAvatarClick(normX, normY);
});

// Setup IPC listeners
if (window.avatarAPI) {
    window.avatarAPI.onStateChange((state) => {
        avatarController.handleStateChange(state);
    });
    window.avatarAPI.onTypingRhythm((rhythm) => {
        avatarController.handleTypingRhythm(rhythm);
    });

    // New complex intent
    if (window.avatarAPI.onComplexIntent) {
        window.avatarAPI.onComplexIntent((intent) => {
            console.log('[AvatarWindow] ==========================================');
            console.log('[AvatarWindow] RECEIVED COMPLEX INTENT:', JSON.stringify(intent));
            console.log('[AvatarWindow] avatarController exists:', !!avatarController);
            console.log('[AvatarWindow] avatarController.isEnabled:', avatarController?.isEnabled);
            console.log('[AvatarWindow] model exists:', !!model);
            console.log('[AvatarWindow] ==========================================');
            if (avatarController) {
                avatarController.handleComplexIntent(intent);
            } else {
                console.error('[AvatarWindow] avatarController is NULL - intent dropped!');
            }
        });
        console.log('[AvatarWindow] onComplexIntent listener registered');
    } else {
        console.warn('[AvatarWindow] window.avatarAPI.onComplexIntent is NOT available');
    }

    // New mouth amplitude
    if (window.avatarAPI.onMouthAmplitude) {
        window.avatarAPI.onMouthAmplitude((amp) => {
            avatarController.handleMouthAmplitude(amp);
        });
    }
}

// Mouse event listeners for cursor tracking
document.addEventListener('mousemove', handleMouseMove);

// Scroll/wheel zoom handler
document.addEventListener('wheel', (e) => {
    if (!zoomState.enabled || !model) return;
    e.preventDefault();

    // Determine zoom direction (scroll up = zoom in, scroll down = zoom out)
    const delta = e.deltaY > 0 ? -zoomState.zoomStep : zoomState.zoomStep;
    zoomState.currentScale = Math.max(zoomState.minScale, Math.min(zoomState.maxScale, zoomState.currentScale + delta));

    // Apply via fitModelToView which respects zoom scale
    const container = document.getElementById('avatar-container');
    if (container) fitModelToView(container);
}, { passive: false });

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
