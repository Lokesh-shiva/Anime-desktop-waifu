# GPT-SoVITS Integration — Design

## Goal

Make GPT-SoVITS Miko's primary TTS voice (confirmed by ear to sound like
Cartethyia, "10x better" than MioTTS on naturalness/breath/pacing), while
keeping MioTTS and SAPI5 as fallback tiers so a GPT-SoVITS hiccup never means
dead audio.

## Non-goals

- No change to the emotion-arc/lip-sync/audio-player pipeline — this only
  changes which engine produces the `.wav` bytes `tts_server.py` already
  returns over `/synthesize`.
- No unstable-generation retry heuristic for GPT-SoVITS (unlike MioTTS's
  codes-per-word ratio) — we don't have an equivalent signal yet. A hard
  timeout covers the one failure mode actually observed in evaluation (a
  60s runaway generation at low temperature).
- No packaging/installer work for shipping GPT-SoVITS to end users — this is
  for the developer's own local instance, same as MioTTS today.

## Architecture

**Sidecar service.** GPT-SoVITS ships its own FastAPI server (`api_v2.py`).
Promote `tts/gpt-sovits-eval/` → `tts/gpt-sovits/` (permanent, gitignored)
and run `api_v2.py` as a second Python subprocess, spawned by `main.js`
alongside the existing `tts_server.py` spawn, on port `9881`. Its own venv
(`tts/gpt-sovits/.venv`) stays fully isolated from `tts/.venv` — no shared
dependency surface, matching the isolation precedent already set by MioTTS
being a separate binary and Discord being a separate module.

**`tts_server.py` client.** A new `GPTSoVITS` class does an HTTP POST to the
sidecar's `/tts` endpoint (`aiohttp` or `httpx`, whichever is already
available — check `requirements.txt`/installed packages before adding a new
dependency) with a hard timeout. Cascade in `/synthesize` becomes:

```
GPT-SoVITS (if sidecar healthy) → MioTTS (if available) → SAPI5
```

Each tier's failure (exception, timeout, non-200) falls through to the next,
exactly matching the existing MioTTS→SAPI5 try/except shape already in
`synthesize()` — just with one more tier stacked on top.

**Reference audio.** The reference clip and its transcript (confirmed
working in evaluation) move into `tts/gpt-sovits/ref_audio/`, referenced by
absolute path in every synthesis request — no re-cloning step, this is a
fixed zero-shot reference used on every call (that's how zero-shot TTS
works: the reference audio + its exact transcript are passed with every
request, there's no separate "training" step).

**Startup coupling.** `main.js` spawns the sidecar the same way it spawns
`tts_server.py` — venv-preferred, stdio piped to `[Sidecar]`-prefixed
console logs, retry-with-backoff on unexpected exit, using the same
`killPortStalker`-style stale-process cleanup pattern for port `9881`.
`tts_server.py`'s `GPTSoVITS.is_available()` does a live health check (HTTP
GET, short timeout) rather than assuming the sidecar is up — if the sidecar
is slow to finish loading model weights on cold start, requests during that
window fall through to MioTTS automatically rather than hanging.

## Error handling

- Sidecar not running / still loading weights → `is_available()`'s health
  check fails fast → falls straight to MioTTS, same as today's "MioTTS not
  built" case falling to SAPI5.
- Sidecar returns non-200 or times out mid-request → caught in
  `tts_server.py`'s existing try/except cascade → falls to MioTTS.
- Sidecar process crashes → `main.js`'s `close` handler retries with backoff
  (same pattern as `ttsProcess`), while `tts_server.py` keeps falling
  through to MioTTS/SAPI5 in the meantime — chat never blocks on TTS.

## Testing

No automated suite. Manual: start the app, confirm both `[TTS]` and
`[Sidecar]`-prefixed logs show healthy startup, chat with Miko and confirm
`engine: "gptsovits"` shows up (add a temporary log if needed, remove after
confirming), listen for the improved naturalness. Kill the sidecar process
mid-session and confirm the next message still gets audio (falls to
MioTTS), confirming the fallback chain actually works and doesn't hang.
