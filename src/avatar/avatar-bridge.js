/**
 * Avatar Bridge
 * Thin bridge for sending signals from main window to avatar window
 * 
 * This module is intentionally thin:
 * - No logic
 * - No state (except enabled flag)
 * - Just forwards signals via IPC
 * 
 * Rules:
 * - Never modifies signals
 * - Never makes decisions
 * - Never receives data back from avatar
 */

import { AVATAR_SIGNALS } from './avatar-config.js';

// Settings key
const AVATAR_ENABLED_KEY = 'avatar_enabled';

export const AvatarBridge = {
    enabled: false,
    initialized: false,

    /**
     * Initialize the bridge
     */
    init() {
        if (this.initialized) return;

        // Load saved preference
        this.enabled = localStorage.getItem(AVATAR_ENABLED_KEY) === 'true';
        this.initialized = true;

        console.log('[AvatarBridge] Initialized, enabled:', this.enabled);

        // Request avatar window creation if enabled
        if (this.enabled && window.electronAPI?.toggleAvatar) {
            window.electronAPI.toggleAvatar(true);
        }
    },

    /**
     * Check if avatar is enabled
     * @returns {boolean}
     */
    isEnabled() {
        return this.enabled;
    },

    /**
     * Enable or disable the avatar
     * @param {boolean} enabled 
     */
    setEnabled(enabled) {
        this.enabled = enabled;
        localStorage.setItem(AVATAR_ENABLED_KEY, enabled.toString());

        console.log('[AvatarBridge] Enabled:', enabled);

        // Request main process to show/hide avatar window
        if (window.electronAPI?.toggleAvatar) {
            window.electronAPI.toggleAvatar(enabled);
        }
    },

    /**
     * Send state change to avatar
     * @param {'IDLE' | 'THINKING' | 'RESPONDING'} state 
     */
    sendState(state) {
        if (!this.enabled) return;
        this._send(AVATAR_SIGNALS.STATE_CHANGE, state);
    },

    /**
     * Send tone hint to avatar
     * @param {'calm' | 'neutral' | 'energetic'} tone 
     */
    sendToneHint(tone) {
        if (!this.enabled) return;
        this._send(AVATAR_SIGNALS.TONE_HINT, tone);
    },

    /**
     * Send typing rhythm to avatar
     * @param {'playful' | 'gentle' | null} rhythm 
     */
    sendTypingRhythm(rhythm) {
        if (!this.enabled) return;
        this._send(AVATAR_SIGNALS.TYPING_RHYTHM, rhythm);
    },

    /**
     * Send response timing to avatar
     * @param {object} timing 
     */
    sendResponseTiming(timing) {
        if (!this.enabled) return;
        this._send(AVATAR_SIGNALS.RESPONSE_TIMING, timing);
    },

    /**
     * Send mouth amplitude for lip sync
     * @param {number} amplitude - 0.0 to 1.0
     */
    sendMouthAmplitude(amplitude) {
        if (!this.enabled) return;
        this._send(AVATAR_SIGNALS.MOUTH_AMPLITUDE, amplitude);
    },

    /**
     * Enable/disable external mouth control
     * @param {boolean} active 
     */
    sendExternalMouthControl(active) {
        if (!this.enabled) return;
        this._send(AVATAR_SIGNALS.EXTERNAL_MOUTH_CONTROL, active);
    },

    /**
     * Send sentiment to avatar for expression
     * @param {'happy' | 'excited' | 'curious' | 'sad' | 'confused' | 'surprised' | 'neutral'} sentiment 
     */
    sendSentiment(sentiment) {
        if (!this.enabled) return;
        this._send('avatar:sentiment', sentiment);
    },

    /**
     * Internal send via IPC
     */
    _send(channel, data) {
        if (window.electronAPI?.sendToAvatar) {
            window.electronAPI.sendToAvatar(channel, data);
        }
    }
};
