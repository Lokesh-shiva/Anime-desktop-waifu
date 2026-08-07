/**
 * Audio Player
 * Handles audio playback and amplitude analysis for mouth sync
 * Uses HTML5 Audio for compatibility with various WAV formats
 */
export class AudioPlayer {
    constructor() {
        this.audio = null;
        this.isPlayingState = false;
        this.amplitudeCallback = null;
        this.onEndCallback = null;
        this.durationCallback = null;
        this.playbackStartCallback = null;
        this.animationFrameId = null;

        // Playback rate: 1.0 = normal, 0.85 = ~15% slower, 0.75 = noticeably soft/intimate
        this.playbackRate = 0.85;

        // For amplitude analysis
        this.audioContext = null;
        this.analyser = null;
        this.sourceNode = null;
        this.gainNode = null;
        this.muted = false;
    }

    /**
     * Mute/unmute output while keeping amplitude analysis (for lip-sync)
     * fully intact — used when audio is actually being played elsewhere
     * (e.g. into a Discord voice channel) and this local copy exists only
     * to drive MouthSync/emotion-arc timing, not to be heard.
     * @param {boolean} muted
     */
    setMuted(muted) {
        this.muted = muted;
        // Near-zero rather than exactly 0 — a hard-zero-output audio graph
        // can get optimized/throttled by the browser, which starved the
        // analyser of live data during "muted" playback and misfired the
        // flat-signal guard below (fake continuous mouth-wiggle instead of
        // natural open/close). This value is inaudible but keeps the graph
        // genuinely live.
        if (this.gainNode) this.gainNode.gain.value = muted ? 0.00001 : 1;
    }

    /**
     * Set playback speed (0.5 - 1.0). Applied to every audio element on play.
     * @param {number} rate
     */
    setPlaybackRate(rate) {
        this.playbackRate = Math.max(0.5, Math.min(1.0, rate));
        if (this.audio) this.audio.playbackRate = this.playbackRate;
    }

    /**
     * Decode base64 audio and play
     * @param {string} b64Audio - Base64-encoded audio bytes
     * @param {string} [mimeType='audio/wav'] - MIME type (e.g. 'audio/mpeg' for ElevenLabs MP3)
     */
    async play(b64Audio, mimeType = 'audio/wav') {
        try {
            this.stop(); // Stop any current playback

            console.log('[AudioPlayer] Starting playback, data length:', b64Audio?.length || 0, 'type:', mimeType);

            if (!b64Audio || b64Audio.length === 0) {
                console.error('[AudioPlayer] No audio data received');
                this._handleEnded();
                return;
            }

            // Create data URL from base64
            const dataUrl = `data:${mimeType};base64,${b64Audio}`;
            console.log('[AudioPlayer] Created data URL');

            // Create Audio element
            this.audio = new Audio(dataUrl);
            this.audio.playbackRate = this.playbackRate;

            // Set up event handlers
            this.audio.onended = () => {
                console.log('[AudioPlayer] Audio ended');
                this._handleEnded();
            };

            this.audio.onerror = (e) => {
                console.error('[AudioPlayer] Audio error:', e);
                this._handleEnded();
            };

            this.audio.oncanplaythrough = () => {
                if (this.audio && isFinite(this.audio.duration) && this.audio.duration > 0) {
                    // Actual playback duration accounts for the playback rate (slower = longer)
                    const realMs = (this.audio.duration / this.playbackRate) * 1000;
                    console.log(`[AudioPlayer] duration: ${this.audio.duration.toFixed(3)}s → ${realMs.toFixed(0)}ms at rate ${this.playbackRate}`);
                    if (this.durationCallback) this.durationCallback(realMs);
                }
            };

            // Try to set up amplitude analysis (non-critical - won't crash if it fails)
            try {
                this._setupAnalysis();
                // Resume AudioContext — Chromium suspends it until user gesture.
                // Without this, getByteTimeDomainData returns silent zeros and
                // the mouth never moves.
                if (this.audioContext && this.audioContext.state === 'suspended') {
                    await this.audioContext.resume();
                    console.log('[AudioPlayer] AudioContext resumed');
                }
            } catch (analysisError) {
                console.warn('[AudioPlayer] Could not setup amplitude analysis:', analysisError);
            }

            // Play
            console.log('[AudioPlayer] Playing audio...');
            await this.audio.play();
            this.isPlayingState = true;
            this._flatFrames = 0; // Reset flat-signal counter
            console.log('[AudioPlayer] Playback started');
            if (this.playbackStartCallback) this.playbackStartCallback();

            // Start amplitude analysis loop. Uses setInterval rather than
            // requestAnimationFrame — rAF is throttled/paused by the browser
            // when the window loses focus or is occluded, which stalls lip
            // sync exactly when streaming (focus shifts to Discord while she
            // keeps talking). setInterval keeps ticking regardless of focus.
            if (this.animationFrameId) {
                clearInterval(this.animationFrameId);
            }
            this.animationFrameId = setInterval(() => this._analyze(), 50);

        } catch (error) {
            console.error('[AudioPlayer] Playback failed:', error);
            this._handleEnded();
        }
    }

