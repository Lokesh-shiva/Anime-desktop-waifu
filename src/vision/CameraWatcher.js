/**
 * CameraWatcher
 * Periodically captures a webcam frame and runs it through VisionAdapter.
 * Manages the MediaStream lifecycle and shows/hides a camera-active indicator.
 */

import { VisionAdapter } from './VisionAdapter.js';

const INTERVAL_MS  = 4 * 60 * 1000; // 4 minutes
const CAPTURE_W    = 640;
const CAPTURE_H    = 480;
const JPEG_QUALITY = 0.55;

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

            this._context = { ...result, timestamp: Date.now() };
            this._reactionConsumed = false;
            console.log('[CameraWatcher] isPresent:', result.isPresent,
                '| state:', result.userState, '| react:', result.shouldReact);
        } catch (e) {
            console.warn('[CameraWatcher] Tick error:', e.message);
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
