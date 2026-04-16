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
 * Proactive Idle Messenger
 *
 * Tracks silence and fires a callback when Miko should initiate contact.
 * Timer resets after every user interaction or Miko response.
 *
 * Thresholds:
 *   First idle message : ~3 min  (±60s jitter)
 *   Subsequent messages: ~12 min (±90s jitter)
 *   Minimum gap        : 60s  (safety floor)
 */
export const ProactiveIdle = {
    _timer: null,
    _callback: null,
    _messageCount: 0,

    FIRST_MS:      3  * 60 * 1000,  // 3 min
    SUBSEQUENT_MS: 12 * 60 * 1000,  // 12 min
    JITTER_FIRST:  60 * 1000,        // ±60s
    JITTER_NEXT:   90 * 1000,        // ±90s
    MIN_MS:        60 * 1000,        // never sooner than 1 min

    /**
     * Set the callback and start the initial timer.
     * @param {function({timeOfDay: string, minutesSilent: number, messageCount: number}): void} callback
     */
    init(callback) {
        this._callback = callback;
        this._messageCount = 0;
        this._schedule();
    },

    /**
     * Reset (restart) the silence timer. Call after every user input or Miko response.
     */
    reset() {
        this._clearTimer();
        this._schedule();
    },

    /** Stop permanently (e.g. on app teardown). */
    stop() {
        this._clearTimer();
    },

    _clearTimer() {
        if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    },

    _schedule() {
        const base   = this._messageCount === 0 ? this.FIRST_MS       : this.SUBSEQUENT_MS;
        const jitter = this._messageCount === 0 ? this.JITTER_FIRST   : this.JITTER_NEXT;
        // Random offset in [-jitter, +jitter]
        const offset = (Math.random() * 2 - 1) * jitter;
        const delay  = Math.max(this.MIN_MS, base + offset);

        console.log(`[IdleTimer] Next idle check in ${Math.round(delay / 1000)}s`);
        this._timer = setTimeout(() => this._fire(), delay);
    },

    _fire() {
        this._timer = null;
        this._messageCount++;
        const minutesSilent = this._messageCount === 1
            ? Math.round(this.FIRST_MS / 60000)
            : Math.round(this.SUBSEQUENT_MS / 60000);

        if (this._callback) {
            this._callback({
                timeOfDay: getTimeOfDayTone(),
                minutesSilent,
                messageCount: this._messageCount
            });
        }
        // Schedule the next idle message after this one
        this._schedule();
    }
};

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
