# Discord User Recognition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Miko recognizes individual Discord users across visits — brand-new people get a real first-meeting introduction, returning people get progressively warmer treatment as a familiarity tier builds, and replies visibly quote/highlight the message they're responding to.

**Architecture:** New `src/discord/discord-user-memory.js` (main process) persists a per-Discord-user-ID record with message count, tier, and self-reported name (extracted via the same regex approach `memory-manager.js` already uses, no LLM call). `discord-bridge.js` records every buffered message and tracks the last message ID per batch for reply-quoting. `discord-renderer.js` tags each line in the batch prompt with tier/name context instead of just a raw username.

**Tech Stack:** Plain Node.js (CommonJS, main process) for the new store, matching `discord-bridge.js`'s existing style.

---

## Important context for the engineer

- Repo root: `C:\Users\Lokesh\Desktop\Pojects\Waifu`. No automated test suite — verification is manual, requires a real Discord account (ideally a second/alt account to genuinely test the "brand new" path, since your main account will already have prior message history once this ships).
- `src/discord/discord-bridge.js` (main process, CommonJS) is the file to extend — current full content already reviewed; exact line numbers below refer to it as it stands before this plan's edits.
- The persisted-JSON-with-userData-path pattern to mirror is `main.js`'s `loadDiscordConfig()`/`saveDiscordConfigToDisk()` (lines ~509-522) — try/catch-and-default on load, plain `fs.writeFileSync(path, JSON.stringify(data, null, 2))` on save. The new store computes its own path directly via `require('electron').app.getPath('userData')` since it's a self-contained main-process module (no need to thread the path in from `main.js`).
- The exact `NAME_PATTERNS` regex array to reuse (from `src/memory/memory-manager.js:24-28`):
  ```js
  const NAME_PATTERNS = [
      /my name(?:'s| is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
      /(?:i'm|i am)\s+([A-Z][a-z]{1,})\b(?!\s+(?:not|going|trying|working|doing|feeling|going|a\b))/i,
      /(?:call me|you can call me|just call me|people call me)\s+([A-Z][a-z]+)/i,
  ];
  ```
- `discord-bridge.js`'s buffer currently holds `{ username, content }` (line 40, pushed at line 227) — needs `userId` added.
- `discord-bridge.js`'s `messageCreate` handler already computes `displayName` at line 226 right before pushing to `buffer` — the new `recordMessage()` call and `userId` field go right there.
- `sendResponse(channelId, text)` (lines 261-275) is called from `main.js`'s `discord-send-response` IPC handler (`ipcMain.handle('discord-send-response', async (event, channelId, text) => { await discordBridge.sendResponse(channelId, text); });`) which in turn is called from `discord-renderer.js` via `window.electronAPI.sendDiscordResponse(batch.channelId, responseObj.text)` (in `preload.js`: `sendDiscordResponse: (channelId, text) => ipcRenderer.invoke('discord-send-response', channelId, text)`) — all three layers need the new optional `replyToMessageId` parameter threaded through.
- `flush()` (lines 119-133) builds the batch payload sent to the renderer via `batchReadyCallback({ channelId: activeChannelId, messages })` — needs a `replyToMessageId` field added, sourced from the last message pushed to `buffer` before this flush.
- `discord-renderer.js`'s `formatBatchAsPrompt()` (lines ~38-40) currently does `messages.map(m => \`[${m.username}]: ${m.content}\`).join('\n')` — needs the tier/name context added per message. Its `handleBatch()` already has `batch.channelId` available; `batch.replyToMessageId` will be available the same way.

---

### Task 1: Create the per-Discord-user memory store

**Files:**
- Create: `src/discord/discord-user-memory.js`

- [ ] **Step 1: Write the module**

```js
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
```

- [ ] **Step 2: Verify syntax**

```bash
node --check src/discord/discord-user-memory.js
```

Expected: no output (success).

- [ ] **Step 3: Sanity-check the tier logic in isolation**

```bash
node -e "
const mod = require('./src/discord/discord-user-memory.js');
" 2>&1 | head -5
```

