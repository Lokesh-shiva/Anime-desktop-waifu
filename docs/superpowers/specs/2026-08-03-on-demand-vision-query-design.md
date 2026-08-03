# On-Demand Vision Query — Design

## Goal

Let Miko answer direct questions like "what do you see?", "what's on my
screen?", or "what do you see from the camera?" with a **fresh** capture and
analysis at the moment of asking, instead of relying on whatever her ambient
4-minute polling last captured (which could be stale by up to 4 minutes).

## Non-goals

- No changes to the existing ambient/periodic vision system (`ScreenWatcher`'s
  4-minute diff-checked polling, `CameraWatcher`'s typed reactions like
  `noticed_you`/`are_you_okay`/`looking_focused`). Those keep working exactly
  as they do today, unaffected by this feature.
- No changes to `VisionAdapter.js` (the Gemini vision call itself) — this
  feature only changes *when* a capture happens, not how it's analyzed.
- No LLM-based intent classification — phrase matching only, to keep this
  fast and avoid an extra round-trip before every message.

## Architecture

**New file: `src/vision/vision-intent.js`**

Exports a single function, e.g. `detectVisionIntent(text)`, that checks the
user's message against phrase patterns and returns one of:
- `'screen'` — screen-specific phrasing ("what's on my screen", "look at my
  screen", "what am I doing on screen")
- `'camera'` — camera-specific phrasing ("check the camera", "look at me",
  "what do you see from the camera")
- `'both'` — generic vision phrasing with no screen/camera keyword ("what do
  you see?", "can you see anything?")
- `null` — no vision-related phrasing detected (the normal case)

This mirrors the existing `NAME_PATTERNS` regex-array pattern already used in
`memory-manager.js` for instant, LLM-free detection.

**`captureNow()` on `ScreenWatcher` and `CameraWatcher`**

Each watcher gets a new public method that performs a single capture +
`VisionAdapter` analysis and *returns* the result directly, rather than
updating the watcher's internal `_context` cache the way `_tick()` does.

- `ScreenWatcher.captureNow()`: captures and analyzes immediately, skipping
  the diff-check (the diff-check exists to avoid wasted *periodic* API calls
  when nothing changed — it doesn't apply when the user explicitly asked).
- `CameraWatcher.captureNow()`: captures and analyzes immediately if the
  camera stream is active; returns `null` if the camera isn't running (vision
  disabled, or `start()` failed, e.g. permission denied).

Both bypass their timers entirely — no interaction with `start()`/`stop()`/the
`setInterval` polling loop.

## Resolving `'both'`

Per your confirmation: check whichever channels are actually enabled.

- Only screen enabled → check screen only.
- Only camera enabled → check camera only.
- Both enabled → check both, merge into context.
- Neither enabled → no capture; the system prompt reflects that nothing is
  currently visible, so Miko can honestly say she can't see anything right
  now rather than guessing or hallucinating an answer.

Same "channel is disabled → say so" logic applies to an explicit `'screen'` or
`'camera'` match when that specific channel isn't enabled.

## Wiring into `handleUserSubmit` (`src/renderer.js`)

Right after the user's message is captured (before `buildSystemPrompt` is
called), run `detectVisionIntent(query)`. If it returns non-null:

1. For each channel indicated (resolved per the rules above against
   `isScreenVisionEnabled()` / `isCameraVisionEnabled()`), call that watcher's
   `captureNow()`.
2. Build a fresh `visionContext` object for *this turn only* using the fresh
   result(s), falling back to the watcher's existing cached `getContext()` for
   any channel not triggered this turn (e.g. if only screen was asked about
   but camera is also enabled, camera context stays whatever was last
   ambiently captured — no reason to force a camera capture nobody asked
   about).
3. Pass this turn-specific `visionContext` into `buildSystemPrompt(...)`
   instead of the default `getVisionContext()` call.

The watchers' own `_context` caches (used by the ambient reaction system) are
**not** overwritten by `captureNow()` — this keeps the on-demand path fully
isolated from the periodic polling/reaction logic. A `captureNow()` call is a
one-off, turn-scoped lookup.

## Error handling

- `captureNow()` failing (network error, Gemini API error, camera not
  running) resolves to `null`, same failure shape `VisionAdapter` already
  uses. The turn just proceeds with whatever context is available (possibly
  none) — never blocks or fails the whole chat turn over a vision capture
  error.
- Latency: this adds one Gemini vision call (~1-2s observed) before her
  response starts generating, only on turns where vision intent is detected.
  Confirmed acceptable per your answer (accuracy over speed for a direct
  question).

## Testing

No automated test suite in this project — verification is manual: enable
screen vision, ask "what do you see on my screen?", change what's on screen,
ask again, confirm the second answer reflects the *new* screen state (not a
stale one from up to 4 minutes ago). Repeat for camera with "what do you see
from the camera?". Test the disabled-channel case (ask about camera while
camera vision is off) and confirm she says she can't see it rather than
inventing an answer. Test ambiguous phrasing ("what do you see?") with both
channels enabled, then with only one enabled.
