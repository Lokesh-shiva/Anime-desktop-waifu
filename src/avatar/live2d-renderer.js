/**
 * Live2D Renderer
 * Handles PixiJS canvas and Live2D model rendering
 * 
 * Responsibilities:
 * - Initialize PixiJS application with transparent background
 * - Load and display Live2D model
 * - Execute parameter changes with smooth interpolation
 * - Handle automatic behaviors (blinking, breathing)
 * 
 * Rules:
 * - No intelligence or decision making
 * - Graceful failure if model/parameters missing
 * - All parameter access is capability-detected
 */

import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display';
import { TIMING, PARAM_IDS } from './avatar-config.js';

// Register Live2D with PIXI
Live2DModel.registerTicker(PIXI.Ticker);

export class Live2DRenderer {
    constructor(container) {
        this.container = container;
        this.app = null;
        this.model = null;
        this.availableParams = new Set();
        this.isDestroyed = false;

        // Animation state
        this.animationState = {
            blinkTimer: 0,
            nextBlinkTime: this._randomBlinkInterval(),
            isBlinking: false,
            breathPhase: 0,
            mouthPhase: 0,
            breathPhase: 0,
            mouthPhase: 0,
            swayPhase: 0
        };

        // External control flags
        this.externalMouthControl = false;

        // Current target values (for smooth interpolation)
        this.targetValues = {};
        this.currentValues = {};

        // Behavior flags
        this.behaviors = {
            blinkEnabled: true,
            breathingEnabled: true,
            headSwayEnabled: true,
            mouthEnabled: false
        };
    }

    /**
     * Initialize PixiJS application
     */
    async init() {
        if (this.app) return;

        this.app = new PIXI.Application({
            backgroundAlpha: 0,
            resizeTo: this.container,
            antialias: true,
            resolution: window.devicePixelRatio || 1,
            autoDensity: true
        });

        this.container.appendChild(this.app.view);

        // Start animation loop
        this.app.ticker.add(this._onTick.bind(this));
    }

    /**
     * Load a Live2D model from path
     * @param {string} modelPath - Path to .model3.json file
     * @returns {Promise<boolean>} - Success status
     */
    async loadModel(modelPath) {
        if (!modelPath) {
            console.warn('[Live2D] No model path provided');
            return false;
        }

        try {
            // Ensure app is initialized
            await this.init();

            // Remove existing model
            if (this.model) {
                this.app.stage.removeChild(this.model);
                this.model.destroy();
                this.model = null;
            }

            console.log('[Live2D] Loading model:', modelPath);

            // Load the model
            this.model = await Live2DModel.from(modelPath, {
                autoInteract: false, // We control all interactions
                autoUpdate: true
            });

            if (!this.model) {
                console.warn('[Live2D] Model failed to load');
                return false;
            }

            // Discover available parameters
            this._discoverParameters();

            // Position and scale model
            this._fitModelToView();

            // Add to stage
            this.app.stage.addChild(this.model);

            console.log('[Live2D] Model loaded successfully');
            return true;

        } catch (error) {
            console.warn('[Live2D] Failed to load model:', error.message);
            return false;
        }
    }

    /**
     * Discover available parameters from loaded model
     */
    _discoverParameters() {
        this.availableParams.clear();

        if (!this.model?.internalModel?.coreModel) {
            console.warn('[Live2D] Cannot discover parameters - model not ready');
            return;
        }

        try {
            const coreModel = this.model.internalModel.coreModel;
            const paramCount = coreModel.getParameterCount();

            for (let i = 0; i < paramCount; i++) {
                const paramId = coreModel.getParameterId(i);
                this.availableParams.add(paramId);
            }

            console.log('[Live2D] Discovered', this.availableParams.size, 'parameters');
        } catch (e) {
            console.warn('[Live2D] Parameter discovery failed:', e.message);
        }
    }

    /**
     * Check if a parameter is available on the model
     * @param {string} paramId 
     * @returns {boolean}
     */
    hasParameter(paramId) {
        return this.availableParams.has(paramId);
    }

    /**
     * Set a parameter value with optional smooth transition
     * @param {string} paramId - Parameter ID
     * @param {number} value - Target value
     * @param {boolean} immediate - Skip interpolation
     */
    setParameter(paramId, value, immediate = false) {
        if (!this.hasParameter(paramId)) {
            // Silently skip missing parameters
            return;
        }

        if (immediate) {
            this.currentValues[paramId] = value;
            this._applyParameter(paramId, value);
        } else {
            this.targetValues[paramId] = value;
        }
    }

    /**
     * Apply parameter value to model
     */
    _applyParameter(paramId, value) {
        if (!this.model?.internalModel?.coreModel) return;

        try {
            const coreModel = this.model.internalModel.coreModel;
            const index = coreModel.getParameterIndex(paramId);
            if (index >= 0) {
                coreModel.setParameterValueById(paramId, value);
            }
        } catch (e) {
            // Silently ignore parameter errors
        }
    }

    /**
     * Set behavior flags
     * @param {object} behaviors 
     */
    setBehaviors(behaviors) {
        Object.assign(this.behaviors, behaviors);
    }

    /**
     * Fit model to container view
     */
    _fitModelToView() {
        if (!this.model || !this.app) return;

        const containerWidth = this.container.clientWidth;
        const containerHeight = this.container.clientHeight;

        // Scale to fit
        const scale = Math.min(
            containerWidth / this.model.width,
            containerHeight / this.model.height
        ) * 0.9; // 90% of available space

        this.model.scale.set(scale);

        // Center horizontally, anchor at bottom
        this.model.x = containerWidth / 2;
        this.model.y = containerHeight;
        this.model.anchor.set(0.5, 1);
    }

