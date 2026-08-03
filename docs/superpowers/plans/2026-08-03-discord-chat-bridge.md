# Discord Chat Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let viewers chat with Miko through a Discord channel while she's being streamed (via Discord's own screen-share) — a self-contained Discord bot bridges viewer messages into her existing chat pipeline as a batched group conversation, isolated from the user's personal memory/mood/bond.

**Architecture:** Two new files own all Discord-specific logic — `src/discord/discord-bridge.js` (main process: `discord.js` client, `!start`/`!stop` commands, message filtering, busy-aware batching) and `src/discord/discord-renderer.js` (renderer process: receives batches, reuses the existing `BrainRouter`/`VoiceService`/`AvatarBridge` pipeline with a separate throwaway conversation history). `main.js`, `preload.js`, and `renderer.js` each get only minimal, mechanical wiring (IPC plumbing and a settings-input hookup) — no Discord-specific logic lives in any existing file.

**Tech Stack:** `discord.js` (new npm dependency), existing Electron IPC (`ipcMain.handle`/`contextBridge`), existing `BrainRouter`/`VoiceService`/`AvatarBridge` (no changes to those files).

---

## Important context for the engineer

- Repo root: `C:\Users\Lokesh\Desktop\Pojects\Waifu`. Electron app, no automated test suite (`package.json` only has `start`/`build` scripts) — verification in this plan is manual.
- Read `docs/superpowers/specs/2026-08-03-discord-chat-bridge-design.md` first — it has the full rationale for every decision referenced below.
- **Isolation requirement (explicit user instruction):** Discord bot logic must not be woven into existing app files. All bot/batching/prompt logic lives in the two new `src/discord/*.js` files. Existing files only get small, boring wiring changes (IPC registration, one settings-input listener) — never business logic.
- The existing per-turn chat pattern to replicate (read `src/renderer.js:440-521` `handleUserSubmit` before starting) is:
  ```js
  const systemInstruction = buildSystemPrompt(memoryContext, presenceHints, memoryManager.recentMessages, getVisionContext());
  const responseObj = await BrainRouter.generateStreaming(
      query,
      { systemInstruction, conversationHistory: memoryManager.recentMessages },
      (provisionalEmotion) => AvatarBridge.sendComplexIntent({ emotion: provisionalEmotion }),
      (rawChunk) => { /* updates chat bubble progressively — not needed for Discord path */ }
  );
  ```
  The Discord path reuses `BrainRouter.generateStreaming` and `AvatarBridge.sendComplexIntent` the same way, but with its own throwaway history array instead of `memoryManager.recentMessages`, and without the chat-bubble UI update (there's no bubble for a Discord-triggered turn).
- `VoiceService.speak(text, emotion)` starts playback; `VoiceService.isPlaying()` (boolean) is how to detect when she's done speaking. **Do not call `VoiceService.onEnd(cb)`** — that's a single-callback slot already used by the main chat flow (see `src/voice/voice-service.js:113`); registering a second callback there would silently break the main app's state transitions. Poll `isPlaying()` instead (Task 4 shows exactly how).
- `DEFAULT_CONFIG` (system prompt, maxTokens, temperature) is exported from `src/llm/llm-interface.js`.
- Existing IPC pattern to follow exactly (`main.js:372-396`, memory persistence):
  ```js
  const MEMORY_FILE = 'memory.json';
  const userDataPath = app.getPath('userData');
  const memoryPath = path.join(userDataPath, MEMORY_FILE);
  ipcMain.handle('load-memory', async () => { /* read+parse, return null on missing/error */ });
  ipcMain.handle('save-memory', async (event, data) => { /* write, return true/false */ });
  ```
- Existing settings-input wiring pattern to follow exactly (`src/renderer.js:1453-1462`, ElevenLabs key):
  ```js
  let elevenLabsKeyTimeout;
  if (elevenLabsKeyInput) {
      elevenLabsKeyInput.addEventListener('input', (e) => {
          clearTimeout(elevenLabsKeyTimeout);
          elevenLabsKeyTimeout = setTimeout(() => {
              setElevenLabsApiKey(e.target.value.trim());
          }, 500);
      });
  }
  ```
- The settings UI markup pattern to follow (`src/index.html:203-217`, TTS engine radio group) — a `<div class="setting-section">` with a `.section-label` and inputs; see Task 5 for the exact block to add.
- `preload.js` exposes IPC to the renderer via `contextBridge.exposeInMainWorld('electronAPI', {...})` — every new IPC channel needs a matching one-line entry there (see `preload.js:1-41`).

---

## Task 1: `discord-bridge.js` — bot connection, commands, filtering, batching

**Files:**
- Create: `src/discord/discord-bridge.js`

- [ ] **Step 1: Install the `discord.js` dependency**

```bash
npm install discord.js
```

Expected: `package.json`'s `dependencies` now includes `"discord.js"`.

- [ ] **Step 2: Create the bridge module**

Create `src/discord/discord-bridge.js`:

```js
/**
 * Discord Chat Bridge — main-process Discord bot logic.
 * Self-contained: owns all discord.js usage, filtering, and batching.
 * Exposes a minimal callback/method surface; no other file should reach
 * into discord.js internals directly.
 */

const { Client, GatewayIntentBits } = require('discord.js');

const MAX_MESSAGE_LENGTH = 300;
const RATE_LIMIT_WINDOW_MS = 3000;
const BATCH_FLUSH_INTERVAL_MS = 500;

// Small static blocklist — extend as needed. Matched case-insensitively as
// whole words so it doesn't false-positive on substrings of normal words.
const BLOCKLIST_WORDS = ['nigger', 'faggot', 'retard'];
const BLOCKLIST_RE = new RegExp(
    '\\b(' + BLOCKLIST_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
    'i'
);

let client = null;
let activeChannelId = null;
let busy = false;
let buffer = []; // [{ username, content }]
let lastMessageAtByUser = new Map(); // userId -> timestamp ms
let flushTimer = null;
let batchReadyCallback = null;

function isFilteredOut(discordMessage) {
    const content = discordMessage.content.trim();
    if (!content) return true;
    if (content.length > MAX_MESSAGE_LENGTH) return true;
    if (BLOCKLIST_RE.test(content)) return true;

    const userId = discordMessage.author.id;
    const now = Date.now();
    const lastAt = lastMessageAtByUser.get(userId) || 0;
    if (now - lastAt < RATE_LIMIT_WINDOW_MS) return true;
    lastMessageAtByUser.set(userId, now);

    return false;
}

function flushIfReady() {
    if (busy) return;
    if (buffer.length === 0) return;
    if (!batchReadyCallback) return;

    const messages = buffer;
    buffer = [];
    busy = true; // set synchronously to prevent a second flush before the
                 // renderer's generation actually starts
    batchReadyCallback({ channelId: activeChannelId, messages });
}

function start(token) {
    if (client) {
        console.warn('[DiscordBridge] start() called while already connected — ignoring');
        return;
    }
    if (!token) {
        console.error('[DiscordBridge] No token provided, not starting');
        return;
    }

    client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ]
    });

    client.once('clientReady', () => {
        console.log(`[DiscordBridge] Logged in as ${client.user.tag}`);
    });

    client.on('messageCreate', (message) => {
        if (message.author.bot) return;

        const content = message.content.trim();

        if (content === '!start') {
            activeChannelId = message.channel.id;
            buffer = [];
            lastMessageAtByUser.clear();
            message.reply('Miko is now listening here!').catch((e) =>
                console.error('[DiscordBridge] Failed to reply to !start:', e.message)
            );
            return;
        }

        if (content === '!stop') {
            if (message.channel.id === activeChannelId) {
                activeChannelId = null;
                buffer = [];
                message.reply('Miko has stopped listening.').catch((e) =>
                    console.error('[DiscordBridge] Failed to reply to !stop:', e.message)
                );
            }
            return;
        }

        if (!activeChannelId || message.channel.id !== activeChannelId) return;
        if (isFilteredOut(message)) return;

        buffer.push({ username: message.author.username, content });
    });

    client.on('error', (err) => {
        console.error('[DiscordBridge] Client error:', err.message);
    });

    client.login(token).catch((err) => {
        console.error('[DiscordBridge] Login failed:', err.message);
        client = null;
    });

    flushTimer = setInterval(flushIfReady, BATCH_FLUSH_INTERVAL_MS);
}

function stop() {
    if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
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

function onBatchReady(callback) {
    batchReadyCallback = callback;
}

async function sendResponse(channelId, text) {
    if (!client || !channelId) return;
    try {
        const channel = await client.channels.fetch(channelId);
        if (channel && channel.isTextBased()) {
            await channel.send(text);
        }
    } catch (err) {
        console.error('[DiscordBridge] Failed to send response:', err.message);
    }
}

function markFree() {
    busy = false;
}

function getStatus() {
    return {
        connected: !!client,
        activeChannelId
    };
}

module.exports = { start, stop, onBatchReady, sendResponse, markFree, getStatus };
```

- [ ] **Step 3: Verify syntax**

```bash
node --check src/discord/discord-bridge.js
```

Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/discord/discord-bridge.js
git commit -m "feat: add Discord bot bridge (connection, commands, filtering, batching)"
```

---

## Task 2: Wire `main.js` — config persistence + IPC handlers

**Files:**
- Modify: `main.js`

- [ ] **Step 1: Add config persistence, following the exact `memory.json` pattern**

In `main.js`, find the memory persistence block (around line 372-396):

```js
const MEMORY_FILE = 'memory.json';
const userDataPath = app.getPath('userData');
const memoryPath = path.join(userDataPath, MEMORY_FILE);

ipcMain.handle('load-memory', async () => {
    try {
        if (fs.existsSync(memoryPath)) {
            const data = fs.readFileSync(memoryPath, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Failed to load memory:', error);
    }
    return null;
});

ipcMain.handle('save-memory', async (event, data) => {
    try {
        fs.writeFileSync(memoryPath, JSON.stringify(data, null, 2), 'utf-8');
        return true;
    } catch (error) {
        console.error('Failed to save memory:', error);
        return false;
    }
});
```

Immediately after this block, add:

```js
// ============================================
// Discord Chat Bridge
// ============================================

const discordBridge = require('./src/discord/discord-bridge.js');

const DISCORD_CONFIG_FILE = 'discord-config.json';
const discordConfigPath = path.join(userDataPath, DISCORD_CONFIG_FILE);

function loadDiscordConfig() {
    try {
        if (fs.existsSync(discordConfigPath)) {
            return JSON.parse(fs.readFileSync(discordConfigPath, 'utf-8'));
        }
    } catch (error) {
        console.error('[Main] Failed to load Discord config:', error);
    }
    return { token: '', enabled: false };
}

function saveDiscordConfigToDisk(config) {
    fs.writeFileSync(discordConfigPath, JSON.stringify(config, null, 2), 'utf-8');
}

ipcMain.handle('get-discord-config', async () => {
    const config = loadDiscordConfig();
    return { token: config.token || '', enabled: !!config.enabled };
});

ipcMain.handle('save-discord-config', async (event, config) => {
    try {
        saveDiscordConfigToDisk(config);
        discordBridge.stop();
        if (config.enabled && config.token) {
            discordBridge.start(config.token);
        }
        return true;
    } catch (error) {
        console.error('[Main] Failed to save Discord config:', error);
        return false;
    }
});

ipcMain.handle('discord-send-response', async (event, channelId, text) => {
    await discordBridge.sendResponse(channelId, text);
});

ipcMain.handle('discord-mark-free', async () => {
    discordBridge.markFree();
});

ipcMain.handle('discord-get-status', async () => {
    return discordBridge.getStatus();
});
```

- [ ] **Step 2: Start the bridge on app startup if configured, and forward batches to the renderer**

Find where `mainWindow` is created and shown (search for `function createWindow` or similar — it's the function that does `mainWindow = new BrowserWindow(...)`). After `mainWindow` is assigned in that function, add:

```js
    // Start Discord bridge if configured, and forward batches to the renderer
    const discordConfig = loadDiscordConfig();
    discordBridge.onBatchReady((batch) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('discord-batch-ready', batch);
        }
    });
    if (discordConfig.enabled && discordConfig.token) {
        discordBridge.start(discordConfig.token);
    }
```

- [ ] **Step 3: Verify syntax**

```bash
node --check main.js
```

Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat: wire Discord bridge into main.js (config persistence + IPC)"
```

---

## Task 3: Expose the new IPC channels in `preload.js`

**Files:**
- Modify: `preload.js`

- [ ] **Step 1: Add the new entries**

In `preload.js`, inside the `contextBridge.exposeInMainWorld('electronAPI', { ... })` object, after the `setAutoLaunch` entry (the last one, currently ending the object before `});`), add:

```js
    setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),

    // Discord chat bridge
    getDiscordConfig: () => ipcRenderer.invoke('get-discord-config'),
    saveDiscordConfig: (config) => ipcRenderer.invoke('save-discord-config', config),
    onDiscordBatchReady: (callback) => ipcRenderer.on('discord-batch-ready', (_, batch) => callback(batch)),
    sendDiscordResponse: (channelId, text) => ipcRenderer.invoke('discord-send-response', channelId, text),
    discordMarkFree: () => ipcRenderer.invoke('discord-mark-free'),
    getDiscordStatus: () => ipcRenderer.invoke('discord-get-status')
```

(Note: `setAutoLaunch`'s trailing comma changes from none to one, since it's no longer the last entry.)

- [ ] **Step 2: Verify syntax**

```bash
node --check preload.js
```

Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add preload.js
git commit -m "feat: expose Discord bridge IPC channels to renderer"
```

---

## Task 4: `discord-renderer.js` — batch handling, reusing the existing chat pipeline

**Files:**
- Create: `src/discord/discord-renderer.js`
- Modify: `src/renderer.js` (one import + one function call)

- [ ] **Step 1: Create the renderer-side handler**

Create `src/discord/discord-renderer.js`:

```js
/**
 * Discord Chat Bridge — renderer-side batch handling.
 * Receives batches of Discord messages via IPC and feeds them through the
 * existing chat pipeline (BrainRouter, VoiceService, AvatarBridge), using a
 * separate throwaway conversation history so stream chat never touches
 * memoryManager's personal facts/mood/bond.
 */

import { BrainRouter } from '../llm/brain-router.js';
import { DEFAULT_CONFIG } from '../llm/llm-interface.js';
import { AvatarBridge } from '../avatar/avatar-bridge.js';
import { VoiceService } from '../voice/voice-service.js';

const MAX_STREAM_HISTORY_TURNS = 10;

const STREAM_SYSTEM_ADDENDUM = `

=== LIVE STREAM CONTEXT ===
You're live-streaming right now. The message below may contain lines from
multiple different people in your Discord chat, each tagged with their
username — you can see and address them by name, like a streamer reading
chat out loud.`;

let streamRecentMessages = []; // [{role, content}] — separate from memoryManager.recentMessages

function formatBatchAsPrompt(messages) {
    return messages.map(m => `[${m.username}]: ${m.content}`).join('\n');
}

function waitForSpeechToFinish() {
    return new Promise((resolve) => {
        const check = () => {
            if (!VoiceService.isPlaying()) {
                resolve();
            } else {
                setTimeout(check, 300);
            }
        };
        // Give speak() a moment to actually start before polling for "done"
        setTimeout(check, 500);
    });
}

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

        const emotion = responseObj.emotionArc?.[0];
        VoiceService.speak(responseObj.text, emotion);
        await waitForSpeechToFinish();
    } catch (error) {
        console.error('[DiscordRenderer] Failed to handle batch:', error.message);
    } finally {
        window.electronAPI.discordMarkFree();
    }
}

