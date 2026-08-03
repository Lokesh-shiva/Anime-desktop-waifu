# MioTTS Build Setup (one-time, manual)

MioTTS runs as a standalone C++ binary (not a Python package). This is a one-time
build step — `src/`, `build/`, and `models/` are all gitignored; only this doc
and `local_patches.diff` are committed.

## Status summary (as of 2026-08-03)

**Working well:**
- Local GPU-accelerated inference on the RTX 5050 (~0.6-1GB VRAM), fast enough
  for real-time chat and for the Discord streaming bridge
- Clean, stable English speech with the current settings (temperature 0.5,
  `top_k(50)`, repetition penalty 1.5, a fresh random seed per line)
- Zero-shot voice cloning from a short (5-25s) clean reference clip — Miko
  currently speaks with a cloned "Cartethyia" voice, not a stock preset
- Automatic detect-and-retry in `tts_server.py`: generations that look
  unstable (25+ speech codes per word) are retried with a new seed, falling
  back to SAPI5 after 3 failed attempts — this recovers most bad generations
  without the user ever hearing them
- Fully integrated as the default TTS engine app-wide (normal chat and the
  Discord bridge both go through it), with SAPI5 always available as a
  fallback if MioTTS is unavailable or fails
- Emotion/prosody comes through reasonably well from plain text/punctuation
  alone — no explicit emotion tags needed for happy/sad/angry etc. to read
  correctly

**Not working / known limitations:**
- **Japanese and mixed-script text is unstable regardless of script** (kana
  or romaji both break the same way) — worked around by removing Japanese
  from Miko's personality prompt entirely, not fixed at the model level. See
  "Cross-cutting finding" below for the generalized version of this problem.
- **Stutter/near-repeat patterns can still trigger instability in English
  too** — any text with a word or word-root repeated in a short span (`"I...
  I"`, `"run"`/`"running"` + `"care"`/`"caring"` in one reply) can produce
  drawn-out/trembling vowels or runaway generation. The seed-retry logic
  usually recovers within 1-2 attempts, but the underlying trigger isn't
  eliminated — it's caught and re-rolled, not prevented.
- **Not every bad generation self-heals** — some seeds still produce a bad
  ratio on retry; the 3-attempt cap exists because retrying isn't guaranteed
  to succeed.
- **Zero-shot cloning has a real ceiling**: it doesn't reliably reproduce
  out-of-domain voices (e.g. stylized game-character performances) even from
  a clean, short reference clip. Tested with two different source clips —
  this reads as a genuine model-capability limit for this 0.6B checkpoint,
  not something more input cleanup fixes.
- **Bigger isn't better**: the 1.2B model was tested head-to-head on the same
  instability case and was *worse* (full breakdown), not better. Scaling up
  the model size is not a viable fix path for the instability.
- **Root cause never found**: every fix applied (prompt-template correction,
  sampler tuning, seed-retry) is a mitigation around a model behavior that
  was never actually root-caused. It's plausibly a tokenizer/BPE handling
  issue or a training-data gap, but that was never confirmed.

## Prerequisites
- CMake 3.14+ (`cmake --version`)
- Visual Studio Build Tools with the "Desktop development with C++" workload
- CUDA Toolkit (matching your GPU driver) for GPU offload
- ~2GB disk space for the build + models

All three can be installed via winget if missing:
```bash
winget install --id Kitware.CMake -e
winget install --id Microsoft.VisualStudio.BuildTools -e
winget install --id Nvidia.CUDA -e
```

## 1. Clone

From `tts/miotts/`:
```bash
git clone --recursive https://github.com/espresso3389/MioTTS-llama.cpp.git src
```

## 2. Apply local patches

The upstream code has a few issues that needed patching for this setup (Windows
build portability, and generation-quality fixes discovered by testing):

```bash
cd src
git apply ../local_patches.diff
```

What the patches do (see `local_patches.diff` for the full diff):
- **`CMakeLists.txt`**: only link the `m` (math) library on non-Windows — it
  doesn't exist on MSVC and breaks the link step otherwise.
