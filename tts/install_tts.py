import sys
import subprocess
import os

def install_requirements():
    print("Checking Python version...")
    if sys.version_info < (3, 9):
        print("Error: Python 3.9+ is required.")
        return False

    print("Installing base TTS requirements...")
    req_file = os.path.join(os.path.dirname(__file__), "requirements.txt")
    
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", req_file])
        print("Base requirements installed successfully.")
        return True
    except subprocess.CalledProcessError as e:
        print(f"Failed to install requirements: {e}")
        return False

if __name__ == "__main__":
    success = install_requirements()
    sys.exit(0 if success else 1)
