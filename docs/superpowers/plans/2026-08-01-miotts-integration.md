# MioTTS Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SAPI5 as the default local TTS engine with MioTTS-0.6B (Q8_0, GPU-accelerated via llama.cpp), with automatic fallback to SAPI5 if MioTTS isn't built/available.

**Architecture:** `MioTTS-llama.cpp` is built as a standalone C++ CLI binary (`miotts.exe`) with CUDA GPU offload, invoked as a subprocess from `tts_server.py` exactly like `SystemTTS` invokes SAPI5 today. A new `MioTTS` class wraps subprocess invocation. Availability is checked once at server startup; if the binary or model files are missing, `/synthesize` transparently uses `SystemTTS` instead and reports which engine actually ran. `settings.js` gets `TTS_ENGINE.MIOTTS` and it becomes the new default.

**Tech Stack:** C++ (llama.cpp fork), CMake, CUDA (GPU offload via `-ngl`), Python (FastAPI server unchanged in shape), no new Python dependencies.

---

## Important context for the engineer

- Repo root: `C:\Users\Lokesh\Desktop\Pojects\Waifu`
- TTS server lives at `tts/tts_server.py`, currently only implements `SystemTTS` (SAPI5). Read it before starting — it's ~130 lines, small.
- `tts/.venv/` is an isolated Python 3.11 venv — do not add new pip packages to it for this feature. MioTTS runs as an external binary, not a Python import.
- `CLAUDE.md` rule: "Don't add top-level imports to `tts_server.py` for optional engines (lazy-load them)". Follow this for MioTTS too.
- Settings are all in `src/settings.js`, keys prefixed `waifu_*`, `TTS_ENGINE` enum currently has `SYSTEM` and `ELEVEN_LABS` (StyleTTS2 was already removed in a prior cleanup — do not reintroduce it).
- Target voice for now: **`en_female`** stock preset. No voice cloning in this plan — `tts/voices/miko_ref.wav` stays untouched for a future pass.
- Model choice: **MioTTS-0.6B**, quantization **Q8_0**, for both the LLM component and `miocodec.gguf`.
- GPU offload is wanted (`-ngl`) — user has an RTX 5050 with ~1.4GB VRAM headroom after their local chat LLM (LM Studio, qwen2.5-7b-instruct) is loaded.
- The build step (Task 1) requires Visual Studio Build Tools (C++ workload) and CMake 3.14+ to be installed on the user's machine. This cannot be scripted reliably — the engineer must run it interactively and report back if a required tool is missing, rather than guessing around it.

---

### Task 1: Document and perform the MioTTS build (manual, one-time)

**Files:**
- Create: `tts/miotts/SETUP.md`

- [ ] **Step 1: Write the setup doc**

Create `tts/miotts/SETUP.md`:

