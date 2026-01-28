import sys
import subprocess
import os

def install_styletts2():
    print("Installing StyleTTS2 (Experimental)...")
    print("Note: This will download heavy dependencies (~2GB installed size).")
    
    try:
        # Install the package
        subprocess.check_call([sys.executable, "-m", "pip", "install", "styletts2"])
        
        # Verify import and optional model preparation
        print("Verifying installation...")
        try:
            import styletts2
            print("StyleTTS2 installed successfully!")
            print("Note: Model weights will be downloaded on first use (~1GB).")
            return True
        except ImportError:
            print("Installation appeared to succeed but import failed.")
            return False
            
    except subprocess.CalledProcessError as e:
        print(f"Failed to install StyleTTS2: {e}")
        return False

if __name__ == "__main__":
    success = install_styletts2()
    sys.exit(0 if success else 1)
