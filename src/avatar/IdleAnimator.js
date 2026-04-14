/**
 * Idle Animator
 * Procedural animation loop generating idle motions.
 * Outputs a DesiredParameterState frame to be blended by AvatarController.
 */

import { PARAM_IDS, TIMING } from './avatar-config.js';

export class IdleAnimator {
    constructor(capabilityRegistry) {
        this.registry = capabilityRegistry;

        this.state = {
            blinkTimer: 0,
            nextBlinkTime: this._randomBlinkInterval(),
            isBlinking: false,
            breathPhase: 0,
            swayPhase: 0
        };

        // Output overrides
        this.pauseBlink = false;
        this.pauseSway = false;
        this.pauseBreath = false;
        this.intensityMultiplier = 1.0;
    }

    setRegistry(registry) {
        this.registry = registry;
    }

    /**
     * Allow external systems to suppress idle layers
     */
    setOverrides(hints, intensityMultiplier = 1.0) {
        this.pauseBlink = !!hints.pauseIdleBlink;
        this.pauseSway = !!hints.pauseIdleSway;
        this.pauseBreath = !!hints.pauseIdleBreath;
        this.intensityMultiplier = intensityMultiplier;
    }

    /**
     * Advance animation and generate desired state
     * @param {number} dt Delta time in seconds
     * @returns {Object} Desired parameter state
     */
    update(dt) {
        const caps = this.registry ? this.registry.getCapabilities() : {};
        let state = { parameters: {} };

        // 1. Breathing
        if (caps.hasBreath && !this.pauseBreath) {
            this.state.breathPhase += (dt / TIMING.BREATH_CYCLE) * Math.PI * 2;
            if (this.state.breathPhase > Math.PI * 2) this.state.breathPhase -= Math.PI * 2;

            const breathValue = ((Math.sin(this.state.breathPhase) + 1) / 2) * this.intensityMultiplier;
            state.parameters[PARAM_IDS.BREATH] = breathValue;
        }

        // 2. Head/Body Sway
        if (!this.pauseSway) {
            this.state.swayPhase += (dt / TIMING.IDLE_SWAY_CYCLE) * Math.PI * 2;
            if (this.state.swayPhase > Math.PI * 2) this.state.swayPhase -= Math.PI * 2;

            const swayValue = Math.sin(this.state.swayPhase) * TIMING.IDLE_SWAY_AMPLITUDE * this.intensityMultiplier;

            if (caps.hasAngleZ) state.parameters[PARAM_IDS.ANGLE_Z] = swayValue;

            // Subtly sway body if supported instead of just neck
            if (caps.hasBodyAngleX) state.parameters[PARAM_IDS.BODY_ANGLE_X] = swayValue * 0.5;
        }

        // 3. Blinking
        if (caps.hasBlink && !this.pauseBlink) {
            this.state.blinkTimer += dt;

            if (this.state.isBlinking) {
                const progress = this.state.blinkTimer / TIMING.BLINK_DURATION;
                if (progress >= 1) {
                    this.state.isBlinking = false;
                    this.state.blinkTimer = 0;
                    this.state.nextBlinkTime = this._randomBlinkInterval();
                    state.parameters[PARAM_IDS.EYE_L_OPEN] = 1;
                    state.parameters[PARAM_IDS.EYE_R_OPEN] = 1;
                } else {
                    // Blink curve: close then open
                    const eyeOpen = progress < 0.5
                        ? 1 - (progress * 2)
                        : (progress - 0.5) * 2;
                    state.parameters[PARAM_IDS.EYE_L_OPEN] = eyeOpen;
                    state.parameters[PARAM_IDS.EYE_R_OPEN] = eyeOpen;
                }
            } else if (this.state.blinkTimer >= this.state.nextBlinkTime) {
                // start blink
                this.state.isBlinking = true;
                this.state.blinkTimer = 0;
            } else {
                // ensure eyes open outside blink
                state.parameters[PARAM_IDS.EYE_L_OPEN] = 1;
                state.parameters[PARAM_IDS.EYE_R_OPEN] = 1;
            }
        }

        return state;
    }

    _randomBlinkInterval() {
        return TIMING.BLINK_INTERVAL_MIN + Math.random() * (TIMING.BLINK_INTERVAL_MAX - TIMING.BLINK_INTERVAL_MIN);
    }
}
