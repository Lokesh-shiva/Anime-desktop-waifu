/**
 * Avatar Window Renderer
 * Entry point for the avatar window renderer process
 * 
 * Initializes the Live2D rendering pipeline and listens for IPC signals
 * from the main window.
 * 
 * Rules:
 * - Only receives signals
 * - Never sends data back
 * - Graceful failure if model is missing
 */

import { AvatarController } from './avatar-controller.js';
import { MotionMapper } from './motion-mapper.js';
import { Live2DRenderer } from './live2d-renderer.js';
import { DEFAULT_MODEL_PATH, AVATAR_SIGNALS } from './avatar-config.js';

// State
let controller = null;
let motionMapper = null;
let renderer = null;
let isInitialized = false;

/**
 * Initialize the avatar rendering system
 */
async function init() {
    if (isInitialized) return;

    console.log('[AvatarRenderer] Initializing...');

    const container = document.getElementById('avatar-container');
    if (!container) {
        console.error('[AvatarRenderer] Container not found');
        return;
    }

    // Create renderer
    renderer = new Live2DRenderer(container);

    // Get model path from settings or use default
    const modelPath = await getModelPath();

    if (!modelPath) {
        console.warn('[AvatarRenderer] No model path configured, avatar will be empty');
        isInitialized = true;
        return;
    }

    // Load model
    const loaded = await renderer.loadModel(modelPath);

    if (!loaded) {
        console.warn('[AvatarRenderer] Failed to load model, avatar will be empty');
        isInitialized = true;
        return;
    }

    // Create motion mapper and controller
    motionMapper = new MotionMapper(renderer);
    controller = new AvatarController(motionMapper);

    // Set initial state
    controller.handleStateChange('IDLE');

    isInitialized = true;
    console.log('[AvatarRenderer] Ready');
}

/**
 * Get model path from settings
 */
async function getModelPath() {
    // Try to get from IPC if available
    if (window.avatarAPI?.getModelPath) {
        try {
            const path = await window.avatarAPI.getModelPath();
            if (path) return path;
        } catch (e) {
            console.warn('[AvatarRenderer] Could not get model path:', e.message);
        }
    }

    // Fall back to default
    return DEFAULT_MODEL_PATH;
}

/**
 * Handle state change signal
 */
function onStateChange(state) {
    if (!controller) return;
    controller.handleStateChange(state);
}

/**
 * Handle tone hint signal
 */
function onToneHint(tone) {
    if (!controller) return;
    controller.handleToneHint(tone);
}

/**
 * Handle typing rhythm signal
 */
function onTypingRhythm(rhythm) {
    if (!controller) return;
    controller.handleTypingRhythm(rhythm);
}

/**
 * Handle response timing signal
 */
function onResponseTiming(timing) {
    if (!controller) return;
    controller.handleResponseTiming(timing);
}

// Setup IPC listeners
if (window.avatarAPI) {
    window.avatarAPI.onStateChange(onStateChange);
    window.avatarAPI.onToneHint(onToneHint);
    window.avatarAPI.onTypingRhythm(onTypingRhythm);
    window.avatarAPI.onResponseTiming(onResponseTiming);
}

// Handle window resize
window.addEventListener('resize', () => {
    if (renderer) {
        renderer.onResize();
    }
});

// Initialize on load
init().catch(err => {
    console.error('[AvatarRenderer] Init failed:', err);
});