export function initDiscordBridge() {
    if (!window.electronAPI?.onDiscordBatchReady) {
        console.warn('[DiscordRenderer] electronAPI.onDiscordBatchReady not available — skipping init');
        return;
    }
    window.electronAPI.onDiscordBatchReady((batch) => {
        handleBatch(batch);
    });
}
```

- [ ] **Step 2: Hook it into `renderer.js` with a single import + call**

In `src/renderer.js`, find the import block (top of file, around line 7-52). After the last import line (`import { initWizard, isWizardActive } from './wizard.js';`), add:

```js
import { initDiscordBridge } from './discord/discord-renderer.js';
```

Then find where other `init()`-style setup calls happen at startup (search for `initWizard(` being called, not just imported — it's called somewhere near the bottom of the file's initialization sequence). Immediately after that call, add:

```js
initDiscordBridge();
```

- [ ] **Step 3: Verify syntax**

```bash
node --check src/discord/discord-renderer.js
node --check src/renderer.js
```

Expected: no output for either (success). `discord-renderer.js` uses ES module `import`/`export` syntax — this matches `renderer.js`'s existing setup (`src/index.html:416` loads it via `<script type="module" src="renderer.js">`), so no further configuration is needed.

- [ ] **Step 4: Commit**

```bash
git add src/discord/discord-renderer.js src/renderer.js
git commit -m "feat: handle Discord message batches through existing chat pipeline"
```

---

## Task 5: Settings UI — Discord Streaming section

**Files:**
- Modify: `src/index.html`
- Modify: `src/renderer.js`

- [ ] **Step 1: Add the settings markup**

In `src/index.html`, find the TTS Engine settings block (around line 203-217):

```html
        <div id="voice-settings-group" class="setting-section hidden">
          <div class="section-label">TTS Engine</div>
          ...
        </div>
```

After this block's closing `</div>`, add:

```html
        <div id="discord-settings-group" class="setting-section">
          <div class="section-label">Discord Streaming</div>
          <label class="section-label" for="discord-token-input">Bot Token</label>
          <input type="password" id="discord-token-input" class="glass-input"
                 placeholder="Paste your Discord bot token">
          <label class="radio-option" style="margin-top:10px;">
            <input type="checkbox" id="discord-enable-toggle">
            <span>Enable Discord bridge</span>
          </label>
          <div id="discord-status-line" class="hint-text" style="margin-top:6px;">not connected</div>
        </div>
```

- [ ] **Step 2: Wire it up in `renderer.js`, following the ElevenLabs key pattern exactly**

In `src/renderer.js`, find the element-reference declarations near the top (around line 255-270, where `elevenLabsKeyInput` etc. are declared). Add:

```js
const discordTokenInput = document.getElementById('discord-token-input');
const discordEnableToggle = document.getElementById('discord-enable-toggle');
const discordStatusLine = document.getElementById('discord-status-line');
```

Then find the ElevenLabs key wiring block (around line 1453-1462):

```js
// ElevenLabs API key (debounced)
let elevenLabsKeyTimeout;
if (elevenLabsKeyInput) {
    elevenLabsKeyInput.addEventListener('input', (e) => {
        clearTimeout(elevenLabsKeyTimeout);
        elevenLabsKeyTimeout = setTimeout(() => {
            setElevenLabsApiKey(e.target.value.trim());
        }, 500);
    });
}
```

After this block, add:

```js
// Discord bridge settings
async function saveDiscordSettings() {
    await window.electronAPI.saveDiscordConfig({
        token: discordTokenInput.value.trim(),
        enabled: discordEnableToggle.checked
    });
    refreshDiscordStatus();
}

async function refreshDiscordStatus() {
    if (!discordStatusLine) return;
    const status = await window.electronAPI.getDiscordStatus();
    if (!status.connected) {
        discordStatusLine.textContent = 'not connected';
    } else if (status.activeChannelId) {
        discordStatusLine.textContent = 'connected — listening (type !stop in Discord to stop)';
    } else {
        discordStatusLine.textContent = 'connected — idle, waiting for !start in Discord';
    }
}

let discordTokenTimeout;
if (discordTokenInput) {
    window.electronAPI.getDiscordConfig().then((config) => {
        discordTokenInput.value = config.token || '';
        discordEnableToggle.checked = !!config.enabled;
        refreshDiscordStatus();
    });

    discordTokenInput.addEventListener('input', () => {
        clearTimeout(discordTokenTimeout);
        discordTokenTimeout = setTimeout(saveDiscordSettings, 500);
    });
    discordEnableToggle.addEventListener('change', saveDiscordSettings);

    setInterval(refreshDiscordStatus, 5000);
}
```

- [ ] **Step 3: Verify syntax**

```bash
node --check src/renderer.js
```

Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add src/index.html src/renderer.js
git commit -m "feat: add Discord Streaming settings UI"
```

---

## Task 6: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Start the app**

```bash
npm start
```

- [ ] **Step 2: Configure the bridge**

In Settings, paste a real Discord bot token (created per the design doc's prerequisites — Developer Portal application + bot + Message Content Intent enabled + invited to a test server you control) into the new "Discord Streaming" section and enable it. Confirm the status line changes from "not connected" to "connected — idle, waiting for !start in Discord".

- [ ] **Step 3: Test `!start`/`!stop`**

In your test Discord server, type `!start` in a channel. Confirm:
- The bot replies "Miko is now listening here!"
- The Settings status line updates to "connected — listening..." within 5 seconds

Type `!stop` in that same channel. Confirm the bot replies "Miko has stopped listening." and the status line returns to idle.

- [ ] **Step 4: Test single-message flow**

`!start` again, then send one normal message (e.g. "hi Miko!"). Confirm:
- Miko responds (voice plays, avatar reacts) — same as a normal chat turn
- The same response text appears posted back in the Discord channel

- [ ] **Step 5: Test batching with multiple messages**

While Miko is mid-response (voice still playing) from Step 4, send 2-3 more messages from Discord (using a second account/friend if possible, to also verify usernames are tracked correctly). Confirm:
- These messages don't trigger a new response immediately
- Once she finishes speaking, all buffered messages get sent together as one batch (check the console log or her response — it should acknowledge multiple people/messages)

- [ ] **Step 6: Test filtering**

Send a message over 300 characters, and a message containing a blocklisted word. Confirm neither triggers a response and neither gets included in the next real batch.

- [ ] **Step 7: Confirm isolation from personal memory**

After the above testing, check `%APPDATA%\waifu-assistant\memory.json` (PowerShell: `Get-Content "$env:APPDATA\waifu-assistant\memory.json"`) and confirm no new facts, mood changes, or session summaries were added as a result of the Discord test conversation — only from your own personal chat turns, if any occurred separately.

- [ ] **Step 8: Report results**

Summarize what worked and what didn't. If Step 5 (batching) doesn't behave as expected, check `discord-bridge.js`'s `busy`/`markFree()` timing before assuming the batching logic itself is wrong — a common failure mode is `discordMarkFree()` never being called if `handleBatch` throws before reaching the `finally` block silently (it shouldn't, given the try/finally structure, but confirm via console logs).

---

## Explicitly out of scope for this plan

- Voice input from Discord viewers (speaking to Miko) — deferred to a separate follow-up project per the design doc.
- Switching TTS engines (e.g. Fish Speech) — unrelated, out of scope.
- Slash-command registration (`/start` instead of `!start`) — the simple prefix-command approach used here needs no Discord-side command registration and is sufficient for this use case.
- Any change to `memory-manager.js`, `prompt-builder.js`, `brain-router.js`, or `voice-service.js` — this plan deliberately reuses them as-is, unmodified.
