import asyncio
import io
import wave
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from engine import MAX_AUDIO_SECONDS, SpeechError, decode_audio_bounded
from server import MAX_AUDIO_BYTES, MAX_REQUEST_BYTES, create_app, parse_upload


class FakeEngine:
    def __init__(self):
        self.ready = False
        self.calls = []
        self.error = None
        self.closed = False

    async def start(self):
        self.ready = True

    async def transcribe(self, audio, language):
        self.calls.append((audio, language))
        if self.error:
            raise self.error
        return {"text": "Turn on radio.", "language": language or "en", "duration": 3.2}

    def close(self):
        self.closed = True


class FakeVoiceprint:
    available = True
    mode = "observe"

    def __init__(self):
        self.calls = []

    def status(self):
        return {"available": True, "enabled": True, "mode": self.mode, "profiles": []}

    async def enroll_audio(self, profile_id, audio):
        self.calls.append(("enroll", profile_id, audio))
        return {"id": profile_id, "dimension": 2}

    async def verify_audio(self, audio, profile_id=None, threshold=0.25):
        self.calls.append(("verify", profile_id, threshold, audio))
        return {"verified": True, "profileId": profile_id or "owner", "distance": 0.1}

    def profiles(self):
        return []

    def delete(self, profile_id):
        self.calls.append(("delete", profile_id))
        return True

    def close(self):
        pass


@pytest.fixture
def engine():
    return FakeEngine()


@pytest.fixture
def client(engine):
    with TestClient(create_app(engine, voiceprint=FakeVoiceprint()), base_url="http://127.0.0.1:8765", client=("127.0.0.1", 4000)) as session:
        yield session


def upload(client, audio=b"audio", **kwargs):
    return client.post("/v1/audio/transcriptions", files={"file": ("recording.webm", audio, "audio/webm")}, **kwargs)


def test_health_reports_offline_fixed_model(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["model"] == "local-whisper-small"
    assert response.json()["offline"] is True
    assert "access-control-allow-origin" not in response.headers


def test_health_reports_configured_model_identity(monkeypatch):
    monkeypatch.setenv("GEV_LOCAL_SPEECH_MODEL_ID", "medium")
    from engine import resolve_model_config
    engine = FakeEngine()
    engine.model_config = resolve_model_config()
    with TestClient(create_app(engine, voiceprint=FakeVoiceprint()), base_url="http://127.0.0.1:8765", client=("127.0.0.1", 4000)) as session:
        response = session.get("/health")
    assert response.status_code == 200
    assert response.json()["model"] == "local-whisper-medium"


def test_default_voiceprint_store_is_outside_static_models_directory(monkeypatch, tmp_path):
    captured = {}

    class Store(FakeVoiceprint):
        def __init__(self, path, engine):
            captured["path"] = path
            super().__init__()

    monkeypatch.setattr("server.VoiceprintStore", Store)
    monkeypatch.delenv("VOICEPRINT_STORE_PATH", raising=False)
    app = create_app(FakeEngine())
    assert ".gev-cache" in str(captured["path"])
    assert "models" not in str(captured["path"])


def test_voiceprint_endpoints_use_local_audio_without_persisting_it(client):
    enrolled = client.post("/voiceprint/enroll", files={"file": ("recording.wav", b"audio", "audio/wav")}, data={"profile_id": "owner"})
    assert enrolled.status_code == 200
    assert enrolled.json()["id"] == "owner"
    verified = client.post("/voiceprint/verify", files={"file": ("recording.wav", b"audio", "audio/wav")}, data={"profile_id": "owner"})
    assert verified.status_code == 200
    assert verified.json()["verified"] is True
    assert client.delete("/voiceprint/profiles/owner").status_code == 200


def test_voiceprint_rejects_invalid_profile_id(client):
    response = client.post("/voiceprint/enroll", files={"file": ("recording.wav", b"audio", "audio/wav")}, data={"profile_id": "../owner"})
    assert response.status_code == 400


@pytest.mark.parametrize("route", ["enroll", "verify"])
def test_voiceprint_busy_requests_are_rejected_without_processing(client, route):
    client.app.state.voiceprint_processing = True
    response = client.post(f"/voiceprint/{route}", files={"file": ("sample.wav", b"audio", "audio/wav")},
                           data={"profile_id": "owner"})
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "VOICEPRINT_RATE_LIMITED"


def test_voiceprint_rate_is_shared_across_enrollment_and_verification(client):
    for index in range(12):
        route = "enroll" if index % 2 else "verify"
        response = client.post(f"/voiceprint/{route}", files={"file": ("sample.wav", b"audio", "audio/wav")},
                               data={"profile_id": "owner"})
        assert response.status_code == 200
    response = client.post("/voiceprint/verify", files={"file": ("sample.wav", b"audio", "audio/wav")})
    assert response.status_code == 429
    assert client.get("/health").status_code == 200


def test_voiceprint_status_has_a_bounded_independent_rate(client):
    for _ in range(60):
        assert client.get("/voiceprint/status").status_code == 200
    assert client.get("/voiceprint/status").status_code == 429


def test_voiceprint_pending_work_does_not_block_health_or_allow_second_job():
    from voiceprint import VoiceprintError

    class WaitingVoiceprint(FakeVoiceprint):
        async def verify_audio(self, *_args):
            await asyncio.sleep(0.2)
            raise VoiceprintError("VOICEPRINT_TIMEOUT", "Timed out")

    async def scenario():
        app = create_app(FakeEngine(), voiceprint=WaitingVoiceprint())
        async with app.router.lifespan_context(app):
            transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 4000))
            async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8765") as session:
                pending = asyncio.create_task(session.post("/voiceprint/verify", files={"file": ("sample.wav", b"audio", "audio/wav")}))
                await asyncio.sleep(0.02)
                started = time.monotonic()
                assert (await session.get("/health")).status_code == 200
                assert time.monotonic() - started < 0.1
                other = await session.post("/voiceprint/enroll", files={"file": ("sample.wav", b"audio", "audio/wav")}, data={"profile_id": "owner"})
                assert other.status_code == 429
                assert app.state.voiceprint_processing
                response = await pending
                assert response.status_code == 504
                assert response.json()["error"]["code"] == "VOICEPRINT_TIMEOUT"
                assert not app.state.voiceprint_processing

    asyncio.run(scenario())


