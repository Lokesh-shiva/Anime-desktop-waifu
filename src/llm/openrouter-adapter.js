/**
 * OpenRouter Cloud Adapter
 * Implements LLM interface for OpenRouter API
 * Supports any OpenRouter model (free or paid)
 */

import { DEFAULT_CONFIG } from './llm-interface.js';
import { getOpenRouterApiKey, getOpenRouterModel } from '../settings.js';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * OpenRouter Cloud Provider
 */
const OpenRouterAdapter = {
    /**
     * Generate a response from OpenRouter
     * @param {string} prompt - User input
     * @param {Object} options - Optional overrides
     * @returns {Promise<string>} - LLM response
     */
    async generate(prompt, options = {}) {
        const apiKey = getOpenRouterApiKey();
        console.log('[OpenRouter] API key present:', !!apiKey);

        if (!apiKey) {
            throw new Error('OpenRouter API key not configured');
        }

        const systemPrompt = options.systemInstruction || DEFAULT_CONFIG.systemPrompt;
        const modelId = options.modelId || getOpenRouterModel();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), DEFAULT_CONFIG.timeout);

        try {
            console.log('[OpenRouter] Sending request to', modelId);
            console.log('[OpenRouter] System Prompt Preview:', systemPrompt.slice(0, 150) + '...');

            const response = await fetch(OPENROUTER_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'HTTP-Referer': 'https://waifu.local', // Optional: identifies your app
                    'X-Title': 'Waifu Assistant' // Optional: display name
                },
                signal: controller.signal,
                body: JSON.stringify({
                    model: modelId,
                    messages: [
                        {
                            role: 'system',
                            content: systemPrompt
                        },
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    temperature: DEFAULT_CONFIG.temperature,
                    max_tokens: DEFAULT_CONFIG.maxTokens,
                    top_p: 0.95
                })
            });

            clearTimeout(timeoutId);
            console.log('[OpenRouter] Response status:', response.status);

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                console.error('[OpenRouter] API Error:', errorData);
                const errorMsg = errorData?.error?.message || `HTTP ${response.status}`;
                throw new Error(`OpenRouter error: ${errorMsg}`);
            }

            const data = await response.json();
            console.log('[OpenRouter] Response data:', JSON.stringify(data).slice(0, 200));

            let text = data?.choices?.[0]?.message?.content || '';

            // Post-processing hardening (same as Gemini)
            text = text.trim();
            text = text.replace(/^(Here is|Sure|I can help|Okay|As an AI language model).+?[:,\.]/i, '').trim();

            return text || 'No response received.';

        } catch (error) {
            clearTimeout(timeoutId);
            console.error('[OpenRouter] Error:', error.message);

            if (error.name === 'AbortError') {
                throw new Error('OpenRouter request timed out');
            }
            if (error.message.includes('fetch') || error.message.includes('network')) {
                throw new Error('OpenRouter unreachable');
            }
            throw error;
        }
    },

    /**
     * Check if OpenRouter API is reachable
     * @returns {Promise<boolean>}
     */
    async isAvailable() {
        const apiKey = getOpenRouterApiKey();
        if (!apiKey) {
            return false;
        }

        try {
            // Quick health check
            const response = await fetch(OPENROUTER_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                signal: AbortSignal.timeout(5000),
                body: JSON.stringify({
                    model: 'google/gemma-4-31b-it:free',
                    messages: [{ role: 'user', content: 'ping' }],
                    max_tokens: 1
                })
            });
            return response.ok;
        } catch {
            return false;
        }
    }
};

export default OpenRouterAdapter;
