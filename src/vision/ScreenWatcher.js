/**
 * ScreenWatcher
 * Periodically captures the primary screen and runs it through VisionAdapter.
 * Uses a thumbnail diff-check to skip API calls when the screen hasn't changed.
 */

import { VisionAdapter } from './VisionAdapter.js';

const INTERVAL_MS    = 4 * 60 * 1000; // 4 minutes
const DIFF_THRESHOLD = 0.04; // 4% character change triggers a new analysis
const DIFF_SAMPLES   = 800;  // positions sampled from base64 string

export class ScreenWatcher {
    constructor() {
        this._timer       = null;
        this._lastBase64  = null;
        this._context     = { activity: null, shouldReact: false, reactionHint: null, timestamp: 0 };
        this._reactionConsumed = false;
    }

    start() {
        if (this._timer) return;
        console.log('[ScreenWatcher] Started (interval:', INTERVAL_MS / 60000, 'min)');
        // Fire first analysis after 30s so app is fully loaded
        setTimeout(() => this._tick(), 30 * 1000);
        this._timer = setInterval(() => this._tick(), INTERVAL_MS);
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
        console.log('[ScreenWatcher] Stopped');
    }

    /** Current screen context for system prompt injection */
    getContext() {
        return this._context;
    }

    /**
     * Returns the pending reaction hint and clears it so it only fires once.
     * @returns {string|null}
     */
    consumeReaction() {
        if (this._context.shouldReact && !this._reactionConsumed) {
            this._reactionConsumed = true;
            return this._context.reactionHint;
        }
        return null;
    }

    async _tick() {
        try {
            const base64 = await window.electronAPI.captureScreen();
            if (!base64) return;

            // Diff check — sample the raw base64 string directly (no Image load,
            // no CSP issues). JPEG base64 is deterministic enough for change detection.
            if (this._lastBase64) {
                const changeRatio = this._sampleDiff(this._lastBase64, base64);
                if (changeRatio < DIFF_THRESHOLD) {
                    console.log('[ScreenWatcher] Screen unchanged, skipping VLM call');
                    return;
                }
            }
            this._lastBase64 = base64;

            console.log('[ScreenWatcher] Analysing screen...');
            const result = await VisionAdapter.analyzeScreen(base64);

            this._context = { ...result, timestamp: Date.now() };
            this._reactionConsumed = false;
            console.log('[ScreenWatcher] Activity:', result.activity, '| react:', result.shouldReact);
        } catch (e) {
            console.warn('[ScreenWatcher] Tick error:', e.message);
        }
    }

    /** Sample DIFF_SAMPLES positions across two base64 strings and return change ratio */
    _sampleDiff(a, b) {
        const len  = Math.max(a.length, b.length);
        const step = Math.max(1, Math.floor(len / DIFF_SAMPLES));
        let diffs  = 0, total = 0;
        for (let i = 0; i < len; i += step) {
            if (a[i] !== b[i]) diffs++;
            total++;
        }
        return diffs / total;
    }
}

export default ScreenWatcher;
