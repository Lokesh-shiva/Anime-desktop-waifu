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

import threading

import threading
import queue

import comtypes.client

class SystemTTS:
    def __init__(self):
        # We don't need a persistent object for SAPI if we init per request properly
        # But to be safe and fast, we can try to keep one or just init when needed.
        # SAPI is COM based, so thread apartment matters.
        logger.info("System TTS (Direct SAPI5) initialized mode")

    def synthesize(self, text: str, output_file: str):
        """Synthesize text to file using Direct SAPI5"""
        
        # Initialize COM in this thread
        comtypes.CoInitialize()
        try:
            # Create SAPI SpVoice object
            voice = comtypes.client.CreateObject("SAPI.SpVoice")
            
            # Set voice (try to find Zira/Female)
            # Get available voices
            voices = voice.GetVoices()
            target_voice = None
            
            for i in range(voices.Count):
                v = voices.Item(i)
                desc = v.GetDescription()
                if 'zira' in desc.lower() or 'female' in desc.lower():
                    target_voice = v
                    break
            
            if target_voice:
                voice.Voice = target_voice
                
            # Set fast rate (-10 to 10)
            voice.Rate = 1 # Slightly faster
            
            # Create File Stream
            stream = comtypes.client.CreateObject("SAPI.SpFileStream")
            stream.Open(output_file, 3, False) # 3 = SSFMCreateForWrite
            
            # Connect voice to stream
            voice.AudioOutputStream = stream
            
            # Speak (Flags: 0 = Default)
            voice.Speak(text, 0)
            
            # Close stream
            stream.Close()
            
            return output_file
            
        except Exception as e:
            logger.error(f"SAPI5 synthesis failed: {e}")
            raise e
        finally:
            comtypes.CoUninitialize()

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
            # System TTS (Direct SAPI5)
            # Run in thread to keep API responsive, even though SAPI is fast
            await asyncio.to_thread(system_tts.synthesize, request.text, temp_file)

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
