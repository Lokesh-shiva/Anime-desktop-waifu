/**
 * Discord Chat Bridge — main-process Discord bot logic.
 * Self-contained: owns all discord.js usage, filtering, and batching.
 * Exposes a minimal callback/method surface; no other file should reach
 * into discord.js internals directly.
 */

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const EMBED_COLOR = 0xFF9EC4; // soft pink

const MAX_MESSAGE_LENGTH = 300;
const RATE_LIMIT_WINDOW_MS = 1000;
const DEBOUNCE_MS = 3000; // wait this long after the last message before replying
const MAX_BATCH_SIZE = 3; // flush early if this many messages pile up, don't wait forever

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
let debounceTimer = null;
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

function flush() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    if (busy) return;
    if (buffer.length === 0) return;
    if (!batchReadyCallback) return;

    const messages = buffer;
    buffer = [];
    busy = true; // set synchronously to prevent a second flush before the
                 // renderer's generation actually starts
    batchReadyCallback({ channelId: activeChannelId, messages });
}

// Called whenever a new message is buffered (and we're free to eventually
// respond). Waits DEBOUNCE_MS of quiet before flushing, so someone typing
// their thought across 2-3 messages gets captured in one batch instead of
// triggering a separate reply per message. Resets on every new message;
// flushes early if MAX_BATCH_SIZE is hit so it doesn't wait forever.
function scheduleFlush() {
    if (busy) return; // markFree() will call scheduleFlush() again once free
    if (buffer.length === 0) return;

    if (buffer.length >= MAX_BATCH_SIZE) {
        flush();
        return;
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, DEBOUNCE_MS);
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
            if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
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
                if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
                message.reply('Miko has stopped listening.').catch((e) =>
                    console.error('[DiscordBridge] Failed to reply to !stop:', e.message)
                );
            }
            return;
        }

        if (!activeChannelId || message.channel.id !== activeChannelId) return;
        if (isFilteredOut(message)) return;

        // Guild nickname / display name, not the raw account username (which
        // is often an ugly handle-and-numbers combo). Falls back to the raw
        // username if no member/display name is available. Whatever Unicode
        // styling a display name has comes through as-is — plain JS strings
        // handle that natively, nothing special needed.
        const displayName = message.member?.displayName || message.author.username;
        buffer.push({ username: displayName, content });
        scheduleFlush();
    });

    client.on('error', (err) => {
        console.error('[DiscordBridge] Client error:', err.message);
    });

    client.login(token).catch((err) => {
        console.error('[DiscordBridge] Login failed:', err.message);
        client = null;
    });
}

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

function onBatchReady(callback) {
    batchReadyCallback = callback;
}

async function sendResponse(channelId, text) {
    if (!client || !channelId) return;
    try {
        const channel = await client.channels.fetch(channelId);
        if (channel && channel.isTextBased()) {
            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setAuthor({ name: 'Miko' })
                .setDescription(text);
            await channel.send({ embeds: [embed] });
        }
    } catch (err) {
        console.error('[DiscordBridge] Failed to send response:', err.message);
    }
}

function markFree() {
    busy = false;
    scheduleFlush(); // in case messages piled up while busy
}

function getStatus() {
    return {
        connected: !!client,
        activeChannelId
    };
}

module.exports = { start, stop, onBatchReady, sendResponse, markFree, getStatus };