    /**
     * Set up audio analysis for mouth sync (optional, won't crash if fails)
     */
    _setupAnalysis() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        if (!this.analyser) {
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
        }

        if (!this.gainNode) {
            this.gainNode = this.audioContext.createGain();
            this.gainNode.gain.value = this.muted ? 0 : 1;
            this.analyser.connect(this.gainNode);
            this.gainNode.connect(this.audioContext.destination);
        }

        // Connect audio element to analyser
        if (this.audio && !this.sourceNode) {
            this.sourceNode = this.audioContext.createMediaElementSource(this.audio);
            this.sourceNode.connect(this.analyser);
        }
    }

    /**
     * Stop playback immediately
     */
    stop() {
        if (this.audio) {
            try {
                this.audio.pause();
                this.audio.currentTime = 0;
            } catch (e) {
                // Ignore errors
            }
            this.audio = null;
        }

        if (this.sourceNode) {
            try {
                this.sourceNode.disconnect();
            } catch (e) {
                // Ignore
            }
            this.sourceNode = null;
        }

        if (this.animationFrameId) {
            clearInterval(this.animationFrameId);
            this.animationFrameId = null;
        }

        this.isPlayingState = false;
    }

    /**
     * Check if currently playing
     */
    isPlaying() {
        return this.isPlayingState;
    }

    /**
     * Set amplitude callback (0.0 - 1.0)
     */
    onAmplitude(callback) {
        this.amplitudeCallback = callback;
    }

    /**
     * Set on end callback
     */
    onEnd(callback) {
        this.onEndCallback = callback;
    }

    /**
     * Set duration callback — fires once when real audio duration is known.
     * @param {function(number): void} callback - receives actual playback duration in ms
     */
    onDuration(callback) {
        this.durationCallback = callback;
    }

    /**
     * Set playback-start callback — fires the moment audio.play() resolves.
     * Use this to sync animations/arcs to actual audio start, not synthesis start.
     * @param {function(): void} callback
     */
    onPlaybackStart(callback) {
        this.playbackStartCallback = callback;
    }

    /**
     * Animation loop for amplitude analysis.
     *
     * Primary path: Web Audio AnalyserNode RMS from the live audio stream.
     * Fallback path: cosine-wave simulation — triggers automatically when the
     * analyser returns near-silence for >10 frames while audio is playing.
     * This covers the common case where AudioContext stays suspended or the
     * data-URL source doesn't feed through the graph in some Electron builds.
     */
    _analyze() {
        if (!this.isPlayingState) return;

        let visualAmp = 0;

        if (this.analyser) {
            try {
                const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
                this.analyser.getByteTimeDomainData(dataArray);

                // Calculate RMS amplitude
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    const amplitude = (dataArray[i] - 128) / 128;
                    sum += amplitude * amplitude;
                }
                const rms = Math.sqrt(sum / dataArray.length);
                visualAmp = Math.min(1.0, rms * 4.0);

                // Flat-signal guard: if RMS is suspiciously low for many frames
                // while we know audio is playing, fall back to cosine simulation.
                if (rms < 0.002) {
                    this._flatFrames = (this._flatFrames || 0) + 1;
                } else {
                    this._flatFrames = 0;
                }

                if (this._flatFrames > 10) {
                    // AudioContext likely suspended or source not wired — simulate
                    const t = performance.now() / 1000;
                    visualAmp = 0.25 + 0.22 * Math.abs(Math.sin(t * 4.5)) +
                                0.10 * Math.abs(Math.sin(t * 9.1));
                }
            } catch (e) {
                // Fallback: cosine simulation
                const t = performance.now() / 1000;
                visualAmp = 0.25 + 0.22 * Math.abs(Math.sin(t * 4.5));
            }
        } else {
            // No analyser at all — cosine simulation
            const t = performance.now() / 1000;
            visualAmp = 0.25 + 0.22 * Math.abs(Math.sin(t * 4.5)) +
                        0.10 * Math.abs(Math.sin(t * 9.1));
        }

        if (this.amplitudeCallback) {
            this.amplitudeCallback(visualAmp);
        }
    }

    _handleEnded() {
        this.stop();
        if (this.onEndCallback) {
            this.onEndCallback();
        }
    }
}

