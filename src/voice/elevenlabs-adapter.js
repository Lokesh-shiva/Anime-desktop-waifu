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
 * Per-emotion voice delivery presets.
 * stability: lower = more variable/breathy/emotional
 * style:     higher = more expressive, dramatic pacing
 * speed:     lower = slower, more deliberate
 */
const EMOTION_PRESETS = {
    // Core shy/intimate states
    shy:         { stability: 0.22, style: 0.58, speed: 0.82 },
    embarrassed: { stability: 0.15, style: 0.72, speed: 0.79 },
    flustered:   { stability: 0.13, style: 0.78, speed: 0.78 },
    hesitant:    { stability: 0.20, style: 0.62, speed: 0.80 },

    // Warm/positive states
    happy:       { stability: 0.32, style: 0.62, speed: 0.88 },
    grateful:    { stability: 0.28, style: 0.58, speed: 0.84 },
    kind:        { stability: 0.33, style: 0.52, speed: 0.85 },
    tender:      { stability: 0.26, style: 0.54, speed: 0.80 },
    playful:     { stability: 0.22, style: 0.72, speed: 0.90 },

    // Quiet/soft states
    calm:        { stability: 0.48, style: 0.38, speed: 0.86 },
    longing:     { stability: 0.35, style: 0.52, speed: 0.78 },
    lonely:      { stability: 0.38, style: 0.48, speed: 0.78 },
    melancholic: { stability: 0.40, style: 0.46, speed: 0.78 },

    // Active/reactive states
    curious:     { stability: 0.28, style: 0.62, speed: 0.87 },
    surprised:   { stability: 0.18, style: 0.78, speed: 0.88 },
    sad:         { stability: 0.38, style: 0.50, speed: 0.80 },
    anger:       { stability: 0.22, style: 0.82, speed: 0.90 },
};

const DEFAULT_PRESET = { stability: 0.22, style: 0.65, speed: 0.85 };

/**
 * Get voice settings for a given emotion object or label string.
 * Blends preset with intensity (higher intensity = more extreme values).
 */
function getEmotionSettings(emotion) {
    const label = (typeof emotion === 'string' ? emotion : emotion?.label || '').toLowerCase();
    const intensity = typeof emotion === 'object' ? (emotion?.intensity ?? 0.8) : 0.8;
    const preset = EMOTION_PRESETS[label] || DEFAULT_PRESET;

    // Interpolate toward extreme with intensity: 0.5 = half effect, 1.0 = full
    const t = Math.max(0, Math.min(1, intensity));
    return {
        stability: preset.stability * (1 - t * 0.3),   // More intense = even lower stability
        style:     Math.min(1, preset.style * (1 + t * 0.2)), // More intense = more expressive
        speed:     preset.speed
    };
}

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
export async function synthesize(text, { apiKey, voiceId, emotion } = {}) {
    if (!apiKey) {
        return { error: 'Missing ElevenLabs API key' };
    }
    const voice = voiceId || DEFAULT_VOICE_ID;
    const url = `${API_BASE}/${voice}`;

    const ev = getEmotionSettings(emotion);
    console.log(`[ElevenLabs] Emotion: ${emotion?.label || 'default'} → stability:${ev.stability.toFixed(2)} style:${ev.style.toFixed(2)} speed:${ev.speed}`);

    const body = {
        text,
        model_id: DEFAULT_MODEL_ID,
        speed: ev.speed,
        voice_settings: {
            stability: ev.stability,
            similarity_boost: 0.92,
            style: ev.style,
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