Expected: it will throw on `require('electron')` since this is run outside Electron — that's fine, just confirms the module loads far enough to hit the Electron dependency (real verification happens in Task 4's end-to-end test, where it runs inside the actual app).

- [ ] **Step 4: Commit**

```bash
git add src/discord/discord-user-memory.js
git commit -m "feat: add per-Discord-user recognition store (tiers, name detection)"
```

---

### Task 2: Wire recording + reply-target tracking into `discord-bridge.js`

**Files:**
- Modify: `src/discord/discord-bridge.js`

- [ ] **Step 1: Import the new module**

Find:

```js
const { Readable } = require('stream');
```

Right after it, add:

```js
const discordUserMemory = require('./discord-user-memory.js');
```

- [ ] **Step 2: Track the last message ID for reply-quoting**

Find:

```js
let buffer = []; // [{ username, content }]
```

Replace with:

```js
let buffer = []; // [{ username, userId, content }]
let lastBufferedMessageId = null;
```

- [ ] **Step 3: Record the message and thread `userId` through**

Find:

```js
        // Guild nickname / display name, not the raw account username (which
        // is often an ugly handle-and-numbers combo). Falls back to the raw
        // username if no member/display name is available. Whatever Unicode
        // styling a display name has comes through as-is — plain JS strings
        // handle that natively, nothing special needed.
        const displayName = message.member?.displayName || message.author.username;
        buffer.push({ username: displayName, content });
        scheduleFlush();
```

Replace with:

```js
        // Guild nickname / display name, not the raw account username (which
        // is often an ugly handle-and-numbers combo). Falls back to the raw
        // username if no member/display name is available. Whatever Unicode
        // styling a display name has comes through as-is — plain JS strings
        // handle that natively, nothing special needed.
        const displayName = message.member?.displayName || message.author.username;
        const userId = message.author.id;
        discordUserMemory.recordMessage(userId, displayName, content);
        buffer.push({ username: displayName, userId, content });
        lastBufferedMessageId = message.id;
        scheduleFlush();
```

- [ ] **Step 4: Include the reply target in the flushed batch**

Find:

```js
function flush() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    if (busy) return;
    if (buffer.length === 0) return;
    if (!batchReadyCallback) return;

    const messages = buffer;
    buffer = [];
    busy = true; // set synchronously to prevent a second flush before the
                 // renderer's generation actually starts
    batchReadyCallback({ channelId: activeChannelId, messages });
}
```

Replace with:

```js
function flush() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    if (busy) return;
    if (buffer.length === 0) return;
    if (!batchReadyCallback) return;

    const messages = buffer;
    const replyToMessageId = lastBufferedMessageId;
    buffer = [];
    lastBufferedMessageId = null;
    busy = true; // set synchronously to prevent a second flush before the
                 // renderer's generation actually starts
    batchReadyCallback({ channelId: activeChannelId, messages, replyToMessageId });
}
```

- [ ] **Step 5: Accept and use `replyToMessageId` in `sendResponse()`**

Find:

```js
async function sendResponse(channelId, text) {
    if (!client || !channelId) return;
    try {
        const channel = await client.channels.fetch(channelId);
        if (channel && channel.isTextBased()) {
            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setAuthor({ name: 'Miko' })
                .setDescription(text);
            await channel.send({ embeds: [embed] });
        }
    } catch (err) {
        console.error('[DiscordBridge] Failed to send response:', err.message);
    }
}
```

Replace with:

```js
async function sendResponse(channelId, text, replyToMessageId = null) {
    if (!client || !channelId) return;
    try {
        const channel = await client.channels.fetch(channelId);
        if (channel && channel.isTextBased()) {
            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setAuthor({ name: 'Miko' })
                .setDescription(text);
            const options = { embeds: [embed] };
            if (replyToMessageId) {
                options.reply = { messageReference: replyToMessageId, failIfNotExists: false };
            }
            await channel.send(options);
        }
    } catch (err) {
        console.error('[DiscordBridge] Failed to send response:', err.message);
    }
}
```

