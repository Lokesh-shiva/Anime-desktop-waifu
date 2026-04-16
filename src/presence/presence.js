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
    if (hour >= TIME_RANGES.CALM.start || hour < TIME_RANGES.CALM.end) return 'calm';
    if (hour >= TIME_RANGES.ENERGETIC.start && hour < TIME_RANGES.ENERGETIC.end) return 'energetic';
    return 'neutral';
}

/**
 * Rich time context object — used to give Miko natural awareness of
 * when things are happening without hardcoding lines into the LLM prompt.
 *
 * @returns {{
 *   hour: number,
 *   slot: string,        — 'dead of night'|'early morning'|'morning'|'midday'|'afternoon'|'evening'|'night'|'late night'
 *   dayName: string,     — 'Monday' … 'Sunday'
 *   isWeekend: boolean,
 *   isMonday: boolean,
 *   isFriday: boolean,
 *   tone: string,        — 'calm'|'neutral'|'energetic'
 *   naturalDesc: string  — ready-to-inject phrase e.g. "late on a Friday night"
 * }}
 */
export function getRichTimeContext() {
    const now     = new Date();
    const hour    = now.getHours();
    const minute  = now.getMinutes();
    const dayIdx  = now.getDay(); // 0 = Sunday
    const DAYS    = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName = DAYS[dayIdx];
    const isWeekend = dayIdx === 0 || dayIdx === 6;
    const isMonday  = dayIdx === 1;
    const isFriday  = dayIdx === 5;

    // Fine-grained time slot
    let slot;
    if      (hour >= 0  && hour < 4)  slot = 'dead of night';
    else if (hour >= 4  && hour < 6)  slot = 'early morning';
    else if (hour >= 6  && hour < 9)  slot = 'morning';
    else if (hour >= 9  && hour < 12) slot = 'late morning';
    else if (hour >= 12 && hour < 14) slot = 'midday';
    else if (hour >= 14 && hour < 17) slot = 'afternoon';
    else if (hour >= 17 && hour < 20) slot = 'evening';
    else if (hour >= 20 && hour < 22) slot = 'night';
    else                               slot = 'late night';

    // Natural description — avoids the robotic "It is 11 PM on Tuesday"
    let naturalDesc;
    if (slot === 'dead of night')  naturalDesc = `really late — past midnight on ${dayName}`;
    else if (slot === 'early morning') naturalDesc = `early in the morning on ${dayName}`;
    else if (isWeekend)            naturalDesc = `${slot} on a ${dayName}`;
    else if (isMonday)             naturalDesc = `${slot} on a Monday`;
    else if (isFriday)             naturalDesc = `${slot} on a Friday`;
    else                           naturalDesc = `${slot} on ${dayName}`;

    // Add minute-awareness for near-midnight / near-noon moments
    if (hour === 23 && minute >= 45) naturalDesc = 'almost midnight';
    if (hour === 11 && minute >= 45) naturalDesc = `almost midday on ${dayName}`;

    return {
        hour,
        slot,
        dayName,
        isWeekend,
        isMonday,
        isFriday,
        tone: getTimeOfDayTone(),
        naturalDesc
    };
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
        this._paused = false;
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
        this._paused = false;
    },

    /**
     * Pause idle timer — user is active in another window.
     * Timer is cleared; resumes from scratch when resume() is called.
     */
    pause() {
        if (this._paused) return;
        this._paused = true;
        this._clearTimer();
        console.log('[IdleTimer] Paused — window lost focus');
    },

    /**
     * Resume idle timer after focus returns.
     * Starts a fresh countdown (not from where it paused — user just came back).
     */
    resume() {
        if (!this._paused) return;
        this._paused = false;
        this._schedule();
        console.log('[IdleTimer] Resumed — window regained focus');
    },

    _clearTimer() {
        if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    },

    _schedule() {
        if (this._paused) return;
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
                timeContext: getRichTimeContext(),
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

/**
 * Weather Context
 * Fetches local weather once per session (or once per day) via open-meteo.com
 * — no API key required. Provides a natural-language weather phrase for prompts.
 *
 * Usage:
 *   await WeatherContext.init();   // call once on startup
 *   WeatherContext.getPhrase();    // returns e.g. "it's raining and about 18°C outside"
 */
export const WeatherContext = {
    _phrase: null,
    _fetchedAt: null,
    _REFRESH_MS: 6 * 60 * 60 * 1000, // re-fetch every 6 hours

    /**
     * Initialise — fetches coordinates from browser geolocation then weather.
     * Fails silently if user denies location or network is unavailable.
     */
    async init() {
        // Don't re-fetch if recent
        if (this._fetchedAt && (Date.now() - this._fetchedAt) < this._REFRESH_MS) return;

        try {
            const { lat, lon } = await this._getCoords();
            await this._fetchWeather(lat, lon);
        } catch (e) {
            console.warn('[WeatherContext] Could not fetch weather:', e.message);
            this._phrase = null;
        }
    },

    /** Returns a ready-to-inject phrase, or null if unavailable. */
    getPhrase() {
        return this._phrase;
    },

    _getCoords() {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) return reject(new Error('Geolocation unavailable'));
            navigator.geolocation.getCurrentPosition(
                (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
                (err) => reject(new Error(err.message)),
                { timeout: 5000 }
            );
        });
    },

    async _fetchWeather(lat, lon) {
        // open-meteo: free, no key, returns current conditions
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weathercode,windspeed_10m&temperature_unit=celsius&windspeed_unit=kmh&timezone=auto`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`open-meteo ${resp.status}`);
        const data = await resp.json();

        const temp = Math.round(data.current.temperature_2m);
        const code = data.current.weathercode;
        const wind = Math.round(data.current.windspeed_10m);

        this._phrase = this._buildPhrase(code, temp, wind);
        this._fetchedAt = Date.now();
        console.log(`[WeatherContext] ${this._phrase}`);
    },

    _buildPhrase(code, temp, wind) {
        // WMO weather codes → natural description
        const desc =
            code === 0                          ? 'clear skies' :
            code === 1                          ? 'mostly clear' :
            code === 2                          ? 'partly cloudy' :
            code === 3                          ? 'overcast' :
            code >= 45 && code <= 48           ? 'foggy' :
            code >= 51 && code <= 55           ? 'drizzling' :
            code >= 61 && code <= 65           ? 'raining' :
            code >= 71 && code <= 77           ? 'snowing' :
            code >= 80 && code <= 82           ? 'rainy with showers' :
            code >= 95 && code <= 99           ? 'stormy' :
            'cloudy';

        const windDesc = wind > 40 ? ', pretty windy' : wind > 20 ? ', a bit breezy' : '';
        return `it's ${desc} and about ${temp}°C outside${windDesc}`;
    }
};
