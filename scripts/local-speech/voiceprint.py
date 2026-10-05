"""Optional local speaker verification through voice-detect.cpp's C ABI.

The native library is deliberately optional. Transcription remains available
when it is not installed, while enrolled profiles contain embeddings only and
never retain microphone audio.
"""

import ctypes
import json
import math
import os
import re
import tempfile
import threading
from pathlib import Path

import numpy as np


class VoiceprintError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def cosine_distance(left, right):
    a = np.asarray(left, dtype=np.float32)
    b = np.asarray(right, dtype=np.float32)
    if a.ndim != 1 or b.ndim != 1 or a.size == 0 or a.size != b.size:
        raise VoiceprintError("VOICEPRINT_DIMENSION", "Voiceprint dimensions do not match.")
    denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denominator <= 1e-8:
        raise VoiceprintError("VOICEPRINT_AUDIO", "Voiceprint audio is too quiet.")
    distance = 1.0 - float(np.dot(a, b) / denominator)
    if not math.isfinite(distance):
        raise VoiceprintError("VOICEPRINT_AUDIO", "Voiceprint embedding is invalid.")
    return max(0.0, min(2.0, distance))


class VoiceDetectEngine:
    """ctypes adapter for voicedetect_capi_embed_pcm."""

    def __init__(self, library_path=None, model_path=None):
        self.library_path = str(library_path or os.getenv("VOICEDETECT_LIBRARY", "")).strip()
        self.model_path = str(model_path or os.getenv("VOICEDETECT_MODEL", "")).strip()
        self._library = None
        self._context = None
        if self.library_path and self.model_path:
            self._load()

    @property
    def available(self):
        return self._context is not None

    def _load(self):
        try:
            self._library = ctypes.CDLL(self.library_path)
            self._library.voicedetect_capi_load.argtypes = [ctypes.c_char_p]
            self._library.voicedetect_capi_load.restype = ctypes.c_void_p
            self._library.voicedetect_capi_free.argtypes = [ctypes.c_void_p]
            self._library.voicedetect_capi_embed_pcm.argtypes = [
                ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_int,
                ctypes.c_int, ctypes.POINTER(ctypes.POINTER(ctypes.c_float)), ctypes.POINTER(ctypes.c_int),
            ]
            self._library.voicedetect_capi_embed_pcm.restype = ctypes.c_int
            self._library.voicedetect_capi_free_vec.argtypes = [ctypes.POINTER(ctypes.c_float)]
            self._context = self._library.voicedetect_capi_load(self.model_path.encode("utf-8"))
            if not self._context:
                self._library = None
        except (OSError, AttributeError, UnicodeError):
            self._library = None
            self._context = None

    def embed_pcm(self, audio):
        if not self.available:
            raise VoiceprintError("VOICEPRINT_UNAVAILABLE", "Native voiceprint engine is not configured.")
        pcm = np.asarray(audio, dtype=np.float32).reshape(-1)
        if pcm.size < 1600 or float(np.max(np.abs(pcm), initial=0.0)) < 0.003:
            raise VoiceprintError("VOICEPRINT_AUDIO", "Voiceprint audio is too short or too quiet.")
        values = np.ascontiguousarray(pcm, dtype=np.float32)
        out = ctypes.POINTER(ctypes.c_float)()
        dimension = ctypes.c_int(0)
        rc = self._library.voicedetect_capi_embed_pcm(
            self._context, values.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            int(values.size), 16000, ctypes.byref(out), ctypes.byref(dimension),
        )
        try:
            if rc != 0 or not out or dimension.value <= 0:
                raise VoiceprintError("VOICEPRINT_FAILED", "Voiceprint embedding failed.")
            return np.ctypeslib.as_array(out, shape=(dimension.value,)).copy()
        finally:
            if out:
                self._library.voicedetect_capi_free_vec(out)

    def close(self):
        if self._context and self._library:
            self._library.voicedetect_capi_free(self._context)
        self._context = None
        self._library = None