```markdown
# MioTTS Build Setup (one-time, manual)

MioTTS runs as a standalone C++ binary (not a Python package). This is a one-time
build step — the resulting `build/` and `models/` folders are gitignored.

## Prerequisites
- CMake 3.14+ (`cmake --version` to check)
- A C++ compiler toolchain: Visual Studio Build Tools with the "Desktop development
  with C++" workload (or full Visual Studio)
- CUDA Toolkit installed and on PATH, matching your GPU driver (for `-ngl` GPU offload)
- ~600MB free disk space for the build, ~1GB more for the Q8_0 models

## 1. Clone and build

Run from `tts/miotts/`:

```bash
git clone --recursive https://github.com/espresso3389/MioTTS-llama.cpp.git src
cd src
mkdir build
cd build
cmake .. -DGGML_CUDA=ON
cmake --build . --config Release --target miotts
```

If `-DGGML_CUDA=ON` fails because CUDA isn't found, install the CUDA Toolkit
matching your driver version first, then retry.

On success, the binary is at `tts/miotts/src/build/Release/miotts.exe` (or
`tts/miotts/src/build/miotts.exe` depending on generator — check both).
Copy or symlink it to `tts/miotts/build/miotts.exe` — this is the fixed path
`tts_server.py` expects.

## 2. Download models (0.6B, Q8_0)

Use the download scripts provided in the cloned repo (`src/scripts/` or similar —
check the repo README for the exact script name, it may have changed). You need
three files, placed in `tts/miotts/models/`:

- `MioTTS-0.6B-Q8_0.gguf` — the LLM component
- `miocodec.gguf` — the audio codec (Q8_0)
- `en_female.emb.gguf` — the stock English female voice embedding

If the download script doesn't support 0.6B directly, download manually from
https://huggingface.co/Aratako/MioTTS-GGUF (or the 0.6B-specific repo under the
Aratako collection: https://huggingface.co/collections/Aratako/miotts) and the
voice embeddings from the same source repo's `models/` or `voices/` folder.

## 3. Verify the build works standalone

From `tts/miotts/`:

```bash
build/miotts.exe -m models/MioTTS-0.6B-Q8_0.gguf -c models/miocodec.gguf -v models/en_female.emb.gguf -ngl 99 -p "Hello, this is a test of the voice." -o test_output.wav
```

Play `test_output.wav`. Confirm:
- It produces audible, correct speech (not silence/noise)
- GPU is actually used: run `nvidia-smi` in another terminal while the command
  runs, confirm `miotts.exe` shows up as a process using VRAM

Expected final layout:
```
tts/miotts/
  SETUP.md
  build/miotts.exe
  models/MioTTS-0.6B-Q8_0.gguf
  models/miocodec.gguf
  models/en_female.emb.gguf
```

Delete `tts/miotts/src/` and `test_output.wav` after confirming — only
`build/` and `models/` need to stick around.
```

- [ ] **Step 2: Perform the build following the doc above**

This is an interactive, manual step. Run each command from Step 1 for real, in
order. If any tool is missing (CMake, VS Build Tools, CUDA Toolkit), stop and
report exactly what's missing rather than trying to work around it — the user
needs to install it themselves.

- [ ] **Step 3: Verify standalone synthesis works**

Run the verification command from Step 1, part 3. Confirm `test_output.wav` is
valid audio (play it, or check with `python -c "import soundfile as sf; print(sf.info('test_output.wav'))"`
from within `tts/.venv` — should show a nonzero duration and 22050+ sample rate).
Confirm `nvidia-smi` shows GPU usage during synthesis.

Do not proceed to Task 2 until this works. If synthesis produces silence or
garbage, that's a build/model problem to fix here, not a server integration bug
to chase later.

- [ ] **Step 4: Commit the setup doc**

```bash
git add tts/miotts/SETUP.md
git commit -m "docs: add MioTTS build setup instructions"
```

