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

# GPT-SoVITS's English text frontend needs two NLTK resources
# (averaged_perceptron_tagger_eng, cmudict) and lookups for these have
# intermittently failed even when the files exist in the user-level
# %APPDATA%\nltk_data — cause unconfirmed, but reproduces across both a
# sandboxed launch and a normal one. Bundling a known-good copy inside this
# sidecar's own directory and pointing NLTK_DATA at it removes the
# dependency on whatever's in the user-level location entirely. This is a
# plain env var — no nltk import here, so it can't trigger the cwd-import
# security block nltk itself raises when imported too early (see git log
# for the reverted attempt that hit this).
os.environ["NLTK_DATA"] = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nltk_data")

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
