/**
 * Motion Intent Mapper
 * Maps AI states and typing rhythm to Live2D motion behaviors.
 * Outputs a DesiredParameterState frame to be blended by the AvatarController.
 */

import { PARAM_IDS } from './avatar-config.js';

export class MotionIntentMapper {
    constructor(capabilityRegistry) {
        this.registry = capabilityRegistry;

        // Current Inputs
        this.aiState = 'IDLE'; // IDLE, THINKING, RESPONDING
        this.typingRhythm = 'normal'; // 'normal', 'fast', 'slow'

        // Priority definition (Highest absolute value wins for absolute params)
        this.PRIORITIES = {
            RESPONDING: 3,
            THINKING: 2,
            TYPING_FAST: 1,
            IDLE: 0
        };
    }

    setRegistry(registry) {
        this.registry = registry;
    }

    /**
     * Set the current AI State
     * @param {'IDLE' | 'THINKING' | 'RESPONDING'} state 
     */
    setAIState(state) {
        this.aiState = state;
    }

    /**
     * Set the current user typing rhythm
     * @param {'fast' | 'slow' | 'normal'} rhythm 
     */
    setTypingRhythm(rhythm) {
        this.typingRhythm = rhythm;
    }

    /**
     * Determine the current active priority context
     */
    _getActivePriority() {
        if (this.aiState === 'RESPONDING') return this.PRIORITIES.RESPONDING;
        if (this.aiState === 'THINKING') return this.PRIORITIES.THINKING;
        if (this.typingRhythm === 'fast') return this.PRIORITIES.TYPING_FAST;
        return this.PRIORITIES.IDLE;
    }

    /**
     * Generate the intended parameter and behavior state frame
     * @returns {Object} Desired behavior state
     */
    getDesiredState() {
        const priority = this._getActivePriority();
        const caps = this.registry ? this.registry.getCapabilities() : {};

        let state = {
            parameters: {},
            // Behavior hints for other systems
            pauseIdleBlink: false,
            pauseIdleSway: false,
            pauseIdleBreath: false
        };

        // Base Idle state (Priority 0)
        if (priority >= this.PRIORITIES.IDLE) {
            // Default look forward
            state.parameters[PARAM_IDS.EYE_BALL_X] = 0;
            state.parameters[PARAM_IDS.EYE_BALL_Y] = 0;
            state.parameters[PARAM_IDS.ANGLE_X] = 0;
            state.parameters[PARAM_IDS.ANGLE_Y] = 0;
            state.parameters[PARAM_IDS.ANGLE_Z] = 0;
        }

        // Typing Fast state (Priority 1)
        if (priority >= this.PRIORITIES.TYPING_FAST) {
            // Slight attentive lean
            if (caps.hasAngleZ) state.parameters[PARAM_IDS.ANGLE_Z] = -5;
            if (caps.hasEyeBallXY) {
                state.parameters[PARAM_IDS.EYE_BALL_X] = 0;
                state.parameters[PARAM_IDS.EYE_BALL_Y] = 0.2; // Look slightly up/attentive
            }
        }

        // Thinking state (Priority 2)
        if (priority >= this.PRIORITIES.THINKING) {
            // Slight head tilt, eyes up
            if (caps.hasAngleZ) state.parameters[PARAM_IDS.ANGLE_Z] = 8;
            if (caps.hasAngleY) state.parameters[PARAM_IDS.ANGLE_Y] = 5;
            if (caps.hasEyeBallXY) {
                state.parameters[PARAM_IDS.EYE_BALL_X] = 0.1;
                state.parameters[PARAM_IDS.EYE_BALL_Y] = 0.3; // Look up to think
            }

            state.pauseIdleBlink = true; // Reduced blinking
            state.pauseIdleSway = true;  // Hold still
        }

        // Responding state (Priority 3)
        if (priority >= this.PRIORITIES.RESPONDING) {
            // Maintain eye contact
            if (caps.hasEyeBallXY) {
                state.parameters[PARAM_IDS.EYE_BALL_X] = 0;
                state.parameters[PARAM_IDS.EYE_BALL_Y] = 0;
            }
            // Reset head angles to face user
            if (caps.hasAngleX) state.parameters[PARAM_IDS.ANGLE_X] = 0;
            if (caps.hasAngleY) state.parameters[PARAM_IDS.ANGLE_Y] = 0;
            if (caps.hasAngleZ) state.parameters[PARAM_IDS.ANGLE_Z] = 0;

            state.pauseIdleSway = true; // Still to talk, or maybe subtle, handle later
        }

        return state;
    }
}
