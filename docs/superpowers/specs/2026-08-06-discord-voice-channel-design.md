# Discord Voice Channel Audio — Design

## Goal

When Discord chat is active, Miko's voice plays into the Discord voice channel (for everyone listening) instead of only locally on the host machine. Also fix the text/audio desync — right now the text reply posts to Discord immediately, then audio starts noticeably later, because `discord-renderer.js` sends the text before synthesis has even started.

## Non-goals

- **Avatar video streaming to Discord is explicitly out of scope and will not be built.** Researched directly: Discord blocks video from real bot accounts entirely — every working implementation found requires a "selfbot" (automating a real user account instead of a bot token), which violates Discord's Terms of Service and risks a permanent account ban. Not worth that risk for this feature.
- Not building incremental/streaming TTS in this pass (playing audio in chunks as it generates). Deferred — the sync-ordering fix alone should resolve most of the perceived lag, since GPT-SoVITS synthesis is already a few seconds, not tens of seconds. Revisit only if this pass doesn't feel fast enough in practice.
- Normal 1:1 chat with you (not Discord-triggered) keeps playing locally exactly as it does today — unaffected by this change.

## Architecture

**Voice channel join/leave**: `!start` (already the command that activates text listening in a channel) also joins the voice channel the invoking user is currently in, if any — checked via `message.member.voice.channel`. `!stop` (already deactivates text listening) also disconnects from voice. Requires adding the `GuildVoiceStates` gateway intent (not currently requested) so `message.member.voice` is populated.

**New dependencies**: `@discordjs/voice` (the official voice-connection library) plus `opusscript` as the Opus encoder — deliberately the **pure-JS** encoder, not the native `@discordjs/opus`, since the native option needs a C++ build toolchain (MSVC/node-gyp) and this project specifically uninstalled Visual Studio Build Tools earlier this session to reclaim disk space. `@discordjs/voice` transcodes WAV → Opus via `prism-media`, which shells out to `ffmpeg` — already installed and on `PATH` on this machine (confirmed working, used earlier this session for audio format conversion).

**Audio routing for Discord-triggered turns**: Currently, `discord-renderer.js`'s `handleBatch()` calls `VoiceService.speak()`, which does IPC to the main process for synthesis, gets base64 WAV back, and plays it locally via HTML5 `<audio>`. For Discord-active turns, that local-playback step is skipped — instead, the synthesized base64 audio is sent to the main process over a new IPC channel, decoded to a `Buffer`, wrapped in a readable stream, and played into the joined voice connection via `@discordjs/voice`'s `createAudioResource` + `AudioPlayer`. All new discord.js/voice-connection logic stays inside `discord-bridge.js`, matching the project's existing isolation rule (`CLAUDE.md`: "Don't put Discord logic in existing files — it stays isolated in `src/discord/`").

**Text/audio sync fix**: `handleBatch()` currently sends the text reply (`window.electronAPI.sendDiscordResponse(...)`) immediately after the LLM response resolves, then separately kicks off `VoiceService.speak()`. Reordered so synthesis is requested first (or concurrently) and the text is sent right as playback actually starts — using the same "wait for audio to actually begin" signal the emotion-arc system already relies on (`VoiceService`'s existing `onAudioStart`-style callback, already used elsewhere in the codebase) rather than a fixed delay guess.

## Error handling

- If the invoking user isn't in a voice channel when running `!start`, text-only mode continues exactly as it does today — no error, just no voice join.
- If joining voice fails (permissions, disconnected mid-session), Discord text replies keep working; voice failures are logged, never block a text response.
- If audio synthesis fails, same existing fallback behavior applies (MioTTS → SAPI5 cascade in `tts_server.py` is unaffected by this change) — Discord voice just plays whatever audio comes back from that existing pipeline.

## Testing

No automated suite. Manual: join a voice channel yourself, run `!start` in a text channel, confirm the bot joins your voice channel and confirm `!stop` disconnects it. Send a message, confirm the text reply and the start of audio playback happen together rather than text-then-long-pause-then-audio. Test the no-voice-channel case (run `!start` while not in any VC) and confirm text-only mode still works normally.