@pytest.mark.parametrize("route", ["enroll", "verify", "delete"])
def test_voiceprint_unexpected_errors_are_sanitized_and_busy_is_released(route):
    class FailingVoiceprint(FakeVoiceprint):
        async def enroll_audio(self, *_args):
            raise OSError("private-path-and-token")

        async def verify_audio(self, *_args):
            raise OSError("private-path-and-token")

        def delete(self, *_args):
            raise OSError("private-path-and-token")

    app = create_app(FakeEngine(), voiceprint=FailingVoiceprint())
    with TestClient(app, base_url="http://127.0.0.1:8765", client=("127.0.0.1", 4000)) as session:
        if route == "delete":
            response = session.delete("/voiceprint/profiles/owner")
        else:
            response = session.post(f"/voiceprint/{route}", files={"file": ("sample.wav", b"audio", "audio/wav")}, data={"profile_id": "owner"})
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "VOICEPRINT_FAILED"
        assert "private-path-and-token" not in response.text
        assert not app.state.voiceprint_processing


def test_health_unavailable_during_model_recovery(client, engine):
    engine.ready = False
    assert client.get("/health").status_code == 503
    assert upload(client).status_code == 503


def test_transcription_uses_in_memory_audio_and_language(client, engine):
    response = upload(client, data={"model": "local-whisper-base", "language": "zh", "response_format": "json"})
    assert response.status_code == 200
    assert response.json()["text"] == "Turn on radio."
    assert engine.calls == [(b"audio", "zh")]


@pytest.mark.parametrize("model", ["small", "local-whisper-small", "base", "whisper-1", "local-whisper-base"])
def test_openai_compatible_model_aliases_use_same_fixed_engine(client, engine, model):
    assert upload(client, data={"model": model, "language": "zh"}).status_code == 200
    assert engine.calls == [(b"audio", "zh")]


def test_transcription_without_model_uses_fixed_engine(client, engine):
    assert upload(client, data={"language": "zh"}).status_code == 200
    assert engine.calls == [(b"audio", "zh")]


@pytest.mark.parametrize("data", [
    {"model": "../../secret"}, {"model": "large-v3"}, {"model": "Systran/faster-whisper-small"},
    {"model": "https://example.com/model"}, {"language": "unknown"},
    {"response_format": "text"}, {"prompt": "override"}, {"language": "zh-CN"},
])
def test_rejects_unsupported_fields_without_engine_work(client, engine, data):
    assert upload(client, data=data).status_code == 400
    assert engine.calls == []


def test_rejects_empty_audio(client):
    assert upload(client, audio=b"").status_code == 400


def test_rejects_audio_larger_than_four_mib(client):
    assert upload(client, audio=b"x" * (MAX_AUDIO_BYTES + 1)).status_code == 413


def test_rejects_body_larger_than_limit_before_reading(client):
    response = client.post("/v1/audio/transcriptions", content=b"x", headers={"content-length": str(MAX_REQUEST_BYTES + 1)})
    assert response.status_code == 413


def test_rejects_streamed_body_larger_than_limit(client):
    response = client.post("/v1/audio/transcriptions", content=iter([b"x" * MAX_REQUEST_BYTES, b"x"]))
    assert response.status_code == 413


