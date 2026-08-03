# Waifu Assistant — Codebase Guide

## What this is
Electron desktop app. An anime Live2D waifu (Miko) that talks, remembers, watches your screen/camera, and reacts emotionally. Local-first.

## Run
```
npm start
```
TTS server (Python) auto-starts on port 19765. LLM runs via LM Studio (port 1234) or Ollama (port 11434).

## Key files
| File | Purpose |
|---|---|
| `main.js` | Electron main process, IPC handlers, TTS server spawn |
| `src/renderer.js` | All UI logic, chat loop, settings wiring |
| `src/llm/brain-router.js` | Routes LLM calls — local/cloud/fallback |
| `src/llm/llm-interface.js` | **System prompt lives here** (Miko's personality) |
| `src/llm/lmstudio-adapter.js` | LM Studio adapter (primary local) |
| `src/llm/ollama-adapter.js` | Ollama adapter |
| `src/memory/memory-manager.js` | Long-term facts, session summaries, bond score |
| `src/memory/prompt-builder.js` | Assembles system prompt + memory context |
| `src/voice/voice-service.js` | TTS orchestration (ElevenLabs or system) |
| `src/avatar/brain-router.js` | Emotion arc → Live2D motion mapping |
| `src/vision/ScreenWatcher.js` | Screen capture → VLM description |
| `src/vision/CameraWatcher.js` | Webcam → VLM description |
| `src/settings.js` | All settings getters/setters + localStorage keys |
| `tts/tts_server.py` | FastAPI TTS server (MioTTS + SAPI5 fallback) |
| `tts/.venv/` | Python 3.11 venv — isolated, don't touch globally |
| `src/discord/discord-bridge.js` | Discord bot (main process): commands, filtering, batching |
| `src/discord/discord-renderer.js` | Discord batches → chat pipeline (renderer side) |

## Architecture
```
User input → renderer.js → BrainRouter → LM Studio / Ollama
                                ↓
                         parsed JSON response
                        { text, emotionArc, actionHints }
                           ↓           ↓
                      VoiceService   AvatarBridge
                      (TTS server)   (Live2D emotions + motion)
```

## LLM response format
Every response must be:
```
[EMOTION:label:intensity]
{"text": "...", "emotionArc": [...], "actionHints": {...}}
```
Parsed in `brain-router.js → _parseLLMResponse()`.

## Conversation history
Passed as proper `messages[]` array to LLM APIs (not embedded in system prompt). Lives in `memoryManager.recentMessages` (last 10 turns), forwarded via `options.conversationHistory` in every adapter.

## Settings storage
All in `localStorage`. Keys prefixed `waifu_*`. Engine options: `miotts` (default), `system`, `elevenlabs`.
Exception: the Discord bot token lives in `discord-config.json` in Electron's `userData`, not localStorage.

## TTS server
Python 3.11 venv at `tts/.venv/`. Started by main.js, prefers venv python over system python. Port 19765.
Engines: **MioTTS** (default, local GPU neural TTS, cloned Cartethyia voice) with **SAPI5** as automatic fallback.
MioTTS runs as a C++ binary at `tts/miotts/build/miotts.exe` — see `tts/miotts/SETUP.md` for build steps,
tuning rationale, and known limitations. Unstable generations are auto-detected (codes-per-word ratio)
and retried with a new random seed before falling back to SAPI5.

## Don't
- Don't import settings directly in adapters — pass via `options`
- Don't add top-level imports to `tts_server.py` for optional engines (lazy-load them)
- Don't commit `tts/.venv/` or `node_modules/`
- Don't put Discord logic in existing files — it stays isolated in `src/discord/`
- **Don't re-evaluate Fish Speech as a TTS engine.** Fully tested and rejected 2026-08-03 —
  see `tts/FISH_SPEECH_EVALUATION.md`. Blockers are measured, not assumed, and are hardware-bound.
  Only revisit if the GPU is upgraded well beyond the current 8GB (realistically 24GB).
