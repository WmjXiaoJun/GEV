import asyncio
from collections import deque
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import numpy as np
import pytest

import engine
from engine import ModelConfigError, SpeechEngine, SpeechError, resolve_model_config


def test_model_config_defaults_to_local_small(monkeypatch):
    monkeypatch.delenv("GEV_LOCAL_SPEECH_MODEL_ID", raising=False)
    monkeypatch.delenv("GEV_LOCAL_SPEECH_MODEL_PATH", raising=False)
    config = resolve_model_config()
    assert config.id == "local-whisper-small"
    assert config.path.name == "faster-whisper-small"


@pytest.mark.parametrize("model_id, directory", [
    ("medium", "faster-whisper-medium"),
    ("local-whisper-medium", "faster-whisper-medium"),
    ("large-v3-turbo", "faster-whisper-large-v3-turbo"),
    ("local-whisper-large-v3-turbo", "faster-whisper-large-v3-turbo"),
])
def test_model_config_supports_accuracy_presets(monkeypatch, model_id, directory):
    monkeypatch.setenv("GEV_LOCAL_SPEECH_MODEL_ID", model_id)
    monkeypatch.delenv("GEV_LOCAL_SPEECH_MODEL_PATH", raising=False)
    config = resolve_model_config()
    assert config.id == f"local-whisper-{directory.removeprefix('faster-whisper-')}"
    assert config.path.name == directory


def test_model_config_explicit_path_overrides_preset(monkeypatch, tmp_path):
    monkeypatch.setenv("GEV_LOCAL_SPEECH_MODEL_ID", "large-v3-turbo")
    monkeypatch.setenv("GEV_LOCAL_SPEECH_MODEL_PATH", str(tmp_path / "my-model"))
    config = resolve_model_config()
    assert config.id == "local-whisper-large-v3-turbo"
    assert config.path == (tmp_path / "my-model").resolve()


def test_model_config_accepts_mapping_without_process_environment(tmp_path):
    config = resolve_model_config({"GEV_LOCAL_SPEECH_MODEL_ID": "medium", "GEV_LOCAL_SPEECH_MODEL_PATH": str(tmp_path)})
    assert config.id == "local-whisper-medium"
    assert config.path == tmp_path.resolve()


