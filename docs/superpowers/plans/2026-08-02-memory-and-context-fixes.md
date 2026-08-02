# Memory & Conversation Context Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two confirmed bugs causing Miko's responses to feel disconnected/robotic and her long-term memory to fill with garbage: (1) the cloud LLM adapters (Gemini, OpenRouter) silently drop conversation history on every request, and (2) the memory-extraction pipeline has no guard against storing raw dialogue quotes as if they were facts.

**Architecture:** No new files or subsystems — this is a targeted fix to existing adapters and the memory analyzer, following the pattern already working correctly in `ollama-adapter.js` and `lmstudio-adapter.js`. Conversation history flows through unchanged (`memoryManager.recentMessages` → `options.conversationHistory` → adapter) — only `cloud-adapter.js` and `openrouter-adapter.js` need to actually consume it. The memory-extraction prompt gets negative few-shot examples, and `memory-manager.js` gets a small validation guard applied before any newly extracted fact is stored.

**Tech Stack:** Plain JavaScript (ES modules), Gemini REST API, OpenRouter (OpenAI-compatible) REST API. No new dependencies.

---

## Important context for the engineer

- Repo root: `C:\Users\Lokesh\Desktop\Pojects\Waifu`
- This is an Electron app with no automated test suite (`package.json` only has `start`/`build` scripts). Verification in this plan is manual: run `npm start`, check console logs, and confirm behavior in the actual running app.
- **Root cause 1** (confirmed by reading the code, not guessed): `src/llm/ollama-adapter.js` and `src/llm/lmstudio-adapter.js` both do this correctly:
  ```js
  const history = Array.isArray(options.conversationHistory) ? options.conversationHistory : [];
  // ... messages: [{role:'system',...}, ...history.map(...), {role:'user', content: prompt}]
  ```
  `src/llm/cloud-adapter.js` (Gemini) and `src/llm/openrouter-adapter.js` do not — they build a request with only the system prompt and the single current message, silently ignoring `options.conversationHistory` entirely. Since the app's default mode is `cloud_preferred` with Gemini active, this means production conversations currently have **zero memory of the previous turn** on every single request. This is the primary cause of "robotic," "bland," "doesn't use context," and non-sequitur replies like responding to "thank you" with "not that I expect anything less."
- **Root cause 2**: `src/memory/memory-manager.js`'s `analyze()` method accepts any non-empty `newFact.content` string from the LLM's extraction response and stores it as a fact, with zero validation. The extraction prompt asks the model to "Ignore greetings, filler, and small talk" but the model doesn't reliably comply, resulting in garbage facts like `"Hello there"` and `"no you're not"` being stored as if they were real facts about the user (confirmed by reading `C:\Users\Lokesh\AppData\Roaming\waifu-assistant\memory.json`).
- `memoryManager.recentMessages` is an array of `{role: 'user'|'assistant', content: string}` (see `src/memory/memory-manager.js:438-439`). This is already the correct shape both adapters need.
- Gemini's API does **not** use `role: 'assistant'` — it uses `role: 'model'`. This mapping must happen in `cloud-adapter.js`; don't just copy the array as-is.
- Do not touch `ollama-adapter.js` or `lmstudio-adapter.js` — they're already correct and are the reference pattern for this fix.
- Length-based fact rejection was explicitly ruled out by the user ("too short are okay") — the validation guard in this plan only rejects facts that are verbatim/near-verbatim quotes from the conversation, not short facts in general.

---

### Task 1: Fix conversation history in `openrouter-adapter.js`

**Files:**
- Modify: `src/llm/openrouter-adapter.js`

- [ ] **Step 1: Read the current `generate()` method**

Current content at `src/llm/openrouter-adapter.js:22-100` includes this request body (lines 49-64):

```js
                body: JSON.stringify({
                    model: modelId,
                    messages: [
                        {
                            role: 'system',
                            content: systemPrompt
                        },
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    temperature: DEFAULT_CONFIG.temperature,
                    max_tokens: DEFAULT_CONFIG.maxTokens,
                    top_p: 0.95
                })
```

- [ ] **Step 2: Add history extraction and thread it into the messages array**

In `src/llm/openrouter-adapter.js`, find this block (around line 30):

```js
        const systemPrompt = options.systemInstruction || DEFAULT_CONFIG.systemPrompt;
        const modelId = options.modelId || getOpenRouterModel();
```

Replace with:

```js
        const systemPrompt = options.systemInstruction || DEFAULT_CONFIG.systemPrompt;
        const modelId = options.modelId || getOpenRouterModel();
        const history = Array.isArray(options.conversationHistory) ? options.conversationHistory : [];
```

Then find the `messages` array (lines 51-60):

```js
                    messages: [
                        {
                            role: 'system',
                            content: systemPrompt
                        },
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
```

Replace with:

```js
                    messages: [
                        { role: 'system', content: systemPrompt },
                        ...history.map(m => ({ role: m.role, content: m.content })),
                        { role: 'user',   content: prompt }
                    ],
```

- [ ] **Step 3: Verify syntax**

