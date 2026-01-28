import os
import sys
import base64
import io
import tempfile
import asyncio
import logging
from typing import Optional, Dict, Any, Literal
from contextlib import asynccontextmanager

import numpy as np
import soundfile as sf
import pyttsx3
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("tts-server")

# Global state
engine_cache = {}
active_engine_type = "system"

# --- TTS Engines ---

class SystemTTS:
    def __init__(self):
        try:
            # Initialize pyttsx3
            # Note: pyttsx3 is not thread-safe, so we need to be careful
            # We will re-initialize for each request or use a lock if needed
            # For now, we'll try a fresh init per request or manage a global instance carefully
            self.engine = pyttsx3.init()
            logger.info("System TTS (pyttsx3) initialized")
        except Exception as e:
            logger.error(f"Failed to initialize System TTS: {e}")
            raise e

    def synthesize(self, text: str, output_file: str):
        """Synthesize text to file using system TTS"""
        # Re-init safely for this call to avoid loop conflicts
        engine = pyttsx3.init()
        
        # Try to set a female voice (Zira)
        voices = engine.getProperty('voices')
        for voice in voices:
            if 'zira' in voice.name.lower() or 'female' in voice.name.lower():
                engine.setProperty('voice', voice.id)
                break
        
        # Slightly faster rate for natural feel (default is ~200)
        engine.setProperty('rate', 180)
        
        engine.save_to_file(text, output_file)
        engine.runAndWait()
        return output_file

class StyleTTS2Wrapper:
    def __init__(self):
        self.model = None
        self.ready = False
        
    def load(self):
        try:
            from styletts2 import tts
            self.model = tts.StyleTTS2()
            self.ready = True
            logger.info("StyleTTS2 loaded successfully")
        except ImportError:
            logger.error("StyleTTS2 package not found. Install it to use neural voice.")
            raise ImportError("StyleTTS2 not installed")
        except Exception as e:
            logger.error(f"Failed to load StyleTTS2: {e}")
            raise e

    def synthesize(self, text: str, output_file: str):
        if not self.ready:
            self.load()
            
        # StyleTTS2 returns a numpy array, but the wrapper also saves to file if requested
        self.model.inference(text, output_wav_file=output_file)
        return output_file

# Initialize engines
system_tts = SystemTTS()
neural_tts = StyleTTS2Wrapper()

# --- API Models ---

class SynthesisRequest(BaseModel):
    text: str
    engine: Literal["system", "styletts2"] = "system"
    style_params: Optional[Dict[str, Any]] = None

class HealthResponse(BaseModel):
    status: str
    active_engine: str
    available_engines: list[str]

# --- FastAPI App ---

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("TTS Server starting...")
    yield
    # Shutdown
    logger.info("TTS Server shutting down...")

app = FastAPI(lifespan=lifespan)

@app.get("/health", response_model=HealthResponse)
async def health_check():
    engines = ["system"]
    try:
        import styletts2
        engines.append("styletts2")
    except ImportError:
        pass
        
    return HealthResponse(
        status="ready",
        active_engine=active_engine_type,
        available_engines=engines
    )

@app.post("/synthesize")
async def synthesize(request: SynthesisRequest):
    """
    Synthesize text to audio.
    Returns base64 encoded WAV data.
    """
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    temp_file = ""
    try:
        # Create temp file for output
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as fp:
            temp_file = fp.name
        
        # Close handle so engine can write to it
        
        if request.engine == "styletts2":
            try:
                # Run in thread pool to avoid blocking
                await asyncio.to_thread(neural_tts.synthesize, request.text, temp_file)
            except ImportError:
                # Fallback silently or error? For V1, let's error so frontend knows
                raise HTTPException(status_code=503, detail="StyleTTS2 not installed")
            except Exception as e:
                logger.error(f"StyleTTS2 error: {e}")
                raise HTTPException(status_code=500, detail=str(e))
        else:
            # System TTS
            try:
                await asyncio.to_thread(system_tts.synthesize, request.text, temp_file)
            except Exception as e:
                logger.error(f"System TTS error: {e}")
                raise HTTPException(status_code=500, detail=str(e))

        # Read back the file
        if not os.path.exists(temp_file) or os.path.getsize(temp_file) == 0:
             raise HTTPException(status_code=500, detail="Audio generation failed (empty output)")

        with open(temp_file, "rb") as f:
            audio_data = f.read()
            
        # Encode to base64
        b64_audio = base64.b64encode(audio_data).decode("utf-8")
        
        # Get duration and sample rate for metadata
        # We can read the first few bytes or use soundfile to check
        try:
             info = sf.info(temp_file)
             duration = info.duration
             sample_rate = info.samplerate
        except:
             duration = 0
             sample_rate = 24000 # Default assumption

        return {
            "audio": b64_audio,
            "sample_rate": sample_rate,
            "duration": duration,
            "engine": request.engine
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Synthesis failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # Cleanup temp file
        if temp_file and os.path.exists(temp_file):
            try:
                os.unlink(temp_file)
            except:
                pass

if __name__ == '__main__':
    import uvicorn
    import argparse
    
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    
    # Use uvicorn.Config to enable socket reuse
    config = uvicorn.Config(
        app, 
        host="127.0.0.1", 
        port=args.port,
        log_level="info"
    )
    server = uvicorn.Server(config)
    
    # Run the server
    server.run()
