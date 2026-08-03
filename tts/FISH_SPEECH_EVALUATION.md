# Fish Speech — Evaluation & Rejection Record

**Date evaluated:** 2026-08-03
**Verdict: REJECTED.** Staying with MioTTS.

> ## ⛔ DO NOT REVISIT THIS
>
> Do not re-attempt Fish Speech integration **unless the machine has a GPU with
> significantly more VRAM than the current 8GB RTX 5050** — realistically 24GB.
> This was fully evaluated end-to-end on 2026-08-03: it was installed, made to
> work, and tested against real audio. The blockers below are **measured, not
> assumed**. Re-testing on the same hardware will reproduce the same results and
> waste hours.
>
> The only thing that changes this verdict is hardware. If you're reading this
> without a bigger GPU, stop here.

---

## Why it was evaluated

Fish Speech was proposed as a MioTTS replacement based on three claims:

1. Better zero-shot voice cloning
2. Inline emotion tags (`[laugh]`, `[whisper]`, `[excited]`)
3. Clean multilingual / Japanese support

MioTTS is weak on (1) and outright broken on (3) — Japanese had to be stripped
from Miko's personality prompt entirely because MioTTS produced garbled
screaming on it. So the motivation was real.

## What actually happened

**It was installed and it worked.** This is not a "couldn't get it running"
report. Fish Speech 1.5 generated audio in Cartethyia's cloned voice, in
English and Japanese. Findings are based on listening to real output.

### What Fish Speech genuinely does better

| Capability | MioTTS 0.6B | Fish Speech 1.5 |
|---|---|---|
| Voice clone fidelity | Poor — "not even close" to the reference | **Excellent — "exactly like Cartethyia"** |
| Japanese / mixed script | Breaks down (screaming, hits token cap) | **Clean.** 148 tokens, no runaway, good pronunciation |

Both of these are real, verified wins.

### The blockers (all measured)

**1. Permanent audio muffling — the dealbreaker.**

The codec (`firefly-gan-vq-fsq-8x1024-21hz`) aggressively discards high
frequencies. Measured via FFT on an encode→decode round-trip of the reference
clip (i.e. isolating the codec, with no generation involved):

| Band | Original | After codec | Loss |
|---|---|---|---|
| 4–8 kHz | 0.64% | 0.33% | ~half |
| 8–12 kHz | 1.06% | 0.33% | ~⅔ |
| 12–16 kHz | 0.58% | 0.15% | ~¾ |
| **99% energy rolloff** | **9278 Hz** | **3443 Hz** | **−5835 Hz** |

This is inherent to a 21Hz-frame-rate neural codec, not a config error.
**High-shelf EQ compensation was tried and rejected** (+6dB and +11dB above
3kHz): it cannot restore discarded information, so it only amplified sibilance
("more ss sound") while the muffling remained. Dead end.

Rationale for treating this as decisive: voice identity is a one-time "that's
her!" reaction; muffled audio degrades *every line, forever*.

**2. Emotion tags do not exist in any runnable version.**

Verified directly against the tokenizer, not inferred:

```
checkpoints/fish-speech-1.5/special_tokens.json
  total special tokens: 1036
  emotion-ish tokens:   NONE FOUND
  (all structural: <|text|>, <|voice|>, <|phoneme_start|>, ...)
```

Tags like `[excited]` / `[laugh]` / `[whisper]` are tokenized as ordinary words
and **read aloud literally**. Confirmed by listening. No bracket-syntax variant
fixes this — the capability is absent from the model.

The "15,000+ emotive tags" marketing belongs to **S2-Pro**, a different and much
larger model. See VRAM below. This is the single biggest reason the hardware
gate exists: the headline feature requires a model this machine cannot run.

**3. VRAM / hardware conflict.**

- Fish Speech 1.5 inference: **1.66GB VRAM** (measured)
- RTX 5050 total: 8151MB; LM Studio's local LLM already uses ~6.6GB
- → Cannot coexist with the local LLM. Would require downsizing or dropping
  local LLM fallback.
