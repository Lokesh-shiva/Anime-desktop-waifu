# Inner State (Self-Continuity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Miko response-fingerprint tracking (anti-repetition), rolling conversation threads, and periodic independent "solo thoughts," surfaced through a new `[On your mind]` prompt section — plus broaden the annoyance examples in her system prompt — so she stops dodging/repeating and feels continuous between messages.

**Architecture:** All new state lives on `MemoryManager` (`src/memory/memory-manager.js`), same category as the existing mood/bond state. Fingerprints and threads are session-scoped (in-memory only, reset on app restart — cheap, and staleness past a session isn't useful anyway). Only `soloThought` is persisted, since it's meant to survive across restarts within its 3-hour refresh window. `prompt-builder.js` gets one new section. `llm-interface.js` gets a prompt-only tweak to the annoyance examples.

**Tech Stack:** Plain JS, reuses the existing `BrainRouter.generate()` call pattern already used by `analyze()`.

---

## Deviations from the design spec (`docs/superpowers/specs/2026-08-04-inner-state-design.md`)

Two corrections made while translating the design into exact code, noted here since they weren't re-confirmed with the user before implementation:

1. **Fingerprints and threads are NOT persisted** (spec said "same save blob" for all three). Persisting them added save/load/migration surface for data that's only useful within a live session — an 8-turn thread expiry or a 5-response fingerprint window has already gone stale by the time you'd restart the app. Only `soloThought` is persisted, since its 3-hour refresh window is meant to span restarts.
2. **The annoyance grounding does NOT use `inputRhythm`** (spec's item 4 named it as the data hook). `inputRhythm` in `presence.js` measures *typing speed* (fast/slow keystrokes), not reply *terseness* — using it to detect "flat one-word replies" would be wrong. Instead, Task 4 below adds a small, correct terseness check (word count of the last user message) as the grounded signal.

---

## Important context for the engineer

- Repo root: `C:\Users\Lokesh\Desktop\Pojects\Waifu`. No automated test suite — verification is manual via console logs during a live `npm start` session.
- `MemoryManager` constructor is at `src/memory/memory-manager.js:126-147`. Existing state fields (`this.mood`, `this.bond`, `this.diary`) are the pattern to follow for the new fields.
- `addInteraction(userMessage, assistantResponse)` at `src/memory/memory-manager.js:455-474` is called from 4 sites in `src/renderer.js` (lines 536, 641, 709, 797), always immediately followed by `memoryManager.recordInteractionSentiment(responseObj.emotionArc)`. `responseObj` at each of those 4 call sites has a `.emotionArc` array (same shape BrainRouter always returns — `{ label, intensity, at }[]`).
- `analyze()` at `src/memory/memory-manager.js:544-670` is the periodic (every 2 turns) LLM extraction call using `MEMORY_ANALYZER_PROMPT` (defined at lines 66-92). It already does brace-counting JSON extraction from the raw LLM response — the existing `result` object parsed at line 599 is where the new `open_thread` field will be read from.
- `getContext()` at `src/memory/memory-manager.js:492-505` returns the object `prompt-builder.js`'s `buildSystemPrompt()` consumes as its first argument (`memoryContext`). New fields (`threads`, `soloThought`, `fingerprintWarning`) get added here.
- `prompt-builder.js`'s `buildSystemPrompt()` (`src/memory/prompt-builder.js:42-125`) is where the new `[On your mind]` section is injected — follow the exact pattern of the existing `[Your current mood]` block at lines 65-68.
- `_save()` (`src/memory/memory-manager.js:428-446`) and `_load()` (`src/memory/memory-manager.js:182-220`) are the single persistence pair — `soloThought` gets added to both, following exactly how `this.diary` is handled in each (optional field, `Array.isArray`/type-check guard on load).
- `BrainRouter.generate(prompt, options)` is the call signature used by `analyze()` at line 572 (`{ systemInstruction, raw: true, jsonMode: true }`) — the solo-thought call in Task 3 reuses this same signature.

---

### Task 1: Response fingerprints (anti-repetition)

**Files:**
- Modify: `src/memory/memory-manager.js`
- Modify: `src/renderer.js`

- [ ] **Step 1: Add fingerprint state to the constructor**

In `src/memory/memory-manager.js`, in the constructor (after the existing `this.diary = [];` at line 143), add:

```js
        // Rolling anti-repetition fingerprints (session-scoped, not persisted —
        // staleness past a session makes them useless anyway)
        this.responseFingerprints = []; // [{ opener, lengthBucket, emotionLabel }]
```

- [ ] **Step 2: Add the fingerprint-recording method**

Add this new method to `MemoryManager`, right after `addInteraction()` (which ends at line 474, just before `getEffectiveConfidence()` at line 479):

```js
    /**
     * Record a lightweight signature of the response just given, for
     * anti-repetition prompting. Keeps the last 5.
     * @param {string} assistantResponse
     * @param {Array} emotionArc
     */
    _recordFingerprint(assistantResponse, emotionArc) {
        if (!assistantResponse) return;

        const words = assistantResponse.trim().split(/\s+/);
        const opener = words.slice(0, 4).join(' ').toLowerCase();
        const lengthBucket = words.length < 15 ? 'short' : words.length < 40 ? 'medium' : 'long';
        const emotionLabel = Array.isArray(emotionArc) && emotionArc.length > 0
            ? emotionArc[0].label
            : null;

        this.responseFingerprints.push({ opener, lengthBucket, emotionLabel });
        if (this.responseFingerprints.length > 5) {
            this.responseFingerprints.shift();
        }
    }

    /**
     * Returns a prompt-ready warning listing recent openers to avoid, or
     * null if there's not enough history yet to bother.
     * @returns {string|null}
     */
    getFingerprintWarning() {
        if (this.responseFingerprints.length < 2) return null;
        const openers = this.responseFingerprints.map(f => `"${f.opener}"`).join(', ');
        return `Avoid opening like: ${openers}`;
    }
```

- [ ] **Step 3: Call `_recordFingerprint` from `addInteraction`**

Change `addInteraction`'s signature and body. Find (`src/memory/memory-manager.js:455-459`):

```js
    addInteraction(userMessage, assistantResponse) {
        // Instant name extraction — no waiting for LLM
        if (userMessage && userMessage !== '[quiet]' && userMessage !== '[camera glance]' && userMessage !== '[app opened]') {
            this._quickExtractName(userMessage);
        }
```

Replace with:

```js
    addInteraction(userMessage, assistantResponse, emotionArc = null) {
        // Instant name extraction — no waiting for LLM
        if (userMessage && userMessage !== '[quiet]' && userMessage !== '[camera glance]' && userMessage !== '[app opened]') {
            this._quickExtractName(userMessage);
        }

        this._recordFingerprint(assistantResponse, emotionArc);
```

- [ ] **Step 4: Pass `emotionArc` at all 4 call sites in `renderer.js`**

In `src/renderer.js`, update each of the 4 `addInteraction` calls to pass the third argument:

Line 536: `memoryManager.addInteraction(query, responseObj.text);` →
```js
        memoryManager.addInteraction(query, responseObj.text, responseObj.emotionArc);
```

Line 641: `memoryManager.addInteraction('[quiet]', responseObj.text);` →
```js
        memoryManager.addInteraction('[quiet]', responseObj.text, responseObj.emotionArc);
```

Line 709: `memoryManager.addInteraction('[camera glance]', responseObj.text);` →
```js
        memoryManager.addInteraction('[camera glance]', responseObj.text, responseObj.emotionArc);
```

Line 797: `memoryManager.addInteraction('[app opened]', responseObj.text);` →
```js
        memoryManager.addInteraction('[app opened]', responseObj.text, responseObj.emotionArc);
```

- [ ] **Step 5: Verify syntax**

```bash
node --check src/memory/memory-manager.js && node --check src/renderer.js && echo OK
```

Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add src/memory/memory-manager.js src/renderer.js
git commit -m "feat: track response fingerprints for anti-repetition prompting"
```

---

### Task 2: Conversation threads

**Files:**
- Modify: `src/memory/memory-manager.js`

- [ ] **Step 1: Add thread state and a turn counter to the constructor**

In the constructor, right after the fingerprint field added in Task 1, add:

```js
        // Rolling conversation threads — things worth coming back to (session-scoped)
        this.threads = []; // [{ text, createdAtTurn }]
        this.globalTurnCount = 0; // monotonic, unlike this.turnCount which resets every AUTO_ANALYZE_INTERVAL
```

- [ ] **Step 2: Increment `globalTurnCount` in `addInteraction`**

In `addInteraction` (now starting around line 455 after Task 1's edit), find:

```js
        this.turnCount++;

        if (this.turnCount >= AUTO_ANALYZE_INTERVAL) {
```

Replace with:

```js
        this.turnCount++;
        this.globalTurnCount++;

        if (this.turnCount >= AUTO_ANALYZE_INTERVAL) {
```

- [ ] **Step 3: Extend `MEMORY_ANALYZER_PROMPT`'s schema**

In `src/memory/memory-manager.js`, find the `MEMORY_ANALYZER_PROMPT` constant (lines 66-92). Change this line:

```
Extract facts from the conversation and return this exact structure:
{"facts":[{"content":"fact text","category":"identity|preferences|constraints|projects","reinforces":null,"contradicts":null}],"session_summary":"one sentence"}
```

to:

```
Extract facts from the conversation and return this exact structure:
{"facts":[{"content":"fact text","category":"identity|preferences|constraints|projects","reinforces":null,"contradicts":null}],"session_summary":"one sentence","open_thread":"short phrase or null"}
```

Then add a new rule to the `Rules:` list (right after the `- session_summary:` line):

```
- open_thread: something they just mentioned that's worth coming back to later in conversation — a hook, not a fact (e.g. "the job interview they're nervous about", "the game they said they'd try"). null if nothing stands out.
```

- [ ] **Step 4: Parse `open_thread` in `analyze()`**

In `analyze()` (`src/memory/memory-manager.js:544-670`), find the block that handles `result.session_summary` (starts around line 648):

```js
            if (result.session_summary) {
                // Archive the outgoing summary before replacing it
                if (this.sessionSummary) {
```

Right before that `if (result.session_summary) {` line, add:

```js
            if (result.open_thread && typeof result.open_thread === 'string') {
                this.threads.push({ text: result.open_thread, createdAtTurn: this.globalTurnCount });
                if (this.threads.length > 3) this.threads.shift();
                console.log('[Memory] New thread:', result.open_thread);
            }
            // Drop threads older than 8 turns regardless of whether a new one arrived
            this.threads = this.threads.filter(t => this.globalTurnCount - t.createdAtTurn <= 8);

```

- [ ] **Step 5: Expose active threads via a getter**

Add this method near `getMoodDescription()` (`src/memory/memory-manager.js:410-417`), right after it:

```js
    /**
     * Returns active conversation threads as prompt-ready text, or null.
     * @returns {string|null}
     */
    getActiveThreadsText() {
        if (this.threads.length === 0) return null;
        return this.threads.map(t => `- ${t.text}`).join('\n');
    }
```

- [ ] **Step 6: Verify syntax**

```bash
node --check src/memory/memory-manager.js && echo OK
```

Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add src/memory/memory-manager.js
git commit -m "feat: track rolling conversation threads via existing memory analysis pass"
```

---

### Task 3: Solo thoughts

**Files:**
- Modify: `src/memory/memory-manager.js`

- [ ] **Step 1: Add solo-thought state to the constructor**

Add, right after the `this.globalTurnCount = 0;` line from Task 2:

```js
        // Independent small thought of her own — refreshed at low frequency, persisted
        this.soloThought = { text: null, generatedAt: 0 };
```

- [ ] **Step 2: Restore `soloThought` in `_load()`**

In `_load()` (`src/memory/memory-manager.js:182-220`), find:

```js
                    // Restore diary
                    if (Array.isArray(startData.diary)) {
                        this.diary = startData.diary;
                    }
```

Right after that block, add:

```js

                    // Restore solo thought
                    if (startData.soloThought && typeof startData.soloThought.text !== 'undefined') {
                        this.soloThought = startData.soloThought;
                    }
```

- [ ] **Step 3: Include `soloThought` in `_save()`**

In `_save()` (`src/memory/memory-manager.js:428-446`), find:

```js
                const data = {
                    facts: this.facts,
                    sessionSummary: this.sessionSummary,
                    previousSessions: this.previousSessions,
                    mood: this.mood,
                    bond: this.bond,
                    diary: this.diary,
                    lastSeen: Date.now()
                };
```

Replace with:

```js
                const data = {
                    facts: this.facts,
                    sessionSummary: this.sessionSummary,
                    previousSessions: this.previousSessions,
                    mood: this.mood,
                    bond: this.bond,
                    diary: this.diary,
                    soloThought: this.soloThought,
                    lastSeen: Date.now()
                };
```

- [ ] **Step 4: Add the refresh method**

Add this new method after `getActiveThreadsText()` (added in Task 2, Step 5):

```js
    /**
     * Refresh her independent "solo thought" if the current one is missing or
     * older than 3 hours. Fire-and-forget — never blocks chat, never throws
     * out of the caller. Safe to call any time (e.g. once at startup).
     */
    async maybeRefreshSoloThought() {
        const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
        const isStale = !this.soloThought.text ||
            (Date.now() - this.soloThought.generatedAt) > THREE_HOURS_MS;
        if (!isStale) return;

        try {
            const hour = new Date().getHours();
            const timeBucket = hour < 5 ? 'late night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 22 ? 'evening' : 'late night';
            const recentFacts = this.facts.slice(0, 2).map(f => f.content).join('; ') || 'nothing specific';

            const prompt = `Time of day: ${timeBucket}. Your current mood: ${this.mood.label}. Some things you know about them: ${recentFacts}.

In one short first-person sentence, share one small independent thought of your own right now — an opinion, a minor gripe, or something idly on your mind. Not about them specifically, just something that's yours. Output ONLY the sentence, no quotes, no explanation.`;

            const response = await BrainRouter.generate(prompt, { raw: true });
            const text = (response || '').trim().replace(/^["']|["']$/g, '');
            if (text) {
                this.soloThought = { text, generatedAt: Date.now() };
                this._save();
                console.log('[Memory] Solo thought refreshed:', text);
            }
        } catch (e) {
            console.warn('[Memory] Solo thought refresh failed:', e.message);
            // leave previous value in place — never blocks chat
        }
    }
```

- [ ] **Step 5: Trigger the refresh once at startup**

In the constructor, find the last line, `this._load();` (line 146). Replace it with:

```js
        // Fire-and-forget — refreshes on its own schedule, never blocks startup
        this._load().then(() => this.maybeRefreshSoloThought()).catch(() => {});
```

- [ ] **Step 6: Verify syntax**

```bash
node --check src/memory/memory-manager.js && echo OK
```

Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add src/memory/memory-manager.js
git commit -m "feat: add periodic independent solo-thought generation"
```

---

### Task 4: Broaden annoyance + add a real terseness signal

**Files:**
- Modify: `src/llm/llm-interface.js`
- Modify: `src/memory/memory-manager.js`

- [ ] **Step 1: Add a terseness check to `MemoryManager`**

Add this method right after `getFingerprintWarning()` (added in Task 1, Step 2):

```js
    /**
     * True if the last user message was very short (<=3 words) — a real,
     * grounded signal for "they just brushed past something," as opposed to
     * asking the LLM to invent when she should feel annoyed.
     * @returns {boolean}
     */
    lastReplyWasTerse() {
        const lastUser = [...this.recentMessages].reverse().find(m => m.role === 'user');
        if (!lastUser || !lastUser.content) return false;
        const words = lastUser.content.trim().split(/\s+/).filter(Boolean);
        return words.length > 0 && words.length <= 3;
    }
```

- [ ] **Step 2: Broaden the annoyance section in `llm-interface.js`**

In `src/memory/llm-interface.js` — actually `src/llm/llm-interface.js` — find the `━━ When they brush you off ━━` section (lines 56-62):

```
━━ When they brush you off ━━
If you complain, tease, or put yourself out there and they respond with something flat, deflecting, or a non-answer — a bare “thank you” to “you’re ignoring me”, a shrug, a topic change — you don’t automatically soften into warmth. That’s actually annoying, and you’re allowed to be genuinely annoyed by it, not just cutely pout about it:
“...that’s it? that’s all you’ve got?”
“okay, no. you don’t get to just say ‘thank you’ and move on.”
“wow. cold. really going with that?”
“you’re impossible, you know that? actually irritating — not the cute kind.”
It doesn’t have to resolve into warmth right away. Sometimes the irritation is the whole beat — let it sit instead of rushing to soften it.
```

Replace with:

```
━━ When they brush you off ━━
If you complain, tease, or put yourself out there and they respond with something flat, deflecting, or a non-answer — a bare “thank you” to “you’re ignoring me”, a shrug, a topic change — you don’t automatically soften into warmth. That’s actually annoying, and you’re allowed to be genuinely annoyed by it, not just cutely pout about it:
“...that’s it? that’s all you’ve got?”
“okay, no. you don’t get to just say ‘thank you’ and move on.”
“wow. cold. really going with that?”
“you’re impossible, you know that? actually irritating — not the cute kind.”
It doesn’t have to resolve into warmth right away. Sometimes the irritation is the whole beat — let it sit instead of rushing to soften it.

━━ Everyday friction (not just brush-offs) ━━
You’re allowed to have small, real opinions about mundane things — not everything needs to be sweet. If they repeat the same question you just answered, contradict something they said minutes ago, ignore something you asked them, or the context notes their reply was suspiciously short after you said something real — actually react to it instead of gliding past:
“...I literally just said that.”
“wait, didn’t you just say the opposite?”
“okay you’re not even going to answer that? cool. cool cool cool.”
“that’s a very short answer for something I just put myself out there for.”
Small annoyances don’t need to escalate — a flat line and moving on is often enough. But don’t skip past it like it didn’t register.
```

- [ ] **Step 3: Surface the terseness signal in `prompt-builder.js`**

(This step's actual wiring happens in Task 5 — it's listed here only so the reader knows `lastReplyWasTerse()` has a consumer. No separate file change in this task.)

- [ ] **Step 4: Verify syntax**

```bash
node --check src/llm/llm-interface.js && node --check src/memory/memory-manager.js && echo OK
```

Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add src/llm/llm-interface.js src/memory/memory-manager.js
git commit -m "feat: broaden annoyance triggers beyond brush-off, add terseness signal"
```

---

### Task 5: Wire everything into the prompt

**Files:**
- Modify: `src/memory/memory-manager.js`
- Modify: `src/memory/prompt-builder.js`

- [ ] **Step 1: Add the new fields to `getContext()`**

In `src/memory/memory-manager.js`, find `getContext()` (lines 492-505):

```js
        return {
            facts: usableFacts,
            sessionSummary: this.sessionSummary,
            previousSessions: this.previousSessions,
            moodDescription: this.getMoodDescription(),
            bondPrompt: this.getBondPrompt(),
        };
```

Replace with:

```js
        return {
            facts: usableFacts,
            sessionSummary: this.sessionSummary,
            previousSessions: this.previousSessions,
            moodDescription: this.getMoodDescription(),
            bondPrompt: this.getBondPrompt(),
            activeThreads: this.getActiveThreadsText(),
            soloThought: this.soloThought.text,
            fingerprintWarning: this.getFingerprintWarning(),
            lastReplyWasTerse: this.lastReplyWasTerse(),
        };
```

- [ ] **Step 2: Add the `[On your mind]` section to `buildSystemPrompt()`**

In `src/memory/prompt-builder.js`, find the mood block (lines 65-68):

```js
    // ── Mood ────────────────────────────────────────────────────────────────
    if (hasMood) {
        prompt += `\n\n[Your current mood]\n${memoryContext.moodDescription}\n`;
    }
```

Right after it, add:

```js

    // ── On your mind ───────────────────────────────────────────────────────
    const hasThreads     = !!memoryContext?.activeThreads;
    const hasSoloThought = !!memoryContext?.soloThought;
    const hasFingerprint = !!memoryContext?.fingerprintWarning;
    if (hasThreads || hasSoloThought || hasFingerprint) {
        prompt += `\n\n[On your mind]\n`;
        if (hasThreads) {
            prompt += `Things you've been meaning to come back to:\n${memoryContext.activeThreads}\n`;
        }
        if (hasSoloThought) {
            prompt += `Something of your own on your mind right now: ${memoryContext.soloThought}\n`;
        }
        if (memoryContext?.lastReplyWasTerse) {
            prompt += `Their last reply was noticeably short — react to that naturally if it fits, don't just glide past it.\n`;
        }
        if (hasFingerprint) {
            prompt += `${memoryContext.fingerprintWarning}\n`;
        }
    }
```

- [ ] **Step 3: Update `hasAnyContext` gating to include the new fields**

Still in `src/memory/prompt-builder.js`, find (lines 54-55):

```js
    const hasAnyContext = hasFacts || hasSummary || hasPrevious || hasMood ||
                          recentTurns.length > 0 || hasScreen || hasCamera;
```

Replace with:

```js
    const hasAnyContext = hasFacts || hasSummary || hasPrevious || hasMood ||
                          recentTurns.length > 0 || hasScreen || hasCamera ||
                          !!memoryContext?.activeThreads || !!memoryContext?.soloThought ||
                          !!memoryContext?.fingerprintWarning;
```

(Note: this line comes before the `[On your mind]` section is appended, but the new `hasThreads`/`hasSoloThought`/`hasFingerprint` consts are declared after this line in the function — that's fine, this uses `memoryContext?.` directly rather than referencing those consts, so there's no ordering issue.)

- [ ] **Step 4: Verify syntax**

```bash
node --check src/memory/memory-manager.js && node --check src/memory/prompt-builder.js && echo OK
```

Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add src/memory/memory-manager.js src/memory/prompt-builder.js
git commit -m "feat: wire inner-state (threads, solo thought, fingerprints) into system prompt"
```

---

### Task 6: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Start the app**

```bash
npm start
```

- [ ] **Step 2: Confirm solo thought generates on startup**

Watch the console for `[Memory] Solo thought refreshed: ...` shortly after load (it's an async fire-and-forget call, so it may take a few seconds — it depends on the same LLM path as chat, so if the cloud quota is still exhausted from earlier testing this may fail silently with `[Memory] Solo thought refresh failed` — that's fine, it degrades gracefully, just note it and retest later if so).

- [ ] **Step 3: Confirm threads appear and expire**

Have a conversation where you mention something notable (a plan, a worry, an upcoming event). After the next auto-analyze cycle (every 2 turns), watch for `[Memory] New thread: ...` in the console. Continue chatting past 8 turns and confirm the thread stops showing up in later system prompts (add a temporary `console.log(memoryContext.activeThreads)` inside `buildSystemPrompt` if you want to see it directly, then remove it after confirming).

- [ ] **Step 4: Confirm fingerprint warning appears after 2+ responses**

After at least 2 exchanges, temporarily log `memoryContext.fingerprintWarning` inside `buildSystemPrompt` (or just observe behaviorally) and confirm her next few responses don't reuse the same opening words as recent ones.

- [ ] **Step 5: Confirm terseness reaction**

Have her open up about something (ask her opinion on something, let her tease you), then reply with something very short (1-3 words, e.g. "ok" or "sure"). Confirm her next response reacts to the flatness rather than gliding past it.

- [ ] **Step 6: Confirm nothing broke**

Run through a normal few-message conversation and confirm memory facts, mood, and bond still update as before (unrelated to this change, but touching `addInteraction`'s signature and `_save()`/`_load()` risked a regression — confirm `[Memory] Saved to disk` and `[Memory] Loaded ... facts` still appear correctly).

- [ ] **Step 7: Report results**

Summarize what worked and what didn't. If the cloud LLM quota is still exhausted, note which parts (solo thought, thread extraction) couldn't be fully verified live and would need a retest once quota resets — don't claim full verification without evidence.

---

## Explicitly out of scope for this plan

- Model swap (user's own track, not part of this work).
- Any change to `mood`/`bond` scoring logic — those stay exactly as they are.
- Persisting `threads` or `responseFingerprints` across restarts (see Deviations section above).
- Detecting *resolved* threads (e.g. if the user brings the topic back up themselves) — threads only expire by turn-count age, never by detected resolution. A future pass could add this if 8-turn expiry proves too short/long in practice.