(`failIfNotExists: false` makes it degrade gracefully to a normal message if the target was deleted before the reply sends, instead of throwing.)

- [ ] **Step 6: Also expose `getTierInfo` for the renderer to use via IPC**

Add this new function right after `getStatus()`:

```js
function getUserTierInfo(userId) {
    return discordUserMemory.getTierInfo(userId);
}
```

Find:

```js
module.exports = { start, stop, onBatchReady, sendResponse, markFree, getStatus, playAudioBuffer };
```

Replace with:

```js
module.exports = { start, stop, onBatchReady, sendResponse, markFree, getStatus, playAudioBuffer, getUserTierInfo };
```

- [ ] **Step 7: Verify syntax**

```bash
node --check src/discord/discord-bridge.js
```

Expected: no output (success).

- [ ] **Step 8: Commit**

```bash
git add src/discord/discord-bridge.js
git commit -m "feat: record Discord users per-message, track reply target, support reply-quoting"
```

---

### Task 3: Expose tier info over IPC and use it in the batch prompt

**Files:**
- Modify: `main.js`
- Modify: `preload.js`
- Modify: `src/discord/discord-renderer.js`

- [ ] **Step 1: Add the main.js IPC handler**

In `main.js`, find:

```js
ipcMain.handle('discord-get-status', async () => {
    return discordBridge.getStatus();
});
```

Right after it, add:

```js

ipcMain.handle('discord-get-user-tier', async (event, userId) => {
    return discordBridge.getUserTierInfo(userId);
});
```

- [ ] **Step 2: Expose it in preload.js**

In `preload.js`, find:

```js
    getDiscordStatus: () => ipcRenderer.invoke('discord-get-status')
```

Replace with:

```js
    getDiscordStatus: () => ipcRenderer.invoke('discord-get-status'),
    getDiscordUserTier: (userId) => ipcRenderer.invoke('discord-get-user-tier', userId)
```

- [ ] **Step 3: Update `sendDiscordResponse` to accept the reply target**

Still in `preload.js`, find:

```js
    sendDiscordResponse: (channelId, text) => ipcRenderer.invoke('discord-send-response', channelId, text),
```

Replace with:

```js
    sendDiscordResponse: (channelId, text, replyToMessageId) => ipcRenderer.invoke('discord-send-response', channelId, text, replyToMessageId),
```

- [ ] **Step 4: Update the main.js handler to pass it through**

In `main.js`, find:

```js
ipcMain.handle('discord-send-response', async (event, channelId, text) => {
    await discordBridge.sendResponse(channelId, text);
});
```

Replace with:

```js
ipcMain.handle('discord-send-response', async (event, channelId, text, replyToMessageId) => {
    await discordBridge.sendResponse(channelId, text, replyToMessageId);
});
```

- [ ] **Step 5: Verify syntax**

```bash
node --check main.js && node --check preload.js
```

Expected: no output (success).

- [ ] **Step 6: Update `formatBatchAsPrompt()` and `handleBatch()` in `discord-renderer.js`**

Find:

```js
function formatBatchAsPrompt(messages) {
    return messages.map(m => `[${m.username}]: ${m.content}`).join('\n');
}
```

Replace with:

```js
const TIER_DESCRIPTIONS = {
    new: 'brand new, never talked before',
    acquaintance: 'you\'ve talked a bit before',
    regular: 'a regular, you know them well',
};

async function formatBatchAsPrompt(messages) {
    const lines = await Promise.all(messages.map(async (m) => {
        let tag = m.username;
        try {
            const info = await window.electronAPI.getDiscordUserTier(m.userId);
            const desc = TIER_DESCRIPTIONS[info.tier] || TIER_DESCRIPTIONS.new;
            const nameNote = info.knownName ? `, name: ${info.knownName}` : '';
            tag = `${m.username} (${desc}${nameNote})`;
        } catch (e) {
            console.warn('[DiscordRenderer] Could not get tier info for', m.username, e.message);
        }
        return `[${tag}]: ${m.content}`;
    }));
    return lines.join('\n');
}
```

