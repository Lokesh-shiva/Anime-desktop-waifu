/**
 * Discord User Memory — per-Discord-user-ID recognition store.
 * Fully separate from memoryManager (which is the single main-user's
 * facts/mood/bond) — this only tracks WHO Discord users are across visits
 * so Miko can calibrate tone (brand-new vs. familiar), never what they said.
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const STORE_FILE = 'discord-user-memory.json';

// Instant name-detection — same regex approach as memory-manager.js's
// NAME_PATTERNS, no LLM call needed for this.
const NAME_PATTERNS = [
    /my name(?:'s| is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    /(?:i'm|i am)\s+([A-Z][a-z]{1,})\b(?!\s+(?:not|going|trying|working|doing|feeling|going|a\b))/i,
    /(?:call me|you can call me|just call me|people call me)\s+([A-Z][a-z]+)/i,
];

const TIER_THRESHOLDS = {
    ACQUAINTANCE: 2,  // messageCount >= this
    REGULAR: 11,      // messageCount >= this
};

let users = {}; // userId -> { userId, displayName, knownName, messageCount, firstSeenAt, lastSeenAt }
let loaded = false;

function storePath() {
    return path.join(app.getPath('userData'), STORE_FILE);
}

function load() {
    if (loaded) return;
    loaded = true;
    try {
        const p = storePath();
        if (fs.existsSync(p)) {
            users = JSON.parse(fs.readFileSync(p, 'utf-8'));
        }
    } catch (e) {
        console.error('[DiscordUserMemory] Load failed, starting fresh:', e.message);
        users = {};
    }
}

function save() {
    try {
        fs.writeFileSync(storePath(), JSON.stringify(users, null, 2), 'utf-8');
    } catch (e) {
        console.error('[DiscordUserMemory] Save failed:', e.message);
    }
}

function extractName(content) {
    for (const pattern of NAME_PATTERNS) {
        const match = content.match(pattern);
        if (match) {
            const name = match[1].trim();
            if (name.length >= 2 && name.length <= 30) return name;
        }
    }
    return null;
}

/**
 * Record a message from a Discord user — increments their count, updates
 * timestamps, and attempts name extraction from the message content.
 * Never throws — recognition is a tone-calibration enhancer, not a blocker.
 * @param {string} userId
 * @param {string} displayName
 * @param {string} content
 */
function recordMessage(userId, displayName, content) {
    try {
        load();
        const now = Date.now();
        const existing = users[userId];

        if (!existing) {
            users[userId] = {
                userId,
                displayName,
                knownName: extractName(content),
                messageCount: 1,
                firstSeenAt: now,
                lastSeenAt: now,
            };
        } else {
            existing.displayName = displayName; // keep current in case of nickname changes
            existing.messageCount += 1;
            existing.lastSeenAt = now;
            const extracted = extractName(content);
            if (extracted && !existing.knownName) existing.knownName = extracted;
        }
        save();
    } catch (e) {
        console.error('[DiscordUserMemory] recordMessage failed:', e.message);
    }
}

/**
 * Get tier info for a Discord user, based on their CURRENT record (call
 * this AFTER recordMessage() for the current message, so a brand-new
 * user's very first message correctly reads as tier 'new').
 * @param {string} userId
 * @returns {{tier: 'new'|'acquaintance'|'regular', knownName: string|null, messageCount: number}}
 */
function getTierInfo(userId) {
    load();
    const user = users[userId];
    if (!user) return { tier: 'new', knownName: null, messageCount: 0 };

    let tier = 'new';
    if (user.messageCount >= TIER_THRESHOLDS.REGULAR) tier = 'regular';
    else if (user.messageCount >= TIER_THRESHOLDS.ACQUAINTANCE) tier = 'acquaintance';

    return { tier, knownName: user.knownName, messageCount: user.messageCount };
}

module.exports = { recordMessage, getTierInfo };
