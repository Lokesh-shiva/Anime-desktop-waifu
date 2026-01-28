/**
 * Ollama Adapter
 * Implements LLM interface for local Ollama server
 */

import { DEFAULT_CONFIG, registerProvider } from './llm-interface.js';

const OLLAMA_ENDPOINT = 'http://localhost:11434/api/generate';
const MODEL = 'phi4-mini:3.8b';

/**
 * Ollama LLM Provider
 */
const OllamaAdapter = {
    /**
     * Generate a response from the LLM
     * @param {string} prompt - User input
     * @returns {Promise<string>} - LLM response
     */
    async generate(prompt, options = {}) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), DEFAULT_CONFIG.timeout);

        // Use override prompt if provided, else default
        const systemPrompt = options.systemInstruction || DEFAULT_CONFIG.systemPrompt;

        // Use chat API with proper message roles to prevent instruction leaking
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt }
        ];

        try {
            const response = await fetch('http://localhost:11434/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    model: MODEL,
                    messages: messages,
                    stream: false,
                    options: {
                        num_predict: DEFAULT_CONFIG.maxTokens,
                        temperature: DEFAULT_CONFIG.temperature
                    }
                })
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`Ollama error: ${response.status}`);
            }

            const data = await response.json();
            return data.message?.content?.trim() || 'No response received.';

        } catch (error) {
            clearTimeout(timeoutId);

            if (error.name === 'AbortError') {
                throw new Error('Request timed out');
            }
            if (error.message.includes('fetch')) {
                throw new Error('Assistant offline - is Ollama running?');
            }
            throw error;
        }
    },

    /**
     * Check if Ollama is available
     * @returns {Promise<boolean>}
     */
    async isAvailable() {
        try {
            const response = await fetch('http://localhost:11434/api/tags', {
                method: 'GET',
                signal: AbortSignal.timeout(3000)
            });
            return response.ok;
        } catch {
            return false;
        }
    }
};

// Register this adapter as the current provider
registerProvider(OllamaAdapter);

export default OllamaAdapter;