@pytest.mark.parametrize("env", [
    {"GEV_LOCAL_SPEECH_MODEL_ID": "../../secret"},
    {"GEV_LOCAL_SPEECH_MODEL_ID": "not-a-supported-model"},
    {"GEV_LOCAL_SPEECH_MODEL_PATH": "\u0001invalid"},
])
def test_model_config_rejects_invalid_values(monkeypatch, env):
    monkeypatch.delenv("GEV_LOCAL_SPEECH_MODEL_ID", raising=False)
    monkeypatch.delenv("GEV_LOCAL_SPEECH_MODEL_PATH", raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    with pytest.raises(ModelConfigError):
        resolve_model_config()


class FakeConnection:
    def __init__(self, messages=()):
        self.messages = deque(messages)
        self.sent = []
        self.closed = False

    def poll(self):
        return bool(self.messages)

    def recv(self):
        value = self.messages.popleft()
        if isinstance(value, Exception):
            raise value
        return value

    def send(self, value):
        self.sent.append(value)

    def close(self):
        self.closed = True


class FakeProcess:
    def __init__(self):
        self.alive = False
        self.killed = False

    def start(self):
        self.alive = True

    def is_alive(self):
        return self.alive

    def terminate(self):
        self.alive = False

    def kill(self):
        self.killed = True
        self.alive = False

    def join(self, timeout):
        pass


def fake_context(messages=({"ready": True},)):
    parent, child, process = FakeConnection(messages), FakeConnection(), FakeProcess()
    context = SimpleNamespace(Pipe=lambda: (parent, child), Process=lambda **kwargs: process)
    return context, parent, child, process


def test_start_loads_model_and_closes_child_pipe():
    context, parent, child, process = fake_context()
    service = SpeechEngine(context)
    asyncio.run(service.start())
    assert service.ready and process.alive and child.closed
    service.close()
    assert parent.closed and not process.alive and not service.ready


def test_bad_startup_message_stops_worker():
    context, _, _, process = fake_context([{"error": "bad model"}])
    service = SpeechEngine(context)
    with pytest.raises(SpeechError) as error:
        asyncio.run(service.start())
    assert error.value.code == "MODEL_UNAVAILABLE"
    assert not process.alive


def test_receives_transcription_and_sends_only_audio_and_language():
    context, parent, _, _ = fake_context([{"ready": True}, {"result": {"text": "hello"}}])
    service = SpeechEngine(context)

    async def scenario():
        await service.start()
        assert await service.transcribe(b"wav", "en") == {"text": "hello"}
        service.close()

    asyncio.run(scenario())
    assert parent.sent == [{"audio": b"wav", "language": "en"}]


def test_returns_worker_validation_error():
    context, _, _, _ = fake_context([{"ready": True}, {"error": (400, "INVALID_AUDIO", "Bad audio.")}])
    service = SpeechEngine(context)

    async def scenario():
        await service.start()
        with pytest.raises(SpeechError) as error:
            await service.transcribe(b"wav", "en")
        assert error.value.code == "INVALID_AUDIO"
        service.close()

    asyncio.run(scenario())


def test_rejects_transcription_when_model_not_ready():
    with pytest.raises(SpeechError) as error:
        asyncio.run(SpeechEngine().transcribe(b"wav", "en"))
    assert error.value.code == "MODEL_UNAVAILABLE"


@pytest.mark.parametrize("failure", [SpeechError(504, "TIMEOUT", "Timed out"), OSError("broken"), EOFError()])
def test_timeout_kills_and_recovers_inference_worker(failure):
    context, _, _, process = fake_context()
    service = SpeechEngine(context)
    service._recover = AsyncMock()

    async def scenario():
        await service.start()
        service._receive = AsyncMock(side_effect=failure)
        with pytest.raises(SpeechError) as error:
            await service.transcribe(b"wav", "en")
        assert error.value.status == 504
        await service.recovery

    asyncio.run(scenario())
    assert not process.alive
    service._recover.assert_awaited_once()


def test_cancelled_request_stops_worker():
    context, _, _, process = fake_context()
    service = SpeechEngine(context)
    service._recover = AsyncMock()

    async def scenario():
        await service.start()
        service._receive = AsyncMock(side_effect=asyncio.CancelledError())
        with pytest.raises(asyncio.CancelledError):
            await service.transcribe(b"wav", "en")
        await service.recovery

    asyncio.run(scenario())
    assert not process.alive


def test_failed_recovery_is_logged_and_not_ready(caplog):
    service = SpeechEngine()
    service.start = AsyncMock(side_effect=SpeechError(503, "BAD", "Bad model"))
    asyncio.run(service._recover())
    assert not service.ready
    assert "restart the service" in caplog.text


def test_receive_checks_worker_crash():
    service = SpeechEngine()
    with pytest.raises(SpeechError):
        asyncio.run(service._receive(0.1))


def test_receive_handles_closed_pipe():
    service = SpeechEngine()
    service.connection = FakeConnection([EOFError()])
    with pytest.raises(SpeechError):
        asyncio.run(service._receive(0.1))


def test_receive_deadline_and_yielding():
    service = SpeechEngine()
    service.connection = FakeConnection()
    service.process = FakeProcess()
    service.process.start()
    with pytest.raises(SpeechError):
        asyncio.run(service._receive(0.01))


def test_stop_kills_worker_that_does_not_terminate():
    service = SpeechEngine()
    process = FakeProcess()
    process.start()
    process.terminate = lambda: None
    service.process = process
    service.close()
    assert process.killed


def test_close_cancels_pending_recovery():
    service = SpeechEngine()
    recovery = Mock()
    recovery.done.return_value = False
    service.recovery = recovery
    service.close()
    recovery.cancel.assert_called_once()


def test_transcribe_decodes_bounded_audio_and_uses_fixed_options(monkeypatch):
    monkeypatch.setattr(engine, "decode_audio_bounded", lambda _: np.zeros(16000, dtype=np.float32))
    model = Mock()
    model.transcribe.return_value = ([SimpleNamespace(text=" hello ")], SimpleNamespace(language="en"))
    assert engine.transcribe_audio(model, b"wav", "en") == {"text": "hello", "language": "en", "duration": 1.0}
    assert model.transcribe.call_args.kwargs["max_new_tokens"] == 400
    assert model.transcribe.call_args.kwargs["beam_size"] == 1
    assert model.transcribe.call_args.kwargs["temperature"] == 0.0
    assert "initial_prompt" not in model.transcribe.call_args.kwargs


def test_chinese_transcription_uses_accurate_decoding_and_domain_vocabulary(monkeypatch):
    monkeypatch.setattr(engine, "decode_audio_bounded", lambda _: np.zeros(16000, dtype=np.float32))
    original_text = "\u5b9a\u4f4d\u5230\u6211\u521a\u624d\u63d0\u5230\u7684\u57ce\u5e02"
    model = Mock()
    model.transcribe.return_value = ([SimpleNamespace(text=original_text)], SimpleNamespace(language="zh"))

    result = engine.transcribe_audio(model, b"wav", "zh")

    options = model.transcribe.call_args.kwargs
    assert options["language"] == "zh"
    assert options["beam_size"] == 5
    assert options["temperature"] == 0.0
    assert options["vad_filter"] is True
    assert options["vad_parameters"] == {"min_silence_duration_ms": 500, "speech_pad_ms": 250}
    assert options["condition_on_previous_text"] is False
    assert options["max_new_tokens"] == 320
    assert "\u7b80\u4f53\u4e2d\u6587" in options["initial_prompt"]
    assert "\u56fe\u5c42" in options["initial_prompt"]
    assert "\u822a\u73ed" in options["initial_prompt"]
    assert "\u536b\u661f" in options["initial_prompt"]
    assert len(options["initial_prompt"]) <= 120
    assert result == {"text": original_text, "language": "zh", "duration": 1.0}


def test_automatic_language_does_not_force_chinese_prompt(monkeypatch):
    monkeypatch.setattr(engine, "decode_audio_bounded", lambda _: np.zeros(16000, dtype=np.float32))
    model = Mock()
    model.transcribe.return_value = ([SimpleNamespace(text="hello")], SimpleNamespace(language="en"))
    engine.transcribe_audio(model, b"wav", None)
    assert model.transcribe.call_args.kwargs["language"] is None
    assert model.transcribe.call_args.kwargs["beam_size"] == 1
    assert "initial_prompt" not in model.transcribe.call_args.kwargs


@pytest.mark.parametrize("language", ["zh", "en"])
def test_transcription_prompt_fits_actual_whisper_token_budget(monkeypatch, language):
    from faster_whisper import WhisperModel
    from faster_whisper.tokenizer import Tokenizer
    from tokenizers import Tokenizer as RawTokenizer

    tokenizer = Tokenizer(RawTokenizer.from_file(str(engine.MODEL_PATH / "tokenizer.json")),
                          multilingual=True, task="transcribe", language=language)
    monkeypatch.setattr(engine, "decode_audio_bounded", lambda _: np.zeros(16000, dtype=np.float32))

    class BudgetCheckedModel:
        max_length = 448

        def transcribe(self, audio, **options):
            initial_prompt = options.get("initial_prompt")
            previous = tokenizer.encode(" " + initial_prompt.strip()) if initial_prompt else []
            prompt = WhisperModel.get_prompt(self, tokenizer, previous)
            total_tokens = len(prompt) + options["max_new_tokens"]
            if total_tokens > self.max_length:
                raise ValueError(f"Prompt {len(prompt)} + output {options['max_new_tokens']} = {total_tokens} exceeds {self.max_length}")
            return [SimpleNamespace(text="test")], SimpleNamespace(language=language)

    result = engine.transcribe_audio(BudgetCheckedModel(), b"wav", language)
    assert result["text"] == "test"


def test_transcribe_rejects_oversized_result(monkeypatch):
    monkeypatch.setattr(engine, "decode_audio_bounded", lambda _: np.zeros(16000))
    model = Mock()
    model.transcribe.return_value = ([SimpleNamespace(text="x" * 8001)], SimpleNamespace(language="en"))
    with pytest.raises(SpeechError):
        engine.transcribe_audio(model, b"wav", "en")


def test_worker_uses_only_local_model_and_safe_messages(monkeypatch):
    import faster_whisper

    model_factory = Mock(return_value=Mock())
    monkeypatch.setattr(faster_whisper, "WhisperModel", model_factory)
    monkeypatch.setattr(engine, "transcribe_audio", lambda *_: {"text": "hello"})
    connection = FakeConnection([{"audio": b"wav", "language": "en"}, None])
    engine.worker_main(connection)
    assert connection.sent == [{"ready": True}, {"result": {"text": "hello"}}]
    assert model_factory.call_args.kwargs["local_files_only"] is True
    assert model_factory.call_args.kwargs["compute_type"] == "int8"
    assert model_factory.call_args.args[0] == str(engine.MODEL_PATH)
    assert engine.MODEL_PATH.name == "faster-whisper-small"
    assert engine.MODEL_ID == "local-whisper-small"
    assert connection.closed


@pytest.mark.parametrize("cpu_count, expected_threads", [(None, 1), (1, 1), (4, 4), (8, 8), (32, 8)])
def test_worker_uses_bounded_cpu_threads(monkeypatch, cpu_count, expected_threads):
    import faster_whisper

    model_factory = Mock(return_value=Mock())
    monkeypatch.setattr(faster_whisper, "WhisperModel", model_factory)
    monkeypatch.setattr(engine.os, "cpu_count", lambda: cpu_count)
    connection = FakeConnection([None])
    engine.worker_main(connection)
    assert model_factory.call_args.kwargs["cpu_threads"] == expected_threads
    assert model_factory.call_args.kwargs["num_workers"] == 1
    assert model_factory.call_args.kwargs["device"] == "cpu"


@pytest.mark.parametrize("failure, code", [
    (SpeechError(400, "INVALID_AUDIO", "Bad audio"), "INVALID_AUDIO"),
    (RuntimeError("secret"), "INFERENCE_FAILED"),
])
def test_worker_sanitizes_inference_failure(monkeypatch, failure, code):
    import faster_whisper

    monkeypatch.setattr(faster_whisper, "WhisperModel", Mock())
    monkeypatch.setattr(engine, "transcribe_audio", Mock(side_effect=failure))
    connection = FakeConnection([{"audio": b"wav", "language": "en"}, None])
    engine.worker_main(connection)
    assert connection.sent[1]["error"][1] == code
    assert "secret" not in str(connection.sent)


def test_worker_handles_disconnected_parent(monkeypatch):
    import faster_whisper

    monkeypatch.setattr(faster_whisper, "WhisperModel", Mock())
    connection = FakeConnection([EOFError()])
    engine.worker_main(connection)
    assert connection.closed


def test_worker_reports_model_failure_without_paths(monkeypatch):
    import faster_whisper

    monkeypatch.setattr(faster_whisper, "WhisperModel", Mock(side_effect=RuntimeError("secret path")))
    connection = FakeConnection()
    engine.worker_main(connection)
    assert connection.sent[0]["error"][1] == "MODEL_UNAVAILABLE"
    assert "secret" not in str(connection.sent)


def test_worker_handles_startup_broken_pipe(monkeypatch):
    import faster_whisper

    monkeypatch.setattr(faster_whisper, "WhisperModel", Mock(side_effect=RuntimeError("model missing")))
    connection = FakeConnection()
    connection.send = Mock(side_effect=OSError())
    engine.worker_main(connection)
    assert connection.closed


def test_blocked_ipc_send_does_not_block_health_or_escape_deadline(monkeypatch):
    context, connection, _, process = fake_context([{"ready": True}, {"result": {"text": "late"}}])
    service = SpeechEngine(context)
    service._recover = AsyncMock()
    monkeypatch.setattr(engine, "TRANSCRIPTION_TIMEOUT", 0.03)
    connection.send = lambda _: time.sleep(0.15)

    async def scenario():
        await service.start()
        start = time.monotonic()
        responsiveness = []

        async def health_tick():
            await asyncio.sleep(0.005)
            responsiveness.append(time.monotonic() - start)

        tick = asyncio.create_task(health_tick())
        with pytest.raises(SpeechError) as error:
            await service.transcribe(b"wav", "en")
        assert error.value.status == 504
        await tick
        await service.recovery
        assert responsiveness[0] < 0.1
        assert not process.alive

    asyncio.run(scenario())


def test_audio_decoder_disables_file_and_network_protocols(monkeypatch):
    import av

    fake_open = Mock(side_effect=ValueError("invalid audio"))
    monkeypatch.setattr(av, "open", fake_open)
    with pytest.raises(SpeechError):
        engine.decode_audio_bounded(b"untrusted audio")
    options = fake_open.call_args.kwargs["options"]
    assert options["protocol_whitelist"] == "pipe"
    assert "hls" not in options["format_whitelist"]
    assert "concat" not in options["format_whitelist"]
    assert "wav" in options["format_whitelist"]
