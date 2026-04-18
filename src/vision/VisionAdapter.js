/**
 * VisionAdapter
 * Sends a single base64 image to Gemini Flash (multimodal) and returns
 * structured context. Intentionally separate from BrainRouter — VLM calls
 * use a different request shape and should never interfere with chat.
 */

import { getCloudApiKey } from '../settings.js';

const GEMINI_VISION_ENDPOINT =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const SCREEN_PROMPT = `You are a passive observer describing a desktop screen for an AI companion.
In 1 sentence describe what the user is doing (e.g. "writing code in VS Code", "watching a YouTube video", "browsing Reddit").
Focus on the activity, not private text or personal info.
Then decide if there is something interesting enough to warrant a natural comment.

Output ONLY valid JSON, no markdown:
{"activity":"<one sentence>","shouldReact":<true|false>,"reactionHint":"<one casual sentence hook, or null>"}

shouldReact = true only for genuinely notable things (new game started, error screen, creative work, etc.) — not idle desktop or browser tabs.`;

const CAMERA_PROMPT = `You are looking at a webcam image for an AI companion app.
First check if a person is clearly visible.
If yes, describe their apparent state in one word from: focused, relaxed, tired, stressed, happy.
Decide if their state is notable enough to mention.

Output ONLY valid JSON, no markdown:
{"isPresent":<true|false>,"userState":"<focused|relaxed|tired|stressed|happy|unknown>","shouldReact":<true|false>,"reactionHint":"<one warm empathetic sentence hook, or null>"}

If no person is visible: {"isPresent":false,"userState":"away","shouldReact":false,"reactionHint":null}`;

async function callGeminiVision(base64Jpeg, prompt) {
    const apiKey = getCloudApiKey();
    if (!apiKey) throw new Error('No cloud API key configured');

    const body = {
        contents: [{
            parts: [
                { inlineData: { mimeType: 'image/jpeg', data: base64Jpeg } },
                { text: prompt }
            ]
        }],
        generationConfig: { maxOutputTokens: 120, temperature: 0.2 }
    };

    const response = await fetch(`${GEMINI_VISION_ENDPOINT}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(`Vision API error: ${err?.error?.message || response.status}`);
    }

    const data = await response.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Vision response not parseable: ' + raw.slice(0, 80));
    return JSON.parse(jsonMatch[0]);
}

export const VisionAdapter = {
    async analyzeScreen(base64Jpeg) {
        try {
            const result = await callGeminiVision(base64Jpeg, SCREEN_PROMPT);
            return {
                activity:      result.activity      || null,
                shouldReact:   !!result.shouldReact,
                reactionHint:  result.reactionHint  || null
            };
        } catch (e) {
            console.warn('[Vision] Screen analysis failed:', e.message);
            return { activity: null, shouldReact: false, reactionHint: null };
        }
    },

    async analyzeCamera(base64Jpeg) {
        try {
            const result = await callGeminiVision(base64Jpeg, CAMERA_PROMPT);
            return {
                isPresent:    !!result.isPresent,
                userState:    result.userState    || 'unknown',
                shouldReact:  !!result.shouldReact,
                reactionHint: result.reactionHint || null
            };
        } catch (e) {
            console.warn('[Vision] Camera analysis failed:', e.message);
            return { isPresent: true, userState: 'unknown', shouldReact: false, reactionHint: null };
        }
    }
};

export default VisionAdapter;