```bash
node --check src/llm/openrouter-adapter.js
```

Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add src/llm/openrouter-adapter.js
git commit -m "fix: thread conversation history into OpenRouter requests"
```

---

### Task 2: Fix conversation history in `cloud-adapter.js` (Gemini)

**Files:**
- Modify: `src/llm/cloud-adapter.js`

Gemini's API is stricter about shape than OpenAI-compatible APIs: history must be `contents: [{role, parts:[{text}]}]` with role `"model"` for assistant turns (not `"assistant"`), and the Gemma-3 branch has no `systemInstruction` field so history has to be merged into the first turn's text instead.

- [ ] **Step 1: Add a history-to-Gemini-contents mapping helper**

In `src/llm/cloud-adapter.js`, after the imports (after line 7, before `function buildRequestBody`), add:

```js
/**
 * Map memoryManager.recentMessages ({role:'user'|'assistant', content}) to
 * Gemini's contents format ({role:'user'|'model', parts:[{text}]}).
 * Gemini uses "model" for assistant turns, not "assistant".
 */
function mapHistoryToGeminiContents(history) {
    return history.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
    }));
}
```

- [ ] **Step 2: Update `buildRequestBody` to accept and use history**

Current `buildRequestBody` (lines 14-43):

```js
function buildRequestBody(systemPrompt, userText, extraConfig = {}, jsonMode = false) {
    const model = getGeminiModel();
    const isGemma3 = /^gemma-3/i.test(model);
    const generationConfig = {
        maxOutputTokens: DEFAULT_CONFIG.maxTokens,
        temperature: DEFAULT_CONFIG.temperature,
        ...extraConfig
    };
    // JSON mode: Gemini returns pure JSON, no reasoning prose
    if (jsonMode && !isGemma3) {
        generationConfig.responseMimeType = 'application/json';
    }

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
```

Replace the entire function with:

```js
function buildRequestBody(systemPrompt, userText, history = [], extraConfig = {}, jsonMode = false) {
    const model = getGeminiModel();
    const isGemma3 = /^gemma-3/i.test(model);
    const generationConfig = {
        maxOutputTokens: DEFAULT_CONFIG.maxTokens,
        temperature: DEFAULT_CONFIG.temperature,
        ...extraConfig
    };
    // JSON mode: Gemini returns pure JSON, no reasoning prose
    if (jsonMode && !isGemma3) {
        generationConfig.responseMimeType = 'application/json';
    }

    const historyContents = mapHistoryToGeminiContents(history);

    if (isGemma3) {
        // Gemma 3 only: no systemInstruction field — prepend system prompt to the
        // first turn instead (either the first history message, or the current
        // user turn if there's no history yet).
        if (historyContents.length > 0) {
            const contents = historyContents.map((c, i) => {
                if (i === 0 && c.role === 'user') {
                    return { role: 'user', parts: [{ text: `${systemPrompt}\n\n${c.parts[0].text}` }] };
                }
                return c;
            });
            contents.push({ role: 'user', parts: [{ text: MODEL_HARDENING_PREFIX + userText }] });
            return { contents, generationConfig };
        }
        return {
            contents: [{
                role: 'user',
                parts: [{ text: `${systemPrompt}\n\n${MODEL_HARDENING_PREFIX}${userText}` }]
            }],
            generationConfig
        };
    }

    // Gemini + Gemma 4+: proper system instruction field, full conversation history
    return {
        contents: [
            ...historyContents,
            { role: 'user', parts: [{ text: MODEL_HARDENING_PREFIX + userText }] }
        ],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig
    };
}
```

- [ ] **Step 3: Update the `generate()` call site**

Find this line in `generate()` (around line 88):

```js
                body: JSON.stringify(buildRequestBody(systemPrompt, prompt, {}, !!options.jsonMode))
```

Replace with:

```js
                body: JSON.stringify(buildRequestBody(
                    systemPrompt,
                    prompt,
                    Array.isArray(options.conversationHistory) ? options.conversationHistory : [],
                    {},
                    !!options.jsonMode
                ))
```

- [ ] **Step 4: Update the `stream()` call site**

Find this line in `stream()` (around line 156):

```js
                body: JSON.stringify(buildRequestBody(systemPrompt, prompt))
```

Replace with:

```js
                body: JSON.stringify(buildRequestBody(
                    systemPrompt,
                    prompt,
                    Array.isArray(options.conversationHistory) ? options.conversationHistory : []
                ))
```

- [ ] **Step 5: Verify syntax**

```bash
node --check src/llm/cloud-adapter.js
```

Expected: no output (success).

- [ ] **Step 6: Commit**

```bash
git add src/llm/cloud-adapter.js
git commit -m "fix: thread conversation history into Gemini requests"
```

---

### Task 3: Tighten the memory-extraction prompt with negative examples

**Files:**
- Modify: `src/memory/memory-manager.js`

- [ ] **Step 1: Replace `MEMORY_ANALYZER_PROMPT`**

Current content at `src/memory/memory-manager.js:66-81`:

```js
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

Output the JSON object directly. Nothing before it. Nothing after it.`;
```

Replace with:

```js
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
```

- [ ] **Step 2: Verify syntax**

```bash
node --check src/memory/memory-manager.js
```

Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add src/memory/memory-manager.js
git commit -m "fix: add negative examples to memory extraction prompt"
```

---

### Task 4: Add a validation guard against raw-dialogue facts

**Files:**
- Modify: `src/memory/memory-manager.js`

- [ ] **Step 1: Add the guard method to the `MemoryManager` class**

Find the `textSimilarity` helper function (`src/memory/memory-manager.js:90-101`, just before `class MemoryManager {`):

```js
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
```

After this function (still before `class MemoryManager {`), add:

```js
/**
 * True if `content` appears verbatim (ignoring case/punctuation) inside
 * `conversationText` — i.e. the model echoed back a line of dialogue
 * instead of extracting an actual fact about the user.
 */
function looksLikeRawDialogue(content, conversationText) {
    const normalize = (s) => s.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const normalizedContent = normalize(content);
    if (!normalizedContent) return true;
    return normalize(conversationText).includes(normalizedContent);
}
```

- [ ] **Step 2: Apply the guard in `analyze()`**

Find this block in `analyze()` (`src/memory/memory-manager.js:585-618`):

```js
            if (result.facts && Array.isArray(result.facts)) {
                for (const newFact of result.facts) {
                    if (!newFact.content) continue;

                    if (newFact.reinforces) {
```

Replace with:

```js
            if (result.facts && Array.isArray(result.facts)) {
                for (const newFact of result.facts) {
                    if (!newFact.content) continue;

                    if (looksLikeRawDialogue(newFact.content, conversationText)) {
                        console.log('[Memory] Rejected fact (looks like raw dialogue):', newFact.content);
                        continue;
                    }

                    if (newFact.reinforces) {
```

(`conversationText` is already in scope in `analyze()` — it's defined at line 528-530, built from `this.recentMessages` before the analysis prompt is constructed. No new variable needed.)

- [ ] **Step 3: Verify syntax**

```bash
node --check src/memory/memory-manager.js
```

Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add src/memory/memory-manager.js
git commit -m "fix: reject raw-dialogue quotes from being stored as facts"
```

---

### Task 5: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Confirm current model mode uses the fixed cloud path**

```bash
grep -n "getModelMode\|CLOUD_PREFERRED" src/settings.js | head -5
```

Confirm the app is set to `cloud_preferred` or `cloud_only` mode (matches the mode seen in this session's console logs: `[Brain] Mode: cloud_preferred`). If it's `local_only`, the fix in Task 1/2 won't be exercised by manual testing — ask the user to temporarily switch to cloud mode in Settings for this verification, then switch back after.

- [ ] **Step 2: Start the app**

```bash
npm start
```

- [ ] **Step 3: Have a multi-turn conversation that requires context**

In the running app, send at least 3 messages in a row where each reply should logically depend on the previous one — e.g.:
1. Say something Miko should react to (e.g. "I got a new job today")
2. Reply with something short and ambiguous on its own (e.g. "thanks")
3. Ask her to reference what you just told her (e.g. "what did I just tell you?")

Confirm her reply in step 3 correctly references the job news from step 1 — this proves conversation history is actually reaching the model now.

- [ ] **Step 4: Check the browser DevTools console (if accessible) or terminal logs**

Look for `[Cloud] Sending request to Gemini...` log lines. There's no direct log of the full request body currently, so this step is about behavioral confirmation (Step 3), not a log-based check.

- [ ] **Step 5: Trigger a memory-analysis pass and check for garbage facts**

Memory analysis runs automatically every 2 turns (`AUTO_ANALYZE_INTERVAL = 2` in `memory-manager.js`). After the conversation in Step 3, check:

```powershell
Get-Content "$env:APPDATA\waifu-assistant\memory.json" | Select-String '"content"'
```

Confirm no new facts look like raw dialogue/quotes (e.g. nothing resembling `"thanks"`, `"no you're not"`, or short greetings stored as facts). If a bad fact was already in memory.json from before this fix, that's expected — old bad facts aren't retroactively cleaned up by this plan, only new ones are prevented.

- [ ] **Step 6: Report results**

Summarize whether conversation context is now working (Step 3) and whether new fact extraction looks clean (Step 5). If either fails, stop and report exactly what was observed rather than guessing at further fixes.

---

## Explicitly out of scope for this plan

- Retroactively cleaning up existing garbage facts already stored in `memory.json` (e.g. `"User's name is asking"`, `"Hello there"`) — this plan only prevents new ones going forward. Cleaning existing bad facts would need a separate, deliberate decision about which facts to keep/discard.
- Length-based fact rejection — explicitly ruled out by the user.
- Any changes to `ollama-adapter.js` or `lmstudio-adapter.js` — already correct.
- Any changes to temperature/maxTokens or other generation parameters — confirmed not the cause of the reported issues (temperature 0.88, maxTokens 2048 are both reasonable).
- Fixing the chain-of-thought leakage in Gemini's memory-extraction responses (the existing brace-counting JSON extractor already recovers the correct JSON from it — noisy but not broken).
