/**
 * Memory Manager
 * Handles short-term context, fact storage with confidence/decay, and session summarization
 */

import { BrainRouter } from '../llm/brain-router.js';

const BUFFER_SIZE = 10;
const AUTO_ANALYZE_INTERVAL = 2; // Analyze every 2 turns for faster updates
const MAX_PREVIOUS_SESSIONS = 5; // How many past session summaries to keep
const MAX_DIARY_ENTRIES = 14;    // Keep ~2 weeks of diary

// Bond level thresholds (cumulative score)
const BOND_LEVELS = [
    { key: 'stranger',     min: 0,    label: 'Stranger',      prompt: null },
    { key: 'acquaintance', min: 40,   label: 'Acquaintance',  prompt: 'You know their name and a little about them. You are warming up to them.' },
    { key: 'friend',       min: 150,  label: 'Friend',        prompt: 'You are genuine friends. You look forward to talking with them and feel comfortable being yourself.' },
    { key: 'close',        min: 400,  label: 'Close Friend',  prompt: 'You are very close. You worry about them when they are gone too long. You can tease, be vulnerable, and share things unprompted.' },
    { key: 'bestfriend',   min: 900,  label: 'Best Friend',   prompt: 'They are your closest person. You speak with easy familiarity, inside references feel natural, and you do not hide how much you care.' },
    { key: 'cherished',    min: 1800, label: 'Cherished',     prompt: 'This person means the world to you. Your warmth is quiet and deep — you don\'t need to perform it.' },
];

// Instant name-detection patterns (no LLM needed)
const NAME_PATTERNS = [
    /my name(?:'s| is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    /(?:i'm|i am)\s+([A-Z][a-z]{1,})\b(?!\s+(?:not|going|trying|working|doing|feeling|going|a\b))/i,
    /(?:call me|you can call me|just call me|people call me)\s+([A-Z][a-z]+)/i,
];

// Mood config
const MOOD_RESTING_VALUE  = -0.1;  // Drifts here when idle (slightly lonely)
const MOOD_DRIFT_RATE     = 0.04;  // Per hour — ~17h to reach resting from neutral
const MOOD_INTERACTION_BOOST = {
    positive: 0.12,  // happy/excited/love/playful/grateful/kind/tender
    neutral:  0.04,  // calm/curious/confused/determined/neutral
    negative: -0.02  // sad/crying/angry/disgusted — interaction still slightly positive
};
const MOOD_MAX =  0.80;
const MOOD_MIN = -0.80;

const POSITIVE_EMOTIONS = new Set([
    'happy','excited','love','playful','grateful','kind','tender','smug','determined'
]);
const NEGATIVE_EMOTIONS = new Set([
    'sad','crying','angry','anger','dark','disgusted','scared','lonely','melancholic'
]);

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

