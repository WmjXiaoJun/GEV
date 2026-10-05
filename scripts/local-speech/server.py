"""Loopback-only OpenAI-compatible transcription API; recordings stay in RAM."""

import asyncio
from collections import deque
from contextlib import asynccontextmanager
from email import policy
from email.parser import BytesParser
import ipaddress
import logging
import os
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from engine import MAX_AUDIO_SECONDS, MODEL_ID, MODEL_PRESETS, SpeechEngine, SpeechError
from voiceprint import VoiceprintError, VoiceprintStore
from voiceprint_worker import VoiceprintWorker

MAX_AUDIO_BYTES = 4 * 1024 * 1024
MAX_REQUEST_BYTES = MAX_AUDIO_BYTES + 16384
UPLOAD_TIMEOUT = 10
ALLOWED_HOSTS = {"127.0.0.1:8765", "localhost:8765", "[::1]:8765"}
ALLOWED_TYPES = {"audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/mpeg", "audio/mp3", "audio/flac"}
MODEL_ALIASES = frozenset({
    MODEL_ID, "small", "local-whisper-base", "base", "whisper-1",
    "medium", "local-whisper-medium", "large-v3-turbo", "local-whisper-large-v3-turbo",
    *MODEL_PRESETS.keys(),
    *(preset[0] for preset in MODEL_PRESETS.values()),
})
logger = logging.getLogger("local-speech")


def invalid_upload():
    return SpeechError(400, "INVALID_REQUEST", "Provide a supported audio file and valid transcription settings.")