(The `build/` and `models/` folders are added to `.gitignore` in Task 2, so they
won't accidentally get staged here.)

---

### Task 2: Gitignore the build artifacts

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add MioTTS build/model paths to `.gitignore`**

Open `.gitignore` and add:

```
# MioTTS build artifacts (built locally per tts/miotts/SETUP.md)
tts/miotts/build/
tts/miotts/models/
tts/miotts/src/
```

- [ ] **Step 2: Confirm git status is clean**

```bash
git status
```

Expected: `tts/miotts/build/`, `tts/miotts/models/` do not appear as untracked
(they're now ignored). `tts/miotts/SETUP.md` was already committed in Task 1.

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore MioTTS build artifacts"
```

---

### Task 3: Add the `MioTTS` class to `tts_server.py`

**Files:**
- Modify: `tts/tts_server.py`

- [ ] **Step 1: Add path constants and the `MioTTS` class**

In `tts/tts_server.py`, after the existing `SystemTTS` class (after line 47,
`system_tts = SystemTTS()`), add:

```python
# ─── MioTTS (GPU-accelerated local neural TTS) ───────────────────────────────

import subprocess
from pathlib import Path

MIOTTS_DIR    = Path(__file__).parent / "miotts"
MIOTTS_BIN    = MIOTTS_DIR / "build" / "miotts.exe"
MIOTTS_MODEL  = MIOTTS_DIR / "models" / "MioTTS-0.6B-Q8_0.gguf"
MIOTTS_CODEC  = MIOTTS_DIR / "models" / "miocodec.gguf"
MIOTTS_VOICE  = MIOTTS_DIR / "models" / "en_female.emb.gguf"


class MioTTS:
    def is_available(self) -> bool:
        return (
            MIOTTS_BIN.exists()
            and MIOTTS_MODEL.exists()
            and MIOTTS_CODEC.exists()
            and MIOTTS_VOICE.exists()
        )

    def synthesize(self, text: str, output_file: str):
        result = subprocess.run(
            [
                str(MIOTTS_BIN),
                "-m", str(MIOTTS_MODEL),
                "-c", str(MIOTTS_CODEC),
                "-v", str(MIOTTS_VOICE),
                "-ngl", "99",
                "-p", text,
                "-o", output_file,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            logger.error(f"MioTTS failed (exit {result.returncode}): {result.stderr}")
            raise RuntimeError(f"MioTTS synthesis failed: {result.stderr[:200]}")


mio_tts = MioTTS()
```

- [ ] **Step 2: Verify syntax**

```bash
cd tts && ../tts/.venv/Scripts/python -m py_compile tts_server.py
```

Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add tts/tts_server.py
git commit -m "feat: add MioTTS subprocess wrapper to TTS server"
```

---

### Task 4: Wire MioTTS into the `/synthesize` endpoint with fallback

**Files:**
- Modify: `tts/tts_server.py`

- [ ] **Step 1: Update the lifespan log line to report MioTTS availability**

Replace the `lifespan` function (currently):

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("TTS Server starting (system/SAPI5 only)")
    yield
    logger.info("TTS Server shutting down")
```

with:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    if mio_tts.is_available():
        logger.info("TTS Server starting (MioTTS available, SAPI5 fallback ready)")
    else:
        logger.warning(
            "TTS Server starting (MioTTS NOT found at %s — falling back to SAPI5. "
            "See tts/miotts/SETUP.md to build it.)",
            MIOTTS_BIN,
        )
    yield
    logger.info("TTS Server shutting down")
```

- [ ] **Step 2: Update `/health` to report MioTTS status**

Replace:

```python
@app.get("/health")
async def health_check():
    return {
        "status": "ready",
        "active_engine": "system",
        "available_engines": ["system"],
    }
```

with:

```python
@app.get("/health")
async def health_check():
    engines = ["system"]
    if mio_tts.is_available():
        engines.append("miotts")
    return {
        "status": "ready",
        "active_engine": "miotts" if mio_tts.is_available() else "system",
        "available_engines": engines,
    }
```

- [ ] **Step 3: Update `/synthesize` to try MioTTS first, fall back to SAPI5**

Replace the body of `synthesize()` (the `await asyncio.to_thread(system_tts.synthesize, ...)`
line and the `"engine": "system"` field in the return dict) as follows.

Current relevant lines:

```python
        await asyncio.to_thread(system_tts.synthesize, request.text, temp_file)

        if not os.path.exists(temp_file) or os.path.getsize(temp_file) == 0:
            raise HTTPException(status_code=500, detail="Audio generation failed (empty output)")
```

and further down:

```python
        return {
            "audio":       b64_audio,
            "sample_rate": sample_rate,
            "duration":    duration,
            "engine":      "system",
        }
```

Replace both spots — full new `synthesize()` function body:

```python
@app.post("/synthesize")
async def synthesize(request: SynthesisRequest):
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    temp_file = ""
    engine_used = "system"
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as fp:
            temp_file = fp.name

        if mio_tts.is_available():
            try:
                await asyncio.to_thread(mio_tts.synthesize, request.text, temp_file)
                engine_used = "miotts"
            except Exception as e:
                logger.warning(f"MioTTS failed, falling back to SAPI5: {e}")
                await asyncio.to_thread(system_tts.synthesize, request.text, temp_file)
                engine_used = "system"
        else:
            await asyncio.to_thread(system_tts.synthesize, request.text, temp_file)
            engine_used = "system"

        if not os.path.exists(temp_file) or os.path.getsize(temp_file) == 0:
            raise HTTPException(status_code=500, detail="Audio generation failed (empty output)")

        with open(temp_file, "rb") as f:
            audio_data = f.read()

        b64_audio = base64.b64encode(audio_data).decode("utf-8")

        try:
            info        = sf.info(temp_file)
            duration    = info.duration
            sample_rate = info.samplerate
        except Exception:
            duration    = 0
            sample_rate = 22050

        return {
            "audio":       b64_audio,
            "sample_rate": sample_rate,
            "duration":    duration,
            "engine":      engine_used,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Synthesis failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if temp_file and os.path.exists(temp_file):
            try:
                os.unlink(temp_file)
            except Exception:
                pass
```

Note: the incoming `request.engine` field (from the client) is intentionally
ignored here — MioTTS-vs-SAPI5 selection is a server-side capability decision
(is MioTTS built and working?), not a per-request client choice. ElevenLabs
stays a separate client-side path in `voice-service.js` and never reaches this
endpoint.

- [ ] **Step 4: Verify syntax**

```bash
cd tts && .venv/Scripts/python -m py_compile tts_server.py
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add tts/tts_server.py
git commit -m "feat: try MioTTS first in /synthesize, fall back to SAPI5"
```

---

### Task 5: Add `TTS_ENGINE.MIOTTS` to settings and make it the default

**Files:**
- Modify: `src/settings.js`

- [ ] **Step 1: Add the new engine constant**

Find the `TTS_ENGINE` export (around line 33-36):

```javascript
export const TTS_ENGINE = Object.freeze({
    SYSTEM:      'system',      // SAPI5 (Windows, no setup)
    ELEVEN_LABS: 'elevenlabs'   // ElevenLabs cloud API
});
```

Replace with:

```javascript
export const TTS_ENGINE = Object.freeze({
    MIOTTS:      'miotts',      // Local GPU neural TTS (default) — falls back to SAPI5 server-side if not built
    SYSTEM:      'system',      // SAPI5 (Windows, no setup)
    ELEVEN_LABS: 'elevenlabs'   // ElevenLabs cloud API
});
```

- [ ] **Step 2: Find and update the default engine getter**

Search for the function that reads the stored TTS engine setting (grep for
`getTTSEngine` in `src/settings.js`). It will look like:

```javascript
export function getTTSEngine() {
    return localStorage.getItem(STORAGE_KEYS.TTS_ENGINE) || TTS_ENGINE.SYSTEM;
}
```

Change the fallback default from `TTS_ENGINE.SYSTEM` to `TTS_ENGINE.MIOTTS`:

```javascript
export function getTTSEngine() {
    return localStorage.getItem(STORAGE_KEYS.TTS_ENGINE) || TTS_ENGINE.MIOTTS;
}
```

- [ ] **Step 3: Verify syntax**

```bash
node --check src/settings.js
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/settings.js
git commit -m "feat: make MioTTS the default TTS engine"
```

---

### Task 6: Update `index.html` engine selector to include MioTTS

**Files:**
- Modify: `src/index.html`

- [ ] **Step 1: Locate the existing engine radio buttons**

They're at `src/index.html:203-217`, currently:

```html
        <div id="voice-settings-group" class="setting-section hidden">
          <div class="section-label">TTS Engine</div>
          <div class="radio-stack">
            <label class="radio-option">
              <input type="radio" name="tts-engine" value="system" checked>
              <span class="radio-dot"></span>
              <span>System <em>(Windows built-in)</em></span>
            </label>
            <label class="radio-option">
              <input type="radio" name="tts-engine" value="elevenlabs">
              <span class="radio-dot"></span>
              <span>ElevenLabs <em>(Cloud · Expressive)</em></span>
            </label>
          </div>
        </div>
```

- [ ] **Step 2: Add a MioTTS radio option as the new default**

Replace that block with:

```html
        <div id="voice-settings-group" class="setting-section hidden">
          <div class="section-label">TTS Engine</div>
          <div class="radio-stack">
            <label class="radio-option">
              <input type="radio" name="tts-engine" value="miotts" checked>
              <span class="radio-dot"></span>
              <span>MioTTS <em>(Local · GPU · Recommended)</em></span>
            </label>
            <label class="radio-option">
              <input type="radio" name="tts-engine" value="system">
              <span class="radio-dot"></span>
              <span>System <em>(Windows built-in)</em></span>
            </label>
            <label class="radio-option">
              <input type="radio" name="tts-engine" value="elevenlabs">
              <span class="radio-dot"></span>
              <span>ElevenLabs <em>(Cloud · Expressive)</em></span>
            </label>
          </div>
        </div>
```

Note: `checked` moved from the `system` radio to the new `miotts` radio, so the
UI's default matches the `TTS_ENGINE.MIOTTS` default set in `settings.js` in
Task 5.

- [ ] **Step 3: Manually verify in browser**

Run `npm start`, open Settings, confirm the MioTTS option appears and is
selected by default, and that selecting System/ElevenLabs still works (doesn't
throw console errors).

- [ ] **Step 4: Commit**

```bash
git add src/index.html
git commit -m "feat: add MioTTS option to TTS engine selector UI"
```

---

### Task 7: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Start the app**

```bash
npm start
```

- [ ] **Step 2: Check the TTS server log**

Confirm the terminal shows either:
`[TTS] INFO:tts-server:TTS Server starting (MioTTS available, SAPI5 fallback ready)`

If it instead shows the SAPI5-fallback warning, go back and confirm all 4 files
from Task 1 exist at the exact paths `MIOTTS_BIN`/`MIOTTS_MODEL`/`MIOTTS_CODEC`/
`MIOTTS_VOICE` expect in `tts_server.py`.

- [ ] **Step 3: Hit `/health` directly**

```bash
curl -s http://127.0.0.1:19765/health
```

Expected: `{"status":"ready","active_engine":"miotts","available_engines":["system","miotts"]}`

- [ ] **Step 4: Hit `/synthesize` directly**

```bash
curl -s -X POST http://127.0.0.1:19765/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this is a test."}' | python -c "import sys,json,base64; d=json.load(sys.stdin); print('engine:', d['engine']); open('curl_test.wav','wb').write(base64.b64decode(d['audio']))"
```

Play `curl_test.wav`, confirm it sounds like MioTTS (not the SAPI5 robotic
voice), then delete the file.

- [ ] **Step 5: Full app test**

In the running app, send a chat message to Miko. Confirm:
- She responds with voice audio (not silence, not an error toast)
- The voice is noticeably better/more natural than the old SAPI5 voice
- Mouth-sync animation still tracks the audio

- [ ] **Step 6: Fallback test**

Temporarily rename `tts/miotts/build/miotts.exe` to `miotts.exe.bak`, restart
`npm start`, confirm:
- Startup log shows the SAPI5-fallback warning
- `/health` shows `"active_engine":"system"`, `"available_engines":["system"]`
- Chat still produces voice audio (via SAPI5, no crash)

Rename it back to `miotts.exe` afterward and restart once more to confirm
MioTTS is active again.

- [ ] **Step 7: Report results**

Summarize what worked, what didn't, and any audio quality impressions —
this is the point where voice cloning (deferred, not in this plan) would be
decided as a next step or not.

---

## Explicitly out of scope for this plan

- Voice cloning from `tts/voices/miko_ref.wav` (deferred until stock voice is evaluated)
- Any changes to ElevenLabs or LM Studio integration
- Automating the C++ build from `main.js` (stays a manual one-time step)
