import { AudioPlayer } from './audio-player.js';
import { MouthSync } from './mouth-sync.js';
import {
    isVoiceEnabled,
    getTTSEngine,
    TTS_ENGINE,
    getElevenLabsApiKey,
    getElevenLabsVoiceId
} from '../settings.js';
import { synthesize as elevenLabsSynthesize, DEFAULT_VOICE_ID } from './elevenlabs-adapter.js';

export const VoiceService = {
    player: new AudioPlayer(),

    // Callbacks
    _onStart: null,
    _onEnd: null,
    _onDuration: null,

    init() {
        // Wire up player -> mouth sync
        this.player.onAmplitude((amp) => {
            MouthSync.update(amp);
        });

        this.player.onEnd(() => {
            MouthSync.stop();
            if (this._onEnd) this._onEnd();
        });

        this.player.onDuration((ms) => {
            if (this._onDuration) this._onDuration(ms);
        });
    },

    /**
     * Synthesize and speak text
     * @param {string} text
     * @param {Object} [emotion] - Emotion object {label, intensity} from LLM response
     */
    async speak(text, emotion = null) {
        console.log('[Voice] speak() called');

        if (!isVoiceEnabled()) {
            console.log('[Voice] Voice disabled, skipping');
            return;
        }

        // Stop previous if any
        console.log('[Voice] Stopping previous playback');
        this.stop();

        try {
            if (this._onStart) this._onStart();

            // 1. Request Synthesis
            const engine = getTTSEngine();
            console.log(`[Voice] Requesting synthesis (${engine}):`, text.substring(0, 20) + '...');

            let result;
            if (engine === TTS_ENGINE.ELEVEN_LABS) {
                const apiKey = getElevenLabsApiKey();
                if (!apiKey) {
                    console.error('[Voice] ElevenLabs API key missing');
                    if (this._onEnd) this._onEnd();
                    return;
                }
                const voiceId = getElevenLabsVoiceId() || DEFAULT_VOICE_ID;
                console.log('[Voice] Calling ElevenLabs API, voice:', voiceId);
                result = await elevenLabsSynthesize(text, { apiKey, voiceId, emotion });
            } else {
                console.log('[Voice] Calling ttsSynthesize IPC...');
                try {
                    result = await window.electronAPI.ttsSynthesize(text, { engine });
                    console.log('[Voice] IPC returned, result keys:', result ? Object.keys(result) : 'null');
                } catch (ipcError) {
                    console.error('[Voice] IPC call failed:', ipcError);
                    if (this._onEnd) this._onEnd();
                    return;
                }
            }

            if (result.error) {
                console.error('[Voice] Synthesis error:', result.error);
                if (this._onEnd) this._onEnd();
                return;
            }

            if (!result.audio) {
                console.warn('[Voice] No audio received');
                if (this._onEnd) this._onEnd();
                return;
            }

            console.log('[Voice] Got audio, length:', result.audio.length);

            // 2. Start Playback & Sync
            MouthSync.start();
            await this.player.play(result.audio, result.mimeType);
            console.log('[Voice] Playback complete');

        } catch (error) {
            console.error('[Voice] Speech failed:', error);
            MouthSync.stop();
            if (this._onEnd) this._onEnd();
        }
    },

    /**
     * Stop speaking immediately
     */
    stop() {
        if (this.player.isPlaying()) {
            this.player.stop();
            MouthSync.stop();
        }
    },

    /**
     * Check if currently speaking
     */
    isPlaying() {
        return this.player.isPlaying();
    },

    /**
     * Set callbacks
     */
    onStart(cb) { this._onStart = cb; },
    onEnd(cb) { this._onEnd = cb; },
    onDuration(cb) { this._onDuration = cb; }
};

// Initialize
VoiceService.init();
