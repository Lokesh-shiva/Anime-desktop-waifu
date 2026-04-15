/**
 * Prompt Builder
 * Helper to construct the full system prompt with memory context
 * Handles confidence-aware fact phrasing
 */

import { DEFAULT_CONFIG } from '../llm/llm-interface.js';

// Confidence thresholds for phrasing
const CONFIDENCE = {
    HIGH: 0.7,      // Direct assertion
    MEDIUM: 0.4,    // Soft assertion
    LOW: 0.2        // Uncertain phrasing
};

/**
 * Format a fact based on its confidence level
 * High confidence: Direct statement
 * Medium confidence: Softer phrasing
 * Low confidence: Uncertain phrasing
 */
function formatFactByConfidence(fact) {
    const conf = fact.effectiveConfidence ?? fact.confidence;
    const content = fact.content;

    if (conf >= CONFIDENCE.HIGH) {
        // High confidence - state directly
        return content;
    } else if (conf >= CONFIDENCE.MEDIUM) {
        // Medium confidence - softer phrasing
        // Avoid modifying if it already sounds uncertain
        if (content.toLowerCase().includes('may') ||
            content.toLowerCase().includes('might') ||
            content.toLowerCase().includes('possibly')) {
            return content;
        }
        return `Likely: ${content}`;
    } else {
        // Low confidence - uncertain
        return `Possibly: ${content}`;
    }
}

/**
 * Build the full system prompt including memory context and recent conversation.
 * @param {Object} memoryContext  - { facts: object[], sessionSummary: string }
 * @param {Object} presenceHints  - { timeOfDay, inputRhythm } (optional)
 * @param {Array}  recentMessages - raw { role, content }[] from memoryManager (optional)
 * @returns {string}
 */
export function buildSystemPrompt(memoryContext, presenceHints, recentMessages) {
    let prompt = DEFAULT_CONFIG.systemPrompt;

    const hasFacts   = memoryContext?.facts?.length > 0;
    const hasSummary = !!memoryContext?.sessionSummary;
    // Only inject the last 6 turns (3 exchanges) so the prompt stays lean
    const recentTurns = Array.isArray(recentMessages)
        ? recentMessages.slice(-6)
        : [];

    if (!hasFacts && !hasSummary && recentTurns.length === 0) {
        return prompt;
    }

    prompt += `\n\n=== CONTEXT (internal — never quote or reference directly) ===`;

    // ── Recent conversation turns ───────────────────────────────────────────
    // These are the actual messages from this session. Use them to feel
    // continuous — pick up threads, notice moods, don't repeat yourself.
    if (recentTurns.length > 0) {
        prompt += `\n\n[This conversation so far]\n`;
        for (const msg of recentTurns) {
            const speaker = msg.role === 'user' ? 'them' : 'you';
            prompt += `${speaker}: ${msg.content}\n`;
        }
    }

    // ── Long-term memory ────────────────────────────────────────────────────
    if (hasSummary || hasFacts) {
        prompt += `\n[What you know about them]\n`;
        prompt += `Use this to feel attentive, not to recite facts.\n`;
        prompt += `For uncertain items (Likely/Possibly), never assert strongly.\n`;

        if (hasSummary) {
            prompt += `Context: ${memoryContext.sessionSummary}\n`;
        }

        if (hasFacts) {
            const categories = { identity: [], preferences: [], constraints: [], projects: [] };
            for (const fact of memoryContext.facts) {
                const cat = fact.category || 'preferences';
                (categories[cat] || categories.preferences).push(fact);
            }
            const allFacts = [
                ...categories.identity,
                ...categories.preferences,
                ...categories.constraints,
                ...categories.projects
            ];
            for (const fact of allFacts) {
                prompt += `- ${formatFactByConfidence(fact)}\n`;
            }
        }
    }

    return prompt;
}