const MEMORY_ANALYZER_PROMPT = `You are a memory extraction module. Output ONLY valid JSON. No explanation, no markdown, no bullet points, no reasoning — just the JSON object.

Extract facts from the conversation and return this exact structure:
{"facts":[{"content":"fact text","category":"identity|preferences|constraints|projects","reinforces":null,"contradicts":null}],"session_summary":"one sentence"}

Rules:
- facts: extract user NAME, preferences, and key facts only. Empty array if nothing notable.
- category: identity (name/traits), preferences (likes/habits), constraints (hardware/limits), projects (current work)
- reinforces: copy exact content of an existing fact this confirms, else null
- contradicts: copy exact content of an existing fact this contradicts, else null
- session_summary: one sentence describing what happened in this conversation
- Ignore greetings, filler, and small talk
- Never invent facts
- Never store emotions unless user explicitly states them
- A fact must be your own third-person statement describing something about the
  user. Never copy a line of dialogue verbatim as if it were a fact.

Examples of what NOT to extract as facts (these are dialogue, not information):
- User said "Hello there" -> NOT a fact, just a greeting
- User said "no you're not" -> NOT a fact, just a reply/rebuttal
- User said "thanks" or "yes" -> NOT a fact, just an acknowledgement

Examples of what TO extract:
- User says "my brother's name is Aditya" -> {"content":"User's brother is named Aditya","category":"identity","reinforces":null,"contradicts":null}
- User mentions they work as a software engineer -> {"content":"User works as a software engineer","category":"identity","reinforces":null,"contradicts":null}

Output the JSON object directly. Nothing before it. Nothing after it.`;

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
        this.recentMessages   = []; // Rolling buffer
        this.facts            = []; // Structured fact objects
        this.sessionSummary   = "";
        this.previousSessions = []; // Last N session summaries (oldest first)
        this.turnCount        = 0;
        this.isAnalyzing      = false;
        this.lastSeen         = null; // Timestamp (ms) of previous session end

        // Persistent mood state
        this.mood = { value: 0.0, label: 'content', lastUpdated: Date.now() };

        // Relationship bond
        this.bond = { score: 0, level: 'stranger', totalInteractions: 0 };

        // Miko's diary entries [{ date, entry }]
        this.diary = [];

        // Load persistent memory
        this._load();
    }

    /**
     * Get the timestamp (ms) of the last session save, or null if first run.
     * @returns {number|null}
     */
    getLastSeen() {
        return this.lastSeen;
    }

    /**
     * True when there's no recorded user name and no prior session — used by the
     * onboarding flow to trigger a real "first meeting" greeting.
     */
    isFirstMeeting() {
        return !this.lastSeen && !this.hasKnownName();
    }

    /**
     * Returns the stored user name (if any), null otherwise.
     */
    getUserName() {
        const fact = this.facts.find(f => /^User's name is /i.test(f.content));
        if (!fact) return null;
        const m = fact.content.match(/^User's name is (.+)$/i);
        return m ? m[1].trim() : null;
    }

    hasKnownName() {
        return !!this.getUserName();
    }

    /**
     * Load memory from disk with migration support
     */
    async _load() {
        try {
            if (window.electronAPI?.loadMemory) {
                const startData = await window.electronAPI.loadMemory();
                if (startData) {
                    this.facts            = this._migrateFacts(startData.facts || []);
                    this.sessionSummary   = startData.sessionSummary || "";
                    this.previousSessions = Array.isArray(startData.previousSessions)
                        ? startData.previousSessions : [];
                    this.lastSeen         = startData.lastSeen || null;

                    // Restore mood and apply idle drift since last session
                    if (startData.mood && typeof startData.mood.value === 'number') {
                        this.mood = startData.mood;
                    }
                    this._applyIdleMoodDrift();

                    // Restore bond
                    if (startData.bond && typeof startData.bond.score === 'number') {
                        this.bond = startData.bond;
                    }

                    // Restore diary
                    if (Array.isArray(startData.diary)) {
                        this.diary = startData.diary;
                    }

                    // Apply fact confidence decay based on time since last use
                    this._applyDecay();

                    console.log('[Memory] Loaded', this.facts.length, 'facts;',
                        this.previousSessions.length, 'previous sessions; mood:', this.mood.label,
                        '; bond:', this.bond.level);
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
            if (typeof fact === 'object' && fact.id) return fact;

            if (typeof fact === 'string') {
                return {
                    id: generateId(),
                    content: fact,
                    category: this._guessCategory(fact),
                    confidence: 0.6,
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

        return 'preferences';
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
            const decayFactor = Math.pow(1 - decayRate, daysSinceReinforced);
            return { ...fact, confidence: Math.max(0, fact.confidence * decayFactor) };
        });

        const beforeCount = this.facts.length;
        this.facts = this.facts.filter(f => f.confidence >= CONFIDENCE.MIN_USABLE * 0.5);

        if (beforeCount > this.facts.length) {
            console.log('[Memory] Removed', beforeCount - this.facts.length, 'decayed facts');
        }
    }

    // ── Mood ────────────────────────────────────────────────────────────────

    /**
     * Drift mood toward the resting value based on hours idle since lastSeen.
     * Called once on load.
     */
    _applyIdleMoodDrift() {
        if (!this.lastSeen) return;
        const hoursIdle = (Date.now() - this.mood.lastUpdated) / (1000 * 60 * 60);
        if (hoursIdle < 0.1) return;

        // Exponential approach toward MOOD_RESTING_VALUE
        const alpha = 1 - Math.exp(-MOOD_DRIFT_RATE * hoursIdle);
        const newValue = this.mood.value + (MOOD_RESTING_VALUE - this.mood.value) * alpha;
        this.mood.value = Math.max(MOOD_MIN, Math.min(MOOD_MAX, newValue));
        this.mood.label = this._moodLabel(this.mood.value);
        this.mood.lastUpdated = Date.now();
        console.log(`[Mood] After ${hoursIdle.toFixed(1)}h idle: ${this.mood.label} (${this.mood.value.toFixed(2)})`);
    }

    _moodLabel(value) {
        if (value <= -0.50) return 'lonely';
        if (value <= -0.20) return 'melancholic';
        if (value <=  0.15) return 'content';
        if (value <=  0.45) return 'happy';
        return 'playful';
    }

    /**
     * Update mood after an interaction based on the emotion arc chosen by the LLM.
     * @param {Array} emotionArc - array of { label, intensity, at } from parsed response
     */
    recordInteractionSentiment(emotionArc) {
        if (!Array.isArray(emotionArc) || emotionArc.length === 0) {
            this.mood.value = Math.min(MOOD_MAX, this.mood.value + MOOD_INTERACTION_BOOST.neutral);
        } else {
            // Use the dominant (first/highest intensity) emotion in the arc
            const dominant = emotionArc.reduce((a, b) => b.intensity > a.intensity ? b : a);
            const label = dominant.label?.toLowerCase() || 'neutral';
            let boost;
            if (POSITIVE_EMOTIONS.has(label))      boost = MOOD_INTERACTION_BOOST.positive;
            else if (NEGATIVE_EMOTIONS.has(label)) boost = MOOD_INTERACTION_BOOST.negative;
            else                                   boost = MOOD_INTERACTION_BOOST.neutral;
            this.mood.value = Math.max(MOOD_MIN, Math.min(MOOD_MAX, this.mood.value + boost));
        }
        this.mood.label       = this._moodLabel(this.mood.value);
        this.mood.lastUpdated = Date.now();

        // Bond growth per interaction
        const sentimentScore = Array.isArray(emotionArc) && emotionArc.length > 0
            ? (() => {
                const dominant = emotionArc.reduce((a, b) => b.intensity > a.intensity ? b : a);
                const lbl = dominant.label?.toLowerCase() || 'neutral';
                if (POSITIVE_EMOTIONS.has(lbl)) return 3;
                if (NEGATIVE_EMOTIONS.has(lbl)) return 0.5;
                return 1.5;
            })()
            : 1.5;
        this.bond.score += sentimentScore;
        this.bond.totalInteractions = (this.bond.totalInteractions || 0) + 1;
        this.bond.level = this._getBondLevel();
        this._save();
    }

    _getBondLevel() {
        for (let i = BOND_LEVELS.length - 1; i >= 0; i--) {
            if (this.bond.score >= BOND_LEVELS[i].min) return BOND_LEVELS[i].key;
        }
        return 'stranger';
    }

    getBondInfo() {
        const current = BOND_LEVELS.find(l => l.key === this.bond.level) || BOND_LEVELS[0];
        const nextIdx = BOND_LEVELS.indexOf(current) + 1;
        const next    = BOND_LEVELS[nextIdx] || null;
        const progress = next
            ? Math.min(1, (this.bond.score - current.min) / (next.min - current.min))
            : 1;
        return { ...this.bond, label: current.label, progress, nextLabel: next?.label || null };
    }

    getBondPrompt() {
        const level = BOND_LEVELS.find(l => l.key === this.bond.level);
        return level?.prompt || null;
    }

    /**
     * Instant name extraction — no LLM, fires synchronously on every message.
     */
    _quickExtractName(text) {
        for (const pattern of NAME_PATTERNS) {
            const match = text.match(pattern);
            if (match) {
                const name = match[1].trim();
                if (name.length < 2 || name.length > 30) continue;
                const content = `User's name is ${name}`;
                const existing = this._findSimilarFact(content, 0.55);
                if (existing) {
                    this._reinforceFact(existing);
                } else {
                    this.facts.push({
                        id: generateId(),
                        content,
                        category: 'identity',
                        confidence: 0.85,
                        lastReinforced: Date.now(),
                        reinforceCount: 1,
                    });
                    console.log('[Memory] Quick-extracted name:', name);
                }
                this._save();
                return;
            }
        }
    }

    /**
     * Returns a human-readable mood description for the system prompt.
     */
    getMoodDescription() {
        const v = this.mood.value;
        if (v <= -0.50) return "She's been feeling quite lonely — it's been a while since you last talked, and she's missed you.";
        if (v <= -0.20) return "She's feeling a bit quiet and wistful today, like she's been waiting.";
        if (v <=  0.15) return null; // content is the default — no annotation needed
        if (v <=  0.45) return "She's in a warm, happy mood — recent conversations have been good.";
        return "She's feeling bright and playful — she's really been enjoying talking with you.";
    }

    getMood() {
        return { ...this.mood };
    }

    // ── Persistence ─────────────────────────────────────────────────────────

    /**
     * Save memory to disk
     */
    async _save() {
        try {
            if (window.electronAPI?.saveMemory) {
                const data = {
                    facts: this.facts,
                    sessionSummary: this.sessionSummary,
                    previousSessions: this.previousSessions,
                    mood: this.mood,
                    bond: this.bond,
                    diary: this.diary,
                    lastSeen: Date.now()
                };
                await window.electronAPI.saveMemory(data);
                console.log('[Memory] Saved to disk');
            }
        } catch (e) {
            console.error('[Memory] Save failed:', e);
        }
    }

    // ── Interactions ─────────────────────────────────────────────────────────

    /**
     * Add a user-assistant interaction to memory
     * @param {string} userMessage
     * @param {string} assistantResponse
     */
    addInteraction(userMessage, assistantResponse) {
        // Instant name extraction — no waiting for LLM
        if (userMessage && userMessage !== '[quiet]' && userMessage !== '[camera glance]' && userMessage !== '[app opened]') {
            this._quickExtractName(userMessage);
        }

        this.recentMessages.push({ role: 'user', content: userMessage });
        this.recentMessages.push({ role: 'assistant', content: assistantResponse });

        if (this.recentMessages.length > BUFFER_SIZE * 2) {
            this.recentMessages.splice(0, 2);
        }

        this.turnCount++;

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
     * @returns {Object} { facts, sessionSummary, previousSessions, mood }
     */
    getContext() {
        const usableFacts = this.facts
            .map(f => ({ ...f, effectiveConfidence: this.getEffectiveConfidence(f) }))
            .filter(f => f.effectiveConfidence >= CONFIDENCE.MIN_USABLE)
            .sort((a, b) => b.effectiveConfidence - a.effectiveConfidence);

        return {
            facts: usableFacts,
            sessionSummary: this.sessionSummary,
            previousSessions: this.previousSessions,
            moodDescription: this.getMoodDescription(),
            bondPrompt: this.getBondPrompt(),
        };
    }

    // ── Internal fact helpers ────────────────────────────────────────────────

    _findSimilarFact(content, threshold = 0.6) {
        for (const fact of this.facts) {
            if (textSimilarity(fact.content, content) >= threshold) return fact;
        }
        return null;
    }

    _findFactByContent(content) {
        if (!content) return null;
        const normalizedContent = content.toLowerCase().trim();
        return this.facts.find(f =>
            f.content.toLowerCase().trim() === normalizedContent ||
            textSimilarity(f.content, content) > 0.8
        );
    }

    _reinforceFact(fact) {
        fact.reinforceCount = (fact.reinforceCount || 1) + 1;
        fact.lastReinforced = Date.now();
        const boost = CONFIDENCE.REINFORCEMENT_BOOST / Math.sqrt(fact.reinforceCount);
        fact.confidence = Math.min(CONFIDENCE.MAX, fact.confidence + boost);
        console.log('[Memory] Reinforced fact:', fact.content, '-> confidence:', fact.confidence.toFixed(2));
    }

    _contradictFact(fact) {
        fact.confidence = Math.max(0, fact.confidence - CONFIDENCE.CONTRADICTION_PENALTY);
        console.log('[Memory] Contradicted fact:', fact.content, '-> confidence:', fact.confidence.toFixed(2));
    }

    // ── Analysis ─────────────────────────────────────────────────────────────

    /**
     * Run background analysis to extract facts and summarize.
     * Archives the current session summary to previousSessions before overwriting.
     */
    async analyze() {
        if (this.isAnalyzing) return;
        this.isAnalyzing = true;

        try {
            console.log('[Memory] Starting background analysis...');

            const conversationText = this.recentMessages
                .map(msg => `${msg.role.toUpperCase()}: ${msg.content}`)
                .join('\n');

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

            const response = await BrainRouter.generate(analysisPrompt, {
                systemInstruction: MEMORY_ANALYZER_PROMPT,
                raw: true,
                jsonMode: true
            });

            console.log('[Memory] Raw analysis response:', response);

            // Gemini thinking models output reasoning prose around the JSON.
            // Use brace-counting to find every top-level {...} block, try each last-first.
            let result;
            const blocks = [];
            for (let i = 0; i < response.length; i++) {
                if (response[i] !== '{') continue;
                let depth = 0, inStr = false, esc = false;
                for (let j = i; j < response.length; j++) {
                    const c = response[j];
                    if (esc)          { esc = false; continue; }
                    if (c === '\\' && inStr) { esc = true; continue; }
                    if (c === '"')    { inStr = !inStr; continue; }
                    if (inStr)        continue;
                    if (c === '{')    depth++;
                    else if (c === '}') { depth--; if (depth === 0) { blocks.push(response.slice(i, j + 1)); break; } }
                }
            }
            for (const block of blocks.reverse()) {
                try {
                    const parsed = JSON.parse(block);
                    if (parsed && Array.isArray(parsed.facts)) { result = parsed; break; }
                } catch { /* try next */ }
            }
            if (!result) {
                console.error('[Memory] JSON extraction failed — no valid block found');
                return;
            }

            if (result.facts && Array.isArray(result.facts)) {
                for (const newFact of result.facts) {
                    if (!newFact.content) continue;

                    if (newFact.reinforces) {
                        const existingFact = this._findFactByContent(newFact.reinforces);
                        if (existingFact) { this._reinforceFact(existingFact); continue; }
                    }

                    if (newFact.contradicts) {
                        const existingFact = this._findFactByContent(newFact.contradicts);
                        if (existingFact) this._contradictFact(existingFact);
                    }

                    const similarFact = this._findSimilarFact(newFact.content);
                    if (similarFact) {
                        this._reinforceFact(similarFact);
                        if (newFact.category === 'identity' && similarFact.category !== 'identity') {
                            similarFact.category = 'identity';
                        }
                    } else {
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
                // Archive the outgoing summary before replacing it
                if (this.sessionSummary) {
                    this.previousSessions.push(this.sessionSummary);
                    if (this.previousSessions.length > MAX_PREVIOUS_SESSIONS) {
                        this.previousSessions.shift();
                    }
                }
                this.sessionSummary = result.session_summary;
                console.log('[Memory] Summary updated; archive now has', this.previousSessions.length, 'entries');
            }

            // Diary entry — written after session summary is ready
            if (result.session_summary) {
                this._writeDiaryEntry(result.session_summary).catch(() => {});
            }

        } catch (error) {
            console.warn('[Memory] Analysis failed:', error.message);
        } finally {
            this.isAnalyzing = false;
            this._save();
        }
    }

    async _writeDiaryEntry(sessionSummary) {
        const DIARY_PROMPT = `You are Miko, a warm AI companion. Write a short private diary entry (2-3 sentences, first person) reflecting on the conversation session summarised below. Be genuine, slightly wistful, and personal — like a real diary. Don't start with "Dear diary". Don't use the word "delve". Output ONLY the diary text, nothing else.\n\nSession: ${sessionSummary}`;
        try {
            let entry = await BrainRouter.generate(DIARY_PROMPT, { raw: true });
            // BrainRouter may return the full Miko JSON format — extract just the text
            const jsonMatch = entry.match(/\{[\s\S]*"text"\s*:\s*"([\s\S]*?)"\s*[,}]/);
            if (jsonMatch) entry = jsonMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
            if (!entry || entry.length < 10) return;
            this.diary.push({ date: new Date().toISOString(), entry: entry.trim() });
            if (this.diary.length > MAX_DIARY_ENTRIES) this.diary.shift();
            console.log('[Memory] Diary entry written');
            this._save();
        } catch (e) {
            console.warn('[Memory] Diary write failed:', e.message);
        }
    }

    // ── Public utilities ─────────────────────────────────────────────────────

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

    forgetFactByContent(content) {
        const fact = this._findFactByContent(content);
        if (fact) return this.forgetFact(fact.id);
        return false;
    }

    clear() {
        this.recentMessages   = [];
        this.facts            = [];
        this.sessionSummary   = "";
        this.previousSessions = [];
        this.mood             = { value: 0.0, label: 'content', lastUpdated: Date.now() };
        this.bond             = { score: 0, level: 'stranger', totalInteractions: 0 };
        this.diary            = [];
        this.turnCount        = 0;
        this._save();
        console.log('[Memory] Cleared');
    }

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
