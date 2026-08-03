# Discord Chat Bridge — Design

## Goal

Let Miko take live chat from a Discord server while the user streams her (via
Discord's own screen-share/"Go Live", audio included) to that server. Viewers
type in a designated channel; Miko sees their messages as a group
conversation and responds — spoken through her existing voice pipeline (which
Discord's screen-share audio carries to viewers) and echoed as text in the
channel.

Video/audio broadcast itself needs no code — Discord's screen-share with
"Share Sound" already carries the running app's window and audio to viewers.
This project is scoped to just the chat bridge: getting viewer messages into
Miko and her replies back out.

## Non-goals (explicitly out of scope for this iteration)

- Voice input from viewers (speaking to Miko via a Discord voice channel,
  transcribed with Groq STT) — deliberately deferred to a follow-up project
  once the text bridge is proven out. Nothing in this design should make that
  harder to add later, but it isn't being built now.
- Switching the TTS engine (e.g. to Fish Speech) — out of scope; Cartethyia/
  MioTTS stays as-is. Any future TTS engine evaluation is a separate project.
- Any changes to Miko's personal memory, mood, or bond score — stream
  interactions are explicitly isolated from that (see below).

## Architecture

A new, self-contained module: `src/discord/discord-bridge.js`. It owns all
`discord.js` usage and exposes a minimal surface to the rest of the app:

- `start(token)` — logs the bot in, wires its internal event listeners.
- `stop()` — logs the bot out, clears internal state.
- `onBatchReady(callback)` — registers a callback invoked with
  `{ channelId, messages: [{ username, content }] }` whenever a batch of
  viewer messages is ready to be sent to the LLM.
- `sendResponse(channelId, text)` — posts Miko's reply text back to the given
  Discord channel.

`main.js` is the only existing file that changes, and only to wire this
module in: on app start, if a bot token is configured, call `start(token)`
and register a batch-ready handler that forwards to the renderer via a new
IPC channel (`discord-batch-ready`), and register an IPC handler
(`discord-send-response`) that the renderer calls once it has Miko's reply,
which calls `sendResponse()`. No other existing file (`renderer.js`,
`brain-router.js`, `memory-manager.js`, `prompt-builder.js`, etc.) is
modified. If `discord-bridge.js` throws or the bot disconnects, that's
isolated to this module and its IPC handlers — the core chat/avatar/TTS
pipeline is unaffected.

## Channel activation

The bridge doesn't listen anywhere until told to. In any channel the bot can
see, a user typing `!start` makes the bridge remember that channel's ID as
"active" and reply with a confirmation message. `!stop` (from the active
channel) clears it back to idle. Only one active channel at a time — a second
`!start` in a different channel replaces the previous one (with a reply
noting the switch).

## Message filtering

Applied to every message in the active channel before it's buffered:

- **Blocklist**: a small static list of terms (slurs/spam patterns) — a
  matching message is silently dropped (not queued, not acknowledged).
- **Max length**: messages over ~300 characters are dropped (prevents one
  person pasting a huge wall of text into the batch).
- **Per-user rate limit**: a given Discord user ID can contribute at most 1
  message per 3-second window; extras in that window are dropped. This
  prevents one person flooding the batch and drowning out others.

Filtering is a pure function of `(message, recentHistoryForThisUser)` inside
`discord-bridge.js` — no LLM call involved, so it's cheap and instant.

## Batching ("respond once she's free")

The bridge tracks a simple busy/free flag, toggled by the renderer via the
IPC surface (busy = from when a batch is sent to the LLM, until her spoken
response finishes playing). While busy, incoming (filtered) messages
accumulate in an in-memory array per active channel. The moment the flag
flips to free, if the array is non-empty, the whole array is flushed as one
batch via `onBatchReady()` and cleared. If the array is empty when she
becomes free, nothing happens (no empty batches sent).

## Prompt integration

The renderer's existing chat-generation code path is reused, not
reimplemented. A batch is formatted as a single "message" like:

```
[alice]: hows it going miko
[bob]: play something for us!!
[alice]: yeah do the thing
```

This is passed to the *existing* `BrainRouter.generate()`/`generateStreaming()`
exactly like a normal user message, but with two differences from a personal
chat turn:

1. **Separate conversation history**: a new, throwaway array (e.g.
   `streamRecentMessages`, living only in the renderer's memory for the
   session) is used instead of `memoryManager.recentMessages`. It's never
   passed to `memory-manager.js`'s `analyze()` — no facts, mood, or bond
   changes ever result from stream chat.
2. **A short system-prompt addendum** appended only for stream turns (not
   stored in `DEFAULT_CONFIG.systemPrompt` permanently), telling her she's
   live-streaming to multiple people at once and can address them by name —
   e.g. `"You're live-streaming right now. The message below may contain
   lines from multiple different people in your Discord chat, each tagged
   with their username — you can see and address them by name, like a
   streamer reading chat."`

Her response is parsed and handled exactly like a normal response (emotion
arc, `VoiceService.speak()`, avatar update) — no changes needed there. The
same response text is also passed back through `sendResponse()` to post in
the Discord channel as text.

## Settings & credentials

The bot token is sensitive and shouldn't go through the same path as the
existing cloud API keys (which live in renderer `localStorage` via
`settings.js`). Instead:

- Stored in a new JSON file in the Electron `userData` directory (same
  pattern as `memory.json` in `main.js`), e.g. `discord-config.json`:
  `{ "token": "...", "enabled": true }`.
- A new IPC handler in `main.js` (`save-discord-config` /
  `get-discord-config`), following the existing `save-memory` pattern.
- New Settings UI section in `index.html`: "Discord Streaming" — a password-
  type token input, an enable/disable toggle, and a read-only status line
  showing "not connected" / "connected — listening in #channel-name" /
  "connected — idle, waiting for !start", updated via a status IPC push.

## Error handling

- Missing/invalid token: `start()` logs an error and does nothing further;
  rest of the app is unaffected.
- Discord disconnects mid-session: `discord.js`'s own client reconnection
  handles this; `discord-bridge.js` doesn't need custom reconnect logic.
- A batch fails to produce a response (LLM error, TTS error): logged and
  skipped — the busy flag still clears so the bridge doesn't get stuck, and
  the failed batch's messages are simply dropped (not retried).

## Testing

No automated test suite exists in this project (Electron app, `package.json`
only has `start`/`build` scripts) — verification is manual: run the app with
a configured bot token, add the bot to a test server, `!start` in a channel,
send messages from 2+ Discord accounts while Miko is mid-response to confirm
batching works, confirm the group-chat format reaches the LLM correctly,
confirm `!stop` halts the bridge, and confirm personal `memory.json` /
mood/bond are unaffected after a stream session.
