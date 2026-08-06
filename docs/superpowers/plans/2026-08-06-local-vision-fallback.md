# Local Vision Fallback (LM Studio) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Gemini vision analysis fails (rate limit, network, bad response), try a local LM Studio vision model before falling back to the existing neutral "can't see" default — so a rate limit no longer means losing vision context entirely.

**Architecture:** `VisionAdapter.js` gets a new `callLMStudioVision()` function using LM Studio's existing OpenAI-compatible chat endpoint (multimodal `image_url` content part), called as a second attempt inside `analyzeScreen()`/`analyzeCamera()`'s existing catch blocks. Model selection via a new `getLMStudioVisionModel()` setting with a matching Settings UI field.

**Tech Stack:** Plain JS, `fetch` to LM Studio's local server (same pattern as `lmstudio-adapter.js`).

---

## Important context for the engineer

- Repo root: `C:\Users\Lokesh\Desktop\Pojects\Waifu`. No automated test suite — verification is manual.
- The user needs to have a vision-capable model (a 3B VLM, ~3.27GB) already downloaded and loaded in LM Studio, with its exact model ID entered in the new Settings field, before this can be tested end-to-end. If that hasn't happened yet, code changes can still be verified for syntax/logic; live fallback testing waits until the model is loaded.
- `src/vision/VisionAdapter.js` (99 lines) currently has `callGeminiVision(base64Jpeg, prompt)` (lines 33-65) and exports `analyzeScreen`/`analyzeCamera` (lines 67-96), each with a try/catch that returns a neutral default on any failure (lines 76-79, 91-94).
- `src/llm/lmstudio-adapter.js` is the reference pattern for talking to LM Studio's server: base URL `http://localhost:1234/v1`, endpoint `${LMSTUDIO_BASE}/chat/completions`, POST with `{ model, messages, max_tokens, temperature, stream: false }`, response at `data.choices?.[0]?.message?.content`. Timeout via `AbortController` (that file uses `DEFAULT_CONFIG.timeout`, but vision calls should use a short, vision-appropriate timeout independent of chat's config — see Task 1 below for the exact value chosen, matching Gemini vision's existing 15000ms in `VisionAdapter.js:50`).
- `src/settings.js`'s `STORAGE_KEYS` object is at lines 8-26; `getLMStudioModel()`/`setLMStudioModel()` are at lines 311-320, the exact pattern to mirror. The main `export { ... }` block includes `getLMStudioModel,` / `setLMStudioModel,` around line 398-399 — the new getter/setter need adding there too.
- `src/index.html`'s Vision settings section is at lines 277-301, inside `<div class="setting-section" style="margin-top:16px;">` with `<div class="section-label">Vision (requires Cloud API)</div>` — the new input field goes here, after the two existing toggle rows, following the exact markup pattern of the existing `lmstudio-model-group` field at lines 148-153.
- `src/renderer.js` wires `lmstudio-model-input` at lines 1042-1071 (populate on load, debounced save on input). The new field follows the identical debounced-save pattern. The Vision toggles wiring starts at line 1073 (`screen-vision-toggle`/`camera-vision-toggle`) — the new field's wiring goes near there since it's conceptually part of the Vision section, not the LLM local-provider section.

---

### Task 1: Add the LM Studio vision setting

**Files:**
- Modify: `src/settings.js`

- [ ] **Step 1: Add the storage key**

In `src/settings.js`, find (line 25):

```js
    LMSTUDIO_MODEL: 'waifu_lmstudio_model'
```

Replace with:

```js
    LMSTUDIO_MODEL: 'waifu_lmstudio_model',
    LMSTUDIO_VISION_MODEL: 'waifu_lmstudio_vision_model'
```

- [ ] **Step 2: Add the getter/setter**

Right after `setLMStudioModel()` (ends at line 320), add:

```js

export function getLMStudioVisionModel() {
    return localStorage.getItem(STORAGE_KEYS.LMSTUDIO_VISION_MODEL) || '';
}

export function setLMStudioVisionModel(modelId) {
    localStorage.setItem(STORAGE_KEYS.LMSTUDIO_VISION_MODEL, modelId || '');
    notifyListeners({ type: 'lmstudioVisionModel', value: modelId });
    console.log('[Settings] LM Studio vision model changed to:', modelId);
}
```

(Empty-string default, unlike `getLMStudioModel()`'s hardcoded default — there's no safe guess for a vision model name, so an empty value signals "not configured yet" and `VisionAdapter.js` treats that as unavailable, skipping straight to the neutral fallback rather than sending a request with a blank model ID.)

- [ ] **Step 3: Add both to the export block**

Find the `getLMStudioModel,` / `setLMStudioModel,` lines in the main export block (around line 398-399) and add right after:

```js
    getLMStudioVisionModel,
    setLMStudioVisionModel,
```

- [ ] **Step 4: Verify syntax**

```bash
node --check src/settings.js
```

Expected: no output (success).

- [ ] **Step 5: Commit**

```bash
git add src/settings.js
git commit -m "feat: add LM Studio vision model setting"
```

