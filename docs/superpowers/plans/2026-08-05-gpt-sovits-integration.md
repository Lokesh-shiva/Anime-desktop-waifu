# GPT-SoVITS Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GPT-SoVITS Miko's primary TTS voice via a standalone sidecar service, with MioTTS and SAPI5 remaining as fallback tiers.

**Architecture:** Promote `tts/gpt-sovits-eval/` → `tts/gpt-sovits/`. A small launcher script applies the same environment workarounds discovered during evaluation (torchaudio→soundfile patch, UTF-8 console encoding) before starting the real `api_v2.py` server on port 9881. `main.js` spawns it exactly like it spawns `tts_server.py`. A new `GPTSoVITS` class in `tts_server.py` calls it over HTTP via `requests` (already installed, no new dependency), added as the new first tier in the existing MioTTS→SAPI5 cascade.

**Tech Stack:** Python (FastAPI sidecar via GPT-SoVITS's own `api_v2.py`), `requests` for the HTTP client, Node.js `child_process.spawn` in `main.js` (same pattern as the existing TTS server spawn).

---

## Important context for the engineer

- Repo root: `C:\Users\Lokesh\Desktop\Pojects\Waifu`. No automated test suite — verification is manual via live `npm start`.
- The evaluation already proved this works: `tts/GPT_SOVITS_EVALUATION.md` has the full measured writeup, and `tts/gpt-sovits-eval/run_eval.py` is a working reference implementation of exactly how to load and call GPT-SoVITS. This plan promotes that eval directory to permanent status rather than redoing any of that discovery work.
- The eval venv (`tts/gpt-sovits-eval/.venv`) already has the two persistent workarounds baked in: a `jieba_fast` shim package at `.venv/Lib/site-packages/jieba_fast/` (re-exports pure-Python `jieba`), and `nltk`'s `averaged_perceptron_tagger_eng` data already downloaded to the user-level `%APPDATA%\nltk_data` (not project-local — survives the directory rename/move in Task 1).
- The `torchaudio.load` → `soundfile` monkeypatch and `PYTHONIOENCODING=utf-8` fix are NOT yet baked into anything persistent — `run_eval.py` applied them itself at the top of the script (see `tts/gpt-sovits-eval/run_eval.py` lines 1-16). Task 2 below creates a small launcher that applies the same patches before importing `api_v2`.
- `GPT_SoVITS/configs/tts_infer.yaml`'s `custom` profile (the default profile `api_v2.py` loads) already points at the correct v2 zero-shot weights with `device: cuda`, `is_half: true` — confirmed by reading the file directly. No config edit needed.
- The confirmed-working reference audio is `tts/gpt-sovits-eval/ref_audio/ref_clip.wav` with the exact transcript `"wants to blend into the crowd. Singing, dancing, and spinning, hand in hand with"` (from `tts/gpt-sovits-eval/run_eval.py` lines 34-35) — this exact pairing was what produced the clone the user confirmed sounds like Cartethyia. Do not swap in a different clip/transcript pairing without re-confirming quality.
- `api_v2.py`'s `/tts` endpoint accepts POST with JSON body (documented in its own docstring, `tts/gpt-sovits-eval/api_v2.py` lines 1-40): `text`, `text_lang`, `ref_audio_path`, `prompt_text`, `prompt_lang`, plus optional sampling params. Language codes needed here are `"en"` for English (verify against `tts/gpt-sovits-eval/GPT_SoVITS/configs/tts_infer.yaml` / `api_v2.py`'s language validation if the exact string differs — the docstring example uses `"zh"` for Chinese, English is `"en"`).
- `tts_server.py`'s existing `MioTTS` class (`tts/tts_server.py` lines 72-129) and its usage in `/synthesize` (lines 174-199) are the exact pattern to mirror — same file, same shape, just one more tier.
- `main.js`'s `startTTSServer()` (lines 772-825) and its supporting state (`ttsProcess`, `ttsRetryCount`, `TTS_PORT`, `killPortStalker()`, lines 745-770) are the exact pattern to mirror for the sidecar spawn — same file, parallel constants/functions with a `Sidecar`/`GPTSoVITS` naming prefix instead of `tts`/`TTS`.
- `requests` is already installed in `tts/.venv` (verified via `tts/.venv/Scripts/python.exe -c "import requests"` — succeeded). `httpx` is also present but `requests` is used here since it matches the sync-call-wrapped-in-`asyncio.to_thread` pattern `mio_tts.synthesize` already uses, keeping the two engine classes structurally identical.

