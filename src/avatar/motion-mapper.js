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

import { PARAM_IDS, STATE_BEHAVIORS, RHYTHM_BEHAVIORS, TONE_EXPRESSIONS } from './avatar-config.js';

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
     * Apply state-specific head/body pose
     */
    _applyStatePose(state, behavior) {
        if (state === 'THINKING' && behavior.headTilt) {
            // Thinking tilt
            this.renderer.setParameter(PARAM_IDS.ANGLE_X, behavior.headTilt.x);
            this.renderer.setParameter(PARAM_IDS.ANGLE_Y, behavior.headTilt.y);
            this.renderer.setParameter(PARAM_IDS.ANGLE_Z, behavior.headTilt.z);
        } else if (state === 'IDLE') {
            // Reset to neutral (head sway will take over)
            this.renderer.setParameter(PARAM_IDS.ANGLE_X, 0);
            this.renderer.setParameter(PARAM_IDS.ANGLE_Y, 0);
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
     * Apply expression based on tone
     */
    _applyToneExpression(tone) {
        const expr = TONE_EXPRESSIONS[tone] || TONE_EXPRESSIONS.neutral;

        this.renderer.setParameter(PARAM_IDS.EYE_L_SMILE, expr.eyeSmile);
        this.renderer.setParameter(PARAM_IDS.EYE_R_SMILE, expr.eyeSmile);
        this.renderer.setParameter(PARAM_IDS.BROW_L_Y, expr.browY);
        this.renderer.setParameter(PARAM_IDS.BROW_R_Y, expr.browY);
        this.renderer.setParameter(PARAM_IDS.MOUTH_FORM, expr.mouthForm);
    }

    /**
     * Apply thinking expression
     */
    _applyThinkingExpression() {
        // Slightly raised eyebrows, focused look
        this.renderer.setParameter(PARAM_IDS.EYE_L_SMILE, 0);
        this.renderer.setParameter(PARAM_IDS.EYE_R_SMILE, 0);
        this.renderer.setParameter(PARAM_IDS.BROW_L_Y, 0.3);
        this.renderer.setParameter(PARAM_IDS.BROW_R_Y, 0.3);
        this.renderer.setParameter(PARAM_IDS.MOUTH_FORM, 0);
        this.renderer.setParameter(PARAM_IDS.MOUTH_OPEN_Y, 0);
    }

    /**
     * Apply neutral expression
     */
    _applyNeutralExpression() {
        this.renderer.setParameter(PARAM_IDS.EYE_L_SMILE, 0);
        this.renderer.setParameter(PARAM_IDS.EYE_R_SMILE, 0);
        this.renderer.setParameter(PARAM_IDS.BROW_L_Y, 0);
        this.renderer.setParameter(PARAM_IDS.BROW_R_Y, 0);
        this.renderer.setParameter(PARAM_IDS.MOUTH_FORM, 0);
        this.renderer.setParameter(PARAM_IDS.MOUTH_OPEN_Y, 0);
    }

    /**
     * Apply posture based on typing rhythm
     */
    _applyRhythmPose(rhythm) {
        const pose = RHYTHM_BEHAVIORS[rhythm] || RHYTHM_BEHAVIORS.normal;

        if (pose.headTilt) {
            this.renderer.setParameter(PARAM_IDS.ANGLE_X, pose.headTilt.x);
            this.renderer.setParameter(PARAM_IDS.ANGLE_Y, pose.headTilt.y);
            this.renderer.setParameter(PARAM_IDS.ANGLE_Z, pose.headTilt.z);
        }

        // Focus eyes slightly toward user for fast typing
        if (pose.eyeFocus) {
            this.renderer.setParameter(PARAM_IDS.EYE_BALL_X, 0);
            this.renderer.setParameter(PARAM_IDS.EYE_BALL_Y, 0.2);
        } else {
            this.renderer.setParameter(PARAM_IDS.EYE_BALL_X, 0);
            this.renderer.setParameter(PARAM_IDS.EYE_BALL_Y, 0);
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
