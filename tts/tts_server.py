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

import subprocess
from pathlib import Path

MIOTTS_DIR    = Path(__file__).parent / "miotts"
MIOTTS_BIN    = MIOTTS_DIR / "build" / "miotts.exe"
MIOTTS_MODEL  = MIOTTS_DIR / "models" / "MioTTS-0.6B-Q8_0.gguf"
MIOTTS_CODEC  = MIOTTS_DIR / "models" / "miocodec.gguf"
MIOTTS_VOICE  = MIOTTS_DIR / "models" / "cartethyia.emb.gguf"


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
