/**
 * Mouth Sync
 * Amplitude-based voice synchronization with smoothing and delay compensation.
 * Outputs a DesiredParameterState frame to be blended by AvatarController.
 */

import { PARAM_IDS } from './avatar-config.js';

export class MouthSync {
    constructor() {
        this.targetAmplitude = 0;
        this.currentAmplitude = 0;
        this.smoothingFactor = 0.3; // Low-pass filter (0 to 1, higher = faster)
        this.maxOpen = 0.85;        // Clamp max open
        this.isSpeaking = false;

        // Delay compensation buffer
        this.amplitudeBuffer = [];
        this.delayFrames = 3;       // Frames to delay
    }

    /**
     * Input amplitude from voice source
     * @param {number} amplitude (0 - 1) 
     */
    setAmplitude(amplitude) {
        // Clamp input
        const clamped = Math.min(1, Math.max(0, amplitude));

        // Push to delay buffer
        this.amplitudeBuffer.push(clamped);

        // Extract delayed value
        let delayedAmplitude = 0;
        if (this.amplitudeBuffer.length > this.delayFrames) {
            delayedAmplitude = this.amplitudeBuffer.shift();
        } else {
            delayedAmplitude = this.amplitudeBuffer[0];
        }

        // Apply clamping and target scaling
        this.targetAmplitude = delayedAmplitude * this.maxOpen;

        if (this.targetAmplitude > 0.05) {
            this.isSpeaking = true;
        } else if (this.currentAmplitude < 0.05) {
            this.isSpeaking = false;
        }
    }

    /**
     * Stop speaking explicitly
     */
    stop() {
        this.targetAmplitude = 0;
        this.amplitudeBuffer = [];
    }

    /**
     * Determine if mouth is currently syncing
     * @returns {boolean}
     */
    isActive() {
        return this.isSpeaking || this.currentAmplitude > 0.01;
    }

    /**
     * Update interpolation and generate desired state
     * @param {number} dt Delta time in seconds
     * @returns {Object} Desired parameter state
     */
    update(dt) {
        // Apply low-pass filter for smoothing (avoid jittering)
        // Adjust smoothing base on frame delta for stability
        const smoothSpeed = this.smoothingFactor * (60 * dt);

        this.currentAmplitude += (this.targetAmplitude - this.currentAmplitude) * Math.min(1, smoothSpeed);

        // Hard floor near zero to ensure full close
        if (this.currentAmplitude < 0.01 && this.targetAmplitude === 0) {
            this.currentAmplitude = 0;
        }

        return {
            parameters: {
                [PARAM_IDS.MOUTH_OPEN_Y]: this.currentAmplitude
            }
        };
    }
}
