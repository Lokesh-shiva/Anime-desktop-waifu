# Discord Voice Channel Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `!start` joins the caller's voice channel and Miko's Discord-triggered responses play there instead of locally; text and audio start together instead of text arriving first.

**Architecture:** `discord-bridge.js` gains voice-connection logic using `@discordjs/voice` (pure-JS Opus/encryption libs — `opusscript` + `tweetnacl` — to avoid needing a native build toolchain, since this machine doesn't have MSVC Build Tools installed). `discord-renderer.js`'s `handleBatch()` bypasses `VoiceService`'s local-playback path for Discord turns, instead sending synthesized audio to the main process over a new IPC channel that doesn't resolve until playback finishes — giving natural sequencing (text sent right as playback starts) without polling.

**Tech Stack:** `@discordjs/voice`, `opusscript`, `tweetnacl` (new deps), Node's `stream.Readable`, existing IPC/preload pattern.

---

## Important context for the engineer

- Repo root: `C:\Users\Lokesh\Desktop\Pojects\Waifu`. No automated test suite — verification is manual, requires an actual Discord server/bot token and joining a real voice channel to fully test.
- `@discordjs/voice` needs a runtime Opus encoder and an encryption library, loaded via optional `require()` checks (not hard npm peer deps) — install `opusscript` (pure-JS Opus, no native compile) and `tweetnacl` (pure-JS encryption) specifically to avoid needing Visual Studio Build Tools, which this project uninstalled earlier this session to reclaim disk space (see git history / `tts/FISH_SPEECH_EVALUATION.md` for that context). Do NOT install `@discordjs/opus` or `sodium-native` — both require native compilation.
- `tts_server.py`'s `/synthesize` response never includes a `mimeType` field — `audio-player.js:39`'s `play(b64Audio, mimeType = 'audio/wav')` defaults to `'audio/wav'` when it's absent, confirming every engine's output (SAPI5, MioTTS, GPT-SoVITS) is WAV bytes by the time it reaches the renderer. This matters because the Discord voice pipeline needs to know the input format for `@discordjs/voice`'s transcoding.
- `discord-bridge.js` currently requests intents `[Guilds, GuildMessages, MessageContent]` (line ~92) — needs `GuildVoiceStates` added so `message.member.voice.channel` is populated (without it, `member.voice` is always undefined).
- `discord-bridge.js`'s `!start` handler is at lines 107-116, `!stop` at lines 118-128 (current file, before this plan's edits) — both need extending for voice join/leave.
- `discord-renderer.js`'s `handleBatch()` (lines 52-97) currently: awaits the LLM response, pushes history, sends text via `window.electronAPI.sendDiscordResponse(...)` (line 78), plays the emotion arc, then calls `VoiceService.speak()` + `waitUntilDonePlaying()` (lines 90-91) for **local** playback. This plan changes the audio path only — LLM call, history, and emotion-arc playback stay as-is.
- `preload.js`'s `electronAPI` surface is built via `contextBridge.exposeInMainWorld` starting at line 3; existing Discord-related bridges are at lines 43-48 (`getDiscordConfig`, `saveDiscordConfig`, `onDiscordBatchReady`, `sendDiscordResponse`, `discordMarkFree`, `getDiscordStatus`) — the new bridge follows the same `ipcRenderer.invoke(...)` pattern.
- `main.js`'s existing Discord IPC handlers are at lines 543-553 (`discord-send-response`, `discord-mark-free`, `discord-get-status`) — the new handler goes here, following the identical `ipcMain.handle(...)` pattern, delegating to a new `discordBridge` function.
- `package.json`'s `dependencies` block currently lists `discord.js`, `pixi-live2d-display`, `pixi.js` (alphabetical) — new deps get added there.

---

### Task 1: Install voice dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the packages**

```bash
cd "C:\Users\Lokesh\Desktop\Pojects\Waifu"
npm install @discordjs/voice opusscript tweetnacl
```