class VoiceprintStore:
    PROFILE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")

    def __init__(self, path, engine):
        self.path = Path(path)
        self.engine = engine
        self._write_lock = threading.RLock()
        self._profiles = self._read()

    @property
    def available(self):
        return bool(getattr(self.engine, "available", True))

    @property
    def enabled(self):
        return os.getenv("VOICEPRINT_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}

    @property
    def mode(self):
        value = os.getenv("VOICEPRINT_MODE", "observe").strip().lower()
        return value if value in {"observe", "enforce"} else "observe"

    def status(self):
        return {"available": self.available, "enabled": self.enabled, "mode": self.mode,
                "profile": os.getenv("VOICEPRINT_PROFILE", "").strip(), "profiles": self.profiles()}

    def _read(self):
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                return {}
            profiles = payload.get("profiles", {})
            if not isinstance(profiles, dict):
                return {}
            clean = {}
            for profile_id, profile in profiles.items():
                if not isinstance(profile_id, str) or not self.PROFILE_ID.fullmatch(profile_id):
                    continue
                if not isinstance(profile, dict) or not isinstance(profile.get("embedding"), list):
                    continue
                try:
                    vector = np.asarray(profile["embedding"], dtype=np.float32).reshape(-1)
                except (TypeError, ValueError):
                    continue
                if vector.size == 0 or not np.all(np.isfinite(vector)) or float(np.linalg.norm(vector)) <= 1e-8:
                    continue
                clean[profile_id] = {"embedding": [round(float(value), 6) for value in vector]}
            return clean
        except (OSError, ValueError, TypeError):
            return {}

    def _write(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({"version": 1, "profiles": self._profiles}, ensure_ascii=True, allow_nan=False)
        with self._write_lock:
            fd, temporary_name = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent)
            temporary = Path(temporary_name)
            try:
                with open(fd, "w", encoding="utf-8", closefd=True) as output:
                    output.write(payload)
                    output.flush()
                    os.fsync(output.fileno())
                temporary.replace(self.path)
            finally:
                try:
                    temporary.unlink()
                except FileNotFoundError:
                    pass

    def enroll(self, profile_id, embedding):
        if not isinstance(profile_id, str) or not self.PROFILE_ID.fullmatch(profile_id):
            raise VoiceprintError("VOICEPRINT_ID", "Voiceprint profile name is invalid.")
        try:
            vector = np.asarray(embedding, dtype=np.float32).reshape(-1)
        except (TypeError, ValueError):
            raise VoiceprintError("VOICEPRINT_AUDIO", "Voiceprint embedding is invalid.") from None
        if vector.size == 0 or not np.all(np.isfinite(vector)) or float(np.linalg.norm(vector)) <= 1e-8:
            raise VoiceprintError("VOICEPRINT_AUDIO", "Voiceprint audio is too quiet.")
        vector = vector / np.linalg.norm(vector)
        updated_profiles = {**self._profiles, profile_id: {"embedding": [round(float(v), 6) for v in vector]}}
        previous_profiles = self._profiles
        self._profiles = updated_profiles
        try:
            self._write()
        except Exception:
            self._profiles = previous_profiles
            raise
        return {"id": profile_id, "dimension": int(vector.size)}

    async def enroll_audio(self, profile_id, audio):
        return self.enroll(profile_id, await self.engine.embed_audio(audio))

    async def verify_audio(self, audio, profile_id=None, threshold=0.25):
        return self.verify(await self.engine.embed_audio(audio), profile_id, threshold)

    def verify(self, embedding, profile_id=None, threshold=0.25):
        candidates = [profile_id] if profile_id else list(self._profiles)
        best_id, best_distance = None, math.inf
        for candidate in candidates:
            profile = self._profiles.get(candidate)
            if not isinstance(profile, dict):
                continue
            try:
                distance = cosine_distance(embedding, profile.get("embedding", []))
            except VoiceprintError:
                continue
            if distance < best_distance:
                best_id, best_distance = candidate, distance
        verified = best_id is not None and best_distance <= float(threshold)
        return {"verified": bool(verified), "profileId": best_id if verified else None,
                "distance": None if best_id is None else round(best_distance, 6)}

    def delete(self, profile_id):
        if profile_id not in self._profiles:
            return False
        updated_profiles = {key: value for key, value in self._profiles.items() if key != profile_id}
        previous_profiles = self._profiles
        self._profiles = updated_profiles
        try:
            self._write()
        except Exception:
            self._profiles = previous_profiles
            raise
        return True

    def profiles(self):
        return [{"id": key, "dimension": len(value.get("embedding", []))}
                for key, value in self._profiles.items() if isinstance(value, dict)]
