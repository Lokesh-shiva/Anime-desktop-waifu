/**
 * Motion Mapper
 * Translates abstract state/tone signals to Live2D parameter commands
 * 
 * Behavior Mapping:
 * 
 * IDLE:
 *   - Subtle breathing animation (auto)
 *   - Occasional eye blink (auto)
 *   - Minimal head sway (auto)
 * 
 * USER TYPING:
 *   - Fast typing → slight head tilt, attentive eyes
 *   - Slow typing → relaxed posture
 *   - No mouth movement
 * 
 * THINKING:
 *   - Reduced blinking
 *   - Head tilted slightly
 *   - Expression: curious / thinking
 * 
 * RESPONDING:
 *   - Mouth open/close synced to timing
 *   - Expression matches tone hint
 * 
 * Rules:
 * - No intelligence or decision making
 * - Parameter access is validated
 * - Smooth transitions between states
 */

import { PARAM_IDS, STATE_BEHAVIORS, RHYTHM_BEHAVIORS, TONE_EXPRESSIONS, EXPRESSION_TRANSITIONS } from './avatar-config.js';

export class MotionMapper {
    constructor(live2dRenderer) {
        this.renderer = live2dRenderer;
        this.currentState = 'IDLE';
        this.currentTone = 'neutral';
        this.currentRhythm = 'normal';

        // Transition state
        this.isTransitioning = false;
    }

    /**
     * Set avatar state and update behaviors accordingly
     * @param {'IDLE' | 'THINKING' | 'RESPONDING'} state 
     */
    setState(state) {
        if (state === this.currentState) return;

        console.log('[MotionMapper] State:', this.currentState, '→', state);
        this.currentState = state;

        const behavior = STATE_BEHAVIORS[state];
        if (!behavior) {
            console.warn('[MotionMapper] Unknown state:', state);
            return;
        }

        // Update renderer behaviors
        this.renderer.setBehaviors({
            blinkEnabled: behavior.blinkEnabled,
            breathingEnabled: behavior.breathingEnabled,
            headSwayEnabled: behavior.headSwayEnabled,
            mouthEnabled: behavior.mouthEnabled
        });

        // Apply state-specific poses
        this._applyStatePose(state, behavior);

        // Apply expression based on tone
        if (state === 'RESPONDING') {
            this._applyToneExpression(this.currentTone);
        } else if (state === 'THINKING') {
            this._applyThinkingExpression();
        } else {
            this._applyNeutralExpression();
        }
    }

    /**
     * Apply state-specific head/body pose with eased transitions
     */
    _applyStatePose(state, behavior) {
        const opts = this._getTransitionOptions(state === 'THINKING' ? 'thinking' : 'neutral');

        if (state === 'THINKING' && behavior.headTilt) {
            this.renderer.setParameter(PARAM_IDS.ANGLE_X, behavior.headTilt.x, false, opts);
            this.renderer.setParameter(PARAM_IDS.ANGLE_Y, behavior.headTilt.y, false, opts);
            this.renderer.setParameter(PARAM_IDS.ANGLE_Z, behavior.headTilt.z, false, opts);
        } else if (state === 'IDLE') {
            this.renderer.setParameter(PARAM_IDS.ANGLE_X, 0, false, opts);
            this.renderer.setParameter(PARAM_IDS.ANGLE_Y, 0, false, opts);
            // Z is controlled by head sway
        }
    }

    /**
     * Set tone hint and update expression
     * @param {'calm' | 'neutral' | 'energetic'} tone 
     */
    setTone(tone) {
        if (!tone || tone === this.currentTone) return;

        console.log('[MotionMapper] Tone:', this.currentTone, '→', tone);
        this.currentTone = tone;

        // Only apply if currently responding
        if (this.currentState === 'RESPONDING') {
            this._applyToneExpression(tone);
        }
    }

    /**
     * Set typing rhythm and update posture
     * @param {'fast' | 'slow' | 'normal' | null} rhythm 
     */
    setTypingRhythm(rhythm) {
        const normalizedRhythm = rhythm || 'normal';
        if (normalizedRhythm === this.currentRhythm) return;

        console.log('[MotionMapper] Rhythm:', this.currentRhythm, '→', normalizedRhythm);
        this.currentRhythm = normalizedRhythm;

        // Only react during IDLE state (while user is typing)
        if (this.currentState === 'IDLE') {
            this._applyRhythmPose(normalizedRhythm);
        }
    }

    /**
     * Start mouth sync for responding
     * @param {boolean} active 
     */
    setMouthSync(active) {
        this.renderer.setBehaviors({ mouthEnabled: active });

        if (!active) {
            // Close mouth when done
            this.renderer.setParameter(PARAM_IDS.MOUTH_OPEN_Y, 0);
        }
    }

    /**
     * Get transition options for a given expression type
     * @param {string} expressionType - e.g. 'neutral', 'calm', 'energetic', 'thinking'
     * @returns {{ duration: number, easing: string }}
     */
    _getTransitionOptions(expressionType) {
        return {
            duration: EXPRESSION_TRANSITIONS.expressionDurations[expressionType]
                ?? EXPRESSION_TRANSITIONS.defaultDuration,
            easing: EXPRESSION_TRANSITIONS.expressionEasing[expressionType]
                ?? EXPRESSION_TRANSITIONS.defaultEasing
        };
    }