- **`src/istft.cpp`**: define `_USE_MATH_DEFINES` before `<cmath>` so `M_PI` is
  available under MSVC.
- **`src/test-to-speech.cpp`, `build_prompt()`**: removes a leading
  `<|startoftext|>` token that isn't part of the model's actual chat template
  (verified against the `tokenizer.chat_template` GGUF metadata). Including it
  pushed the model out of distribution and it would never sample an EOS token,
  running every generation to the hard `max_tokens` cap (700 codes ≈ 28s of
  audio, mostly silence/garbage past the real ~5s of speech).
- **`src/test-to-speech.cpp`, sampler chain**: adds `top_k(50)` +
  `penalties(64, 1.5, 0, 0)` (repetition penalty) before temperature sampling.
  Without it the model would dwell on similar codes and produce drawn-out,
  trembling vowels ("hellooo...voicceee") especially on energetic/exclamatory
  text.
- **`src/main.cpp`, `src/test-to-speech.h`**: default temperature lowered from
  `0.8` to `0.5`. At `0.8`, generation was audibly unstable (warped vowels on
  expressive text) and could occasionally still blow through the token cap
  even with the repetition penalty in place. `0.5` was stable across neutral,
  happy, and sad English test phrases.
- **`src/main.cpp`, `src/test-to-speech.h/cpp`**: adds a `--seed N` CLI flag
  (previously hardcoded to seed 42 everywhere). This isn't just a debug knob —
  `tts_server.py` relies on it for two things: (1) picking a fresh random seed
  per synthesis call instead of reusing 42 for every single line (so lines
  don't all share one fixed prosody "flavor"), and (2) retrying with a new
  random seed when a generation looks unstable (see below), since retrying
  with the same seed would just reproduce the identical bad output.

**Runaway-generation instability isn't limited to exact stutters.** Testing
found that punctuation-dense, choppy text with near-repeated word roots (not
exact repeats) — e.g. `"run"`/`"running"` and `"care"`/`"caring"` both
appearing in one short reply — can trigger the same drawn-out/trembling-vowel
breakdown, generating 25-35+ speech codes per word instead of the normal
~10-12/word. This is broader than the single-word-stutter pattern documented
below and isn't reliably preventable by rephrasing text, so it's handled at
the TTS layer instead: `tts_server.py`'s `MioTTS.synthesize()` (see that file)
parses the `T=<N> codes` line MioTTS prints, compares it against the input's
word count, and retries with a new random seed (up to 3 attempts total) if the
ratio exceeds `MIOTTS_CODES_PER_WORD_LIMIT` (18). If still unstable after all
attempts, it raises and the existing SAPI5 fallback in `/synthesize` kicks in.
Retrying with a different seed doesn't always fix it (some seeds still
produce a bad ratio), but empirically it usually resolves within 1-2 retries.

**Known limitation — Japanese / mixed-script text:** even with the above
fixes, this checkpoint (`MioTTS-0.6B-Q8_0.gguf`) is unstable on Japanese and
mixed Japanese/English input — particularly stutter-repeated words next to
punctuation (e.g. `い、いや!`). Symptoms range from drawn-out/trembling vowels
to full breakdown (screaming/garbled noise) and failure to terminate
generation (hits the 700-token cap). Tried and ruled out: raising the
repetition penalty further (1.3→1.5, no meaningful improvement) and switching
to the 1.2B model (worse, not better — full breakdown on the same test phrase).
The fix applied: [llm-interface.js](../../src/llm/llm-interface.js)'s "Language"
section (Japanese flavor words) was removed from Miko's personality prompt
entirely — the earlier "use it rarely" mitigation still let it surface often
enough to keep breaking. If revisiting this, the next thing to try would be a
different codec/LLM pairing or checking whether the tokenizer handles Japanese
BPE merges correctly for this specific GGUF export — this was never
root-caused, only avoided by not generating Japanese text at all.

## 3. Build (with CUDA/GPU offload)

Requires a Visual Studio dev environment with CUDA on PATH. From `tts/miotts/src/`:

