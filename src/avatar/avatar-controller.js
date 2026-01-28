/**
 * Avatar Controller
 * Central signal receiver - the "puppet master"
 * 
 * Receives signals from the main window and dispatches to motion mapper.
 * This is the ONLY entry point for avatar control.
 * 
 * Rules:
 * - ONLY receives signals, never sends
 * - No AI calls
 * - No memory access
 * - No decision making
 * - All actions are reactive, never proactive
 */

export class AvatarController {
    constructor(motionMapper) {
        this.motionMapper = motionMapper;
        this.isEnabled = true;

        // Response timing state
        this.responseTimerId = null;
    }

    /**
     * Enable/disable avatar reactions
     * @param {boolean} enabled 
     */
    setEnabled(enabled) {
        this.isEnabled = enabled;

        if (!enabled) {
            this.stopResponseSync();
            this.motionMapper.reset();
        }
    }

    /**
     * Handle state change signal
     * @param {'IDLE' | 'THINKING' | 'RESPONDING'} state 
     */
    handleStateChange(state) {
        if (!this.isEnabled) return;

        console.log('[AvatarController] State change:', state);

        // Stop any ongoing response sync
        if (state !== 'RESPONDING') {
            this.stopResponseSync();
        }

        this.motionMapper.setState(state);

        // Start mouth sync for RESPONDING state
        if (state === 'RESPONDING') {
            this.startResponseSync();
        }
    }

    /**
     * Handle tone hint signal
     * @param {'calm' | 'neutral' | 'energetic'} tone 
     */
    handleToneHint(tone) {
        if (!this.isEnabled) return;

        console.log('[AvatarController] Tone hint:', tone);
        this.motionMapper.setTone(tone);
    }

    /**
     * Handle typing rhythm signal
     * @param {'fast' | 'slow' | 'normal' | 'playful' | 'gentle' | null} rhythm 
     */
    handleTypingRhythm(rhythm) {
        if (!this.isEnabled) return;

        // Normalize rhythm values
        let normalizedRhythm = 'normal';
        if (rhythm === 'playful' || rhythm === 'fast') {
            normalizedRhythm = 'fast';
        } else if (rhythm === 'gentle' || rhythm === 'slow') {
            normalizedRhythm = 'slow';
        }

        console.log('[AvatarController] Typing rhythm:', normalizedRhythm);
        this.motionMapper.setTypingRhythm(normalizedRhythm);
    }

    /**
     * Handle response timing signal
     * Called with timing info to sync mouth movement
     * @param {object} timing - { duration: number, isComplete: boolean }
     */
    handleResponseTiming(timing) {
        if (!this.isEnabled) return;

        if (timing?.isComplete) {
            this.stopResponseSync();
        }
    }

    /**
     * Start mouth sync animation for response
     */
    startResponseSync() {
        this.motionMapper.setMouthSync(true);

        // Auto-stop after a maximum duration (fallback)
        this.responseTimerId = setTimeout(() => {
            this.stopResponseSync();
        }, 30000); // 30 second max
    }

    /**
     * Stop mouth sync animation
     */
    stopResponseSync() {
        if (this.responseTimerId) {
            clearTimeout(this.responseTimerId);
            this.responseTimerId = null;
        }
        this.motionMapper.setMouthSync(false);
    }

    /**
     * Clean up resources
     */
    destroy() {
        this.stopResponseSync();
        this.isEnabled = false;
    }
}