---

### Task 2: Add the LM Studio vision call to `VisionAdapter.js`

**Files:**
- Modify: `src/vision/VisionAdapter.js`

- [ ] **Step 1: Import the new setting**

In `src/vision/VisionAdapter.js`, find:

```js
import { getCloudApiKey } from '../settings.js';
```

Replace with:

```js
import { getCloudApiKey, getLMStudioVisionModel } from '../settings.js';
```

- [ ] **Step 2: Add the LM Studio vision function**

Find `callGeminiVision()`'s closing brace (ends right before `export const VisionAdapter = {` at line 67). Add right after it:

```js

const LMSTUDIO_VISION_ENDPOINT = 'http://localhost:1234/v1/chat/completions';

async function callLMStudioVision(base64Jpeg, prompt) {
    const modelId = getLMStudioVisionModel();
    if (!modelId) throw new Error('No LM Studio vision model configured');

    const response = await fetch(LMSTUDIO_VISION_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
            model: modelId,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Jpeg}` } }
                ]
            }],
            max_tokens: 1024,
            temperature: 0.2,
            stream: false
        })
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(`LM Studio vision error: ${err?.error?.message || response.status}`);
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || '';

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('LM Studio vision response not parseable: ' + raw.slice(0, 80));
    return JSON.parse(jsonMatch[0]);
}
```

- [ ] **Step 3: Wire the fallback into `analyzeScreen()`**

Find (`src/vision/VisionAdapter.js`, current `analyzeScreen`):

```js
    async analyzeScreen(base64Jpeg) {
        try {
            const result = await callGeminiVision(base64Jpeg, SCREEN_PROMPT);
            return {
                activity:      result.activity      || null,
                shouldReact:   !!result.shouldReact,
                reactionHint:  result.reactionHint  || null
            };
        } catch (e) {
            console.warn('[Vision] Screen analysis failed:', e.message);
            return { activity: null, shouldReact: false, reactionHint: null };
        }
    },
```

Replace with:

```js
    async analyzeScreen(base64Jpeg) {
        try {
            const result = await callGeminiVision(base64Jpeg, SCREEN_PROMPT);
            return {
                activity:      result.activity      || null,
                shouldReact:   !!result.shouldReact,
                reactionHint:  result.reactionHint  || null
            };
        } catch (e) {
            console.warn('[Vision] Gemini screen analysis failed, trying local:', e.message);
            try {
                const result = await callLMStudioVision(base64Jpeg, SCREEN_PROMPT);
                return {
                    activity:      result.activity      || null,
                    shouldReact:   !!result.shouldReact,
                    reactionHint:  result.reactionHint  || null
                };
            } catch (e2) {
                console.warn('[Vision] Local screen analysis also failed:', e2.message);
                return { activity: null, shouldReact: false, reactionHint: null };
            }
        }
    },
```

- [ ] **Step 4: Wire the fallback into `analyzeCamera()`**

Find:

```js
    async analyzeCamera(base64Jpeg) {
        try {
            const result = await callGeminiVision(base64Jpeg, CAMERA_PROMPT);
            return {
                isPresent:    !!result.isPresent,
                userState:    result.userState    || 'unknown',
                shouldReact:  !!result.shouldReact,
                reactionHint: result.reactionHint || null
            };
        } catch (e) {
            console.warn('[Vision] Camera analysis failed:', e.message);
            return { isPresent: true, userState: 'unknown', shouldReact: false, reactionHint: null };
        }
    }
```

Replace with:

```js
    async analyzeCamera(base64Jpeg) {
        try {
            const result = await callGeminiVision(base64Jpeg, CAMERA_PROMPT);
            return {
                isPresent:    !!result.isPresent,
                userState:    result.userState    || 'unknown',
                shouldReact:  !!result.shouldReact,
                reactionHint: result.reactionHint || null
            };
        } catch (e) {
            console.warn('[Vision] Gemini camera analysis failed, trying local:', e.message);
            try {
                const result = await callLMStudioVision(base64Jpeg, CAMERA_PROMPT);
                return {
                    isPresent:    !!result.isPresent,
                    userState:    result.userState    || 'unknown',
                    shouldReact:  !!result.shouldReact,
                    reactionHint: result.reactionHint || null
                };
            } catch (e2) {
                console.warn('[Vision] Local camera analysis also failed:', e2.message);
                return { isPresent: true, userState: 'unknown', shouldReact: false, reactionHint: null };
            }
        }
    }
```

- [ ] **Step 5: Verify syntax**

```bash
node --check src/vision/VisionAdapter.js
```

Expected: no output (success).

- [ ] **Step 6: Commit**

```bash
git add src/vision/VisionAdapter.js
git commit -m "feat: fall back to local LM Studio vision model when Gemini fails"
```

---

### Task 3: Add the Settings UI field

**Files:**
- Modify: `src/index.html`
- Modify: `src/renderer.js`

- [ ] **Step 1: Add the input field to the Vision settings section**

In `src/index.html`, find (lines 291-301):

```html
          <label class="toggle-row" style="margin-top:12px;">
            <span>
              Camera Emotion Reading
              <span class="hint-text" style="display:block;font-size:10px;margin-top:2px;">Reads your mood via webcam every ~4 min</span>
            </span>
            <span class="toggle-wrap">
              <input type="checkbox" id="camera-vision-toggle" class="toggle-input">
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </span>
          </label>
        </div>
