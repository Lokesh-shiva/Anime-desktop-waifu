/**
 * Gemini Cloud Adapter
 * Implements LLM interface for Google Gemini API
 */

import { DEFAULT_CONFIG } from './llm-interface.js';
import { getCloudApiKey, getGeminiModel } from '../settings.js';

/**
 * Build the Gemini API request body.
 * Gemma models don't support systemInstruction — the system prompt is
 * prepended to the user turn as a plain text block instead.
 */
function buildRequestBody(systemPrompt, userText, extraConfig = {}) {
    const model = getGeminiModel();
    // Gemma 3 rejects the systemInstruction field — bake system prompt into user turn.
    // Gemma 4+ and all Gemini models support it properly, so use it for better adherence.
    const isGemma3 = /^gemma-3/i.test(model);
    const generationConfig = {
        maxOutputTokens: DEFAULT_CONFIG.maxTokens,
        temperature: DEFAULT_CONFIG.temperature,
        // stopSequences removed — 'User:' / 'Assistant:' are local-model artifacts
        // that can prematurely cut cloud responses
        ...extraConfig
    };

    if (isGemma3) {
        // Gemma 3 only: no systemInstruction field — prepend system prompt to user turn
        return {
            contents: [{
                parts: [{ text: `${systemPrompt}\n\n${MODEL_HARDENING_PREFIX}${userText}` }]
            }],
            generationConfig
        };
    }

    // Gemini + Gemma 4+: proper system instruction field for better role adherence
    return {
        contents: [{ parts: [{ text: MODEL_HARDENING_PREFIX + userText }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig
    };
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function getEndpoint(action = 'generateContent') {
    return `${GEMINI_BASE}/${getGeminiModel()}:${action}`;
}

// Kept for isAvailable() health check — always use the faster flash model
const GEMINI_ENDPOINT = `${GEMINI_BASE}/gemini-2.5-flash:generateContent`;

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

            const response = await fetch(`${getEndpoint()}?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify(buildRequestBody(systemPrompt, prompt))
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
     * Stream a response from Gemini via SSE, calling onChunk for each token batch.
     * Resolves with the full accumulated text when done.
     * @param {string} prompt
     * @param {Object} options
     * @param {function(string, string): void} onChunk - (newChunk, fullSoFar)
     * @returns {Promise<string>}
     */
    async stream(prompt, options = {}, onChunk) {
        const apiKey = getCloudApiKey();
        if (!apiKey) throw new Error('Cloud API key not configured');

        const systemPrompt = options.systemInstruction || DEFAULT_CONFIG.systemPrompt;
        const controller   = new AbortController();
        const timeoutId    = setTimeout(() => controller.abort(), DEFAULT_CONFIG.timeout);

        try {
            const response = await fetch(`${getEndpoint('streamGenerateContent')}?key=${apiKey}&alt=sse`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify(buildRequestBody(systemPrompt, prompt))
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(`Cloud error: ${err?.error?.message || response.status}`);
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
                        const chunk = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
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
            if (error.name === 'AbortError') throw new Error('Cloud request timed out');
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