- [ ] **Step 7: Await the now-async `formatBatchAsPrompt()` and pass the reply target through**

Find:

```js
async function handleBatch(batch) {
    const promptText = formatBatchAsPrompt(batch.messages);
```

Replace with:

```js
async function handleBatch(batch) {
    const promptText = await formatBatchAsPrompt(batch.messages);
```

Find:

```js
            window.electronAPI.sendDiscordResponse(batch.channelId, responseObj.text);
```

Replace with:

```js
            window.electronAPI.sendDiscordResponse(batch.channelId, responseObj.text, batch.replyToMessageId);
```

- [ ] **Step 8: Add the tier-reading instruction to the stream addendum**

Find:

```js
Emoji: you can use them, but sparingly — one or two per message tops, and
only real ones you can type directly (😄 😭 💀 🔥 👀 etc.), never Discord's
:custom_emoji_name: syntax. You don't know what emojis actually exist on
this server, so guessing a custom name just posts broken text. Stick to
standard Unicode emoji, or none at all if the line doesn't need one.`;
```

Replace with:

```js
Emoji: you can use them, but sparingly — one or two per message tops, and
only real ones you can type directly (😄 😭 💀 🔥 👀 etc.), never Discord's
:custom_emoji_name: syntax. You don't know what emojis actually exist on
this server, so guessing a custom name just posts broken text. Stick to
standard Unicode emoji, or none at all if the line doesn't need one.

Each speaker below is tagged with how well you know them and their name if
you've learned it. Brand new people are meeting you for the first time —
you don't know them at all, so introduce yourself naturally and let their
name come up organically if it fits, don't interrogate them. Regulars get
your relaxed, familiar side — no need to re-introduce yourself or explain
who you are to them. Calibrate warmth per-person even within one reply if
the batch has a mix of new and familiar people.`;
```

- [ ] **Step 9: Verify syntax**

```bash
node --check src/discord/discord-renderer.js
```

Expected: no output (success).

- [ ] **Step 10: Commit**

```bash
git add main.js preload.js src/discord/discord-renderer.js
git commit -m "feat: surface Discord user tiers into the prompt, reply-quote responses"
```

---

### Task 4: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Start the app**

```bash
npm start
```

- [ ] **Step 2: Test the brand-new path**

Using an account that has never messaged in the active channel before (an alt account is ideal — your main account will already be a "regular" once this ships and stays running), run `!start`, then send a message. Confirm:
- The response reads like a genuine first meeting (introduces herself, doesn't assume familiarity).
- The response visibly appears as a Discord reply/quote to that message (the little reply-arrow UI element pointing at the original message).

- [ ] **Step 3: Test tier progression**

Have that same account send several more messages (across multiple batches — wait for each response before sending the next, so `messageCount` actually increments across separate `recordMessage()` calls). Confirm the tone gradually warms up as they cross into "acquaintance," and check `discord-user-memory.json` in Electron's userData folder directly if you want to see the raw `messageCount`/tier math without waiting for 11 real messages.

- [ ] **Step 4: Test a mixed batch**

If you have a second test account, have both a new and an established account send messages close together (within the debounce window) so they land in the same batch. Confirm the single response calibrates differently toward each person by name/mention.

- [ ] **Step 5: Confirm normal chat is unaffected**

Chat with Miko directly in the app (not Discord). Confirm nothing about this feature touched that path.

- [ ] **Step 6: Report results**

Summarize what worked. If reply-quoting doesn't visually appear in Discord, check for a console error around `sendResponse` — the most likely cause would be a Discord permissions issue (the bot needs "Read Message History" permission in that channel to reply-quote), not a code bug — report the exact error if this happens rather than guessing at a fix.

---

## Explicitly out of scope for this plan

- Per-Discord-user fact/preference memory (what they've said, not just who they are).
- Manually editable/resettable tiers (e.g. an admin command to reset someone's familiarity) — not requested, can be added later if needed.
- Decay of familiarity over long absence — tiers only ever go up, never down, in this pass.
