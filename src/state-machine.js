/**
 * State Machine Controller
 * Centralized state management for the assistant
 * 
 * States: IDLE, THINKING, RESPONDING
 * - IDLE: Accepts user input
 * - THINKING: Processing request, no input accepted
 * - RESPONDING: Displaying response, immediately returns to IDLE
 */

// State definitions
export const STATES = Object.freeze({
    IDLE: 'IDLE',
    THINKING: 'THINKING',
    RESPONDING: 'RESPONDING'
});

// Event definitions  
export const EVENTS = Object.freeze({
    USER_INPUT: 'USER_INPUT',
    LLM_RESPONSE: 'LLM_RESPONSE',
    LLM_ERROR: 'LLM_ERROR'
});

// State machine singleton
const StateMachine = {
    currentState: STATES.IDLE,
    listeners: [],

    /**
     * Subscribe to state changes
     * @param {function(string, any): void} callback - (newState, payload) => void
     * @returns {function(): void} - Unsubscribe function
     */
    subscribe(callback) {
        this.listeners.push(callback);
        return () => {
            this.listeners = this.listeners.filter(l => l !== callback);
        };
    },

    /**
     * Notify all listeners of state change
     * @param {string} state 
     * @param {any} payload 
     */
    notify(state, payload) {
        this.listeners.forEach(l => l(state, payload));
    },

    /**
     * Get current state
     * @returns {string}
     */
    getState() {
        return this.currentState;
    },

    /**
     * Transition to new state based on event
     * Only valid transitions are allowed
     * Errors always return to IDLE
     * 
     * @param {string} event - Event type
     * @param {any} payload - Associated data
     * @returns {boolean} - Whether transition occurred
     */
    transition(event, payload = null) {
        const prevState = this.currentState;

        switch (event) {
            case EVENTS.USER_INPUT:
                // Only accept input in IDLE state
                if (this.currentState !== STATES.IDLE) {
                    console.warn(`[SM] ✗ Input rejected (state: ${this.currentState})`);
                    return false;
                }
                this.currentState = STATES.THINKING;
                console.log(`[SM] ${prevState} → ${this.currentState}`);
                this.notify(STATES.THINKING, payload);
                return true;

            case EVENTS.LLM_RESPONSE:
                // Response received - briefly show RESPONDING then return to IDLE
                if (this.currentState !== STATES.THINKING) {
                    console.warn(`[SM] ✗ Response rejected (state: ${this.currentState})`);
                    return false;
                }
                // RESPONDING is transient - notify UI then immediately go to IDLE
                this.currentState = STATES.RESPONDING;
                console.log(`[SM] ${prevState} → ${this.currentState} → IDLE`);
                this.notify(STATES.RESPONDING, payload);
                // Immediately transition to IDLE (no lingering in RESPONDING)
                this.currentState = STATES.IDLE;
                this.notify(STATES.IDLE, null);
                return true;

            case EVENTS.LLM_ERROR:
                // Errors always return to IDLE from any state
                console.error(`[SM] ✗ Error in ${this.currentState}:`, payload);
                this.currentState = STATES.IDLE;
                this.notify(STATES.IDLE, { error: payload });
                return true;

            default:
                console.error('[SM] Unknown event:', event);
                return false;
        }
    },

    /**
     * Force reset to IDLE (emergency recovery)
     */
    reset() {
        this.currentState = STATES.IDLE;
        this.notify(STATES.IDLE, { reset: true });
    }
};

export default StateMachine;
