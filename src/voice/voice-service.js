import { AudioPlayer } from './audio-player.js';
import { MouthSync } from './mouth-sync.js';
import {
    isVoiceEnabled,
    getTTSEngine,
    TTS_ENGINE,
    getElevenLabsApiKey,
    getElevenLabsVoiceId,
} from '../settings.js';
import { synthesize as elevenLabsSynthesize, DEFAULT_VOICE_ID } from './elevenlabs-adapter.js';

export const VoiceService = {
    player: new AudioPlayer(),

    _onStart: null,
    _onEnd: null,
    _onDuration: null,
    _onAudioStart: null,

    init() {
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

        this.player.onPlaybackStart(() => {
            if (this._onAudioStart) this._onAudioStart();
        });
    },

    async speak(text, emotion = null) {
        console.log('[Voice] speak() called');

        if (!isVoiceEnabled()) {
            console.log('[Voice] Voice disabled, skipping');
            return;
        }

        this.stop();

        try {
            if (this._onStart) this._onStart();

            const engine = getTTSEngine();
            console.log(`[Voice] Requesting synthesis (${engine}):`, text.substring(0, 40) + '...');

            let result;
            if (engine === TTS_ENGINE.ELEVEN_LABS) {
                const apiKey = getElevenLabsApiKey();
                if (!apiKey) {
                    console.error('[Voice] ElevenLabs API key missing');
                    if (this._onEnd) this._onEnd();
                    return;
                }
                const voiceId = getElevenLabsVoiceId() || DEFAULT_VOICE_ID;
                result = await elevenLabsSynthesize(text, { apiKey, voiceId, emotion });
            } else {
                // System TTS via Python server
                try {
                    result = await window.electronAPI.ttsSynthesize(text, {
                        engine: 'system',
                        emotion: emotion?.label || null,
                    });
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

            MouthSync.start();
            await this.player.play(result.audio, result.mimeType);

        } catch (error) {
            console.error('[Voice] Speech failed:', error);
            MouthSync.stop();
            if (this._onEnd) this._onEnd();
        }
    },

    stop() {
        if (this.player.isPlaying()) {
            this.player.stop();
            MouthSync.stop();
        }
    },

    isPlaying() {
        return this.player.isPlaying();
    },

    onStart(cb)      { this._onStart = cb; },
    onEnd(cb)        { this._onEnd = cb; },
    onDuration(cb)   { this._onDuration = cb; },
    onAudioStart(cb) { this._onAudioStart = cb; }
};

VoiceService.init();
