/**
 * Brain Router
 * Single interface for all LLM calls
 * Handles model selection, availability checking, and fallback logic
 */

import { getModelMode, MODEL_MODE } from '../settings.js';
import OllamaAdapter from './ollama-adapter.js';
import CloudAdapter from './cloud-adapter.js';

/**
 * Brain Router - unified LLM interface
 * The UI calls this, never the adapters directly
 */
export const BrainRouter = {
    /**
     * Generate a response using the appropriate model
     * @param {string} prompt - User input
     * @returns {Promise<string>} - LLM response
     */
    async generate(prompt, options = {}) {
        const mode = getModelMode();
        console.log(`[Brain] Mode: ${mode}`);

        // If preferLocal requested AND we are not forced to Cloud Only
        // Use local directly
        if (options.preferLocal && mode !== MODEL_MODE.CLOUD_ONLY) {
            console.log('[Brain] Preferring local for background task');
            return this._generateLocal(prompt, options);
        }

        switch (mode) {
            case MODEL_MODE.LOCAL_ONLY:
                return this._generateLocal(prompt, options);

            case MODEL_MODE.CLOUD_PREFERRED:
                return this._generateCloudWithFallback(prompt, options);

            case MODEL_MODE.CLOUD_ONLY:
                return this._generateCloud(prompt, options);

            default:
                // Safety fallback to local
                console.warn('[Brain] Unknown mode, defaulting to local');
                return this._generateLocal(prompt, options);
        }
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
            const response = await CloudAdapter.generate(prompt, options);
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
        const cloudAvailable = await CloudAdapter.isAvailable();

        if (cloudAvailable) {
            try {
                const response = await CloudAdapter.generate(prompt, options);
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

        switch (mode) {
            case MODEL_MODE.LOCAL_ONLY:
                return OllamaAdapter.isAvailable();

            case MODEL_MODE.CLOUD_ONLY:
                return CloudAdapter.isAvailable();

            case MODEL_MODE.CLOUD_PREFERRED:
                // Available if either works
                const [cloud, local] = await Promise.all([
                    CloudAdapter.isAvailable(),
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
