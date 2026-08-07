# Discord User Recognition — Design

## Goal

Miko recognizes individual Discord users across visits — new people get a genuine "meeting you for the first time" introduction (she may naturally ask their name), returning people get progressively warmer/more relaxed treatment as a lightweight familiarity tier builds up, and her replies visibly highlight/quote whichever message they're responding to instead of floating as an untargeted channel post.

## Non-goals

- Not touching `memoryManager`'s bond system — this is a fully separate, Discord-only per-user store, per the project's existing isolation rule.
- Not building active memory *of what people said* (facts/preferences per Discord user) — only recognition (who they are, how many times seen, their tier, and their self-reported name if they've given it). Full per-user fact memory would be a much bigger feature; this stays scoped to recognition + tone calibration.
- Not doing LLM-based name extraction — reuses a cheap, deterministic regex approach (mirroring `memory-manager.js`'s existing `NAME_PATTERNS`), no extra API call per message.

## Architecture

**New file: `src/discord/discord-user-memory.js`** (main process, CommonJS, matching `discord-bridge.js`'s module style). Persisted JSON store at `app.getPath('userData')/discord-user-memory.json`, keyed by Discord user ID:

```js
{ userId, displayName, knownName, messageCount, firstSeenAt, lastSeenAt }
```

Tiers derived from `messageCount`: **new** (this is literally their first-ever message) → **acquaintance** (2-10 messages) → **regular** (11+). Exposes `recordMessage(userId, displayName, content)` (increments count, updates timestamps, attempts name extraction from `content`) and `getTierInfo(userId)`.

**Wiring into `discord-bridge.js`**: `messageCreate`'s buffering step now also calls `recordMessage()` for every buffered message, and each buffered item carries `{ username, userId, content }` instead of just `{ username, content }`. The Discord `Message` object of the *last* message in each flushed batch is tracked so its ID can be threaded through as a reply target.

**Wiring into `discord-renderer.js`**: `formatBatchAsPrompt()` now prefixes each line with tier/name context, e.g. `[Tranzue, regular, you know them well]: ...` or `[xX_shadow_Xx, brand new, never talked before]: ...`, giving the LLM real per-person context to calibrate tone with — same mechanism as the existing username tagging, just richer. A dedicated instruction is added to the stream addendum explaining how to read and use these tags (introduce yourself to brand-new people, be relaxed/familiar with regulars).

**Reply-with-highlight**: `sendResponse()` gains an optional `replyToMessageId` parameter — when present, the embed is sent with Discord's native reply/quote feature (`{ reply: { messageReference: replyToMessageId } }`), visibly anchoring the response to the last message in that batch. No message fetch needed — discord.js accepts a bare message ID for this.

## Error handling

- If the persisted user-memory file is missing/corrupt on load, start fresh (same pattern as `loadDiscordConfig()`'s try/catch-and-default).
- If `recordMessage()` throws for any reason, the message still gets buffered/answered normally — recognition is a tone-calibration enhancer, never a blocker for chat working.
- If the reply-target message was deleted before the response sends, discord.js's reply-with-missing-reference behavior degrades gracefully (posts as a normal message) — no special handling needed.

## Testing

No automated suite. Manual: have a fresh (never-messaged) Discord account send a message in the active channel, confirm the response treats them as brand-new (introduces herself / notices they're new) and visibly quotes that message. Have that same account send several more messages over time (or manually bump the count for testing) and confirm the tone shifts warmer as they cross into "acquaintance" then "regular." Confirm a two-person batch (one new, one regular) produces a response that calibrates differently toward each named person in the same reply.
