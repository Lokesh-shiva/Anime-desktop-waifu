import os
import base64
import tempfile
import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Optional

import soundfile as sf
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("tts-server")


# ─── System TTS (SAPI5) ──────────────────────────────────────────────────────

import comtypes.client

class SystemTTS:
    def synthesize(self, text: str, output_file: str):
        import comtypes
        comtypes.CoInitialize()
        try:
            voice = comtypes.client.CreateObject("SAPI.SpVoice")
            voices = voice.GetVoices()
            for i in range(voices.Count):
                v = voices.Item(i)
                desc = v.GetDescription().lower()
                if 'zira' in desc or 'female' in desc:
                    voice.Voice = v
                    break
            voice.Rate = 1
            stream = comtypes.client.CreateObject("SAPI.SpFileStream")
            stream.Open(output_file, 3, False)
            voice.AudioOutputStream = stream
            voice.Speak(text, 0)
            stream.Close()
        except Exception as e:
            logger.error(f"SAPI5 failed: {e}")
            raise
        finally:
            comtypes.CoUninitialize()


system_tts = SystemTTS()


# ─── MioTTS (GPU-accelerated local neural TTS) ───────────────────────────────

import random
import re
import subprocess
from pathlib import Path

MIOTTS_DIR    = Path(__file__).parent / "miotts"
MIOTTS_BIN    = MIOTTS_DIR / "build" / "miotts.exe"
MIOTTS_MODEL  = MIOTTS_DIR / "models" / "MioTTS-0.6B-Q8_0.gguf"
MIOTTS_CODEC  = MIOTTS_DIR / "models" / "miocodec.gguf"
MIOTTS_VOICE  = MIOTTS_DIR / "models" / "cartethyia.emb.gguf"

# Empirically, stable generations run ~10-12 speech codes per word. Runaway
# generation (drawn-out/trembling vowels, or hitting the 700-token cap) shows
# up as 25+ codes per word. This threshold catches the bad case with margin.
MIOTTS_CODES_PER_WORD_LIMIT = 18
MIOTTS_MAX_ATTEMPTS = 3

_CODES_LINE_RE = re.compile(r"T=(\d+) codes")


class MioTTS:
    def is_available(self) -> bool:
        return (
            MIOTTS_BIN.exists()
            and MIOTTS_MODEL.exists()
            and MIOTTS_CODEC.exists()
            and MIOTTS_VOICE.exists()
        )

    def _run_once(self, text: str, output_file: str, seed: int):
        result = subprocess.run(
            [
                str(MIOTTS_BIN),
                "-m", str(MIOTTS_MODEL),
                "-c", str(MIOTTS_CODEC),
                "-v", str(MIOTTS_VOICE),
                "-ngl", "99",
                "--seed", str(seed),
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

        match = _CODES_LINE_RE.search(result.stderr)
        n_codes = int(match.group(1)) if match else None
        return n_codes

    def synthesize(self, text: str, output_file: str):
        word_count = max(1, len(text.split()))

        for attempt in range(1, MIOTTS_MAX_ATTEMPTS + 1):
            seed = random.randint(1, 2**31 - 1)
            n_codes = self._run_once(text, output_file, seed)

            if n_codes is None:
                # Couldn't parse the codes line — trust the result, nothing more to check.
                return

            ratio = n_codes / word_count
            if ratio <= MIOTTS_CODES_PER_WORD_LIMIT:
                return

            logger.warning(
                f"MioTTS: attempt {attempt}/{MIOTTS_MAX_ATTEMPTS} looks unstable "
                f"({n_codes} codes / {word_count} words = {ratio:.1f}/word, "
                f"seed={seed}) — retrying with a new seed"
            )

        raise RuntimeError(
            f"MioTTS synthesis unstable after {MIOTTS_MAX_ATTEMPTS} attempts "
            f"(last ratio {ratio:.1f} codes/word)"
        )


mio_tts = MioTTS()


# ─── API models ───────────────────────────────────────────────────────────────

class SynthesisRequest(BaseModel):
    text:    str
    engine:  Optional[str] = "system"
    emotion: Optional[str] = None
    voice:   Optional[str] = None


# ─── FastAPI app ──────────────────────────────────────────────────────────────

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

app = FastAPI(lifespan=lifespan)


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


if __name__ == "__main__":
    import uvicorn, argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")
