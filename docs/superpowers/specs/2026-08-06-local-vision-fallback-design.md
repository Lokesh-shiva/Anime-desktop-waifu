# Local Vision Fallback (LM Studio) — Design

## Goal

Stop losing vision analysis entirely when Gemini's free-tier rate limit is hit. Add a local vision model (a 3B VLM loaded in LM Studio, ~3.27GB) as a second attempt when Gemini fails, before falling back to the current neutral "can't see" default.

## Non-goals

- Not replacing Gemini as primary — cloud stays first for quality, local is a fallback only.
- Not adding Ollama — user already runs LM Studio for chat and doesn't want a second local-inference runtime.
- Not downloading/loading the model — that's a manual step in the LM Studio GUI the user does themselves; this only wires the app to call whatever model they've loaded.
- Not changing `ScreenWatcher.js`/`CameraWatcher.js` — this is entirely inside `VisionAdapter.js`, same boundary as before.

## Architecture

**Fallback chain in `VisionAdapter.js`**: `analyzeScreen()`/`analyzeCamera()` currently call `callGeminiVision()` and catch-all failures into a neutral default. Add a second attempt in that catch block: `callLMStudioVision()`, using the exact same prompt. Only if *both* fail does it fall through to today's neutral default (`activity: null` / `userState: 'unknown'`) — same graceful-degradation contract as now, just with one more real attempt first.

**LM Studio vision call**: reuses LM Studio's existing OpenAI-compatible server (`http://localhost:1234/v1/chat/completions` — the same endpoint `lmstudio-adapter.js` already calls for chat). Sends a multimodal message: image as a base64 `image_url` content part alongside the existing text prompt, which is the standard format LM Studio's vision-capable models accept. Same JSON-output contract as Gemini (the prompts already instruct "Output ONLY valid JSON" — reused verbatim).

**Model selection**: new `getLMStudioVisionModel()` / `setLMStudioVisionModel()` in `settings.js`, storage key `waifu_lmstudio_vision_model`, mirroring the existing `getLMStudioModel()` pattern exactly. New Settings input field placed in the existing "Vision (requires Cloud API)" section in `index.html`, wired the same way as the existing `lmstudio-model-input` field (debounced save on input).

## Error handling

- Gemini fails (rate limit, network, bad response) → try LM Studio.
- LM Studio unreachable (not running, wrong model loaded, timeout) → fall through to today's neutral default. Never blocks or crashes a turn.
- No new failure modes introduced — this only adds a second chance before the existing fallback, never removes the existing safety net.

## Testing

No automated suite. Manual: with the local vision model loaded in LM Studio and a valid model ID set in Settings, temporarily use an invalid Gemini API key (or wait for a real rate-limit) and confirm screen/camera analysis still succeeds via the console logs (`[Vision]` prefix) showing which path was used. Confirm normal Gemini-success path is completely unaffected when Gemini works. Confirm the neutral fallback still fires correctly if LM Studio is also unreachable.