```powershell
$cudaRoot = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.3"  # adjust version
$cmd = 'set "CUDA_PATH=' + $cudaRoot + '" && set "CUDA_PATH_V13_3=' + $cudaRoot + '" && set "PATH=' + $cudaRoot + '\bin;%PATH%" && "<path to vcvars64.bat>" && "<path to cmake.exe>" -S . -B build -DGGML_CUDA=ON -DCUDAToolkit_ROOT="' + $cudaRoot + '" && "<path to cmake.exe>" --build build --config Release --target miotts'
cmd /c $cmd
```

`CUDA_PATH`/`CUDA_PATH_V13_3` and the CUDA `bin` dir on `PATH` are required —
without them CMake can't find `nvcc`, and even after finding it, MSBuild's CUDA
integration separately needs `CUDA_PATH` set or you'll hit
`The CUDA Toolkit directory '' does not exist`.

Output binary: `build/Release/miotts.exe`.

## 4. Assemble the runtime folder

Copy the binary and its runtime DLLs into `tts/miotts/build/` — this is the
fixed path `tts_server.py` expects:

```powershell
Copy-Item "src\build\Release\miotts.exe" "build\" -Force
Copy-Item "src\build\bin\Release\*.dll" "build\" -Force   # ggml*.dll, llama.dll
```

Two more DLL sets are needed that CMake doesn't copy automatically — the binary
will fail with `STATUS_DLL_NOT_FOUND` (exit code `-1073741515`) without them:

```powershell
# Universal CRT (api-ms-win-crt-*.dll) — app-local UCRT deployment
Copy-Item "C:\Program Files (x86)\Windows Kits\10\Redist\10.0.26100.0\ucrt\DLLs\x64\*.dll" "build\" -Force

# CUDA runtime (cuBLAS etc.) — used by ggml-cuda.dll, not on PATH by default
$cudaBin = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.3\bin\x64"
Copy-Item "$cudaBin\cublas64_13.dll","$cudaBin\cublasLt64_13.dll","$cudaBin\cudart64_13.dll" "build\" -Force
```

(Use `dumpbin /dependents build\miotts.exe` and `dumpbin /dependents build\ggml-cuda.dll`
from a VS dev prompt if a future rebuild needs different DLLs — that's how these
two sets were identified.)

## 5. Download models

Three files needed in `tts/miotts/models/`, using the `hf` CLI
(`pip install "huggingface_hub"` into `tts/.venv` if not already present):

```bash
hf download mmnga-o/miotts-cpp-gguf miocodec-25hz-44k-v2.gguf --local-dir models
mv models/miocodec-25hz-44k-v2.gguf models/miocodec.gguf
hf download mmnga-o/miotts-cpp-gguf --include "*.emb.gguf" --local-dir models
hf download Aratako/MioTTS-GGUF MioTTS-0.6B-Q8_0.gguf --local-dir models
```

**Important — codec file choice:** `mmnga-o/miotts-cpp-gguf` hosts multiple
`miocodec*.gguf` variants. Only **`miocodec-25hz-44k-v2.gguf`** has the
`wave_upsampler.*` tensors this inference code expects (277 tensors). The plain
`miocodec.gguf` and `miocodec-24khz.gguf` files (247 tensors each) are older
exports missing that component entirely — loading the LLM-generated speech
codes through them computes `S_final=0` internally and crashes with
`STATUS_ACCESS_VIOLATION` partway through decoding. Do not swap this file for
one of the other variants without re-verifying tensor names via
`gguf.GGUFReader` first (see `local_patches.diff` history / project chat log
for the debugging trail if this needs to be repeated for a different model
size).

Expected final layout:
```
tts/miotts/
  SETUP.md
  local_patches.diff
  build/
    miotts.exe
    ggml*.dll, llama.dll          (from the build)
    api-ms-win-crt-*.dll, ...     (UCRT app-local deploy)
    cublas64_13.dll, cublasLt64_13.dll, cudart64_13.dll   (CUDA runtime)
  models/
    MioTTS-0.6B-Q8_0.gguf
    miocodec.gguf                 (actually the -25hz-44k-v2 variant, renamed)
    en_female.emb.gguf, en_male.emb.gguf, jp_female.emb.gguf, jp_male.emb.gguf
```

