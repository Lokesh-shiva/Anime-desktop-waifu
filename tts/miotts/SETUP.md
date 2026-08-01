# MioTTS Build Setup (one-time, manual)

MioTTS runs as a standalone C++ binary (not a Python package). This is a one-time
build step — `src/`, `build/`, and `models/` are all gitignored; only this doc
and `local_patches.diff` are committed.

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

**Known limitation — Japanese / mixed-script text:** even with the above
fixes, this checkpoint (`MioTTS-0.6B-Q8_0.gguf`) is unstable on Japanese and
mixed Japanese/English input — particularly stutter-repeated words next to
punctuation (e.g. `い、いや!`). Symptoms range from drawn-out/trembling vowels
to full breakdown (screaming/garbled noise) and failure to terminate
generation (hits the 700-token cap). Tried and ruled out: raising the
repetition penalty further (1.3→1.5, no meaningful improvement) and switching
to the 1.2B model (worse, not better — full breakdown on the same test phrase).
The practical fix applied instead: [llm-interface.js](../../src/llm/llm-interface.js)'s
"Language" section was dialed back to use Japanese only rarely (at most one
plain word every several responses, never repeated/stuttered, never adjacent
to `!`) so this failure mode is triggered far less often. If revisiting this,
the next thing to try would be a different codec/LLM pairing or checking
whether the tokenizer handles Japanese BPE merges correctly for this specific
GGUF export — this wasn't root-caused, only worked around.

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
only `build/` and `models/` are needed at runtime.
