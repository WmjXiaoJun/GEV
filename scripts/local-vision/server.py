"""Loopback-only local YOLO API; browser callers must use the application proxy."""

import asyncio
import ipaddress
import io
import json
import logging
import re
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.requests import ClientDisconnect

from vision_input import DetectionRequest, MAX_REQUEST_BYTES, VisionError
from vision_runtime import VisionRuntime

logger = logging.getLogger("gev.vision")
LOCAL_HOST = re.compile(r"^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?$", re.IGNORECASE)


def error_response(error):
    return JSONResponse({"error": {"code": error.code, "message": error.message}}, status_code=error.status,
                        headers={"Cache-Control": "no-store"})


def is_local_request(request):
    try:
        loopback = request.client is not None and ipaddress.ip_address(request.client.host).is_loopback
    except ValueError:
        loopback = False
    return (loopback and len(request.headers.getlist("host")) == 1
            and LOCAL_HOST.fullmatch(request.headers.get("host", "")) is not None
            and "origin" not in request.headers
            # Node fetch sends Sec-Fetch-Mode alone; browsers also send Site/Dest.
            and not any(key in request.headers for key in ("sec-fetch-site", "sec-fetch-user", "sec-fetch-dest")))


async def read_payload(request):
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise VisionError("VISION_INVALID_REQUEST", "Use an application/json request.", 415)
    length = request.headers.get("content-length")
    if length is not None:
        if not length.isdecimal():
            raise VisionError("VISION_INVALID_REQUEST", "Invalid request length.")
        if int(length) > MAX_REQUEST_BYTES:
            raise VisionError("VISION_REQUEST_TOO_LARGE", "Image request is too large.", 413)
    body, total = io.BytesIO(), 0
    try:
        async with asyncio.timeout(10):
            async for chunk in request.stream():
                total += len(chunk)
                if total > MAX_REQUEST_BYTES:
                    raise VisionError("VISION_REQUEST_TOO_LARGE", "Image request is too large.", 413)
                body.write(chunk)
    except (TimeoutError, ClientDisconnect):
        raise VisionError("VISION_INVALID_REQUEST", "Image upload was interrupted.", 408) from None
    try:
        return DetectionRequest.model_validate(json.loads(body.getvalue()))
    except (ValueError, TypeError, RecursionError, ValidationError):
        raise VisionError("VISION_INVALID_REQUEST", "Provide a valid image, confidence, and detection task.") from None


def create_app(runtime=None):
    runtime = runtime or VisionRuntime()
    requests = {"health": (), "detect": ()}

    @asynccontextmanager
    async def lifespan(app):
        yield
        runtime.close()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.middleware("http")
    async def local_boundary(request, call_next):
        if not is_local_request(request):
            return error_response(VisionError("VISION_FORBIDDEN", "Use the local application proxy.", 403))
        key = "detect" if request.url.path == "/v1/detect" else "health"
        now = time.monotonic()
        recent = tuple(stamp for stamp in requests[key] if now - stamp < 60)
        if len(recent) >= (12 if key == "detect" else 120):
            return error_response(VisionError("VISION_BUSY", "Too many local vision requests. Retry shortly.", 429))
        requests[key] = (*recent, now)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/health")
    async def health():
        return runtime.health()

    @app.post("/v1/detect")
    async def detect(request: Request):
        try:
            payload = await read_payload(request)
            return await runtime.detect(payload)
        except VisionError as exc:
            return error_response(exc)
        except Exception as exc:
            # Exception messages may contain file paths or submitted image data.
            logger.error("Local vision failure (%s)", type(exc).__name__)
            return error_response(VisionError("VISION_INFERENCE_FAILED", "Local YOLO inference failed.", 503))

    return app


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(create_app(), host="127.0.0.1", port=8766,
                proxy_headers=False, access_log=False, limit_concurrency=24, timeout_keep_alive=5)
