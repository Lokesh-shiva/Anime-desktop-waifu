/**
 * ElevenLabs TTS Adapter
 * Calls the ElevenLabs REST API directly from the renderer and returns
 * base64-encoded MP3 audio for playback.
 *
 * Free tier: 10,000 characters/month with eleven_turbo_v2_5.
 */

const API_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';

// Free-tier pre-made voices (ElevenLabs built-ins, NOT library/community voices)
// These work on free API without 402 errors
export const ELEVENLABS_VOICES = Object.freeze([
    { id: 'piTKgcLEGmPE4e6mEKli', name: 'Nicole (whisper, intimate)' },      // Best for shy/adorable
    { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella (soft, gentle)' },            // Sweet and warm
    { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel (calm, composed)' },          // Smooth and clear
    { id: 'LcfcDJNUP1GQjkzn1xUU', name: 'Emily (warm, emotional)' },         // Deep expressiveness
    { id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli (youthful, bright)' },         // Young and energetic
    { id: 'XB0fDUnXU5powFXDhCwa', name: 'Charlotte (expressive, warm)' },    // Most emotional range
    { id: 'ThT5KcBeYPX3keUQqHPh', name: 'Dorothy (pleasant, gentle)' },      // Soft British
    { id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi (clear, confident)' }          // Crisp and bright
]);

export const DEFAULT_VOICE_ID = 'piTKgcLEGmPE4e6mEKli'; // Nicole — whisper/intimate, best for shy personality
const DEFAULT_MODEL_ID = 'eleven_turbo_v2_5'; // Free tier, low latency

/**
 * Convert an ArrayBuffer to base64 string (renderer-safe).
 */
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

/**
 * Synthesize speech using ElevenLabs.
 * @param {string} text
 * @param {{apiKey: string, voiceId?: string}} opts
 * @returns {Promise<{audio?: string, mimeType?: string, error?: string}>}
 */
export async function synthesize(text, { apiKey, voiceId } = {}) {
    if (!apiKey) {
        return { error: 'Missing ElevenLabs API key' };
    }
    const voice = voiceId || DEFAULT_VOICE_ID;
    const url = `${API_BASE}/${voice}`;

    const body = {
        text,
        model_id: DEFAULT_MODEL_ID,
        // Soft, expressive delivery tuned for a shy/adorable persona
        voice_settings: {
            stability: 0.45,
            similarity_boost: 0.8,
            style: 0.35,
            use_speaker_boost: true
        }
    };

    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg'
            },
            body: JSON.stringify(body)
        });

        if (!resp.ok) {
            let detail = resp.statusText;
            try {
                const errJson = await resp.json();
                detail = errJson?.detail?.message || errJson?.detail || detail;
            } catch (_) { /* not JSON */ }
            return { error: `ElevenLabs ${resp.status}: ${detail}` };
        }

        const buffer = await resp.arrayBuffer();
        return {
            audio: arrayBufferToBase64(buffer),
            mimeType: 'audio/mpeg'
        };
    } catch (e) {
        return { error: `ElevenLabs fetch failed: ${e.message}` };
    }
}
