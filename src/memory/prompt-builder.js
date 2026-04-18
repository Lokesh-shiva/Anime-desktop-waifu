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

function formatFactByConfidence(fact) {
    const conf = fact.effectiveConfidence ?? fact.confidence;
    const content = fact.content;

    if (conf >= CONFIDENCE.HIGH) {
        return content;
    } else if (conf >= CONFIDENCE.MEDIUM) {
        if (content.toLowerCase().includes('may') ||
            content.toLowerCase().includes('might') ||
            content.toLowerCase().includes('possibly')) {
            return content;
        }
        return `Likely: ${content}`;
    } else {
        return `Possibly: ${content}`;
    }
}

/**
 * Build the full system prompt including memory context and recent conversation.
 * @param {Object} memoryContext  - { facts, sessionSummary, previousSessions, moodDescription }
 * @param {Object} presenceHints  - { timeOfDay, inputRhythm } (optional)
 * @param {Array}  recentMessages - raw { role, content }[] from memoryManager (optional)
 * @param {Object} visionContext  - { screen: { activity, ... }, camera: { userState, isPresent, ... } } (optional)
 * @returns {string}
 */
export function buildSystemPrompt(memoryContext, presenceHints, recentMessages, visionContext) {
    let prompt = DEFAULT_CONFIG.systemPrompt;

    const hasFacts    = memoryContext?.facts?.length > 0;
    const hasSummary  = !!memoryContext?.sessionSummary;
    const hasPrevious = Array.isArray(memoryContext?.previousSessions) &&
                        memoryContext.previousSessions.length > 0;
    const hasMood     = !!memoryContext?.moodDescription;
    const recentTurns = Array.isArray(recentMessages) ? recentMessages.slice(-6) : [];
    const hasScreen   = !!visionContext?.screen?.activity;
    const hasCamera   = visionContext?.camera?.isPresent && visionContext.camera.userState !== 'unknown';

    const hasAnyContext = hasFacts || hasSummary || hasPrevious || hasMood ||
                          recentTurns.length > 0 || hasScreen || hasCamera;
    if (!hasAnyContext) return prompt;

    prompt += `\n\n=== CONTEXT (internal — never quote or reference directly) ===`;

    // ── Mood ────────────────────────────────────────────────────────────────
    if (hasMood) {
        prompt += `\n\n[Your current mood]\n${memoryContext.moodDescription}\n`;
    }

    // ── Vision context ───────────────────────────────────────────────────────
    if (hasScreen || hasCamera) {
        prompt += `\n[What you can sense right now]\n`;
        prompt += `Use this awareness naturally — don't announce it, just let it colour your responses.\n`;
        if (hasScreen) {
            prompt += `Screen: ${visionContext.screen.activity}\n`;
        }
        if (hasCamera) {
            prompt += `They look: ${visionContext.camera.userState}\n`;
        }
    }

    // ── Recent conversation turns ────────────────────────────────────────────
    if (recentTurns.length > 0) {
        prompt += `\n[This conversation so far]\n`;
        for (const msg of recentTurns) {
            const speaker = msg.role === 'user' ? 'them' : 'you';
            prompt += `${speaker}: ${msg.content}\n`;
        }
    }

    // ── Long-term memory ─────────────────────────────────────────────────────
    if (hasSummary || hasPrevious || hasFacts) {
        prompt += `\n[What you know about them]\n`;
        prompt += `Use this to feel attentive, not to recite facts.\n`;
        prompt += `For uncertain items (Likely/Possibly), never assert strongly.\n`;

        // Most recent session summary
        if (hasSummary) {
            prompt += `Last session: ${memoryContext.sessionSummary}\n`;
        }

        // Older session summaries — inject last 2, condensed
        if (hasPrevious) {
            const recent = memoryContext.previousSessions.slice(-2);
            prompt += `Earlier sessions:\n`;
            for (const s of recent) {
                prompt += `- ${s}\n`;
            }
        }

        // Structured facts
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