    /**
     * Set a parameter with staggered delay based on facial region
     * @param {string} paramId - Live2D parameter ID
     * @param {number} value - Target value
     * @param {string} region - 'eyes' | 'eyebrows' | 'mouth'
     * @param {string} expressionType - For duration/easing lookup
     */
    _setStaggered(paramId, value, region, expressionType) {
        const opts = this._getTransitionOptions(expressionType);
        opts.delay = EXPRESSION_TRANSITIONS.stagger[region] ?? 0;
        this.renderer.setParameter(paramId, value, false, opts);
    }

    /**
     * Apply expression based on tone with staggered, eased transitions
     */
    _applyToneExpression(tone) {
        const expr = TONE_EXPRESSIONS[tone] || TONE_EXPRESSIONS.neutral;
        const type = tone === 'calm' ? 'calm' : tone === 'energetic' ? 'energetic' : 'neutral';

        // Eyes lead the expression
        this._setStaggered(PARAM_IDS.EYE_L_SMILE, expr.eyeSmile, 'eyes', type);
        this._setStaggered(PARAM_IDS.EYE_R_SMILE, expr.eyeSmile, 'eyes', type);

        // Eyebrows follow
        this._setStaggered(PARAM_IDS.BROW_L_Y, expr.browY, 'eyebrows', type);
        this._setStaggered(PARAM_IDS.BROW_R_Y, expr.browY, 'eyebrows', type);

        // Mouth last
        this._setStaggered(PARAM_IDS.MOUTH_FORM, expr.mouthForm, 'mouth', type);
    }

    /**
     * Apply thinking expression with staggered transitions
     */
    _applyThinkingExpression() {
        // Eyes: focused, no smile
        this._setStaggered(PARAM_IDS.EYE_L_SMILE, 0, 'eyes', 'thinking');
        this._setStaggered(PARAM_IDS.EYE_R_SMILE, 0, 'eyes', 'thinking');

        // Eyebrows: slightly raised (curious)
        this._setStaggered(PARAM_IDS.BROW_L_Y, 0.3, 'eyebrows', 'thinking');
        this._setStaggered(PARAM_IDS.BROW_R_Y, 0.3, 'eyebrows', 'thinking');

        // Mouth: closed, neutral form
        this._setStaggered(PARAM_IDS.MOUTH_FORM, 0, 'mouth', 'thinking');
        this._setStaggered(PARAM_IDS.MOUTH_OPEN_Y, 0, 'mouth', 'thinking');
    }

    /**
     * Apply neutral expression with staggered transitions
     */
    _applyNeutralExpression() {
        // Eyes settle first
        this._setStaggered(PARAM_IDS.EYE_L_SMILE, 0, 'eyes', 'neutral');
        this._setStaggered(PARAM_IDS.EYE_R_SMILE, 0, 'eyes', 'neutral');

        // Brows relax
        this._setStaggered(PARAM_IDS.BROW_L_Y, 0, 'eyebrows', 'neutral');
        this._setStaggered(PARAM_IDS.BROW_R_Y, 0, 'eyebrows', 'neutral');

        // Mouth relaxes last
        this._setStaggered(PARAM_IDS.MOUTH_FORM, 0, 'mouth', 'neutral');
        this._setStaggered(PARAM_IDS.MOUTH_OPEN_Y, 0, 'mouth', 'neutral');
    }

    /**
     * Apply posture based on typing rhythm with eased transitions
     */
    _applyRhythmPose(rhythm) {
        const pose = RHYTHM_BEHAVIORS[rhythm] || RHYTHM_BEHAVIORS.normal;
        const opts = this._getTransitionOptions('rhythm');

        if (pose.headTilt) {
            this.renderer.setParameter(PARAM_IDS.ANGLE_X, pose.headTilt.x, false, opts);
            this.renderer.setParameter(PARAM_IDS.ANGLE_Y, pose.headTilt.y, false, opts);
            this.renderer.setParameter(PARAM_IDS.ANGLE_Z, pose.headTilt.z, false, opts);
        }

        // Focus eyes slightly toward user for fast typing
        if (pose.eyeFocus) {
            this.renderer.setParameter(PARAM_IDS.EYE_BALL_X, 0, false, opts);
            this.renderer.setParameter(PARAM_IDS.EYE_BALL_Y, 0.2, false, opts);
        } else {
            this.renderer.setParameter(PARAM_IDS.EYE_BALL_X, 0, false, opts);
            this.renderer.setParameter(PARAM_IDS.EYE_BALL_Y, 0, false, opts);
        }
    }

    /**
     * Reset all poses and expressions
     */
    reset() {
        this.currentState = 'IDLE';
        this.currentTone = 'neutral';
        this.currentRhythm = 'normal';

        this.renderer.setBehaviors({
            blinkEnabled: true,
            breathingEnabled: true,
            headSwayEnabled: true,
            mouthEnabled: false
        });

        this._applyNeutralExpression();
    }
}