```

Replace with:

```html
          <label class="toggle-row" style="margin-top:12px;">
            <span>
              Camera Emotion Reading
              <span class="hint-text" style="display:block;font-size:10px;margin-top:2px;">Reads your mood via webcam every ~4 min</span>
            </span>
            <span class="toggle-wrap">
              <input type="checkbox" id="camera-vision-toggle" class="toggle-input">
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </span>
          </label>

          <div id="lmstudio-vision-model-group" style="margin-top:12px;">
            <label class="section-label" for="lmstudio-vision-model-input">Local Vision Fallback (LM Studio)</label>
            <input type="text" id="lmstudio-vision-model-input" class="glass-input"
              placeholder="e.g. qwen2.5-vl-3b-instruct" autocomplete="off">
            <p class="hint-text" style="margin-top:5px;">Used automatically if Gemini fails or hits its rate limit. Must match the ID shown at localhost:1234/v1/models. Leave blank to disable.</p>
          </div>
        </div>
```

- [ ] **Step 2: Wire it in `renderer.js`**

In `src/renderer.js`, find the import block:

```js
    setLMStudioModel
} from './settings.js';
```

Replace with:

```js
    setLMStudioModel,
    getLMStudioVisionModel,
    setLMStudioVisionModel
} from './settings.js';
```

- [ ] **Step 3: Populate and wire the debounced save**

Find (lines 1073-1076):

```js
    // Vision toggles
    const screenVisionToggle = document.getElementById('screen-vision-toggle');
    const cameraVisionToggle = document.getElementById('camera-vision-toggle');
```

Replace with:

```js
    // Vision toggles
    const screenVisionToggle = document.getElementById('screen-vision-toggle');
    const cameraVisionToggle = document.getElementById('camera-vision-toggle');

    // LM Studio vision fallback model
    const lmstudioVisionModelInput = document.getElementById('lmstudio-vision-model-input');
    if (lmstudioVisionModelInput) lmstudioVisionModelInput.value = getLMStudioVisionModel();
    let lmstudioVisionModelTimeout;
    if (lmstudioVisionModelInput) {
        lmstudioVisionModelInput.addEventListener('input', (e) => {
            clearTimeout(lmstudioVisionModelTimeout);
            lmstudioVisionModelTimeout = setTimeout(() => {
                setLMStudioVisionModel(e.target.value.trim());
            }, 500);
        });
    }
```

- [ ] **Step 4: Verify syntax**

```bash
node --check src/renderer.js
```

Expected: no output (success).

- [ ] **Step 5: Commit**

```bash
git add src/index.html src/renderer.js
git commit -m "feat: add Settings UI field for LM Studio vision fallback model"
```

---

### Task 4: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Confirm the model is loaded in LM Studio**

If not already done, load the 3B vision model in LM Studio and note its exact model ID (shown at `http://localhost:1234/v1/models` while LM Studio's server is running).

- [ ] **Step 2: Start the app and configure the setting**

```bash
npm start
```

In Settings, paste the exact model ID into the new "Local Vision Fallback (LM Studio)" field.

- [ ] **Step 3: Confirm normal Gemini path still works**

With screen or camera vision enabled and Gemini working normally, confirm nothing changed — console should show the same `[Vision]` success logs as before, no `Gemini ... failed` warnings.

- [ ] **Step 4: Confirm the fallback actually fires**

Temporarily break Gemini access (e.g. clear/corrupt the cloud API key in Settings, or wait for an actual rate limit) and trigger a vision analysis. Confirm the console shows `[Vision] Gemini screen analysis failed, trying local:` followed by either a successful local result or `[Vision] Local screen analysis also failed:` if LM Studio isn't reachable — confirming the fallback path actually executes rather than skipping straight to the neutral default.

- [ ] **Step 5: Confirm the neutral default still works when both fail**

With Gemini broken AND LM Studio's server not running (or vision model field left blank), confirm the app still behaves gracefully — no crash, no hang, Miko just says she can't see anything right now.

- [ ] **Step 6: Restore the real API key**

Put the working Gemini API key back in Settings once testing is done.

- [ ] **Step 7: Report results**

Summarize what worked. If LM Studio's vision model isn't loaded yet at verification time, note that Steps 3-5 are blocked pending that and report what was verified (settings persistence, syntax, the Gemini-success path) versus what still needs a live retest once the model's ready.

---

## Explicitly out of scope for this plan

- Making local vision the primary path (user explicitly chose cloud-primary/local-fallback).
- Any Ollama integration.
- Downloading or configuring the model inside LM Studio itself — a manual GUI step outside this codebase.
