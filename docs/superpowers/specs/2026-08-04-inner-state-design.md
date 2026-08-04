# Inner State (Self-Continuity) — Design

## Goal

Give Miko a lightweight running "inner state" — recent-response fingerprints,
conversation threads worth returning to, and small independent thoughts of
her own — so she stops dodging/repeating and starts feeling like she has
continuity between messages instead of resetting each turn.

## Non-goals

- Not a full personality-prompt rewrite (rejected — risks flattening her
  voice). This only adds new *data* the existing prompt can draw on.
- Not a model swap (out of scope, user's own track).
- Not a new persistence file/IPC channel — reuses the existing
  `load-memory`/`save-memory` blob that already carries facts/mood/bond/diary.

## Architecture

All new state lives on `MemoryManager` in `src/memory/memory-manager.js`,
alongside the existing `mood`/`bond`/`diary` state — same category of "her
running internal state," same save/load blob, same file (consistent with how
mood/bond already work; no new module needed).

### 1. Response fingerprints (anti-repetition)

Pure bookkeeping, no LLM. After each assistant response:
- Extract the first 3-4 words (lowercased) as the "opener"
- Bucket length: short (<15 words) / medium (15-40) / long (40+)
- Record the first emotion label from the arc

Keep the last 5 as `this.responseFingerprints`. Exposed via
`getFingerprintWarning()` → a string like:
`Avoid opening like: "the thing is", "okay so this", "wait, you said"`
or `null` if fewer than 2 recorded (nothing to warn about yet).

### 2. Conversation threads

Extends the existing periodic fact-extraction call (`MEMORY_ANALYZER_PROMPT`,
already runs every 2 turns via `analyze()`) — add one optional field to its
JSON schema: `"open_thread": "<short phrase or null>"` — something the user
just said that's worth coming back to later (not a fact, a hook).

Stored as `this.threads: [{ text, createdAtTurn }]`, max 3, each auto-expires
once `currentTurnCount - createdAtTurn > 8`. No new LLM calls — this rides on
the existing analysis pass.

### 3. Solo thoughts

A separate, deliberately low-frequency small LLM call — NOT tied to the
regular chat/analysis cadence. Regenerated once per session start, or if the
existing one is older than 3 hours. Prompt asks for one small independent
thought given: time of day, current mood label, 1-2 recent facts (NOT full
context — keep it a tiny, cheap call). Stored as
`this.soloThought: { text, generatedAt }`. If the call fails, leave the
previous value in place (or null on first-ever run) — never blocks anything.

### 4. Broader annoyance

Prompt-only change in `llm-interface.js`'s `DEFAULT_CONFIG.systemPrompt`:
broaden the existing "brushed off" example set to cover everyday friction
(not just the one narrow "bare thank-you" case), and reference the
`inputRhythm` presence hint (already computed in `presence.js`, already
passed into `buildSystemPrompt` as part of `presenceHints` but never
surfaced as an annoyance cue) explicitly as a grounded trigger — e.g. terse
one-word replies after she opened up is real data, not invented.

### 5. Wiring into the prompt

`prompt-builder.js` gets a new `[On your mind]` section, same pattern as the
existing `[Your current mood]` block — combining active thread(s), solo
thought, and the fingerprint warning. Injected only when at least one piece
is present (mirrors the `hasAnyContext` gating already used for the rest of
the context block).

## Error handling

- Solo-thought LLM call failing never blocks chat — falls back to the
  previous value or `null`.
- Thread extraction piggybacks on the existing analyze() call, which already
  has its own failure handling (`[Memory] Analysis failed`) — a missing
  `open_thread` field is just treated as `null`, no special handling needed.
- Fingerprint tracking is synchronous/local — can't fail in a way that
  matters to the chat flow.

## Testing

No automated suite. Manual: have a multi-turn conversation, watch console
logs (`[Memory]`) for `open_thread` values appearing/expiring, confirm the
system prompt (loggable via a temporary console.log in `buildSystemPrompt`)
contains the `[On your mind]` section when expected, and confirm consecutive
responses don't reuse the same opener over a longer conversation.
