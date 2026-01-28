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
 * Build the full system prompt including memory context
 * @param {Object} memoryContext - { facts: object[], sessionSummary: string }
 * @returns {string} - The complete system prompt
 */
export function buildSystemPrompt(memoryContext) {
    let prompt = DEFAULT_CONFIG.systemPrompt;

    // Safety check for empty context
    const hasFacts = memoryContext?.facts && memoryContext.facts.length > 0;
    const hasSummary = !!memoryContext?.sessionSummary;

    if (!hasFacts && !hasSummary) {
        return prompt;
    }

    // Append memory section securely
    prompt += `\n\n=== BACKGROUND CONTEXT ===
This is your internal memory. Use it to sound consistent and attentive.
DO NOT mention "memory", "remember", or "context" to the user.
DO NOT quote this section. Just *know* it.
For uncertain facts (marked "Likely" or "Possibly"), phrase recall vaguely - never assert them strongly.
`;

    if (hasSummary) {
        prompt += `\n[Recent Conversation]\n${memoryContext.sessionSummary}\n`;
    }

    if (hasFacts) {
        // Group facts by category for better organization
        const categories = {
            identity: [],
            preferences: [],
            constraints: [],
            projects: []
        };

        for (const fact of memoryContext.facts) {
            const category = fact.category || 'preferences';
            if (categories[category]) {
                categories[category].push(fact);
            } else {
                categories.preferences.push(fact);
            }
        }

        prompt += `\n[Important Facts]\n`;

        // Identity facts first (most reliable)
        if (categories.identity.length > 0) {
            const formatted = categories.identity.map(formatFactByConfidence);
            prompt += formatted.map(f => `- ${f}`).join('\n') + '\n';
        }

        // Then preferences
        if (categories.preferences.length > 0) {
            const formatted = categories.preferences.map(formatFactByConfidence);
            prompt += formatted.map(f => `- ${f}`).join('\n') + '\n';
        }

        // Constraints
        if (categories.constraints.length > 0) {
            const formatted = categories.constraints.map(formatFactByConfidence);
            prompt += formatted.map(f => `- ${f}`).join('\n') + '\n';
        }

        // Projects last (most volatile)
        if (categories.projects.length > 0) {
            const formatted = categories.projects.map(formatFactByConfidence);
            prompt += formatted.map(f => `- ${f}`).join('\n') + '\n';
        }
    }

    return prompt;
}
