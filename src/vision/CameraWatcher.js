/**
 * CameraWatcher
 * Periodically captures a webcam frame and runs it through VisionAdapter.
 * Manages the MediaStream lifecycle and shows/hides a camera-active indicator.
 *
 * Reaction types emitted via onReaction callback:
 *   'noticed_you'     — user reappeared after being away / first detection
 *   'looking_focused' — user has been focused for multiple consecutive reads
 *   'are_you_okay'    — user looks tired or stressed
 */

import { VisionAdapter } from './VisionAdapter.js';

const INTERVAL_MS  = 4 * 60 * 1000; // 4 minutes
const CAPTURE_W    = 640;
const CAPTURE_H    = 480;
const JPEG_QUALITY = 0.55;

// How many consecutive 'focused' reads before Miko says something
const FOCUSED_STREAK_THRESHOLD = 2;

export class CameraWatcher {
    constructor() {
        this._timer   = null;
        this._stream  = null;
        this._video   = null;
        this._canvas  = document.createElement('canvas');
        this._context = {
            isPresent: true, userState: 'unknown',
            shouldReact: false, reactionHint: null, timestamp: 0
        };
        this._reactionConsumed = false;

        // State tracking for typed reactions
        this._prevIsPresent   = null;  // null = no data yet
        this._prevUserState   = null;
        this._focusedStreak   = 0;     // consecutive focused reads
        this._readCount       = 0;     // total tick count (skip reaction on very first)

        // Callback for typed camera reactions — set by renderer
        this._onReaction = null;
    }

    /**
     * Register a callback for named camera reaction events.
     * @param {function(type: string, hint: string): void} fn
     */
    setReactionCallback(fn) {
        this._onReaction = fn;
    }

    async start() {
        if (this._timer) return;

        try {
            this._stream = await navigator.mediaDevices.getUserMedia({
                video: { width: CAPTURE_W, height: CAPTURE_H, facingMode: 'user' },
                audio: false
            });

            this._video = document.createElement('video');
            this._video.srcObject = this._stream;
            this._video.muted = true;
            await this._video.play();

            this._canvas.width  = CAPTURE_W;
            this._canvas.height = CAPTURE_H;

            this._showIndicator(true);
            console.log('[CameraWatcher] Started (interval:', INTERVAL_MS / 60000, 'min)');

            // First analysis after 20s
            setTimeout(() => this._tick(), 20 * 1000);
            this._timer = setInterval(() => this._tick(), INTERVAL_MS);
        } catch (e) {
            console.warn('[CameraWatcher] Could not access camera:', e.message);
        }
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;

        if (this._stream) {
            this._stream.getTracks().forEach(t => t.stop());
            this._stream = null;
        }
        if (this._video) {
            this._video.srcObject = null;
            this._video = null;
        }

        this._showIndicator(false);
        console.log('[CameraWatcher] Stopped');
    }

    getContext() {
        return this._context;
    }

    /**
     * Legacy polling API — still used by ScreenWatcher-style code.
     * Returns a pending reaction hint and clears it so it fires once.
     */
    consumeReaction() {
        if (this._context.shouldReact && !this._reactionConsumed) {
            this._reactionConsumed = true;
            return this._context.reactionHint;
        }
        return null;
    }

    async _tick() {
        if (!this._video || !this._stream) return;

        try {
            const base64 = this._captureFrame();
            if (!base64) return;

            console.log('[CameraWatcher] Analysing camera frame...');
            const result = await VisionAdapter.analyzeCamera(base64);

            const prev = { isPresent: this._prevIsPresent, userState: this._prevUserState };
            this._context = { ...result, timestamp: Date.now() };
            this._reactionConsumed = false;
            this._readCount++;

            console.log('[CameraWatcher] isPresent:', result.isPresent,
                '| state:', result.userState, '| react:', result.shouldReact);

            // ── Typed reaction detection ──────────────────────────────────────
            this._detectTypedReaction(prev, result);

            // Update previous state AFTER detection
            this._prevIsPresent = result.isPresent;
            this._prevUserState = result.userState;

        } catch (e) {
            console.warn('[CameraWatcher] Tick error:', e.message);
        }
    }

    /**
     * Classify what changed and emit the appropriate typed reaction.
     * Skips first tick (no baseline yet) and respects the callback guard.
     */
    _detectTypedReaction(prev, curr) {
        if (!this._onReaction) return;
        // Need at least one prior reading to detect transitions
        if (prev.isPresent === null) return;

        // 1. User reappeared after being absent
        if (!prev.isPresent && curr.isPresent) {
            this._focusedStreak = 0;
            console.log('[CameraWatcher] Reaction: noticed_you');
            this._onReaction('noticed_you',
                `You just noticed them sit back down. They've been away for a bit.`);
            return;
        }

        // Only proceed if user is present
        if (!curr.isPresent) {
            this._focusedStreak = 0;
            return;
        }

        // 2. User looks tired or stressed
        if ((curr.userState === 'tired' || curr.userState === 'stressed') &&
             curr.userState !== prev.userState) {
            this._focusedStreak = 0;
            console.log('[CameraWatcher] Reaction: are_you_okay —', curr.userState);
            this._onReaction('are_you_okay',
                `They look ${curr.userState}. You noticed and it's been on your mind.`);
            return;
        }

        // 3. Deep focus streak — they've been glued to their screen
        if (curr.userState === 'focused') {
            this._focusedStreak++;
            if (this._focusedStreak >= FOCUSED_STREAK_THRESHOLD) {
                this._focusedStreak = 0; // reset so it doesn't spam
                console.log('[CameraWatcher] Reaction: looking_focused');
                this._onReaction('looking_focused',
                    `They've been intensely focused on their screen for a while. You've been watching.`);
            }
        } else {
            this._focusedStreak = 0;
        }
    }

    _captureFrame() {
        try {
            const ctx = this._canvas.getContext('2d');
            ctx.drawImage(this._video, 0, 0, CAPTURE_W, CAPTURE_H);
            const dataUrl = this._canvas.toDataURL('image/jpeg', JPEG_QUALITY);
            // Strip the data:image/jpeg;base64, prefix
            return dataUrl.split(',')[1] || null;
        } catch (e) {
            console.warn('[CameraWatcher] Frame capture failed:', e.message);
            return null;
        }
    }

    /** Show/hide the small camera-active dot in the UI */
    _showIndicator(active) {
        let dot = document.getElementById('camera-active-dot');
        if (!dot) {
            dot = document.createElement('div');
            dot.id = 'camera-active-dot';
            // Positioned by CSS — defined in renderer styles
            document.body.appendChild(dot);
        }
        dot.classList.toggle('visible', active);
    }
}

export default CameraWatcher;
