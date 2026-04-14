/**
 * ElevenLabs TTS Adapter
 * Calls the ElevenLabs REST API directly from the renderer and returns
 * base64-encoded MP3 audio for playback.
 *
 * Free tier: 10,000 characters/month with eleven_turbo_v2_5.
 */

const API_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';

// Free-tier voices confirmed working on ElevenLabs free plan.
// Most "pre-made" voices are now library voices requiring paid tier.
// Bella is the one confirmed free voice — upgrade to paid to unlock more.
export const ELEVENLABS_VOICES = Object.freeze([
    { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella (soft, gentle) ✓ Free' }
]);

export const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'; // Bella — only confirmed free voice
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2'; // Better emotional depth than turbo

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
        // Speed: 0.7 (slowest) - 1.2 (fastest). 0.78 = soft, deliberate, intimate pace
        speed: 0.78,
        // Intimate, emotional delivery tuned for a close companion character
        voice_settings: {
            stability: 0.22,        // Very low = breathy, emotional, variable — not flat
            similarity_boost: 0.92, // Stay true to voice character
            style: 0.65,            // High expressiveness — lets emotion shape the delivery
            use_speaker_boost: true // Sounds present and close, not distant
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
