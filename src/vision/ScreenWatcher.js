/**
 * ScreenWatcher
 * Periodically captures the primary screen and runs it through VisionAdapter.
 * Uses a thumbnail diff-check to skip API calls when the screen hasn't changed.
 */

import { VisionAdapter } from './VisionAdapter.js';

const INTERVAL_MS   = 4 * 60 * 1000; // 4 minutes
const DIFF_CANVAS_W = 160;
const DIFF_CANVAS_H = 90;
const DIFF_THRESHOLD = 0.06; // 6% pixel change triggers a new analysis

export class ScreenWatcher {
    constructor() {
        this._timer       = null;
        this._lastDiffUrl = null;
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

            // Diff check — skip if screen looks the same
            const diffUrl = await this._thumbnailDataUrl(base64);
            if (diffUrl && this._lastDiffUrl) {
                const changeRatio = this._roughDiff(this._lastDiffUrl, diffUrl);
                if (changeRatio < DIFF_THRESHOLD) {
                    console.log('[ScreenWatcher] Screen unchanged, skipping VLM call');
                    return;
                }
            }
            this._lastDiffUrl = diffUrl;

            console.log('[ScreenWatcher] Analysing screen...');
            const result = await VisionAdapter.analyzeScreen(base64);

            this._context = { ...result, timestamp: Date.now() };
            this._reactionConsumed = false;
            console.log('[ScreenWatcher] Activity:', result.activity, '| react:', result.shouldReact);
        } catch (e) {
            console.warn('[ScreenWatcher] Tick error:', e.message);
        }
    }

    /** Render base64 JPEG into a tiny canvas and return its data URL for diffing */
    async _thumbnailDataUrl(base64Jpeg) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width  = DIFF_CANVAS_W;
                canvas.height = DIFF_CANVAS_H;
                canvas.getContext('2d').drawImage(img, 0, 0, DIFF_CANVAS_W, DIFF_CANVAS_H);
                resolve(canvas.toDataURL('image/jpeg', 0.4));
            };
            img.onerror = () => resolve(null);
            img.src = 'data:image/jpeg;base64,' + base64Jpeg;
        });
    }

    /** Rough string-level diff between two data URLs — good enough for change detection */
    _roughDiff(a, b) {
        const len  = Math.max(a.length, b.length);
        let diffs  = 0;
        const step = Math.max(1, Math.floor(len / 500)); // sample 500 positions
        for (let i = 0; i < len; i += step) {
            if (a[i] !== b[i]) diffs++;
        }
        return diffs / (len / step);
    }
}

export default ScreenWatcher;
