/**
 * Presence Module
 * Passive presence layer - adds life without cognition
 * 
 * Features:
 * - Time-aware tone adjustment (ephemeral, not stored)
 * - Input sensitivity detection (typing rhythm)
 * - Idle breathing animation control
 * 
 * Rules:
 * - No AI calls
 * - No memory storage
 * - No proactive behavior
 */

// Time of day boundaries (24-hour format)
const TIME_RANGES = {
    CALM: { start: 22, end: 6 },      // 10 PM - 6 AM
    ENERGETIC: { start: 12, end: 22 } // 12 PM - 10 PM
    // Neutral: 6 AM - 12 PM (default)
};

// Typing speed thresholds (milliseconds between keystrokes)
const TYPING_THRESHOLDS = {
    FAST: 100,   // < 100ms average = playful
    SLOW: 400    // > 400ms average = gentle
};

/**
 * Get current time-of-day tone hint
 * @returns {'calm' | 'neutral' | 'energetic'}
 */
export function getTimeOfDayTone() {
    const hour = new Date().getHours();

    // Check calm range (wraps around midnight)
    if (hour >= TIME_RANGES.CALM.start || hour < TIME_RANGES.CALM.end) {
        return 'calm';
    }

    // Check energetic range
    if (hour >= TIME_RANGES.ENERGETIC.start && hour < TIME_RANGES.ENERGETIC.end) {
        return 'energetic';
    }

    // Default: neutral (morning)
    return 'neutral';
}

/**
 * Analyze typing rhythm and return input hint
 * @param {number[]} keyTimestamps - Array of recent keydown timestamps
 * @returns {'gentle' | 'playful' | null}
 */
export function getInputRhythmHint(keyTimestamps) {
    // Need at least 3 keystrokes to detect rhythm
    if (!keyTimestamps || keyTimestamps.length < 3) {
        return null;
    }

    // Calculate average interval between keystrokes
    let totalInterval = 0;
    for (let i = 1; i < keyTimestamps.length; i++) {
        totalInterval += keyTimestamps[i] - keyTimestamps[i - 1];
    }
    const avgInterval = totalInterval / (keyTimestamps.length - 1);

    // Classify based on thresholds
    if (avgInterval < TYPING_THRESHOLDS.FAST) {
        return 'playful';
    }
    if (avgInterval > TYPING_THRESHOLDS.SLOW) {
        return 'gentle';
    }

    // Normal typing speed - no hint
    return null;
}

/**
 * Idle presence indicator controller
 */
export const IdlePresence = {
    element: null,

    /**
     * Initialize with DOM element
     * @param {HTMLElement} el 
     */
    init(el) {
        this.element = el;
    },

    /**
     * Show idle breathing animation
     */
    show() {
        if (this.element) {
            this.element.classList.remove('presence-hidden');
        }
    },

    /**
     * Hide idle presence indicator
     */
    hide() {
        if (this.element) {
            this.element.classList.add('presence-hidden');
        }
    }
};