- **S2-Pro** (the version with emotion tags, 5B params): **12–24GB VRAM.**
  Not runnable, not close.

**4. Speed.** ~10–12 tokens/sec, giving ~6s for a short phrase and ~15s for a
longer one. `--compile` was **not tested** and reportedly gives a large speedup
(~30→500 tok/s) and does work on Linux/WSL2 — so this specific point is *not*
confirmed as a blocker, but it was moot once (1) and (2) decided it.

**5. Integration cost.** Runs only under WSL2 (upstream states `System: Linux,
WSL`; there is no supported native-Windows path). Adopting it means an HTTP
bridge from Electron into WSL2, plus rebuilding everything already working on
MioTTS: seed-retry stability logic, the Discord streaming bridge path, settings
UI, SAPI5 fallback.

**6. License.** Fish Audio Research License — personal/non-commercial use is
fine, but **commercial use requires a separate written agreement.** Not a
blocker for this project today; would be if it were ever monetized.

---

## Setup gotchas (only relevant if hardware changes)

Recorded so the debugging isn't repeated. All of these cost real time.

**Dependency versions matter enormously — this was the single biggest gotcha.**
Installing deps from `main`'s `pyproject.toml` (v2.0.0) while running v1.5.1
code produced audio that was rough, quiet, and *did not resemble the reference
voice at all*. Correcting the pins fixed it completely — the clone went from
"not even close" to "exactly like Cartethyia". The critical pin:

```
vector_quantize_pytorch==1.14.24   # was resolving to 1.31.1 — sits directly
                                   # in the FSQ audio-decode path
numpy<=1.26.4                      # was 2.4.6
einx[torch]==0.2.2                 # was 0.4.3
scipy<1.14                         # forced by the numpy downgrade
```

**`torch<=2.4.1` (v1.5.1's own pin) is UNRUNNABLE on this GPU.** The RTX 5050 is
Blackwell, compute capability **sm_120**; torch 2.4.1 tops out at sm_90. Must use
**torch 2.8.0+cu128** (verified `get_arch_list()` includes `sm_120`). So full
dependency alignment with v1.5.1 is impossible on Blackwell — torch has to stay
newer than the project pins.

**`torchaudio.load()` segfaults** in this environment (torchaudio 2.8.0 legacy
backend) — crashes on *any* input file, not a file-format issue. Patched
`fish_speech/models/vqgan/inference.py` to use `soundfile` instead:

```python
raw_audio, sr = sf.read(str(input_path), dtype='float32', always_2d=True)
audio = torch.from_numpy(raw_audio.T)
```
(`sf` is already imported at module level — do not re-import locally, it shadows
the global and breaks the later `sf.write()` call.)

**Other setup notes:**
- Check out the **`v1.5.1` tag** — `main` is v2.0.0 and its code does not match
  the 1.5 checkpoint.
- WSL2 `/tmp` is a 3.9GB RAM-backed tmpfs → pip fails with `No space left on
  device` on the large CUDA wheels. Set `TMPDIR` to a real disk path.
- `wsl --install` needs an **Administrator** shell and a reboot.
- Use `wsl -u root` for `apt` (interactive `sudo` password times out).
- System deps required before `pyaudio` will build: `build-essential
  portaudio19-dev libsox-dev ffmpeg`.
- Conda now requires accepting channel ToS before `conda create` will run.

**Where it lives:** WSL2 Ubuntu, `~/fish-speech`, conda env `fish-speech`
(Python 3.12). Roughly 15GB installed. Safe to delete entirely — nothing in the
Waifu app depends on it.

---

## Bottom line

Fish Speech 1.5 is a better *cloner* and genuinely handles Japanese, but it is
permanently muffled on this codec, has no emotion tags, cannot share the GPU
with the local LLM, and needs a WSL2 bridge plus a full re-integration. The
version that would justify the switch (S2-Pro) needs ~3× the VRAM available.

**MioTTS stays.** See `tts/miotts/SETUP.md` for its status and known limits.
