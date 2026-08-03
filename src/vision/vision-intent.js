/**
 * Vision Intent Detector
 * Zero-LLM phrase matching to detect when the user is directly asking what
 * Miko can see (screen or camera), so a fresh capture can be triggered for
 * that turn instead of relying on the ambient watcher's last periodic result.
 * Mirrors the NAME_PATTERNS regex-array style in memory-manager.js.
 */

const SCREEN_PATTERNS = [
    /what(?:'s| is)\s+(?:on|happening on)\s+(?:my\s+)?screen/i,
    /look at my screen/i,
    /what am i doing on(?: my)? screen/i,
    /can you see (?:my|the) screen/i,
    /check (?:my|the) screen/i,
];

const CAMERA_PATTERNS = [
    /what do you see (?:from|on|through) (?:the|my) camera/i,
    /check (?:the|my) camera/i,
    /look at me\b/i,
    /can you see me\b/i,
    /what do i look like/i,
];

const GENERIC_VISION_PATTERNS = [
    /^what do you see\??$/i,
    /can you see anything/i,
    /what can you see/i,
];

/**
 * Detect whether `text` is a direct question about what Miko can currently see.
 * @param {string} text - the user's raw message
 * @returns {'screen'|'camera'|'both'|null}
 */
export function detectVisionIntent(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return null;

    for (const pattern of SCREEN_PATTERNS) {
        if (pattern.test(trimmed)) return 'screen';
    }
    for (const pattern of CAMERA_PATTERNS) {
        if (pattern.test(trimmed)) return 'camera';
    }
    for (const pattern of GENERIC_VISION_PATTERNS) {
        if (pattern.test(trimmed)) return 'both';
    }
    return null;
}

export default detectVisionIntent;