---

### Task 1: Promote the eval directory to permanent status

**Files:**
- Rename: `tts/gpt-sovits-eval/` → `tts/gpt-sovits/`
- Modify: `.gitignore`

- [ ] **Step 1: Rename the directory**

```bash
cd "C:\Users\Lokesh\Desktop\Pojects\Waifu\tts"
mv gpt-sovits-eval gpt-sovits
```

- [ ] **Step 2: Clean up eval-only artifacts not needed going forward**

These were evaluation scaffolding, not part of the running service — remove them so the permanent directory doesn't carry dead eval code:

```bash
cd "C:\Users\Lokesh\Desktop\Pojects\Waifu\tts\gpt-sovits"
rm -f run_eval.py fft_compare.py test_expressiveness.py expr_log.txt
rm -rf outputs
```

(Leave `pretrained_models.zip` — it's the source archive; leave it in place rather than re-downloading if ever needed. Leave `ref_audio/`, `.venv/`, `GPT_SoVITS/`, `api_v2.py`, `config.py`, and everything else untouched.)

- [ ] **Step 3: Update `.gitignore`**

In `C:\Users\Lokesh\Desktop\Pojects\Waifu\.gitignore`, find:

```
# GPT-SoVITS evaluation (standalone, not integrated — see tts/GPT_SOVITS_EVALUATION.md)
tts/gpt-sovits-eval/
```

Replace with:

```
# GPT-SoVITS sidecar (built locally — see tts/GPT_SOVITS_EVALUATION.md for how it got here)
tts/gpt-sovits/
```

- [ ] **Step 4: Verify the venv still resolves correctly after the move**

```bash
"C:\Users\Lokesh\Desktop\Pojects\Waifu\tts\gpt-sovits\.venv\Scripts\python.exe" -c "import torch; print('torch OK', torch.cuda.is_available())"
```

Expected: `torch OK True` (venvs use relative/portable paths for pure-Python imports; this confirms the rename didn't break anything obvious. If this fails, STOP — do not proceed, the venv may have absolute-path references that broke on rename, and that needs investigating before continuing).

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\Lokesh\Desktop\Pojects\Waifu"
git add .gitignore
git commit -m "chore: promote GPT-SoVITS from eval to permanent sidecar directory"
```

(Note: `tts/gpt-sovits/` itself is gitignored, so only the `.gitignore` change is tracked — this commit records the rename's effect on tracked files, not the directory contents.)

---

### Task 2: Create the sidecar launcher script

**Files:**
- Create: `tts/gpt-sovits/run_sidecar.py`

- [ ] **Step 1: Write the launcher**

This applies the same environment workarounds `run_eval.py` used (torchaudio→soundfile patch), sets up `sys.path` the way GPT-SoVITS's internal modules expect, then hands off to the real `api_v2.py`'s own argument parsing and server startup — without modifying the upstream `api_v2.py` file itself, so it stays easy to diff against future GPT-SoVITS updates.

Create `tts/gpt-sovits/run_sidecar.py`:

```python
"""
Sidecar launcher for the GPT-SoVITS API server.
Applies the environment workarounds discovered during evaluation
(see ../GPT_SOVITS_EVALUATION.md) before handing off to the real api_v2.py.
Usage: python run_sidecar.py -a 127.0.0.1 -p 9881
"""
import os
import sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.abspath("."))
sys.path.insert(0, os.path.abspath("GPT_SoVITS"))

import torch
import soundfile as sf
import torchaudio

# torchcodec/ffmpeg isn't set up in this venv — same workaround as the eval
# and the earlier Fish Speech evaluation: read audio via soundfile instead.
def _sf_load(path, *args, **kwargs):
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return torch.from_numpy(data.T), sr

torchaudio.load = _sf_load

os.environ.setdefault("is_half", "True")

# api_v2.py parses its own argv (-a/-p/-c) via argparse at import time — just
# run it as __main__ so its own CLI handling and the ordering of its own
# argv reading is unaffected by wrapping.
if __name__ == "__main__":
    exec(compile(open("api_v2.py", encoding="utf-8").read(), "api_v2.py", "exec"), {"__name__": "__main__"})
```

- [ ] **Step 2: Verify syntax**

```bash
"C:\Users\Lokesh\Desktop\Pojects\Waifu\tts\gpt-sovits\.venv\Scripts\python.exe" -m py_compile "C:\Users\Lokesh\Desktop\Pojects\Waifu\tts\gpt-sovits\run_sidecar.py"
```

Expected: no output (success).

- [ ] **Step 3: Manually smoke-test the sidecar starts and serves**

```bash
cd "C:\Users\Lokesh\Desktop\Pojects\Waifu\tts\gpt-sovits"
"./.venv/Scripts/python.exe" run_sidecar.py -a 127.0.0.1 -p 9881
```

Watch the console for the server reporting it's listening on port 9881 (may take 10-30s to load model weights on cold start — this is expected, matches the `Model load time` figure measured in the evaluation report). Leave it running, then in a second terminal:

```bash
curl "http://127.0.0.1:9881/tts?text=hello%20there&text_lang=en&ref_audio_path=ref_audio/ref_clip.wav&prompt_lang=en&prompt_text=wants%20to%20blend%20into%20the%20crowd.%20Singing%2C%20dancing%2C%20and%20spinning%2C%20hand%20in%20hand%20with&text_split_method=cut5" --output C:\Users\Lokesh\Desktop\Pojects\Waifu\tts\gpt-sovits\smoke_test.wav
```

Expected: `smoke_test.wav` is created and non-empty (`ls -la` to confirm size > 0). Play it if possible to confirm it's actually Cartethyia's voice saying "hello there," not silence or an error dump. Stop the sidecar (Ctrl+C) once confirmed. Delete `smoke_test.wav` afterward — it was just a manual check, not a fixture.

- [ ] **Step 4: Commit**

```bash
cd "C:\Users\Lokesh\Desktop\Pojects\Waifu"
git add tts/gpt-sovits/run_sidecar.py
git commit -m "feat: add GPT-SoVITS sidecar launcher script"
```

(Note: `tts/gpt-sovits/` is gitignored as a whole per Task 1 — if `run_sidecar.py` doesn't get picked up by `git add` because the parent directory is ignored, add a `!tts/gpt-sovits/run_sidecar.py` negation line to `.gitignore` right after the `tts/gpt-sovits/` ignore line, then retry. This file is source code we wrote, not a build artifact, so it should be tracked even though the rest of the directory isn't.)

---

### Task 3: Spawn the sidecar from `main.js`

**Files:**
- Modify: `main.js`

- [ ] **Step 1: Add sidecar state and constants**

In `main.js`, find (around line 745-749):

```js
let ttsProcess = null;
let ttsRetryCount = 0;
const TTS_PORT = 19765;
const TTS_MAX_RETRIES = 5;
const TTS_RETRY_DELAY_MS = 3000;
```

Right after it, add:

```js

let sidecarProcess = null;
let sidecarRetryCount = 0;
const SIDECAR_PORT = 9881;
const SIDECAR_MAX_RETRIES = 5;
const SIDECAR_RETRY_DELAY_MS = 3000;
```

- [ ] **Step 2: Add a port-cleanup helper for the sidecar port**

Right after `killPortStalker()` (ends around line 770), add:

```js

// Kill any stale process on SIDECAR_PORT (same pattern as killPortStalker)
function killSidecarPortStalker() {
    if (process.platform !== 'win32') return;
    try {
        const { spawnSync } = require('child_process');
        const netstat = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
        if (!netstat.stdout) return;
        for (const line of netstat.stdout.split('\n')) {
            if (line.includes(`:${SIDECAR_PORT} `) && line.includes('LISTEN')) {
                const parts = line.trim().split(/\s+/);
                const pid = parseInt(parts[parts.length - 1], 10);
                if (pid > 4) {
                    spawnSync('taskkill', ['/F', '/PID', String(pid)]);
                    console.log(`[Main] Killed stale process on port ${SIDECAR_PORT} (pid=${pid})`);
                }
                break;
            }
        }
    } catch (_) { /* No stale process — ignore */ }
}
```

- [ ] **Step 3: Add `startSidecarServer()`**

Right after `startTTSServer()`'s closing brace (the function ends around line 826, right before the next section) — find where it ends by locating the `}` that matches its opening, then add this new function immediately after it:

```js