def parse_upload(content_type, body, extra_fields=()):
    if not content_type.startswith("multipart/form-data;") or "\r" in content_type or "\n" in content_type:
        raise invalid_upload()
    try:
        message = BytesParser(policy=policy.default).parsebytes(
            b"Content-Type: " + content_type.encode("ascii") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
        parts = list(message.iter_parts())
        if message.defects or not message.is_multipart() or not 1 <= len(parts) <= 4:
            raise invalid_upload()
        values = {}
        for part in parts:
            name = part.get_param("name", header="content-disposition")
            if part.defects or part.is_multipart() or name not in {"file", "model", "language", "response_format", *extra_fields} or name in values:
                raise invalid_upload()
            value = part.get_payload(decode=True)
            if part.get_content_disposition() != "form-data" or value is None:
                raise invalid_upload()
            if name == "file":
                if part.get_filename() is None or part.get_content_type() not in ALLOWED_TYPES or not value:
                    raise invalid_upload()
                if len(value) > MAX_AUDIO_BYTES:
                    raise SpeechError(413, "AUDIO_TOO_LARGE", "Audio must be 4 MiB or smaller.")
                values[name] = value
            else:
                if len(value) > 64 or part.get_filename() is not None:
                    raise invalid_upload()
                values[name] = value.decode("ascii")
        if "file" not in values or values.get("model", MODEL_ID) not in MODEL_ALIASES:
            raise invalid_upload()
        if values.get("language") not in {None, "zh", "en"} or values.get("response_format", "json") != "json":
            raise invalid_upload()
        if extra_fields:
            return values["file"], values.get("language"), {key: value for key, value in values.items() if key in extra_fields}
        return values["file"], values.get("language")
    except (UnicodeError, ValueError, TypeError):
        raise invalid_upload() from None


def error_response(error):
    return JSONResponse({"error": {"code": error.code, "message": error.message}}, status_code=error.status)


async def read_body(request):
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            size = int(content_length)
        except ValueError:
            raise invalid_upload() from None
        if size < 0:
            raise invalid_upload()
        if size > MAX_REQUEST_BYTES:
            raise SpeechError(413, "AUDIO_TOO_LARGE", "Audio must be 4 MiB or smaller.")
    chunks, total = [], 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_REQUEST_BYTES:
            raise SpeechError(413, "AUDIO_TOO_LARGE", "Audio must be 4 MiB or smaller.")
        chunks.append(chunk)
    return b"".join(chunks)


def rate_limited(history, limit):
    now = time.monotonic()
    while history and now - history[0] >= 60:
        history.popleft()
    if len(history) >= limit:
        return True
    history.append(now)
    return False


def create_app(engine=None, voiceprint=None):
    engine = engine or SpeechEngine()
    default_store = Path(__file__).resolve().parents[2] / ".gev-cache" / "voiceprints.json"
    configured_store = os.getenv("VOICEPRINT_STORE_PATH", "").strip()
    voice_worker = VoiceprintWorker() if voiceprint is None else getattr(voiceprint, "engine", None)
    voiceprint = voiceprint or VoiceprintStore(
        Path(configured_store) if configured_store else default_store,
        voice_worker,
    )

    @asynccontextmanager
    async def lifespan(application):
        await engine.start()
        try:
            if voice_worker is not None:
                try:
                    await voice_worker.start()
                except (VoiceprintError, OSError):
                    logger.error("Optional voiceprint worker is unavailable; transcription remains ready.")
            yield
        finally:
            engine.close()
            if voice_worker is not None:
                await voice_worker.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.processing = False
    app.state.speech_requests = deque()
    app.state.health_requests = deque()
    app.state.voiceprint_processing = False
    app.state.voiceprint_requests = deque()
    app.state.voiceprint_status_requests = deque()

    @app.middleware("http")
    async def local_only(request, call_next):
        try:
            local_peer = request.client is not None and ipaddress.ip_address(request.client.host).is_loopback
        except ValueError:
            local_peer = False
        host = request.headers.get("host", "").lower()
        origin = request.headers.get("origin")
        if not local_peer or host not in ALLOWED_HOSTS or (origin is not None and origin != f"http://{host}"):
            return error_response(SpeechError(403, "LOCAL_ONLY", "This endpoint accepts local same-origin requests only."))
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/health")
    async def health():
        if rate_limited(app.state.health_requests, 60):
            return error_response(SpeechError(429, "RATE_LIMITED", "Too many requests. Please retry later."))
        model_config = getattr(engine, "model_config", None)
        model_id = getattr(model_config, "id", MODEL_ID)
        return JSONResponse({"status": "ok" if engine.ready else "loading", "model": model_id,
                             "offline": True, "maxAudioSeconds": MAX_AUDIO_SECONDS,
                             "maxAudioBytes": MAX_AUDIO_BYTES, "voiceprint": voiceprint.status()}, status_code=200 if engine.ready else 503)

    @app.get("/voiceprint/status")
    async def voiceprint_status():
        if rate_limited(app.state.voiceprint_status_requests, 60):
            return error_response(SpeechError(429, "VOICEPRINT_RATE_LIMITED", "Too many voiceprint requests. Please retry later."))
        return JSONResponse(voiceprint.status())

    def admit_voiceprint_work():
        if app.state.voiceprint_processing or rate_limited(app.state.voiceprint_requests, 12):
            raise SpeechError(429, "VOICEPRINT_RATE_LIMITED", "Voiceprint recognition is busy. Please retry later.")
        app.state.voiceprint_processing = True

    def voiceprint_failure(error):
        status = {"VOICEPRINT_UNAVAILABLE": 503, "VOICEPRINT_TIMEOUT": 504,
                  "VOICEPRINT_RATE_LIMITED": 429, "VOICEPRINT_FAILED": 503}.get(error.code, 400)
        return JSONResponse({"error": {"code": error.code, "message": error.message}}, status_code=status)

    async def voiceprint_upload(request):
        body = await asyncio.wait_for(read_body(request), timeout=UPLOAD_TIMEOUT)
        audio, _, fields = parse_upload(request.headers.get("content-type", ""), body, extra_fields=("profile_id", "threshold"))
        return audio, fields

    @app.post("/voiceprint/enroll")
    async def voiceprint_enroll(request: Request):
        admitted = False
        try:
            admit_voiceprint_work()
            admitted = True
            if not voiceprint.available:
                raise VoiceprintError("VOICEPRINT_UNAVAILABLE", "Native voiceprint engine is not configured.")
            audio, fields = await voiceprint_upload(request)
            if not VoiceprintStore.PROFILE_ID.fullmatch(fields.get("profile_id", "")):
                raise VoiceprintError("VOICEPRINT_ID", "Voiceprint profile name is invalid.")
            result = await voiceprint.enroll_audio(fields.get("profile_id", ""), audio)
            return JSONResponse(result)
        except VoiceprintError as error:
            return voiceprint_failure(error)
        except (asyncio.TimeoutError, SpeechError) as error:
            return error_response(error if isinstance(error, SpeechError) else SpeechError(408, "UPLOAD_TIMEOUT", "Audio upload timed out."))
        except Exception as error:
            logger.error("Voiceprint enrollment failed (%s)", type(error).__name__)
            return voiceprint_failure(VoiceprintError("VOICEPRINT_FAILED", "Voiceprint enrollment failed. Please retry."))
        finally:
            if admitted:
                app.state.voiceprint_processing = False

    @app.post("/voiceprint/verify")
    async def voiceprint_verify(request: Request):
        admitted = False
        try:
            admit_voiceprint_work()
            admitted = True
            if not voiceprint.available:
                raise VoiceprintError("VOICEPRINT_UNAVAILABLE", "Native voiceprint engine is not configured.")
            audio, fields = await voiceprint_upload(request)
            threshold = float(fields.get("threshold", "0.25"))
            if not 0.01 <= threshold <= 1.0:
                raise VoiceprintError("VOICEPRINT_THRESHOLD", "Voiceprint threshold is invalid.")
            return JSONResponse(await voiceprint.verify_audio(audio, fields.get("profile_id") or None, threshold))
        except VoiceprintError as error:
            return voiceprint_failure(error)
        except (ValueError, asyncio.TimeoutError, SpeechError) as error:
            return error_response(error if isinstance(error, SpeechError) else SpeechError(400, "VOICEPRINT_INVALID_REQUEST", "Invalid voiceprint request."))
        except Exception as error:
            logger.error("Voiceprint verification failed (%s)", type(error).__name__)
            return voiceprint_failure(VoiceprintError("VOICEPRINT_FAILED", "Voiceprint verification failed. Please retry."))
        finally:
            if admitted:
                app.state.voiceprint_processing = False

    @app.delete("/voiceprint/profiles/{profile_id}")
    async def voiceprint_delete(profile_id: str):
        admitted = False
        try:
            admit_voiceprint_work()
            admitted = True
            if not VoiceprintStore.PROFILE_ID.fullmatch(profile_id):
                raise VoiceprintError("VOICEPRINT_ID", "Voiceprint profile name is invalid.")
            return JSONResponse({"deleted": voiceprint.delete(profile_id)})
        except SpeechError as error:
            return error_response(error)
        except VoiceprintError as error:
            return voiceprint_failure(error)
        except Exception as error:
            logger.error("Voiceprint deletion failed (%s)", type(error).__name__)
            return voiceprint_failure(VoiceprintError("VOICEPRINT_FAILED", "Voiceprint deletion failed. Please retry."))
        finally:
            if admitted:
                app.state.voiceprint_processing = False

    @app.post("/v1/audio/transcriptions")
    async def transcriptions(request: Request):
        if not engine.ready:
            return error_response(SpeechError(503, "MODEL_UNAVAILABLE", "Local speech model is loading. Please retry."))
        if app.state.processing or rate_limited(app.state.speech_requests, 12):
            return error_response(SpeechError(429, "RATE_LIMITED", "Speech recognition is busy. Please retry later."))
        app.state.processing = True
        try:
            body = await asyncio.wait_for(read_body(request), timeout=UPLOAD_TIMEOUT)
            audio, language = parse_upload(request.headers.get("content-type", ""), body)
            # Speaker gating is performed by the application proxy before this
            # endpoint is called. Keeping one authority prevents stale Python
            # environment values from disagreeing with the live UI settings.
            return await engine.transcribe(audio, language)
        except asyncio.TimeoutError:
            return error_response(SpeechError(408, "UPLOAD_TIMEOUT", "Audio upload timed out. Please retry."))
        except SpeechError as error:
            return error_response(error)
        except Exception as error:
            logger.error("Speech request failed (%s)", type(error).__name__)
            return error_response(SpeechError(503, "TRANSCRIPTION_FAILED", "Speech recognition failed. Please retry."))
        finally:
            app.state.processing = False

    return app


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(create_app(), host="127.0.0.1", port=8765, proxy_headers=False,
                access_log=False, limit_concurrency=8, timeout_keep_alive=5)
