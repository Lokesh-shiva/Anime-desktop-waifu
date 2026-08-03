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
