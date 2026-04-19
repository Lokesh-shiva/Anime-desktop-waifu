/**
 * Brain Router
 * Single interface for all LLM calls
 * Handles model selection, availability checking, and fallback logic
 */

import { getModelMode, MODEL_MODE, getCloudProvider } from '../settings.js';
import OllamaAdapter from './ollama-adapter.js';
import CloudAdapter from './cloud-adapter.js';
import OpenRouterAdapter from './openrouter-adapter.js';

/**
 * Get the appropriate cloud adapter based on settings
 */
function getCloudAdapter() {
    const provider = getCloudProvider();
    return provider === 'openrouter' ? OpenRouterAdapter : CloudAdapter;
}

/**
 * Brain Router - unified LLM interface
 * The UI calls this, never the adapters directly
 */
export const BrainRouter = {
    /**
     * Generate a response using the appropriate model
     * @param {string} prompt - User input
     * @returns {Promise<Object>} - Parsed LLM response JSON { text, emotion, actionHints }
     */
    async generate(prompt, options = {}) {
        const mode = getModelMode();
        console.log(`[Brain] Mode: ${mode}`);

        let rawResponse = '';

        // If preferLocal requested AND we are not forced to Cloud Only
        // Use local directly
        if (options.preferLocal && mode !== MODEL_MODE.CLOUD_ONLY) {
            console.log('[Brain] Preferring local for background task');
            rawResponse = await this._generateLocal(prompt, options);
        } else {
            switch (mode) {
                case MODEL_MODE.LOCAL_ONLY:
                    rawResponse = await this._generateLocal(prompt, options);
                    break;
                case MODEL_MODE.CLOUD_PREFERRED:
                    rawResponse = await this._generateCloudWithFallback(prompt, options);
                    break;
                case MODEL_MODE.CLOUD_ONLY:
                    rawResponse = await this._generateCloud(prompt, options);
                    break;
                default:
                    // Safety fallback to local
                    console.warn('[Brain] Unknown mode, defaulting to local');
                    rawResponse = await this._generateLocal(prompt, options);
            }
        }

        // raw: true skips chat JSON parsing — used by memory analyzer and other
        // internal callers that have their own response format
        if (options.raw) return rawResponse;

        return this._parseLLMResponse(rawResponse);
    },

    /**
     * Generate a response with streaming — fires onProvisionalEmotion as soon as
     * the [EMOTION:label:intensity] tag arrives in the first tokens, then resolves
     * with the full parsed response object when generation is complete.
     *
     * Falls back to regular generate() if the chosen adapter has no stream() method
     * (e.g. OpenRouter), still calling onProvisionalEmotion from the parsed arc.
     *
     * @param {string} prompt
     * @param {Object} options
     * @param {function({label:string, intensity:number}): void} onProvisionalEmotion
     * @param {function(string): void} onTextChunk - receives raw (pre-parse) accumulated text on each chunk
     * @returns {Promise<Object>} - same shape as generate()
     */
    async generateStreaming(prompt, options = {}, onProvisionalEmotion = null, onTextChunk = null) {
        const mode = getModelMode();

        // Pick adapter using same logic as generate()
        let adapter;
        if (options.preferLocal && mode !== MODEL_MODE.CLOUD_ONLY) {
            adapter = OllamaAdapter;
        } else {
            switch (mode) {
                case MODEL_MODE.LOCAL_ONLY:     adapter = OllamaAdapter;       break;
                case MODEL_MODE.CLOUD_PREFERRED:
                case MODEL_MODE.CLOUD_ONLY:     adapter = getCloudAdapter();   break;
                default:                        adapter = OllamaAdapter;
            }
        }

        // --- Streaming path ---
        if (typeof adapter.stream === 'function') {
            const EMOTION_TAG_RE = /^\[EMOTION:([a-z]+):([\d.]+)\]/m;
            const VALID_LABELS   = new Set([
                'happy','sad','crying','anger','angry','dark','playful','surprised',
                'embarrassed','excited','sleepy','smug','love','confused','scared',
                'disgusted','determined','curious','shy','grateful','hesitant',
                'melancholic','flustered','tender','calm','longing','lonely','kind',
                'neutral','menacing'
            ]);

            let provisionalFired = false;
            const EMOTION_LINE_RE = /^\[EMOTION:[^\]\n]+\]\n?/;

            const onChunk = (_chunk, fullSoFar) => {
                // ── 1. Fire provisional emotion once (first [EMOTION:…] tag line) ──
                if (!provisionalFired && onProvisionalEmotion) {
                    const firstLine = fullSoFar.split('\n')[0];
                    const match     = firstLine.match(EMOTION_TAG_RE);
                    if (match) {
                        const label     = match[1].toLowerCase();
                        const intensity = Math.min(1, Math.max(0, parseFloat(match[2])));
                        if (VALID_LABELS.has(label)) {
                            provisionalFired = true;
                            console.log(`[Brain] Provisional emotion: ${label} @ ${intensity}`);
                            onProvisionalEmotion({ label, intensity });
                        }
                    }
                }

                // ── 2. Stream raw text (minus emotion tag prefix) to UI ──
                if (onTextChunk) {
                    const stripped = fullSoFar.replace(EMOTION_LINE_RE, '');
                    if (stripped) onTextChunk(stripped);
                }
            };

            try {
                let rawResponse = await adapter.stream(prompt, options, onChunk);

                // For CLOUD_PREFERRED, fall back to local if cloud stream failed
                // (handled via catch below)

                if (options.raw) return rawResponse;

                // Strip the [EMOTION:…] prefix line before JSON parsing
                rawResponse = rawResponse.replace(/^\[EMOTION:[^\]\n]+\]\n?/, '').trim();
                return this._parseLLMResponse(rawResponse);

            } catch (streamError) {
                console.warn('[Brain] Streaming failed:', streamError.message);

                // For CLOUD_PREFERRED, try local fallback
                if (mode === MODEL_MODE.CLOUD_PREFERRED && adapter !== OllamaAdapter) {
                    console.log('[Brain] Falling back to local stream/generate');
                    try {
                        if (typeof OllamaAdapter.stream === 'function') {
                            let rawResponse = await OllamaAdapter.stream(prompt, options, onChunk);
                            if (options.raw) return rawResponse;
                            rawResponse = rawResponse.replace(/^\[EMOTION:[^\]\n]+\]\n?/, '').trim();
                            return this._parseLLMResponse(rawResponse);
                        }
                        const rawResponse = await OllamaAdapter.generate(prompt, options);
                        if (options.raw) return rawResponse;
                        const parsed = this._parseLLMResponse(rawResponse);
                        if (!provisionalFired && onProvisionalEmotion && parsed.emotion) {
                            onProvisionalEmotion(parsed.emotion);
                        }
                        return parsed;
                    } catch (localError) {
                        throw this._sanitizeError(localError);
                    }
                }

                throw this._sanitizeError(streamError);
            }
        }

        // --- Non-streaming fallback (e.g. OpenRouter) ---
        console.log('[Brain] Adapter has no stream() — using generate() fallback');
        const rawResponse = await adapter.generate(prompt, options);
        if (options.raw) return rawResponse;
        const parsed = this._parseLLMResponse(rawResponse);
        // Fire provisional from the parsed arc so caller still gets the callback
        if (onProvisionalEmotion && parsed.emotion) {
            onProvisionalEmotion(parsed.emotion);
        }
        return parsed;
    },

    /**
     * Parse raw string from LLM into structured JSON.
     * Handles local models (phi4-mini) that ramble before/after the JSON block.
     */
    _parseLLMResponse(rawText) {
        let parsed = null;

        // Strip the leading [EMOTION:label:intensity] tag line produced by cloud models.
        // The streaming path strips it during chunk processing; the non-streaming
        // generate() path passes raw text here, so we must strip it before parsing.
        const strippedText = rawText.replace(/^\[EMOTION:[^\]\n]+\]\n?/, '').trim();
        rawText = strippedText;

        // Strategy 1: Pure JSON parse (cloud models usually return clean JSON)
        try {
            parsed = JSON.parse(rawText);
        } catch (_) {}

        // Strategy 2: Extract ALL {...} blocks, try the LAST complete one first.
        // phi4-mini often outputs commentary + multiple JSON attempts; the last
        // block is usually the most complete / correct one.
        if (!parsed) {
            const blocks = [];
            let depth = 0, start = -1;
            for (let i = 0; i < rawText.length; i++) {
                if (rawText[i] === '{') {
                    if (depth === 0) start = i;
                    depth++;
                } else if (rawText[i] === '}') {
                    depth--;
                    if (depth === 0 && start !== -1) {
                        blocks.push(rawText.slice(start, i + 1));
                        start = -1;
                    }
                }
            }
            // Try from last block to first — local models self-correct at the end
            for (let i = blocks.length - 1; i >= 0; i--) {
                try {
                    const candidate = JSON.parse(blocks[i]);
                    // Only accept if it has a non-empty text field
                    if (candidate.text && typeof candidate.text === 'string') {
                        parsed = candidate;
                        break;
                    }
                } catch (_) {}
            }
        }

        // Strategy 3: Truncated JSON — try to salvage the "text" field specifically.
        // This handles the case where a long story causes the JSON to be cut mid-string.
        if (!parsed) {
            console.warn('[Brain] Failed to parse JSON, attempting text field extraction.', rawText.slice(0, 120));

            // Try: extract "text": "..." — handle truncated values by reading until end of string
            const textFieldMatch = rawText.match(/"text"\s*:\s*"([\s\S]*?)(?:(?<!\\)",|\s*$)/);
            let fallbackText = '';
            if (textFieldMatch) {
                // Unescape any JSON escape sequences in the extracted text
                fallbackText = textFieldMatch[1]
                    .replace(/\\n/g, '\n')
                    .replace(/\\t/g, '\t')
                    .replace(/\\"/g, '"')
                    .replace(/\\\\/g, '\\')
                    .trim();
            }

            // If that didn't work, grab the first long quoted string as a last resort
            if (!fallbackText) {
                const sentenceMatch = rawText.match(/"([^"]{10,}?)"/);
                fallbackText = sentenceMatch ? sentenceMatch[1] : rawText.slice(0, 300).trim();
            }

            parsed = {
                text: fallbackText,
                emotion: this._inferEmotionFromText(rawText),
                actionHints: {}
            };
        }

        // Normalize emotionArc: accept array or fall back from legacy single emotion
        const VALID_LABELS = new Set([
            'happy','sad','crying','anger','angry','dark','playful','surprised','embarrassed',
            'excited','sleepy','smug','love','confused','scared','disgusted','determined',
            'curious','shy','grateful','hesitant','melancholic','flustered','tender','calm',
            'longing','lonely','kind','neutral','menacing'
        ]);

        let emotionArc = null;
        if (Array.isArray(parsed.emotionArc) && parsed.emotionArc.length > 0) {
            emotionArc = parsed.emotionArc
                .filter(e => e && typeof e.label === 'string' && VALID_LABELS.has(e.label.toLowerCase()))
                .map(e => ({
                    label: e.label.toLowerCase(),
                    intensity: typeof e.intensity === 'number' ? Math.min(1, Math.max(0, e.intensity)) : 0.7,
                    // Clamp at to 0–0.88: beats at 1.0 fire after audio ends (our
                    // duration estimate always slightly exceeds real audio length)
                    at: typeof e.at === 'number' ? Math.min(0.88, Math.max(0, e.at)) : 0
                }))
                .sort((a, b) => a.at - b.at);
            if (emotionArc.length === 0) emotionArc = null;
        }

        // Backward-compat: legacy single emotion field → wrap as 1-entry arc
        if (!emotionArc && parsed.emotion) {
            const e = parsed.emotion;
            emotionArc = [{ label: (e.label || 'neutral').toLowerCase(), intensity: e.intensity ?? 0.7, at: 0 }];
        }

        const finalArc = emotionArc || [{ label: 'neutral', intensity: 0.5, at: 0 }];
        console.log('[Brain] Parsed arc:', finalArc.map(b => `${b.label}@${b.at.toFixed(2)}(${b.intensity.toFixed(2)})`).join(' → '));

        return {
            text: parsed.text || '',
            emotionArc: finalArc,
            // Keep legacy .emotion as first arc entry so old callsites still work
            emotion: finalArc[0],
            actionHints: parsed.actionHints || {}
        };
    },

    _inferEmotionFromText(text) {
        const lowerText = text.toLowerCase();
        let label = 'neutral';
        let intensity = 0.5;

        // Extremely naive fallback inference
        if (lowerText.includes('haha') || lowerText.includes('happy') || lowerText.includes('!')) {
            label = 'happy';
            intensity = 0.8;
        } else if (lowerText.includes('sad') || lowerText.includes('sorry')) {
            label = 'sad';
            intensity = 0.6;
        } else if (lowerText.includes('angry') || lowerText.includes('mad')) {
            label = 'anger';
            intensity = 0.7;
        }

        return { label, intensity, sentimentScore: 0 };
    },

    /**
     * Generate using local Ollama only
     * @param {string} prompt
     * @returns {Promise<string>}
     */
    async _generateLocal(prompt, options) {
        try {
            const response = await OllamaAdapter.generate(prompt, options);
            console.log('[Brain] Local response received');
            return response;
        } catch (error) {
            console.error('[Brain] Local error:', error.message);
            throw this._sanitizeError(error);
        }
    },

    /**
     * Generate using cloud only (no fallback)
     * @param {string} prompt
     * @returns {Promise<string>}
     */
    async _generateCloud(prompt, options) {
        try {
            const adapter = getCloudAdapter();
            const response = await adapter.generate(prompt, options);
            console.log('[Brain] Cloud response received');
            return response;
        } catch (error) {
            console.error('[Brain] Cloud error:', error.message);
            throw this._sanitizeError(error);
        }
    },

    /**
     * Generate using cloud first, fallback to local on failure
     * @param {string} prompt
     * @returns {Promise<string>}
     */
    async _generateCloudWithFallback(prompt, options) {
        // Check if cloud is available first
        const adapter = getCloudAdapter();
        const cloudAvailable = await adapter.isAvailable();

        if (cloudAvailable) {
            try {
                const response = await adapter.generate(prompt, options);
                console.log('[Brain] Cloud response received');
                return response;
            } catch (error) {
                console.warn('[Brain] Cloud failed, falling back to local:', error.message);
                // Fall through to local
            }
        } else {
            console.log('[Brain] Cloud unavailable, using local');
        }

        // Fallback to local
        try {
            const response = await OllamaAdapter.generate(prompt, options);
            console.log('[Brain] Local fallback response received');
            return response;
        } catch (error) {
            console.error('[Brain] Local fallback also failed:', error.message);
            throw this._sanitizeError(error);
        }
    },

    /**
     * Check if any LLM is available based on current mode
     * @returns {Promise<boolean>}
     */
    async isAvailable() {
        const mode = getModelMode();
        const adapter = getCloudAdapter();

        switch (mode) {
            case MODEL_MODE.LOCAL_ONLY:
                return OllamaAdapter.isAvailable();

            case MODEL_MODE.CLOUD_ONLY:
                return adapter.isAvailable();

            case MODEL_MODE.CLOUD_PREFERRED:
                // Available if either works
                const [cloud, local] = await Promise.all([
                    adapter.isAvailable(),
                    OllamaAdapter.isAvailable()
                ]);
                return cloud || local;

            default:
                return OllamaAdapter.isAvailable();
        }
    },

    /**
     * Sanitize errors - never expose technical details
     * @param {Error} error
     * @returns {Error}
     */
    _sanitizeError(error) {
        const msg = error.message?.toLowerCase() || '';

        // Map technical errors to user-friendly messages
        if (msg.includes('timeout') || msg.includes('timed out')) {
            return new Error('Taking too long to respond. Try again.');
        }
        if (msg.includes('offline') || msg.includes('unreachable') || msg.includes('fetch')) {
            return new Error('Assistant is currently unavailable.');
        }
        if (msg.includes('quota') || msg.includes('429') || msg.includes('rate limit')) {
            return new Error('Cloud quota exceeded. Try "Cloud (fallback)" mode.');
        }
        if (msg.includes('api key') || msg.includes('unauthorized') || msg.includes('401')) {
            return new Error('Invalid API key. Check settings.');
        }
        if (msg.includes('403') || msg.includes('forbidden')) {
            return new Error('API access denied. Check your API key permissions.');
        }

        // Generic fallback - never expose raw error
        return new Error('Something went wrong. Try again.');
    }
};

export default BrainRouter;