Expected: `package.json`'s `dependencies` gains all three; `package-lock.json` updates; no native-compile errors (these are pure-JS or have prebuilt binaries only — if `npm install` tries to invoke `node-gyp`/a C++ compiler for any of these three specifically, STOP and report back rather than trying to work around it, since that would mean the pure-JS choice was wrong).

- [ ] **Step 2: Verify they load**

```bash
node -e "require('@discordjs/voice'); require('opusscript'); require('tweetnacl'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @discordjs/voice + pure-JS opus/encryption deps for Discord voice audio"
```

---

### Task 2: Add voice channel join/leave to `discord-bridge.js`

**Files:**
- Modify: `src/discord/discord-bridge.js`

- [ ] **Step 1: Add the voice intent and imports**

Find:

```js
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const EMBED_COLOR = 0xFF9EC4; // soft pink
```

Replace with:

```js
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    entersState,
    VoiceConnectionStatus,
    AudioPlayerStatus,
    StreamType,
} = require('@discordjs/voice');
const { Readable } = require('stream');

const EMBED_COLOR = 0xFF9EC4; // soft pink
```

- [ ] **Step 2: Add voice connection state**

Find:

```js
let client = null;
let activeChannelId = null;
```

Replace with:

```js
let client = null;
let activeChannelId = null;
let voiceConnection = null;
let audioPlayer = null;
```

- [ ] **Step 3: Add the intent**

Find:

```js
    client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ]
    });
```

Replace with:

```js
    client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildVoiceStates
        ]
    });
```

- [ ] **Step 4: Join voice in `!start`**

Find:

```js
        if (content === '!start') {
            activeChannelId = message.channel.id;
            buffer = [];
            if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
            lastMessageAtByUser.clear();
            message.reply('Miko is now listening here!').catch((e) =>
                console.error('[DiscordBridge] Failed to reply to !start:', e.message)
            );
            return;
        }
```

Replace with:

```js
        if (content === '!start') {
            activeChannelId = message.channel.id;
            buffer = [];
            if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
            lastMessageAtByUser.clear();

            const memberVoiceChannel = message.member?.voice?.channel;
            let replyText = 'Miko is now listening here!';
            if (memberVoiceChannel) {
                try {
                    await joinVoice(memberVoiceChannel);
                    replyText += ` Joined **${memberVoiceChannel.name}** to speak too.`;
                } catch (e) {
                    console.error('[DiscordBridge] Failed to join voice channel:', e.message);
                    replyText += ' (couldn\'t join your voice channel, text-only for now)';
                }
            }

            message.reply(replyText).catch((e) =>
                console.error('[DiscordBridge] Failed to reply to !start:', e.message)
            );
            return;
        }
```

Note: this changes the `messageCreate` handler to be `async` — check Step 5 below.

- [ ] **Step 5: Make the `messageCreate` handler async**

Find:

```js
    client.on('messageCreate', (message) => {
```

Replace with:

```js
    client.on('messageCreate', async (message) => {
```

- [ ] **Step 6: Leave voice in `!stop`**

Find:

```js
        if (content === '!stop') {
            if (message.channel.id === activeChannelId) {
                activeChannelId = null;
                buffer = [];
                if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
                message.reply('Miko has stopped listening.').catch((e) =>
                    console.error('[DiscordBridge] Failed to reply to !stop:', e.message)
                );
            }
            return;
        }
```

Replace with:

```js
        if (content === '!stop') {
            if (message.channel.id === activeChannelId) {
                activeChannelId = null;
                buffer = [];
                if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
                leaveVoice();
                message.reply('Miko has stopped listening.').catch((e) =>
                    console.error('[DiscordBridge] Failed to reply to !stop:', e.message)
                );
            }
            return;
        }
```

- [ ] **Step 7: Add `joinVoice()`, `leaveVoice()`, and `playAudioBuffer()` functions**

Add these new functions right after `isFilteredOut()` (before `flush()`):

