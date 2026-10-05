"""Offline speech worker, isolated so timed-out native inference can be stopped."""

import asyncio
import io
import logging
import multiprocessing
import os
from pathlib import Path
import time
from dataclasses import dataclass

MAX_AUDIO_SECONDS = 60
SAMPLE_RATE = 16000
MODEL_ID = "local-whisper-small"
MODEL_PATH = Path(__file__).resolve().parents[2] / "models" / "speech" / "faster-whisper-small"
MODEL_ROOT = MODEL_PATH.parent
MODEL_ENV_ID = "GEV_LOCAL_SPEECH_MODEL_ID"
MODEL_ENV_PATH = "GEV_LOCAL_SPEECH_MODEL_PATH"
MODEL_PRESETS = {
    "small": ("local-whisper-small", "faster-whisper-small"),
    "base": ("local-whisper-small", "faster-whisper-small"),
    "medium": ("local-whisper-medium", "faster-whisper-medium"),
    "large-v3-turbo": ("local-whisper-large-v3-turbo", "faster-whisper-large-v3-turbo"),
}
CHINESE_TRANSCRIPTION_PROMPT = (
    "\u7b80\u4f53\u4e2d\u6587\uff1a\u5730\u56fe\uff0c\u5b9a\u4f4d\uff0c\u57ce\u5e02\uff0c\u5730\u70b9\uff0c"
    "\u56fe\u5c42\uff0c\u822a\u73ed\uff0c\u8239\u8236\uff0c\u536b\u661f\uff0c\u5730\u9707\uff0c\u4ea4\u901a\uff0c\u60c5\u62a5\u3002"
)
TRANSCRIPTION_TIMEOUT = 35
STARTUP_TIMEOUT = 60
logger = logging.getLogger("local-speech")


class ModelConfigError(ValueError):
    """Raised when the local speech model environment is unsafe or unsupported."""


@dataclass(frozen=True)
class ModelConfig:
    id: str
    path: Path


def resolve_model_config(env=None):
    """Resolve a local model preset or explicit directory from environment."""
    values = os.environ if env is None else env
    raw_id = str(values.get(MODEL_ENV_ID, "small") or "").strip().lower()
    raw_path = str(values.get(MODEL_ENV_PATH, "") or "").strip()
    if not raw_id or any(ord(char) < 32 for char in raw_id + raw_path):
        raise ModelConfigError("Speech model settings contain invalid characters.")
    preset = MODEL_PRESETS.get(raw_id)
    if preset is None and raw_id.startswith("local-whisper-"):
        preset = MODEL_PRESETS.get(raw_id.removeprefix("local-whisper-"))
    if preset is None:
        raise ModelConfigError("Unsupported local speech model. Use small, medium, or large-v3-turbo.")
    model_id, directory = preset
    path = Path(raw_path).expanduser().resolve() if raw_path else MODEL_ROOT / directory
    if not path.name or path == Path(path.anchor):
        raise ModelConfigError("Local speech model path is invalid.")
    return ModelConfig(model_id, path)


class SpeechError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def decode_audio_bounded(data):
    import av
    import numpy as np

    try:
        with av.open(io.BytesIO(data), mode="r", options={
            "protocol_whitelist": "pipe",
            "format_whitelist": "wav,matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,ogg,mp3,flac",
        }) as container:
            if not container.streams.audio:
                raise ValueError("No audio stream")
            resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
            chunks, samples = [], 0
            for frame in container.decode(audio=0):
                if frame.sample_rate > 192000 or len(frame.layout.channels) > 8:
                    raise ValueError("Unsupported audio layout")
                for converted in resampler.resample(frame):
                    samples += converted.samples
                    if samples > MAX_AUDIO_SECONDS * SAMPLE_RATE:
                        raise SpeechError(400, "AUDIO_TOO_LONG", "Audio must be 60 seconds or shorter.")
                    chunks.append(converted.to_ndarray().flatten())
            for converted in resampler.resample(None):
                samples += converted.samples
                if samples > MAX_AUDIO_SECONDS * SAMPLE_RATE:
                    raise SpeechError(400, "AUDIO_TOO_LONG", "Audio must be 60 seconds or shorter.")
                chunks.append(converted.to_ndarray().flatten())
            if not samples:
                raise ValueError("Empty audio stream")
            return np.concatenate(chunks).astype(np.float32) / 32768.0
    except SpeechError:
        raise
    except Exception as error:
        logger.warning("Audio decode failed (%s)", type(error).__name__)
        raise SpeechError(400, "INVALID_AUDIO", "Audio could not be decoded.") from None


