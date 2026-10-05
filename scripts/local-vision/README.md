# Local YOLO26 Vision

This optional loopback service runs Ultralytics `8.4.148`, verified against PyPI
and the official YOLO26 documentation on 2026-09-12. Python 3.11+ is required.
It does not require an LLM API key and does not upload images to third parties.

Two official pretrained nano models are installed with pinned SHA-256 hashes:

- `yolo26n-obb.pt`: the default for map/aerial images, 15 DOTA-v1 classes and
  oriented quadrilateral boxes (planes, ships, vehicles, harbors, etc.).
- `yolo26n.pt`: general photography, 80 COCO classes and axis-aligned boxes.
- `yolo26n-seg.pt`: general photography, 80 COCO classes and instance masks.

For building footprints, `buildings-seg` uses a project-supplied
`models/vision/yolov8n-building-seg.pt` when available, then falls back to the
official `yolo26n-seg.pt`. The fallback is a generic COCO model and does not
have a building class; use a building-trained weight for reliable footprints.
The building weight currently comes from the third-party Hugging Face model
`keremberke/yolov8n-building-segmentation` (saved locally as
`yolov8n-building-seg.pt`). It is not an Amazon Science LPM/SAM2 checkpoint;
verify the upstream model card and license before distributing it.

The building profile combines a 1536-pixel full-frame pass with up to four
overlapping enlarged crops when either image dimension exceeds 1280 pixels.
Crop detections are mapped back to the original pixels; masks clipped by an
interior crop boundary are discarded, and polygon overlap suppresses duplicate
roofs while keeping the full-frame contours. The requested confidence threshold
is respected in every pass. Dense retina-mask contours are simplified to the
256-point output limit instead of discarding the entire building. This is a
recall aid, not a guarantee that every roof is visible or recognized.

These models do not have airport or runway boundary classes. Detecting a plane
does not establish an airport boundary, and no detections does not establish
that no airport exists. Detection boxes are image coordinates, not geographic
polygons. The map application must ground coordinates and obtain confirmation
before drawing. Nano models favor CPU latency; satellite targets may require
closer zoom, better imagery, or domain-specific training.

## Windows

```powershell
powershell -ExecutionPolicy Bypass -File scripts/local-vision/setup.ps1
powershell -ExecutionPolicy Bypass -File scripts/local-vision/start.ps1
```

Run commands from the project root. Setup creates `.venv-vision` and downloads
the official weights into `models/vision`, validating the release digests. Existing
different files are not overwritten. Startup leaves unrelated port listeners
unchanged and is idempotent for a healthy instance of this service.

## Linux / macOS

```sh
python3 -m venv .venv-vision
.venv-vision/bin/python -m pip install --upgrade 'pip>=26.2' 'setuptools>=83.0.0'
.venv-vision/bin/python -m pip install -r scripts/local-vision/requirements.txt
.venv-vision/bin/python scripts/local-vision/setup_models.py
.venv-vision/bin/python scripts/local-vision/server.py
```

Default device is CPU. Set `GEV_YOLO_DEVICE=0` for a CUDA-enabled PyTorch
installation or `GEV_YOLO_DEVICE=mps` on supported Apple hardware. The supplied
Windows installation is CPU-compatible; GPU drivers/toolchains are not
installed or changed automatically.

## API and Limits

- `GET http://127.0.0.1:8766/health` reports version, device and installed/loaded
  models; it never downloads, imports, or runs an inference model.
- `POST /v1/detect` accepts JSON with `image` (PNG/JPEG/WebP base64 data URL),
  optional `confidence` (0.05 to 0.95, default 0.25), and `task` (`obb` default,
  or `detect`, `segment`, or `buildings-seg`). Remote URLs, file paths, arbitrary model selection and extra
  fields are rejected.
- Response: `{model, task, image:{width,height}, detections, supportedClasses,
  truncated, maxDetections:300}`. Detections contain `class`, `confidence`,
  `box:{x,y,width,height}`. OBB and segmentation tasks include `polygon`; OBB
  polygons always contain four points, while segmentation polygons contain the
  ordered mask contour in image pixels (up to 256 points).
- Maximum image is 5 MiB, maximum JSON is 8 MiB, and dimensions must not exceed
  4096 on either side. Header dimensions are checked before decompression.
- One inference runs at a time. A second request returns `VISION_BUSY` (429).
  Timeout is 60 seconds; a timed-out worker keeps its slot until completion,
  preventing unbounded native inference or request queues. Health stays usable.
- Detection is limited to 12 requests/minute, other requests to 120/minute.
  Browser Origin/Sec-Fetch-Site/User/Dest and non-loopback clients/Host values are
  denied. Access it through the same-origin Node `/api/vision/*` proxy.
- No image, crop, prediction text file, or original upload is persisted.
  Model weights and Ultralytics settings (telemetry disabled) are the only
  runtime model artifacts. Model loading uses only preinstalled local paths;
  automatic package installation/network checks are disabled.

The service and application proxy use fixed loopback port 8766. Do not expose
the Python port publicly.

## Tests

```powershell
.venv-vision/Scripts/python.exe -m pip install --upgrade 'pip>=26.2' 'setuptools>=83.0.0'
.venv-vision/Scripts/python.exe -m pip install -r scripts/local-vision/requirements-dev.txt
.venv-vision/Scripts/python.exe -m pytest scripts/local-vision -q --cov=server --cov=vision_input --cov=vision_runtime --cov=building_recall --cov=setup_models --cov-fail-under=80
```

Tests use fake models and in-memory images, covering malformed uploads,
cross-origin/rebinding requests, request limits, inference serialization,
timeouts, responsive health, OBB output, and weight checksum validation.

## License and References

Ultralytics code and weights use AGPL-3.0 or a separate Enterprise license.
Review AGPL source-sharing obligations before distribution or hosted use;
this integration does not grant a commercial-license exemption.

- https://docs.ultralytics.com/models/yolo26/
- https://docs.ultralytics.com/tasks/obb/
- https://pypi.org/project/ultralytics/8.4.148/
- https://github.com/ultralytics/assets/releases/tag/v8.4.0
- https://www.ultralytics.com/license
