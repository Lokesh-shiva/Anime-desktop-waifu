/**
 * Gemini Cloud Adapter
 * Implements LLM interface for Google Gemini API
 */

import { DEFAULT_CONFIG } from './llm-interface.js';
import { getCloudApiKey } from '../settings.js';

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// Gemini-specific hardening prefix to prevent safety/assistant leaks
const MODEL_HARDENING_PREFIX = "Stay fully in character. Do not explain, assist, or summarize.\n\n";

/**
 * Gemini Cloud Provider
 */
const CloudAdapter = {
    /**
     * Generate a response from Gemini
     * @param {string} prompt - User input
     * @returns {Promise<string>} - LLM response
     */
    async generate(prompt, options = {}) {
        const apiKey = getCloudApiKey();
        console.log('[Cloud] API key present:', !!apiKey);

        if (!apiKey) {
            throw new Error('Cloud API key not configured');
        }

        // Use override prompt if provided, else default
        const systemPrompt = options.systemInstruction || DEFAULT_CONFIG.systemPrompt;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), DEFAULT_CONFIG.timeout);

        try {
            console.log('[Cloud] Sending request to Gemini...');
            console.log('[Cloud] System Prompt Preview:', systemPrompt.slice(0, 200) + '...');

            const response = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    contents: [{
                        parts: [{ text: MODEL_HARDENING_PREFIX + prompt }]
                    }],
                    systemInstruction: {
                        parts: [{ text: systemPrompt }]
                    },
                    generationConfig: {
                        maxOutputTokens: DEFAULT_CONFIG.maxTokens, // Enforce strict token limit
                        temperature: DEFAULT_CONFIG.temperature,
                        stopSequences: ["User:", "Assistant:"] // Removed \n\n to allow multi-paragraph responses
                    }
                })
            });

            clearTimeout(timeoutId);
            console.log('[Cloud] Response status:', response.status);

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                console.error('[Cloud] API Error:', errorData);
                const errorMsg = errorData?.error?.message || `HTTP ${response.status}`;
                throw new Error(`Cloud error: ${errorMsg}`);
            }

            const data = await response.json();
            console.log('[Cloud] Response data:', JSON.stringify(data).slice(0, 200));

            let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

            // Post-processing hardening
            text = text.trim();
            // Remove common conversational filler
            text = text.replace(/^(Here is|Sure|I can help|Okay|As an AI language model).+?[:,\.]/i, '').trim();

            return text || 'No response received.';

        } catch (error) {
            clearTimeout(timeoutId);
            console.error('[Cloud] Error:', error.message);

            if (error.name === 'AbortError') {
                throw new Error('Cloud request timed out');
            }
            if (error.message.includes('fetch') || error.message.includes('network')) {
                throw new Error('Cloud unreachable');
            }
            throw error;
        }
    },

    /**
     * Check if Gemini API is reachable
     * @returns {Promise<boolean>}
     */
    async isAvailable() {
        const apiKey = getCloudApiKey();
        if (!apiKey) {
            return false;
        }

        try {
            // Quick health check with minimal request
            const response = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(5000),
                body: JSON.stringify({
                    contents: [{ parts: [{ text: 'ping' }] }],
                    generationConfig: { maxOutputTokens: 1 }
                })
            });
            return response.ok;
        } catch {
            return false;
        }
    }
};

export default CloudAdapter;
