/**
 * Memory Manager
 * Handles short-term context, fact storage with confidence/decay, and session summarization
 */

import { BrainRouter } from '../llm/brain-router.js';

const BUFFER_SIZE = 10;
const AUTO_ANALYZE_INTERVAL = 2; // Analyze every 2 turns for faster updates

// Decay rates per category (% per day)
const DECAY_RATES = {
    identity: 0.005,     // 0.5% per day - very stable
    preferences: 0.02,   // 2% per day - moderate decay
    constraints: 0.01,   // 1% per day - fairly stable
    projects: 0.05       // 5% per day - decays faster when inactive
};

// Confidence thresholds
const CONFIDENCE = {
    INITIAL: 0.5,           // New facts start at medium confidence
    REINFORCEMENT_BOOST: 0.15, // Boost per reinforcement
    CONTRADICTION_PENALTY: 0.3, // Penalty when contradicted
    MIN_USABLE: 0.2,        // Below this, facts are too uncertain to use
    HIGH: 0.7,              // Above this, facts can be stated directly
    MAX: 0.95               // Hard cap to never claim perfect certainty
};

const MEMORY_ANALYZER_PROMPT = `SYSTEM PROMPT – MEMORY ANALYZER

You are a memory analysis module, not a conversational agent.
Your task is to update structured memory from recent interaction.

Rules:
- Extract user's NAME, preferences, and key facts
- Ignore greetings and filler (e.g. "hi", "how are you")
- Do NOT invent facts
- Do NOT store emotions unless explicitly stated
- Classify each fact into ONE category:
  * identity: Name, role, long-term traits, personal info
  * preferences: Likes, dislikes, habits, opinions
  * constraints: Hardware, time, budget, limitations
  * projects: Ongoing work, current tasks, temporary goals

For each fact, indicate if it reinforces or contradicts existing memory.

Output JSON:
{
    "facts": [
        {
            "content": "the fact text",
            "category": "identity|preferences|constraints|projects",
            "reinforces": "existing fact content if this confirms it, or null",
            "contradicts": "existing fact content if this contradicts it, or null"
        }
    ],
    "session_summary": "brief summary of recent conversation"
}

If no new important facts are found:
- Return empty facts array
- Update the session summary only if needed`;

/**
 * Generate a simple UUID for fact identification
 */
function generateId() {
    return 'fact_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5);
}

/**
 * Calculate similarity between two strings (simple word overlap)
 */
function textSimilarity(a, b) {
    const wordsA = a.toLowerCase().split(/\s+/);
    const wordsB = b.toLowerCase().split(/\s+/);
    const setA = new Set(wordsA);
    const setB = new Set(wordsB);
    const intersection = [...setA].filter(w => setB.has(w));
    const union = new Set([...setA, ...setB]);
    return intersection.length / union.size;
}

class MemoryManager {
    constructor() {
        this.recentMessages = []; // Rolling buffer
        this.facts = [];          // Structured fact objects
        this.sessionSummary = "";
        this.turnCount = 0;
        this.isAnalyzing = false;

        // Load persistent memory
        this._load();
    }

    /**
     * Load memory from disk with migration support
     */
    async _load() {
        try {
            if (window.assistant?.memory) {
                const startData = await window.assistant.memory.load();
                if (startData) {
                    // Migrate old string-based facts to new structure
                    this.facts = this._migrateFacts(startData.facts || []);
                    this.sessionSummary = startData.sessionSummary || "";

                    // Apply decay based on time since last use
                    this._applyDecay();

                    console.log('[Memory] Loaded persistent data with', this.facts.length, 'facts');
                }
            }
        } catch (e) {
            console.error('[Memory] Load failed:', e);
        }
    }

    /**
     * Migrate old string[] facts to new structured format
     */
    _migrateFacts(facts) {
        if (!Array.isArray(facts)) return [];

        return facts.map(fact => {
            // Already migrated
            if (typeof fact === 'object' && fact.id) {
                return fact;
            }

            // Legacy string format - convert
            if (typeof fact === 'string') {
                return {
                    id: generateId(),
                    content: fact,
                    category: this._guessCategory(fact),
                    confidence: 0.6, // Slightly higher for established facts
                    lastReinforced: Date.now(),
                    reinforceCount: 1
                };
            }

            return null;
        }).filter(Boolean);
    }

    /**
     * Guess category for legacy facts based on content
     */
    _guessCategory(content) {
        const lower = content.toLowerCase();

        if (lower.includes('name is') || lower.includes('called') ||
            lower.includes('i am') || lower.includes('my age')) {
            return 'identity';
        }
        if (lower.includes('working on') || lower.includes('project') ||
            lower.includes('building') || lower.includes('developing')) {
            return 'projects';
        }
        if (lower.includes('budget') || lower.includes('deadline') ||
            lower.includes('hardware') || lower.includes('can\'t') ||
            lower.includes('cannot') || lower.includes('limited')) {
            return 'constraints';
        }

        return 'preferences'; // Default fallback
    }

