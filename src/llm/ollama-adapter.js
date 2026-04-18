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
     * Stream a response from Ollama, calling onChunk for each token batch.
     * Resolves with the full accumulated text when done.
     * @param {string} prompt
     * @param {Object} options
     * @param {function(string, string): void} onChunk - (newChunk, fullSoFar)
     * @returns {Promise<string>}
     */
    async stream(prompt, options = {}, onChunk) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), DEFAULT_CONFIG.timeout);

        const systemPrompt = options.systemInstruction || DEFAULT_CONFIG.systemPrompt;
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: prompt }
        ];

        try {
            const response = await fetch('http://localhost:11434/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    model: MODEL,
                    messages,
                    stream: true,
                    options: {
                        num_predict: DEFAULT_CONFIG.maxTokens,
                        temperature: DEFAULT_CONFIG.temperature
                    }
                })
            });

            clearTimeout(timeoutId);

            if (!response.ok) throw new Error(`Ollama error: ${response.status}`);

            const reader  = response.body.getReader();
            const decoder = new TextDecoder();
            let fullText = '';
            let buffer   = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // hold back incomplete trailing line

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const data  = JSON.parse(line);
                        const chunk = data.message?.content || '';
                        if (chunk) {
                            fullText += chunk;
                            onChunk?.(chunk, fullText);
                        }
                        if (data.done) return fullText;
                    } catch (_) { /* incomplete JSON line — skip */ }
                }
            }

            return fullText;

        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') throw new Error('Request timed out');
            if (error.message.includes('fetch')) throw new Error('Assistant offline - is Ollama running?');
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