// Start GPT-SoVITS sidecar on app ready with retry logic
function startSidecarServer() {
    killSidecarPortStalker();
    console.log('[Main] Starting GPT-SoVITS sidecar...');
    const sidecarDir    = path.join(resourcesBase, 'tts', 'gpt-sovits');
    const scriptPath    = path.join(sidecarDir, 'run_sidecar.py');

    if (!fs.existsSync(scriptPath)) {
        console.log('[Main] GPT-SoVITS sidecar not installed — skipping (MioTTS/SAPI5 remain available)');
        return;
    }

    const venvPython = process.platform === 'win32'
        ? path.join(sidecarDir, '.venv', 'Scripts', 'python.exe')
        : path.join(sidecarDir, '.venv', 'bin', 'python');
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : 'python';
    console.log('[Main] Using Python for sidecar:', pythonCmd);

    sidecarProcess = spawn(pythonCmd, [scriptPath, '-a', '127.0.0.1', '-p', SIDECAR_PORT.toString()], {
        cwd: sidecarDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });

    sidecarProcess.stdout.on('data', (data) => {
        console.log('[Sidecar]', data.toString().trim());
    });

    sidecarProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg.includes('INFO:') || msg.includes('WARNING:')) {
            console.log('[Sidecar]', msg);
        } else {
            console.error('[Sidecar Error]', msg);
        }
    });

    sidecarProcess.on('close', (code) => {
        console.log(`[Main] GPT-SoVITS sidecar exited with code ${code}`);
        sidecarProcess = null;

        if (code !== 0 && sidecarRetryCount < SIDECAR_MAX_RETRIES) {
            sidecarRetryCount++;
            console.log(`[Main] Retrying GPT-SoVITS sidecar in ${SIDECAR_RETRY_DELAY_MS / 1000}s (attempt ${sidecarRetryCount}/${SIDECAR_MAX_RETRIES})...`);
            setTimeout(startSidecarServer, SIDECAR_RETRY_DELAY_MS);
        } else if (code !== 0) {
            console.error('[Main] GPT-SoVITS sidecar failed to start after max retries — MioTTS/SAPI5 remain available');
        }
    });
}
```

- [ ] **Step 4: Call `startSidecarServer()` alongside `startTTSServer()`**

Find where `startTTSServer()` is called (search for `startTTSServer()` as a call, not the function definition — it should be in the `app.whenReady()` or equivalent startup block). Add a call to `startSidecarServer()` immediately after it:

```js
    startTTSServer();
    startSidecarServer();