def transcribe_audio(model, data, language):
    audio = decode_audio_bounded(data)
    segments, info = model.transcribe(
        audio, language=language, task="transcribe", beam_size=5 if language == "zh" else 1, best_of=1,
        temperature=0.0, vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 250},
        condition_on_previous_text=False,
        # The Chinese prompt and output share Whisper's 448-token context window.
        max_new_tokens=320 if language == "zh" else 400,
        **({"initial_prompt": CHINESE_TRANSCRIPTION_PROMPT} if language == "zh" else {}),
    )
    text = "".join(segment.text for segment in segments).strip()
    if len(text) > 8000:
        raise SpeechError(503, "INVALID_TRANSCRIPT", "Speech recognition returned an invalid result.")
    return {"text": text, "language": info.language, "duration": round(len(audio) / SAMPLE_RATE, 3)}


def worker_main(connection):
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    try:
        from faster_whisper import WhisperModel

        config = resolve_model_config()
        model = WhisperModel(str(config.path), device="cpu", compute_type="int8",
                             cpu_threads=min(8, os.cpu_count() or 1), num_workers=1,
                             local_files_only=True)
        connection.send({"ready": True})
        while True:
            request = connection.recv()
            if request is None:
                break
            try:
                result = transcribe_audio(model, request["audio"], request["language"])
                connection.send({"result": result})
            except SpeechError as error:
                connection.send({"error": (error.status, error.code, error.message)})
            except Exception as error:
                logger.error("Speech inference failed (%s)", type(error).__name__)
                connection.send({"error": (503, "INFERENCE_FAILED", "Speech recognition failed. Please retry.")})
    except (EOFError, BrokenPipeError):
        pass
    except Exception as error:
        logger.error("Speech worker failed (%s)", type(error).__name__)
        try:
            connection.send({"error": (503, "MODEL_UNAVAILABLE", "Local speech model is unavailable.")})
        except (OSError, EOFError):
            pass
    finally:
        connection.close()


class SpeechEngine:
    def __init__(self, context=None):
        self.context = context or multiprocessing.get_context("spawn")
        self.process = None
        self.connection = None
        self.ready = False
        self.recovery = None
        try:
            self.model_config = resolve_model_config()
            self.config_error = None
        except ModelConfigError as error:
            self.model_config = ModelConfig(MODEL_ID, MODEL_PATH)
            self.config_error = error

    async def _receive(self, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.connection and self.connection.poll():
                try:
                    return self.connection.recv()
                except (EOFError, OSError):
                    break
            if not self.process or not self.process.is_alive():
                break
            await asyncio.sleep(0.025)
        raise SpeechError(504, "TRANSCRIPTION_TIMEOUT", "Speech recognition timed out. Please retry.")

    async def start(self):
        if self.config_error:
            raise SpeechError(503, "MODEL_CONFIG_INVALID", "Local speech model configuration is invalid.")
        self._stop_worker()
        self.connection, child = self.context.Pipe()
        self.process = self.context.Process(target=worker_main, args=(child,), daemon=True)
        self.process.start()
        child.close()
        try:
            result = await self._receive(STARTUP_TIMEOUT)
            if not result.get("ready"):
                raise SpeechError(503, "MODEL_UNAVAILABLE", "Local speech model could not be loaded.")
            self.ready = True
        except BaseException:
            self._stop_worker()
            raise

    async def _recover(self):
        try:
            await self.start()
        except (SpeechError, OSError):
            logger.error("Local speech recovery failed; restart the service.")

    async def transcribe(self, audio, language):
        if not self.ready:
            raise SpeechError(503, "MODEL_UNAVAILABLE", "Local speech model is loading. Please retry.")
        try:
            # A full IPC pipe must not prevent the event loop enforcing its deadline.
            async with asyncio.timeout(TRANSCRIPTION_TIMEOUT):
                await asyncio.to_thread(self.connection.send, {"audio": audio, "language": language})
                response = await self._receive(TRANSCRIPTION_TIMEOUT)
        except (SpeechError, OSError, EOFError, TimeoutError):
            self._stop_worker()
            self.recovery = asyncio.create_task(self._recover())
            raise SpeechError(504, "TRANSCRIPTION_TIMEOUT", "Speech recognition timed out. Please retry.") from None
        except asyncio.CancelledError:
            self._stop_worker()
            self.recovery = asyncio.create_task(self._recover())
            raise
        if "error" in response:
            raise SpeechError(*response["error"])
        return response["result"]

    def _stop_worker(self):
        self.ready = False
        if self.process:
            if self.process.is_alive():
                self.process.terminate()
            self.process.join(timeout=2)
            if self.process.is_alive():
                self.process.kill()
                self.process.join(timeout=2)
        if self.connection:
            self.connection.close()
        self.process = None
        self.connection = None

    def close(self):
        if self.recovery and not self.recovery.done():
            self.recovery.cancel()
        self._stop_worker()
