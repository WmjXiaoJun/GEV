"""Download only the pinned official YOLO26 assets, with SHA-256 verification."""

import hashlib
import os
import tempfile
import urllib.request
from pathlib import Path

MODEL_DIRECTORY = Path(__file__).resolve().parents[2] / "models" / "vision"
RELEASE_URL = "https://github.com/ultralytics/assets/releases/download/v8.4.0/"
ASSETS = {
    "yolo26n.pt": (5544453, "9b09cc8bf347f0fc8a5f7657480587f25db09b34bf33b0652110fb03a8ad4fef"),
    "yolo26n-obb.pt": (5907357, "6f51c78197aacda4a33be77294065a9001675fb893f56227a179731b53dbd2b0"),
    "yolo26n-seg.pt": (6719965, "361fbfabab285c3237700b6bb91d7ecfa602cd945fffda8dbe1242829b71e73f"),
}


def valid_asset(path, size, digest):
    if not path.is_file() or path.stat().st_size != size:
        return False
    with path.open("rb") as model:
        return hashlib.file_digest(model, "sha256").hexdigest() == digest


def install_models(directory=MODEL_DIRECTORY, opener=urllib.request.urlopen):
    directory.mkdir(parents=True, exist_ok=True)
    for name, (expected_size, digest) in ASSETS.items():
        target = directory / name
        if valid_asset(target, expected_size, digest):
            print(f"Verified {name} (already installed).")
            continue
        if target.exists():
            raise RuntimeError(f"Existing {name} differs from official weights; move it aside manually before setup.")
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=directory, suffix=".partial", delete=False) as output:
                temporary = Path(output.name)
                total = 0
                with opener(RELEASE_URL + name, timeout=30) as response:
                    while chunk := response.read(128 * 1024):
                        total += len(chunk)
                        if total > expected_size:
                            raise RuntimeError(f"Download size mismatch: {name}")
                        output.write(chunk)
            if not valid_asset(temporary, expected_size, digest):
                raise RuntimeError(f"Download checksum mismatch: {name}")
            os.replace(temporary, target)
            temporary = None
            print(f"Installed {name}; SHA-256 verified.")
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    install_models()