    /**
     * Apply decay to all facts based on time elapsed
     */
    _applyDecay() {
        const now = Date.now();
        const DAY_MS = 24 * 60 * 60 * 1000;

        this.facts = this.facts.map(fact => {
            const daysSinceReinforced = (now - fact.lastReinforced) / DAY_MS;
            const decayRate = DECAY_RATES[fact.category] || DECAY_RATES.preferences;

            // Exponential decay: confidence * (1 - rate)^days
            const decayFactor = Math.pow(1 - decayRate, daysSinceReinforced);
            const newConfidence = Math.max(0, fact.confidence * decayFactor);

            return {
                ...fact,
                confidence: newConfidence
            };
        });

        // Remove facts that have decayed below usable threshold
        const beforeCount = this.facts.length;
        this.facts = this.facts.filter(f => f.confidence >= CONFIDENCE.MIN_USABLE * 0.5);

        if (beforeCount > this.facts.length) {
            console.log('[Memory] Removed', beforeCount - this.facts.length, 'decayed facts');
        }
    }

    /**
     * Save memory to disk
     */
    async _save() {
        try {
            if (window.assistant?.memory) {
                const data = {
                    facts: this.facts,
                    sessionSummary: this.sessionSummary
                };
                await window.assistant.memory.save(data);
                console.log('[Memory] Saved to disk');
            }
        } catch (e) {
            console.error('[Memory] Save failed:', e);
        }
    }

    /**
     * Add a user-assistant interaction to memory
     * @param {string} userMessage 
     * @param {string} assistantResponse 
     */
    addInteraction(userMessage, assistantResponse) {
        // Add to buffer
        this.recentMessages.push({ role: 'user', content: userMessage });
        this.recentMessages.push({ role: 'assistant', content: assistantResponse });

        // Rolling buffer limit
        if (this.recentMessages.length > BUFFER_SIZE * 2) {
            this.recentMessages.splice(0, 2);
        }

        this.turnCount++;

        // Trigger background analysis
        if (this.turnCount >= AUTO_ANALYZE_INTERVAL) {
            this.analyze();
            this.turnCount = 0;
        }
    }

    /**
     * Get effective confidence after decay
     */
    getEffectiveConfidence(fact) {
        const now = Date.now();
        const DAY_MS = 24 * 60 * 60 * 1000;
        const daysSinceReinforced = (now - fact.lastReinforced) / DAY_MS;
        const decayRate = DECAY_RATES[fact.category] || DECAY_RATES.preferences;
        const decayFactor = Math.pow(1 - decayRate, daysSinceReinforced);
        return Math.max(0, Math.min(CONFIDENCE.MAX, fact.confidence * decayFactor));
    }

    /**
     * Get current memory context for the LLM
     * @returns {Object} { facts, sessionSummary }
     */
    getContext() {
        // Filter and sort facts by effective confidence
        const usableFacts = this.facts
            .map(f => ({
                ...f,
                effectiveConfidence: this.getEffectiveConfidence(f)
            }))
            .filter(f => f.effectiveConfidence >= CONFIDENCE.MIN_USABLE)
            .sort((a, b) => b.effectiveConfidence - a.effectiveConfidence);

        return {
            facts: usableFacts,
            sessionSummary: this.sessionSummary
        };
    }

    /**
     * Find existing fact by content similarity
     */
    _findSimilarFact(content, threshold = 0.6) {
        for (const fact of this.facts) {
            if (textSimilarity(fact.content, content) >= threshold) {
                return fact;
            }
        }
        return null;
    }

    /**
     * Find fact by exact or near-exact content match
     */
    _findFactByContent(content) {
        if (!content) return null;
        const normalizedContent = content.toLowerCase().trim();
        return this.facts.find(f =>
            f.content.toLowerCase().trim() === normalizedContent ||
            textSimilarity(f.content, content) > 0.8
        );
    }

    /**
     * Reinforce an existing fact
     */
    _reinforceFact(fact) {
        fact.reinforceCount = (fact.reinforceCount || 1) + 1;
        fact.lastReinforced = Date.now();

        // Boost confidence with diminishing returns
        const boost = CONFIDENCE.REINFORCEMENT_BOOST / Math.sqrt(fact.reinforceCount);
        fact.confidence = Math.min(CONFIDENCE.MAX, fact.confidence + boost);

        console.log('[Memory] Reinforced fact:', fact.content, '-> confidence:', fact.confidence.toFixed(2));
    }

    /**
     * Reduce confidence of a contradicted fact
     */
    _contradictFact(fact) {
        fact.confidence = Math.max(0, fact.confidence - CONFIDENCE.CONTRADICTION_PENALTY);
        console.log('[Memory] Contradicted fact:', fact.content, '-> confidence:', fact.confidence.toFixed(2));
    }