```js
async function joinVoice(voiceChannel) {
    leaveVoice(); // clean up any prior connection first

    voiceConnection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });

    audioPlayer = createAudioPlayer();
    voiceConnection.subscribe(audioPlayer);

    await entersState(voiceConnection, VoiceConnectionStatus.Ready, 10_000);
}

function leaveVoice() {
    if (audioPlayer) {
        audioPlayer.stop();
        audioPlayer = null;
    }
    if (voiceConnection) {
        try { voiceConnection.destroy(); } catch (_) { /* already destroyed */ }
        voiceConnection = null;
    }
}

/**
 * Play a WAV audio buffer into the active voice connection. Resolves once
 * playback finishes (or immediately if there's no active voice connection),
 * so callers can use it as their "done speaking" signal instead of polling.
 * @param {Buffer} wavBuffer
 * @returns {Promise<void>}
 */
function playAudioBuffer(wavBuffer) {
    if (!voiceConnection || !audioPlayer) return Promise.resolve();

    return new Promise((resolve) => {
        const resource = createAudioResource(Readable.from(wavBuffer), {
            inputType: StreamType.Arbitrary,
        });

        const onIdle = () => {
            audioPlayer.off(AudioPlayerStatus.Idle, onIdle);
            audioPlayer.off('error', onError);
            resolve();
        };
        const onError = (err) => {
            console.error('[DiscordBridge] Voice playback error:', err.message);
            audioPlayer.off(AudioPlayerStatus.Idle, onIdle);
            audioPlayer.off('error', onError);
            resolve();
        };

        audioPlayer.once(AudioPlayerStatus.Idle, onIdle);
        audioPlayer.once('error', onError);
        audioPlayer.play(resource);
    });
}
```

