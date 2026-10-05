"""Killable, single-request native speaker inference; recordings stay in RAM."""

import asyncio
from contextlib import suppress
import logging
import multiprocessing
import os
import time

from engine import SpeechError, decode_audio_bounded
from voiceprint import VoiceDetectEngine, VoiceprintError

INFERENCE_TIMEOUT = 20
STARTUP_TIMEOUT = 30
logger = logging.getLogger("local-speech")


def worker_main(connection, library_path, model_path):
    engine = None
    try:
        engine = VoiceDetectEngine(library_path, model_path)
        connection.send({"ready": engine.available})
        if not engine.available:
            return
        while True:
            audio = connection.recv()
            if audio is None:
                break
            try:
                vector = engine.embed_pcm(decode_audio_bounded(audio))
                connection.send({"embedding": vector.tolist()})
            except VoiceprintError as error:
                connection.send({"error": (error.code, error.message)})
            except SpeechError:
                connection.send({"error": ("VOICEPRINT_AUDIO", "Voiceprint audio could not be decoded.")})
            except Exception as error:
                logger.error("Voiceprint inference failed (%s)", type(error).__name__)
                connection.send({"error": ("VOICEPRINT_FAILED", "Voiceprint embedding failed.")})
            finally:
                audio = None
    except (EOFError, BrokenPipeError):
        pass
    except Exception as error:
        logger.error("Voiceprint worker failed (%s)", type(error).__name__)
    finally:
        if engine is not None:
            engine.close()
        connection.close()


class VoiceprintWorker:
    def __init__(self, context=None, timeout=INFERENCE_TIMEOUT, worker_target=worker_main):
        self.context = context or multiprocessing.get_context("spawn")
        self.timeout = timeout
        self.worker_target = worker_target
        self.library_path = os.getenv("VOICEDETECT_LIBRARY", "").strip()
        self.model_path = os.getenv("VOICEDETECT_MODEL", "").strip()
        self.configured = context is not None or bool(self.library_path and self.model_path)
        self.process = None
        self.connection = None
        self.available = False
        self.busy = False
        self.recovery = None
        self.closed = False

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
            await asyncio.sleep(0.01)
        raise VoiceprintError("VOICEPRINT_TIMEOUT", "Voiceprint inference timed out. Please retry.")

    async def start(self):
        if self.closed or not self.configured:
            return
        await self._stop_worker()
        self.connection, child = self.context.Pipe()
        self.process = self.context.Process(target=self.worker_target,
            args=(child, self.library_path, self.model_path), daemon=True)
        try:
            self.process.start()
            child.close()
            result = await self._receive(STARTUP_TIMEOUT)
            if result.get("ready") is not True:
                raise VoiceprintError("VOICEPRINT_UNAVAILABLE", "Native voiceprint engine is not configured.")
            self.available = True
        except BaseException:
            child.close()
            await self._stop_worker()
            raise

    async def _recover(self):
        try:
            await self.start()
        except (VoiceprintError, OSError):
            logger.error("Voiceprint recovery failed; restart the speech service.")

    async def _restart(self):
        await self._stop_worker()
        if not self.closed:
            self.recovery = asyncio.create_task(self._recover())

    async def embed_audio(self, audio):
        if self.busy:
            raise VoiceprintError("VOICEPRINT_RATE_LIMITED", "Voiceprint recognition is busy. Please retry.")
        if not self.available or self.closed:
            raise VoiceprintError("VOICEPRINT_UNAVAILABLE", "Native voiceprint engine is unavailable.")
        self.busy = True
        try:
            connection = self.connection
            async with asyncio.timeout(self.timeout):
                await asyncio.to_thread(connection.send, audio)
                response = await self._receive(self.timeout)
        except (VoiceprintError, OSError, EOFError, TimeoutError):
            await self._restart()
            raise VoiceprintError("VOICEPRINT_TIMEOUT", "Voiceprint inference timed out. Please retry.") from None
        except asyncio.CancelledError:
            await self._restart()
            raise
        finally:
            self.busy = False
        if "error" in response:
            raise VoiceprintError(*response["error"])
        return response["embedding"]

    async def _stop_worker(self):
        self.available = False
        process, connection = self.process, self.connection
        self.process = None
        self.connection = None
        try:
            if process and process.pid is not None:
                if process.is_alive():
                    process.terminate()
                await asyncio.to_thread(process.join, 2)
                if process.is_alive():
                    process.kill()
                    await asyncio.to_thread(process.join, 2)
        finally:
            if connection:
                connection.close()

    async def close(self):
        self.closed = True
        if self.recovery and not self.recovery.done():
            self.recovery.cancel()
            with suppress(asyncio.CancelledError):
                await self.recovery
        await self._stop_worker()
