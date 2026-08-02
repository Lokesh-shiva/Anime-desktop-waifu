/**
 * LM Studio Adapter
 * Implements LLM interface for local LM Studio server
 * Uses OpenAI-compatible /v1/chat/completions API — no system prompt mangling
 */

import { DEFAULT_CONFIG } from './llm-interface.js';
import { getLMStudioModel } from '../settings.js';

const LMSTUDIO_BASE    = 'http://localhost:1234/v1';
const CHAT_ENDPOINT    = `${LMSTUDIO_BASE}/chat/completions`;
const MODELS_ENDPOINT  = `${LMSTUDIO_BASE}/models`;

const LMStudioAdapter = {
    /**
     * Generate a response from LM Studio (non-streaming)
     * @param {string} prompt
     * @param {Object} options
     * @returns {Promise<string>}
     */
    async generate(prompt, options = {}) {
        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), DEFAULT_CONFIG.timeout);

        const systemPrompt = options.systemInstruction || DEFAULT_CONFIG.systemPrompt;
        const history = Array.isArray(options.conversationHistory) ? options.conversationHistory : [];

        try {
            const response = await fetch(CHAT_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    model: options.modelId || getLMStudioModel(),
                    messages: [
                        { role: 'system', content: systemPrompt },
                        ...history.map(m => ({ role: m.role, content: m.content })),
                        { role: 'user',   content: prompt }
                    ],
                    max_tokens:  DEFAULT_CONFIG.maxTokens,
                    temperature: DEFAULT_CONFIG.temperature,
                    stream: false
                })
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(`LM Studio error: ${err?.error?.message || response.status}`);
            }

            const data = await response.json();
            return data.choices?.[0]?.message?.content?.trim() || 'No response received.';

        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') throw new Error('Request timed out');
            if (error.message.includes('fetch') || error.message.includes('Failed to fetch')) {
                throw new Error('Assistant offline — is LM Studio server running?');
            }
            throw error;
        }
    },

    /**
     * Stream a response from LM Studio via SSE, calling onChunk for each token.
     * Resolves with full accumulated text when done.
     * @param {string} prompt
     * @param {Object} options
     * @param {function(string, string): void} onChunk - (newChunk, fullSoFar)
     * @returns {Promise<string>}
     */
    async stream(prompt, options = {}, onChunk) {
        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), DEFAULT_CONFIG.timeout);

        const systemPrompt = options.systemInstruction || DEFAULT_CONFIG.systemPrompt;
        const history = Array.isArray(options.conversationHistory) ? options.conversationHistory : [];

        try {
            const response = await fetch(CHAT_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    model: options.modelId || getLMStudioModel(),
                    messages: [
                        { role: 'system', content: systemPrompt },
                        ...history.map(m => ({ role: m.role, content: m.content })),
                        { role: 'user',   content: prompt }
                    ],
                    max_tokens:  DEFAULT_CONFIG.maxTokens,
                    temperature: DEFAULT_CONFIG.temperature,
                    stream: true
                })
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(`LM Studio error: ${err?.error?.message || response.status}`);
            }

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
                    if (!line.startsWith('data: ')) continue;
                    const jsonStr = line.slice(6).trim();
                    if (!jsonStr || jsonStr === '[DONE]') continue;
                    try {
                        const data  = JSON.parse(jsonStr);
                        const chunk = data.choices?.[0]?.delta?.content || '';
                        if (chunk) {
                            fullText += chunk;
                            onChunk?.(chunk, fullText);
                        }
                    } catch (_) { /* partial SSE line — skip */ }
                }
            }

            return fullText.trim();

        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') throw new Error('Request timed out');
            if (error.message.includes('fetch') || error.message.includes('Failed to fetch')) {
                throw new Error('Assistant offline — is LM Studio server running?');
            }
            throw error;
        }
    },

    /**
     * Check if LM Studio server is reachable
     * @returns {Promise<boolean>}
     */
    async isAvailable() {
        try {
            const response = await fetch(MODELS_ENDPOINT, {
                method: 'GET',
                signal: AbortSignal.timeout(3000)
            });
            return response.ok;
        } catch {
            return false;
        }
    }
};

export default LMStudioAdapter;