- [ ] **Step 8: Clean up voice on `stop()` (the module's full-shutdown function, not the `!stop` command)**

Find:

```js
function stop() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    if (client) {
        client.destroy();
        client = null;
    }
    activeChannelId = null;
    busy = false;
    buffer = [];
    lastMessageAtByUser.clear();
}
```

Replace with:

```js
function stop() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    leaveVoice();
    if (client) {
        client.destroy();
        client = null;
    }
    activeChannelId = null;
    busy = false;
    buffer = [];
    lastMessageAtByUser.clear();
}
```

- [ ] **Step 9: Export `playAudioBuffer`**

Find:

```js
module.exports = { start, stop, onBatchReady, sendResponse, markFree, getStatus };
```

Replace with:

```js
module.exports = { start, stop, onBatchReady, sendResponse, markFree, getStatus, playAudioBuffer };
```

- [ ] **Step 10: Verify syntax**

```bash
node --check src/discord/discord-bridge.js
```

Expected: no output (success).

- [ ] **Step 11: Commit**

```bash
git add src/discord/discord-bridge.js
git commit -m "feat: join/leave Discord voice channel on !start/!stop, add voice playback"
```

---

### Task 3: Wire the IPC channel for playing audio into voice

**Files:**
- Modify: `main.js`
- Modify: `preload.js`

- [ ] **Step 1: Add the main.js IPC handler**

In `main.js`, find:

```js
ipcMain.handle('discord-mark-free', async () => {
    discordBridge.markFree();
});
```

Right after it, add:

```js

ipcMain.handle('discord-play-voice-audio', async (event, base64Audio) => {
    const buffer = Buffer.from(base64Audio, 'base64');
    await discordBridge.playAudioBuffer(buffer);
});
```

- [ ] **Step 2: Expose it in preload.js**

In `preload.js`, find:

```js
    discordMarkFree: () => ipcRenderer.invoke('discord-mark-free'),
```

Right after it, add:

```js
    playDiscordVoiceAudio: (base64Audio) => ipcRenderer.invoke('discord-play-voice-audio', base64Audio),
```

- [ ] **Step 3: Verify syntax**

```bash
node --check main.js && node --check preload.js
```

Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add main.js preload.js
git commit -m "feat: add IPC channel to play synthesized audio into Discord voice"
```

---

### Task 4: Route Discord-triggered audio to voice + fix text/audio sync

**Files:**
- Modify: `src/discord/discord-renderer.js`

- [ ] **Step 1: Replace the audio-handling tail of `handleBatch()`**

Find (`src/discord/discord-renderer.js`, current full function):

```js
async function handleBatch(batch) {
    const promptText = formatBatchAsPrompt(batch.messages);
    if (!promptText.trim()) {
        window.electronAPI.discordMarkFree();
        return;
    }

    const systemInstruction = DEFAULT_CONFIG.systemPrompt + STREAM_SYSTEM_ADDENDUM;

    try {
        const responseObj = await BrainRouter.generateStreaming(
            promptText,
            { systemInstruction, conversationHistory: streamRecentMessages },
            (provisionalEmotion) => {
                AvatarBridge.sendComplexIntent({ emotion: provisionalEmotion });
            },
            null // no chat-bubble UI to update for Discord-triggered turns
        );

        streamRecentMessages.push({ role: 'user', content: promptText });
        streamRecentMessages.push({ role: 'assistant', content: responseObj.text });
        if (streamRecentMessages.length > MAX_STREAM_HISTORY_TURNS * 2) {
            streamRecentMessages.splice(0, 2);
        }

        if (responseObj.text) {
            window.electronAPI.sendDiscordResponse(batch.channelId, responseObj.text);
        }

        // Fire the full emotion arc across the speech duration — same call
        // the normal chat flow makes (src/renderer.js's STATES.RESPONDING
        // handler) — this drives lip-sync/expression changes, not just the
        // single provisional beat above.
        if (responseObj.emotionArc) {
            playEmotionArc(responseObj.emotionArc, responseObj.text, responseObj.actionHints || {});
        }

        const emotion = responseObj.emotionArc?.[0];
        await VoiceService.speak(responseObj.text, emotion);
        await waitUntilDonePlaying();
    } catch (error) {
        console.error('[DiscordRenderer] Failed to handle batch:', error.message);
    } finally {
        window.electronAPI.discordMarkFree();
    }
}
```

Replace with:

```js
async function handleBatch(batch) {
    const promptText = formatBatchAsPrompt(batch.messages);
    if (!promptText.trim()) {
        window.electronAPI.discordMarkFree();
        return;
    }

    const systemInstruction = DEFAULT_CONFIG.systemPrompt + STREAM_SYSTEM_ADDENDUM;

    try {
        const responseObj = await BrainRouter.generateStreaming(
            promptText,
            { systemInstruction, conversationHistory: streamRecentMessages },
            (provisionalEmotion) => {
                AvatarBridge.sendComplexIntent({ emotion: provisionalEmotion });
            },
            null // no chat-bubble UI to update for Discord-triggered turns
        );

        streamRecentMessages.push({ role: 'user', content: promptText });
        streamRecentMessages.push({ role: 'assistant', content: responseObj.text });
        if (streamRecentMessages.length > MAX_STREAM_HISTORY_TURNS * 2) {
            streamRecentMessages.splice(0, 2);
        }

        // Fire the full emotion arc across the speech duration — same call
        // the normal chat flow makes (src/renderer.js's STATES.RESPONDING
        // handler) — this drives lip-sync/expression changes, not just the
        // single provisional beat above.
        if (responseObj.emotionArc) {
            playEmotionArc(responseObj.emotionArc, responseObj.text, responseObj.actionHints || {});
        }

        // Synthesize first, THEN send text + start voice playback together —
        // this is what fixes the text-arrives-long-before-audio desync that
        // came from sending text immediately and synthesizing afterward.
        if (responseObj.text) {
            let audioResult = null;
            try {
                audioResult = await window.electronAPI.ttsSynthesize(responseObj.text, { engine: 'system' });
            } catch (synthError) {
                console.error('[DiscordRenderer] Synthesis failed:', synthError.message);
            }

            window.electronAPI.sendDiscordResponse(batch.channelId, responseObj.text);

            if (audioResult?.audio) {
                await window.electronAPI.playDiscordVoiceAudio(audioResult.audio);
            }
        }
    } catch (error) {
        console.error('[DiscordRenderer] Failed to handle batch:', error.message);
    } finally {
        window.electronAPI.discordMarkFree();
    }
}
```

- [ ] **Step 2: Remove the now-unused `waitUntilDonePlaying()` and its `VoiceService` import**

`playDiscordVoiceAudio` (the new IPC call) already doesn't resolve until playback finishes — the old local-`isPlaying()`-polling helper is no longer called anywhere in this file. Find:

```js
import { AvatarBridge } from '../avatar/avatar-bridge.js';
import { VoiceService } from '../voice/voice-service.js';
import { playEmotionArc } from '../renderer.js';
```

Replace with:

```js
import { AvatarBridge } from '../avatar/avatar-bridge.js';
import { playEmotionArc } from '../renderer.js';
```

Find and delete the entire `waitUntilDonePlaying()` function block:

```js
// VoiceService.speak() resolves once playback STARTS, not once it ends
// (see audio-player.js's play() — it awaits audio.play() and returns right
// after). So we must await speak() itself first (covers however long
// synthesis takes, including MioTTS retries), THEN poll isPlaying() until
// it actually finishes. Polling alone with a fixed initial delay is wrong —
// synthesis can take much longer than any fixed delay, which was causing
// "done speaking" to fire while she was still mid-synthesis, freeing the
// queue too early and cutting her off mid-response.
function waitUntilDonePlaying() {
    return new Promise((resolve) => {
        const check = () => {
            if (!VoiceService.isPlaying()) {
                resolve();
            } else {
                setTimeout(check, 300);
            }
        };
        check();
    });
}

```

(Delete the whole block including its comment, leaving `formatBatchAsPrompt()` followed directly by `async function handleBatch(batch) {`.)

- [ ] **Step 3: Verify syntax**

```bash
node --check src/discord/discord-renderer.js
```

Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add src/discord/discord-renderer.js
git commit -m "fix: route Discord-triggered audio to voice channel, sync text with playback start"
```

---

### Task 5: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Start the app**

```bash
npm start
```

- [ ] **Step 2: Join a voice channel yourself, then run `!start`**

In a Discord server the bot is in, join any voice channel, then type `!start` in a text channel. Confirm:
- The bot replies confirming it's listening AND mentions joining your voice channel.
- The bot actually appears connected in that voice channel (visible in Discord's UI).

- [ ] **Step 3: Send a chat message and confirm sync**

Type a message in the active text channel. Confirm the embed reply and the start of her voice both happen close together — not text immediately followed by a multi-second silent gap before audio starts.

- [ ] **Step 4: Confirm `!stop` disconnects voice**

Run `!stop`. Confirm the bot both stops responding to text AND leaves the voice channel.

- [ ] **Step 5: Confirm text-only mode still works**

Run `!start` again while NOT in any voice channel yourself. Confirm the bot still replies to text normally, with no join attempt/error visible to users (check the console log for the "text-only for now" fallback message, but the Discord reply itself should read cleanly either way).

- [ ] **Step 6: Confirm normal 1:1 chat is unaffected**

Chat with Miko directly in the app (not via Discord). Confirm her voice still plays locally exactly as before — this plan should not have touched that path at all.

- [ ] **Step 7: Report results**

Summarize what worked. If voice playback sounds garbled/silent in Discord specifically (even though the same audio plays fine locally), that would point to an issue in the WAV→Opus transcoding step (`StreamType.Arbitrary` relies on `@discordjs/voice` correctly invoking ffmpeg) — report the exact symptom and any console errors rather than guessing at a fix.

---

## Explicitly out of scope for this plan

- Avatar video streaming to Discord — will not be built (ToS/selfbot risk, see design spec).
- Incremental/streaming TTS (chunked audio generation) — deferred pending whether this pass's sync fix feels fast enough in practice.
- Any change to normal (non-Discord) chat's audio path.