    /**
     * Run background analysis to extract facts and summarize
     */
    async analyze() {
        if (this.isAnalyzing) return;
        this.isAnalyzing = true;

        try {
            console.log('[Memory] Starting background analysis...');

            // Construct input for analyzer
            const conversationText = this.recentMessages
                .map(msg => `${msg.role.toUpperCase()}: ${msg.content}`)
                .join('\n');

            // Include existing facts for reinforcement/contradiction detection
            const existingFactsList = this.facts
                .filter(f => this.getEffectiveConfidence(f) >= CONFIDENCE.MIN_USABLE)
                .map(f => `- [${f.category}] ${f.content}`)
                .join('\n');

            const analysisPrompt = `
EXISTING MEMORY:
${existingFactsList || '(no existing facts)'}

CURRENT SESSION SUMMARY:
${this.sessionSummary || '(none)'}

RECENT CONVERSATION:
${conversationText}

Analyze and update memory.`;

            // Call Brain with preferences:
            // 1. Override system prompt to be the Analyzer
            // 2. Prefer LOCAL model to save costs/latency
            const response = await BrainRouter.generate(analysisPrompt, {
                systemInstruction: MEMORY_ANALYZER_PROMPT,
                preferLocal: true // CRITICAL: Use local model for background work
            });

            // Parse result with robustness for local models
            console.log('[Memory] Raw analysis response:', response);

            // Extract JSON substring if wrapped in text/markdown
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            const cleanJson = jsonMatch ? jsonMatch[0] : response;

            let result;
            try {
                result = JSON.parse(cleanJson);
            } catch (e) {
                console.error('[Memory] JSON parse failed:', e);
                return; // Skip update if parse fails
            }

            // Process facts with reinforcement/contradiction logic
            if (result.facts && Array.isArray(result.facts)) {
                for (const newFact of result.facts) {
                    if (!newFact.content) continue;

                    // Check for reinforcement
                    if (newFact.reinforces) {
                        const existingFact = this._findFactByContent(newFact.reinforces);
                        if (existingFact) {
                            this._reinforceFact(existingFact);
                            continue; // Don't add duplicate
                        }
                    }

                    // Check for contradiction
                    if (newFact.contradicts) {
                        const existingFact = this._findFactByContent(newFact.contradicts);
                        if (existingFact) {
                            this._contradictFact(existingFact);
                        }
                    }

                    // Check if similar fact already exists
                    const similarFact = this._findSimilarFact(newFact.content);
                    if (similarFact) {
                        // Reinforce instead of duplicating
                        this._reinforceFact(similarFact);
                        // Update category if different and new fact is identity
                        if (newFact.category === 'identity' && similarFact.category !== 'identity') {
                            similarFact.category = 'identity';
                        }
                    } else {
                        // Add as new fact
                        const fact = {
                            id: generateId(),
                            content: newFact.content,
                            category: newFact.category || 'preferences',
                            confidence: CONFIDENCE.INITIAL,
                            lastReinforced: Date.now(),
                            reinforceCount: 1
                        };
                        this.facts.push(fact);
                        console.log('[Memory] New fact:', fact.content, `[${fact.category}]`);
                    }
                }
            }

            if (result.session_summary) {
                this.sessionSummary = result.session_summary;
                console.log('[Memory] Summary updated');
            }

        } catch (error) {
            console.warn('[Memory] Analysis failed:', error.message);
        } finally {
            this.isAnalyzing = false;
            // Persist after analysis
            this._save();
        }
    }

    /**
     * Forget a specific fact by ID
     * @param {string} factId 
     */
    forgetFact(factId) {
        const index = this.facts.findIndex(f => f.id === factId);
        if (index !== -1) {
            const removed = this.facts.splice(index, 1)[0];
            console.log('[Memory] Forgot fact:', removed.content);
            this._save();
            return true;
        }
        return false;
    }

    /**
     * Forget a fact by content match
     * @param {string} content 
     */
    forgetFactByContent(content) {
        const fact = this._findFactByContent(content);
        if (fact) {
            return this.forgetFact(fact.id);
        }
        return false;
    }

    /**
     * Clear all memory (Manual trigger)
     */
    clear() {
        this.recentMessages = [];
        this.facts = [];
        this.sessionSummary = "";
        this.turnCount = 0;
        this._save(); // Clear disk too
        console.log('[Memory] Cleared');
    }

    /**
     * Get all facts (for debugging/dev console)
     */
    getAllFacts() {
        return this.facts.map(f => ({
            ...f,
            effectiveConfidence: this.getEffectiveConfidence(f)
        }));
    }
}

// Export singleton
export const memoryManager = new MemoryManager();
export default memoryManager;