```

- [ ] **Step 5: Add sidecar cleanup alongside existing TTS process cleanup**

Find the existing TTS process cleanup block (around line 363, referenced in the earlier `if (ttsProcess) {` context — this runs on app quit). Find the exact block:

```js
    if (ttsProcess) {
```

Read the surrounding ~20 lines first to see the exact cleanup shape (kill via taskkill on Windows, SIGKILL fallback), then add an equivalent block for `sidecarProcess` right after it, following the identical pattern but substituting `sidecarProcess` for `ttsProcess`.

- [ ] **Step 6: Verify syntax**

```bash
node --check main.js && echo OK
```

Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add main.js
git commit -m "feat: spawn GPT-SoVITS sidecar alongside the TTS server"
```

---

### Task 4: Add the `GPTSoVITS` client class and wire it into the cascade

**Files:**
- Modify: `tts/tts_server.py`

- [ ] **Step 1: Add the `GPTSoVITS` class**

In `tts/tts_server.py`, find the MioTTS section boundary — right after the `mio_tts = MioTTS()` line (line 132) and before the `# ─── API models ───` comment (line 135), add:

```python

# ─── GPT-SoVITS (sidecar HTTP client) ────────────────────────────────────────

import requests

GPTSOVITS_URL     = "http://127.0.0.1:9881"
GPTSOVITS_TIMEOUT = 30  # seconds — covers the 60s-runaway-generation failure
                        # mode observed in evaluation by failing well before it
GPTSOVITS_REF_AUDIO = str(Path(__file__).parent / "gpt-sovits" / "ref_audio" / "ref_clip.wav")
GPTSOVITS_REF_TEXT  = "wants to blend into the crowd. Singing, dancing, and spinning, hand in hand with"


class GPTSoVITS:
    def is_available(self) -> bool:
        try:
            resp = requests.get(f"{GPTSOVITS_URL}/", timeout=2)
            return resp.status_code < 500
        except Exception:
            return False

    def synthesize(self, text: str, output_file: str):
        resp = requests.get(
            f"{GPTSOVITS_URL}/tts",
            params={
                "text": text,
                "text_lang": "en",
                "ref_audio_path": GPTSOVITS_REF_AUDIO,
                "prompt_lang": "en",
                "prompt_text": GPTSOVITS_REF_TEXT,
                "text_split_method": "cut5",
            },
            timeout=GPTSOVITS_TIMEOUT,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"GPT-SoVITS synthesis failed (status {resp.status_code}): {resp.text[:200]}")
        with open(output_file, "wb") as f:
            f.write(resp.content)


gpt_sovits = GPTSoVITS()
```

- [ ] **Step 2: Wire it into the `/synthesize` cascade**

In `tts/tts_server.py`, find (lines 185-195):

```python
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
```

Replace with:

```python
        if gpt_sovits.is_available():
            try:
                await asyncio.to_thread(gpt_sovits.synthesize, request.text, temp_file)
                engine_used = "gptsovits"
            except Exception as e:
                logger.warning(f"GPT-SoVITS failed, falling back: {e}")
                engine_used = None  # fall through below
        else:
            engine_used = None

        if engine_used is None:
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
```

- [ ] **Step 3: Update the startup log message**

Find (lines 146-155):

```python
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

Replace with:

```python
async def lifespan(app: FastAPI):
    gptsovits_status = "available" if gpt_sovits.is_available() else "not reachable yet (sidecar may still be loading)"
    miotts_status = "available" if mio_tts.is_available() else "not found"
    logger.info(f"TTS Server starting (GPT-SoVITS {gptsovits_status}; MioTTS {miotts_status}; SAPI5 always ready)")
    yield
    logger.info("TTS Server shutting down")
```

- [ ] **Step 4: Update the `/health` endpoint**

Find (lines 162-171):

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

Replace with:

```python
@app.get("/health")
async def health_check():
    engines = ["system"]
    if mio_tts.is_available():
        engines.append("miotts")
    if gpt_sovits.is_available():
        engines.append("gptsovits")
    active = "gptsovits" if gpt_sovits.is_available() else ("miotts" if mio_tts.is_available() else "system")
    return {
        "status": "ready",
        "active_engine": active,
        "available_engines": engines,
    }
```

- [ ] **Step 5: Verify syntax**

```bash
"C:\Users\Lokesh\Desktop\Pojects\Waifu\tts\.venv\Scripts\python.exe" -m py_compile "C:\Users\Lokesh\Desktop\Pojects\Waifu\tts\tts_server.py"
```

Expected: no output (success).

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\Lokesh\Desktop\Pojects\Waifu"
git add tts/tts_server.py
git commit -m "feat: add GPT-SoVITS as primary TTS engine ahead of MioTTS/SAPI5"
```

---

### Task 5: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the sidecar to the key files table**

In `CLAUDE.md`, find the row for `tts/tts_server.py` in the Key Files table. Right after it, add a new row:

```markdown
| `tts/gpt-sovits/run_sidecar.py` | GPT-SoVITS sidecar launcher — spawned separately from `tts_server.py`, own venv, port 9881 |
```

- [ ] **Step 2: Rewrite the TTS server section**

Find the `## TTS server` section (roughly):

```markdown
## TTS server
Python 3.11 venv at `tts/.venv/`. Started by main.js, prefers venv python over system python. Port 19765.
Engines: **MioTTS** (default, local GPU neural TTS, cloned Cartethyia voice) with **SAPI5** as automatic fallback.
MioTTS runs as a C++ binary at `tts/miotts/build/miotts.exe` — see `tts/miotts/SETUP.md` for build steps,
tuning rationale, and known limitations. Unstable generations are auto-detected (codes-per-word ratio)
and retried with a new random seed before falling back to SAPI5.
```

Replace with:

```markdown
## TTS server
Python 3.11 venv at `tts/.venv/`. Started by main.js, prefers venv python over system python. Port 19765.
Engine cascade: **GPT-SoVITS** (primary — cloned Cartethyia voice, best naturalness/breath/pacing) →
**MioTTS** (fallback — local GPU neural TTS, own C++ binary) → **SAPI5** (last-resort system voice).

GPT-SoVITS runs as a separate sidecar process (`tts/gpt-sovits/run_sidecar.py`, own venv at
`tts/gpt-sovits/.venv/`, port 9881) spawned alongside the main TTS server — fully isolated dependencies,
so a GPT-SoVITS issue can never break the main TTS server process. `tts_server.py` calls it over HTTP with
a 30s timeout; any failure (unreachable, timeout, non-200) falls through to MioTTS automatically.
See `tts/GPT_SOVITS_EVALUATION.md` for how the reference clip/transcript pairing was chosen and measured.

MioTTS runs as a C++ binary at `tts/miotts/build/miotts.exe` — see `tts/miotts/SETUP.md` for build steps,
tuning rationale, and known limitations. Unstable generations are auto-detected (codes-per-word ratio)
and retried with a new random seed before falling back to SAPI5.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for GPT-SoVITS as primary TTS engine"
```

---

### Task 6: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Start the app**

```bash
npm start
```

- [ ] **Step 2: Confirm both processes start**

Watch console for `[Main] Starting TTS server...` / `[TTS] ... Uvicorn running on http://127.0.0.1:19765` AND `[Main] Starting GPT-SoVITS sidecar...` / `[Sidecar] ... Uvicorn running on http://127.0.0.1:9881`. The sidecar will take longer to report ready (model weight loading, ~10-30s per the evaluation's measured load time) — this is expected, not a hang.

- [ ] **Step 3: Confirm GPT-SoVITS is the active engine**

Chat with Miko. Listen — it should sound like the "10x better" naturalness confirmed earlier, not MioTTS's flatter delivery. If possible, temporarily add a `print(engine_used)` right after it's set in `/synthesize` (or check server logs) to directly confirm `engine_used == "gptsovits"`, then remove the temporary log.

- [ ] **Step 4: Confirm the fallback chain actually works**

While the app is running, kill the sidecar process (Task Manager, or find its PID via `tasklist | grep python` and `taskkill //F //PID <pid>`). Send another message to Miko. Confirm audio still plays (now via MioTTS) and the app doesn't hang or error — this proves the cascade's failure handling actually works, not just its happy path.

- [ ] **Step 5: Confirm app restart brings the sidecar back**

Fully quit and restart the app (`npm start` again). Confirm the sidecar auto-starts again without manual intervention.

- [ ] **Step 6: Report results**

Summarize what worked. If the sidecar's cold-start time feels too slow for real conversations (e.g. the very first message after app launch has to wait on model loading), note that as a possible follow-up (e.g. main.js could delay "ready" state until the sidecar's health check passes) rather than silently accepting a bad first impression — but don't implement that fix without checking with the user first, since it's a UX tradeoff (faster app-ready vs. guaranteed-best-voice-from-message-one) outside this plan's scope.

---

## Explicitly out of scope for this plan

- Any unstable-generation retry heuristic for GPT-SoVITS (see Non-goals in the design spec).
- Packaging/distribution of the GPT-SoVITS sidecar for end users beyond the developer's own machine.
- Removing MioTTS or its build tooling — it remains the middle fallback tier, fully intact.
- Tuning GPT-SoVITS's sampling parameters (top_k/top_p/temperature) for expressiveness — the evaluation found no reliable emotion control via these, so Task 4's `synthesize()` uses the same defaults confirmed to produce a good, stable clone during evaluation. Revisit only if a future need for tunable expressiveness arises.
