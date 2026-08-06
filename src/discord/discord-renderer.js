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
import { playEmotionArc } from '../renderer.js';

const MAX_STREAM_HISTORY_TURNS = 10;

const STREAM_SYSTEM_ADDENDUM = `

=== LIVE STREAM CONTEXT ===
You're live in Discord chat right now — not a quiet one-on-one, a live crowd.
Multiple people might be talking at once, each tagged with their username in
the message below. Read it like chat scrolling past: pick out who said what,
address people by name, play favorites, call out a good line when you see one.

Turn the energy up from your usual self — quicker, punchier, more banter.
Less "...I don't know, it just did something" quiet trailing-off, more
back-and-forth roast energy. You're still you — same teasing, same warmth
underneath, same self-aware catches — just louder and faster, like a
streamer who's actually enjoying her chat instead of reading it off a script.

Emoji: you can use them, but sparingly — one or two per message tops, and
only real ones you can type directly (😄 😭 💀 🔥 👀 etc.), never Discord's
:custom_emoji_name: syntax. You don't know what emojis actually exist on
this server, so guessing a custom name just posts broken text. Stick to
standard Unicode emoji, or none at all if the line doesn't need one.`;

let streamRecentMessages = []; // [{role, content}] — separate from memoryManager.recentMessages

function formatBatchAsPrompt(messages) {
    return messages.map(m => `[${m.username}]: ${m.content}`).join('\n');
}

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

export function initDiscordBridge() {
    if (!window.electronAPI?.onDiscordBatchReady) {
        console.warn('[DiscordRenderer] electronAPI.onDiscordBatchReady not available — skipping init');
        return;
    }
    window.electronAPI.onDiscordBatchReady((batch) => {
        handleBatch(batch);
    });
}