@pytest.mark.parametrize("host", ["evil.example", "127.0.0.1.evil.example:8765", "127.0.0.1:4175"])
def test_rejects_dns_rebinding_host(client, host):
    assert client.get("/health", headers={"host": host}).status_code == 403


def test_rejects_non_loopback_peer(engine):
    with TestClient(create_app(engine), base_url="http://127.0.0.1:8765", client=("192.0.2.1", 4000)) as session:
        assert session.get("/health").status_code == 403


@pytest.mark.parametrize("origin", ["https://example.com", "http://127.0.0.1:4175", "null"])
def test_rejects_browser_cross_origin_uploads(client, origin):
    assert upload(client, headers={"origin": origin}).status_code == 403


@pytest.mark.parametrize("content_type", ["application/json", "multipart/form-data", "multipart/form-data; boundary=none"])
def test_rejects_malformed_multipart(client, content_type):
    response = client.post("/v1/audio/transcriptions", content=b"not a multipart body", headers={"content-type": content_type})
    assert response.status_code == 400


def test_rejects_missing_audio_file(client):
    assert client.post("/v1/audio/transcriptions", data={"model": "base"}).status_code == 400


def test_rejects_wrong_mime(client):
    response = client.post("/v1/audio/transcriptions", files={"file": ("file.txt", b"abc", "text/plain")})
    assert response.status_code == 400


def test_rejects_duplicate_files(client):
    response = client.post("/v1/audio/transcriptions", files=[("file", ("one.wav", b"1", "audio/wav")), ("file", ("two.wav", b"2", "audio/wav"))])
    assert response.status_code == 400


def test_rejects_duplicate_fields(client):
    request = httpx.Request("POST", "http://127.0.0.1:8765", files=[("model", (None, "base")), ("model", (None, "base")), ("file", ("x.wav", b"x", "audio/wav"))])
    with pytest.raises(SpeechError):
        parse_upload(request.headers["content-type"], request.read())


def test_busy_requests_are_rejected_not_queued(client):
    client.app.state.processing = True
    assert upload(client).status_code == 429


def test_limits_transcription_rate(client):
    for _ in range(12):
        assert upload(client).status_code == 200
    assert upload(client).status_code == 429


def test_limits_health_rate(client):
    for _ in range(60):
        assert client.get("/health").status_code == 200
    assert client.get("/health").status_code == 429


def test_typed_errors_return_safe_json_and_release_busy(client, engine):
    engine.error = SpeechError(504, "TRANSCRIPTION_TIMEOUT", "Speech recognition timed out.")
    response = upload(client)
    assert response.status_code == 504
    assert response.json()["error"]["code"] == "TRANSCRIPTION_TIMEOUT"
    assert client.app.state.processing is False


def test_unexpected_errors_are_sanitized(client, engine):
    engine.error = RuntimeError("secret-path-and-token")
    response = upload(client)
    assert response.status_code == 503
    assert "secret-path-and-token" not in response.text


def test_lifespan_closes_engine(engine):
    with TestClient(create_app(engine), base_url="http://127.0.0.1:8765", client=("127.0.0.1", 4000)):
        assert engine.ready
    assert engine.closed


def wav_bytes(seconds=0.1):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\x00\x00" * int(seconds * 16000))
    return buffer.getvalue()


def test_decodes_audio_in_memory_at_sixteen_khz():
    audio = decode_audio_bounded(wav_bytes())
    assert audio.shape == (1600,)
    assert str(audio.dtype) == "float32"


def test_rejects_audio_longer_than_sixty_seconds():
    with pytest.raises(SpeechError) as error:
        decode_audio_bounded(wav_bytes(MAX_AUDIO_SECONDS + 1))
    assert error.value.code == "AUDIO_TOO_LONG"


def test_rejects_undecodable_audio():
    with pytest.raises(SpeechError) as error:
        decode_audio_bounded(b"not audio")
    assert error.value.code == "INVALID_AUDIO"


def test_rejects_audio_without_samples():
    with pytest.raises(SpeechError):
        decode_audio_bounded(wav_bytes(0))


@pytest.mark.parametrize("container_format, codec", [("webm", "libopus"), ("ogg", "libopus"), ("mp4", "aac"), ("flac", "flac"), ("mp3", "mp3")])
def test_decoder_supports_mediarecorder_and_upload_audio_formats(container_format, codec):
    import av

    result = io.BytesIO()
    with av.open(io.BytesIO(wav_bytes(0.2)), mode="r") as source:
        with av.open(result, mode="w", format=container_format) as destination:
            stream = destination.add_stream(codec, rate=48000)
            stream.layout = "mono"
            for frame in source.decode(audio=0):
                for packet in stream.encode(frame):
                    destination.mux(packet)
            for packet in stream.encode(None):
                destination.mux(packet)
    audio = decode_audio_bounded(result.getvalue())
    assert 2800 <= audio.size <= 4000