## 6. Verify standalone

From `tts/miotts/`:

```powershell
.\build\miotts.exe -m models\MioTTS-0.6B-Q8_0.gguf -c models\miocodec.gguf -v models\en_female.emb.gguf -ngl 99 -p "Hello, this is a test of the voice." -o test.wav
```

Check the log for `T=<N> codes` — for a short sentence this should be well
under 200, not hitting the 700 cap. If it's exactly 700, generation is
runaway (check the patches applied cleanly, especially the `build_prompt()`
and sampler chain ones). Play `test.wav` and confirm it's stable, natural
speech, not drawn-out/trembling vowels.

Once confirmed, `src/` can be deleted if you want to reclaim disk space —
only `build/` and `models/` are needed at runtime. (Keep it around if you plan
to redo voice cloning below — `src/tools/create_voice_emb.py` lives there.)

## 7. Voice cloning (Miko's actual voice)

`tts_server.py`'s `MIOTTS_VOICE` points at `models/cartethyia.emb.gguf` — a
cloned voice, not one of the stock presets. This file is gitignored (lives
under `models/`), so a fresh clone needs to regenerate it.

**Why a separate venv:** the cloning tool (`Aratako/MioCodec` on PyPI/GitHub)
requires Python ≥3.12, but `tts/.venv` is pinned to 3.11 for the TTS server
itself. Don't touch that venv — set up a throwaway one just for cloning:

```bash
winget install --id Python.Python.3.12 -e --silent
winget install --id Gyan.FFmpeg -e --silent   # needed for non-WAV sources (mp3, m4a, etc.)

cd tts/miotts
py -3.12 -m venv clone_venv
clone_venv/Scripts/python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
clone_venv/Scripts/python -m pip install gguf soundfile numpy "git+https://github.com/Aratako/MioCodec"
```

**Extract an embedding from a reference clip:**

```bash
clone_venv/Scripts/python src/tools/create_voice_emb.py "path/to/reference.wav" "models/<name>.emb.gguf" --name "<Label>"
```

Handles WAV/FLAC/OGG natively; anything else (mp3, m4a, webm) needs `ffmpeg` on
PATH. First run downloads the ~1GB PyTorch `Aratako/MioCodec-25Hz-44.1kHz-v2`
model to the HF cache (separate from the GGUF codec — this is the PyTorch
version used only for embedding extraction, not runtime inference).

**Reference clip guidance (learned by testing, not documented upstream):**
- **Length: 5-25s, not longer.** This tool does a single global-embedding
  extraction (one forward pass, no averaging across samples). A ~3-minute
  clip produced a diluted, unstable-sounding embedding — bad clone quality
  *and* triggered generation instability. A trimmed ~25s clip worked fine.
  Shorter, cleaner clips are safer than long ones.
- **No overlapping background noise/SFX** in the reference — it all gets
  baked into the one embedding vector.
- Voice character fit is a real limit, not just input quality: this 0.6B
  model's zero-shot cloning may just not resemble an out-of-domain voice
  (e.g. a stylized game-character performance) well no matter how clean the
  clip is. If a clone doesn't sound right after a clean short clip, that's
  more likely a model-capability ceiling than something to keep tuning.

Once you have an `.emb.gguf`, point `MIOTTS_VOICE` in `tts/tts_server.py` at
it and restart the app.

**Cross-cutting finding — stutter/repetition text triggers instability
regardless of voice:** the voice embedding only affects the *decode* step,
not the LLM's speech-code generation, so any text-generation instability
(drawn-out/trembling vowels, runaway token count) reproduces identically no
matter which voice is selected. The specific trigger identified by testing:
**stuttered or repeated words next to punctuation** — `"I... I don't know"`,
the Japanese `"い、いや!"` — regardless of language or script. Rephrasing to
remove the repeat (`"I don't know... this is really sad"`) fixed it every
time tested (confirmed by code count dropping ~2x). If a line sounds
stretched/trembling, check for this pattern first before assuming it's a
voice-specific issue.
