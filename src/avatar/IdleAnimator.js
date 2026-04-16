/**
 * Idle Animator
 * Procedural animation loop generating idle motions.
 * Outputs a DesiredParameterState frame to be blended by AvatarController.
 */

import { PARAM_IDS, TIMING } from './avatar-config.js';

// Blink personality profiles — each emotion gives different blink rhythm and duration.
// intervalMin/Max are seconds between blinks; duration is seconds for a single blink.
const BLINK_PROFILES = {
    // Wide-eyed — blinks are rare and quick (holds gaze)
    surprised:   { intervalMin: 4.0, intervalMax: 8.0, duration: 0.10 },
    scared:      { intervalMin: 4.0, intervalMax: 7.0, duration: 0.10 },
    curious:     { intervalMin: 3.5, intervalMax: 7.0, duration: 0.12 },
    smug:        { intervalMin: 3.5, intervalMax: 7.0, duration: 0.20 },

    // Slow soft blinks — dreamy / emotional weight
    love:        { intervalMin: 3.0, intervalMax: 6.0, duration: 0.26 },
    tender:      { intervalMin: 3.0, intervalMax: 6.0, duration: 0.24 },
    calm:        { intervalMin: 3.0, intervalMax: 6.5, duration: 0.22 },
    longing:     { intervalMin: 3.5, intervalMax: 6.5, duration: 0.24 },
    melancholic: { intervalMin: 3.0, intervalMax: 6.0, duration: 0.26 },
    sad:         { intervalMin: 3.0, intervalMax: 5.5, duration: 0.28 },
    lonely:      { intervalMin: 3.0, intervalMax: 5.5, duration: 0.28 },
    crying:      { intervalMin: 1.5, intervalMax: 3.0, duration: 0.30 }, // frequent heavy blinks
    kind:        { intervalMin: 2.5, intervalMax: 5.5, duration: 0.20 },
    grateful:    { intervalMin: 2.5, intervalMax: 5.5, duration: 0.20 },

    // Sleepy — very slow and heavy
    sleepy:      { intervalMin: 1.8, intervalMax: 3.5, duration: 0.38 },

    // Normal / upbeat
    happy:       { intervalMin: 2.5, intervalMax: 5.0, duration: 0.15 },
    playful:     { intervalMin: 2.0, intervalMax: 4.5, duration: 0.14 },
    excited:     { intervalMin: 2.0, intervalMax: 4.0, duration: 0.13 },
    determined:  { intervalMin: 2.5, intervalMax: 5.0, duration: 0.14 },
    confused:    { intervalMin: 2.0, intervalMax: 4.5, duration: 0.15 },

    // Nervous flutter — fast, slightly shorter blinks
    shy:         { intervalMin: 1.5, intervalMax: 3.5, duration: 0.13 },
    embarrassed: { intervalMin: 1.5, intervalMax: 3.0, duration: 0.12 },
    flustered:   { intervalMin: 1.2, intervalMax: 2.8, duration: 0.11 },
    hesitant:    { intervalMin: 1.8, intervalMax: 3.5, duration: 0.13 },

    // Twitchy / irritable
    anger:       { intervalMin: 1.5, intervalMax: 3.0, duration: 0.12 },
    disgusted:   { intervalMin: 1.5, intervalMax: 3.0, duration: 0.12 },
};

export class IdleAnimator {
    constructor(capabilityRegistry) {
        this.registry = capabilityRegistry;

        // Active blink profile — null means use TIMING defaults
        this._blinkProfile = null;

        this.state = {
            blinkTimer: 0,
            nextBlinkTime: this._randomBlinkInterval(),
            isBlinking: false,
            breathPhase: 0,
            swayPhase: 0,
            earWavePhase: Math.random() * Math.PI * 2  // random start so ears don't sync with breath
        };

        // Output overrides
        this.pauseBlink = false;
        this.pauseSway = false;
        this.pauseBreath = false;
        this.intensityMultiplier = 1.0;
    }

    /**
     * Switch blink personality to match the active emotion.
     * Pass null (or call with no arg) to reset to default neutral rhythm.
     * @param {string|null} emotionLabel
     */
    setBlinkProfile(emotionLabel) {
        const profile = emotionLabel ? (BLINK_PROFILES[emotionLabel] || null) : null;
        if (profile === this._blinkProfile) return; // no change
        this._blinkProfile = profile;

        // If not mid-blink, snap the next interval to the new profile so it
        // takes effect immediately rather than waiting out the old countdown.
        if (!this.state.isBlinking) {
            this.state.blinkTimer = 0;
            this.state.nextBlinkTime = this._randomBlinkInterval();
        }
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

        // 2. Ear Wave (VT_ELF Param20 — subtle idle oscillation)
        if (this.registry.hasParam(PARAM_IDS.ELF_EAR_WAVE)) {
            // ~0.8 Hz — slower than breath, feels organic and independent
            this.state.earWavePhase += (dt / 1.25) * Math.PI * 2;
            if (this.state.earWavePhase > Math.PI * 2) this.state.earWavePhase -= Math.PI * 2;
            // Map sin to [0, 0.22] — ears only wave up, never invert in idle
            const earWave = ((Math.sin(this.state.earWavePhase) + 1) / 2) * 0.22 * this.intensityMultiplier;
            state.parameters[PARAM_IDS.ELF_EAR_WAVE] = earWave;
        }

        // 3. Head/Body Sway
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
                const progress = this.state.blinkTimer / this._blinkDuration();
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
        const min = this._blinkProfile?.intervalMin ?? TIMING.BLINK_INTERVAL_MIN;
        const max = this._blinkProfile?.intervalMax ?? TIMING.BLINK_INTERVAL_MAX;
        return min + Math.random() * (max - min);
    }

    _blinkDuration() {
        return this._blinkProfile?.duration ?? TIMING.BLINK_DURATION;
    }
}
