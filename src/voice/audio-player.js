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
        this.animationFrameId = null;

        // For amplitude analysis
        this.audioContext = null;
        this.analyser = null;
        this.sourceNode = null;
    }

    /**
     * Decode base64 audio and play
     * @param {string} b64Audio - Base64 encoded WAV
     */
    async play(b64Audio) {
        try {
            this.stop(); // Stop any current playback

            console.log('[AudioPlayer] Starting playback, data length:', b64Audio?.length || 0);

            if (!b64Audio || b64Audio.length === 0) {
                console.error('[AudioPlayer] No audio data received');
                this._handleEnded();
                return;
            }

            // Create data URL from base64
            const dataUrl = `data:audio/wav;base64,${b64Audio}`;
            console.log('[AudioPlayer] Created data URL');

            // Create Audio element
            this.audio = new Audio(dataUrl);

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
                if (this.audio) {
                    console.log('[AudioPlayer] Audio can play through, duration:', this.audio.duration);
                }
            };

            // Try to set up amplitude analysis (non-critical - won't crash if it fails)
            try {
                this._setupAnalysis();
            } catch (analysisError) {
                console.warn('[AudioPlayer] Could not setup amplitude analysis:', analysisError);
            }

            // Play
            console.log('[AudioPlayer] Playing audio...');
            await this.audio.play();
            this.isPlayingState = true;
            console.log('[AudioPlayer] Playback started');

            // Start amplitude analysis loop
            this._analyze();

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
            this.analyser.connect(this.audioContext.destination);
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
            cancelAnimationFrame(this.animationFrameId);
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
     * Animation loop for amplitude analysis
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
            } catch (e) {
                // Fallback: simple time-based simulation
                visualAmp = Math.random() * 0.3 + 0.2;
            }
        } else {
            // Fallback: simple time-based simulation if no analyser
            visualAmp = Math.random() * 0.3 + 0.2;
        }

        if (this.amplitudeCallback) {
            this.amplitudeCallback(visualAmp);
        }

        this.animationFrameId = requestAnimationFrame(this._analyze.bind(this));
    }

    _handleEnded() {
        this.stop();
        if (this.onEndCallback) {
            this.onEndCallback();
        }
    }
}