    /**
     * Animation tick - handles automatic behaviors
     */
    _onTick(delta) {
        if (this.isDestroyed || !this.model) return;

        const dt = delta / 60; // Convert to seconds (assuming 60fps base)

        // Smooth interpolation of target values
        this._interpolateValues(dt);

        // Automatic behaviors
        if (this.behaviors.blinkEnabled) {
            this._updateBlink(dt);
        }

        if (this.behaviors.breathingEnabled) {
            this._updateBreathing(dt);
        }

        if (this.behaviors.headSwayEnabled) {
            this._updateHeadSway(dt);
        }

        if (this.behaviors.mouthEnabled) {
            this._updateMouthSync(dt);
        }
    }

    /**
     * Smoothly interpolate current values toward targets
     */
    _interpolateValues(dt) {
        const speed = 8.0; // Interpolation speed

        for (const [paramId, target] of Object.entries(this.targetValues)) {
            const current = this.currentValues[paramId] ?? target;
            const diff = target - current;

            if (Math.abs(diff) < 0.001) {
                this.currentValues[paramId] = target;
            } else {
                this.currentValues[paramId] = current + diff * Math.min(1, speed * dt);
            }

            this._applyParameter(paramId, this.currentValues[paramId]);
        }
    }

    /**
     * Automatic blinking behavior
     */
    _updateBlink(dt) {
        this.animationState.blinkTimer += dt;

        if (this.animationState.isBlinking) {
            // Blinking animation
            const blinkProgress = this.animationState.blinkTimer / TIMING.BLINK_DURATION;

            if (blinkProgress >= 1) {
                // End blink
                this.animationState.isBlinking = false;
                this.animationState.blinkTimer = 0;
                this.animationState.nextBlinkTime = this._randomBlinkInterval();
                this.setParameter(PARAM_IDS.EYE_L_OPEN, 1, true);
                this.setParameter(PARAM_IDS.EYE_R_OPEN, 1, true);
            } else {
                // Blink curve (close then open)
                const eyeOpen = blinkProgress < 0.5
                    ? 1 - (blinkProgress * 2)
                    : (blinkProgress - 0.5) * 2;
                this.setParameter(PARAM_IDS.EYE_L_OPEN, eyeOpen, true);
                this.setParameter(PARAM_IDS.EYE_R_OPEN, eyeOpen, true);
            }
        } else if (this.animationState.blinkTimer >= this.animationState.nextBlinkTime) {
            // Start blink
            this.animationState.isBlinking = true;
            this.animationState.blinkTimer = 0;
        }
    }

    /**
     * Automatic breathing behavior
     */
    _updateBreathing(dt) {
        this.animationState.breathPhase += dt / TIMING.BREATH_CYCLE * Math.PI * 2;

        if (this.animationState.breathPhase > Math.PI * 2) {
            this.animationState.breathPhase -= Math.PI * 2;
        }

        const breathValue = (Math.sin(this.animationState.breathPhase) + 1) / 2;
        this.setParameter(PARAM_IDS.BREATH, breathValue, true);
    }

    /**
     * Idle head sway behavior
     */
    _updateHeadSway(dt) {
        this.animationState.swayPhase += dt / TIMING.IDLE_SWAY_CYCLE * Math.PI * 2;

        if (this.animationState.swayPhase > Math.PI * 2) {
            this.animationState.swayPhase -= Math.PI * 2;
        }

        const swayValue = Math.sin(this.animationState.swayPhase) * TIMING.IDLE_SWAY_AMPLITUDE;
        this.setParameter(PARAM_IDS.ANGLE_Z, swayValue, true);
    }

    /**
     * Mouth sync - simple open/close oscillation
     * Or external control override
     */
    _updateMouthSync(dt) {
        // Skip internal oscillation if external control is active
        if (this.externalMouthControl) return;

        this.animationState.mouthPhase += dt / TIMING.MOUTH_CYCLE * Math.PI * 2;

        if (this.animationState.mouthPhase > Math.PI * 2) {
            this.animationState.mouthPhase -= Math.PI * 2;
        }

        const mouthOpen = (Math.sin(this.animationState.mouthPhase) + 1) / 2 * 0.7;
        this.setParameter(PARAM_IDS.MOUTH_OPEN_Y, mouthOpen, true);
    }

    /**
     * Set mouth open value from external source (voice sync)
     * @param {number} amplitude - 0 to 1
     */
    setMouthValue(amplitude) {
        // Clamp and scale for natural movement
        const scaled = Math.min(1, Math.max(0, amplitude)) * 0.8;
        this.setParameter(PARAM_IDS.MOUTH_OPEN_Y, scaled, true); // Immediate update
    }

    /**
     * Enable/disable external mouth control
     * @param {boolean} enabled
     */
    setExternalMouthControl(enabled) {
        this.externalMouthControl = enabled;
        if (!enabled) {
            // Close mouth when external control ends
            this.setParameter(PARAM_IDS.MOUTH_OPEN_Y, 0, true);
        }
    }

    /**
     * Get random interval for next blink
     */
    _randomBlinkInterval() {
        return TIMING.BLINK_INTERVAL_MIN +
            Math.random() * (TIMING.BLINK_INTERVAL_MAX - TIMING.BLINK_INTERVAL_MIN);
    }

    /**
     * Handle window resize
     */
    onResize() {
        if (this.app) {
            this.app.resize();
        }
        this._fitModelToView();
    }

    /**
     * Clean up resources
     */
    destroy() {
        this.isDestroyed = true;

        if (this.model) {
            this.model.destroy();
            this.model = null;
        }

        if (this.app) {
            this.app.destroy(true);
            this.app = null;
        }

        this.availableParams.clear();
    }
}
