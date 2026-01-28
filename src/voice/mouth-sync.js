import { AvatarBridge } from '../avatar/avatar-bridge.js';

/**
 * Mouth Sync Controller
 * Smooths amplitude data and drives avatar mouth
 */
export const MouthSync = {
    // Smoothing factor (0.0 = no smoothing, 1.0 = no update)
    smoothing: 0.3,
    currentValue: 0,

    /**
     * Start syncing
     */
    start() {
        this.currentValue = 0;
        // Ensure avatar knows we are taking control
        try {
            if (AvatarBridge?.sendExternalMouthControl) {
                AvatarBridge.sendExternalMouthControl(true);
            }
        } catch (e) {
            console.warn('[MouthSync] Failed to notify avatar:', e);
        }
    },

    /**
     * Stop syncing (close mouth)
     */
    stop() {
        this.currentValue = 0;
        this.update(0);
        try {
            if (AvatarBridge?.sendExternalMouthControl) {
                AvatarBridge.sendExternalMouthControl(false);
            }
        } catch (e) {
            console.warn('[MouthSync] Failed to notify avatar:', e);
        }
    },

    /**
     * Update mouth opening based on raw amplitude
     * @param {number} rawAmplitude - 0.0 to 1.0 from AudioPlayer
     */
    update(rawAmplitude) {
        // Smooth the value
        this.currentValue = (this.currentValue * this.smoothing) +
            (rawAmplitude * (1.0 - this.smoothing));

        // Threshold to avoid mouth opening for background noise/silence
        const threshold = 0.05;
        const finalValue = this.currentValue < threshold ? 0 : this.currentValue;

        // Send to avatar (safely)
        try {
            if (AvatarBridge?.sendMouthAmplitude) {
                AvatarBridge.sendMouthAmplitude(finalValue);
            }
        } catch (e) {
            // Silently ignore avatar communication errors
        }
    }
};
