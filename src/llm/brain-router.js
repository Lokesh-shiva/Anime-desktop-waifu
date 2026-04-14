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

        return this._parseLLMResponse(rawResponse);
    },

    /**
     * Parse raw string from LLM into structured JSON.
     * Handles local models (phi4-mini) that ramble before/after the JSON block.
     */
    _parseLLMResponse(rawText) {
        let parsed = null;

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

        // Strategy 3: Give up on JSON — extract the first quoted sentence as text
        if (!parsed) {
            console.warn('[Brain] Failed to parse JSON, extracting plain text.', rawText.slice(0, 100));
            // Try to pull a human-readable sentence from the mess
            const sentenceMatch = rawText.match(/"([^"]{5,200})"/);
            const fallbackText = sentenceMatch ? sentenceMatch[1] : rawText.slice(0, 200).trim();
            parsed = {
                text: fallbackText,
                emotion: this._inferEmotionFromText(rawText),
                actionHints: {}
            };
        }

        // Sanitize return
        return {
            text: parsed.text || '',
            emotion: parsed.emotion || { label: 'neutral', intensity: 0, sentimentScore: 0 },
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
