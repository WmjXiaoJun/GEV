import asyncio
import time
import multiprocessing
from collections import deque
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import numpy as np
import pytest

from voiceprint import VoiceprintError


def worker_type():
    from voiceprint_worker import VoiceprintWorker
    return VoiceprintWorker


class FakeConnection:
    def __init__(self, messages=()):
        self.messages = deque(messages)
        self.sent = []
        self.closed = False

    def poll(self):
        return bool(self.messages)

    def recv(self):
        value = self.messages.popleft()
        if isinstance(value, BaseException):
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
        self.pid = None

    def start(self):
        self.alive = True
        self.pid = 1234

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


def test_worker_sends_audio_only_and_returns_embedding():
    context, connection, child, process = fake_context([{"ready": True}, {"embedding": [0.6, 0.8]}])
    worker = worker_type()(context=context)

    async def scenario():
        await worker.start()
        assert worker.available and child.closed
        assert await worker.embed_audio(b"audio") == [0.6, 0.8]
        await worker.close()

    asyncio.run(scenario())
    assert connection.sent == [b"audio"]
    assert connection.closed and not process.alive


def test_worker_timeout_terminates_native_work_and_recovers_without_blocking_loop():
    context, connection, _, process = fake_context()
    worker = worker_type()(context=context, timeout=0.03)
    worker._recover = AsyncMock()

    async def scenario():
        await worker.start()
        ticks = []
        started = time.monotonic()

        async def health():
            await asyncio.sleep(0.005)
            ticks.append(time.monotonic() - started)

        task = asyncio.create_task(health())
        with pytest.raises(VoiceprintError) as error:
            await worker.embed_audio(b"audio")
        assert error.value.code == "VOICEPRINT_TIMEOUT"
        await task
        await worker.recovery
        assert ticks[0] < 0.1
        assert not process.alive and connection.closed
        await worker.close()

    asyncio.run(scenario())
    worker._recover.assert_awaited_once()


def test_worker_cancel_terminates_inflight_native_work():
    context, _, _, process = fake_context()
    worker = worker_type()(context=context)
    worker._recover = AsyncMock()

    async def scenario():
        await worker.start()
        worker._receive = AsyncMock(side_effect=asyncio.CancelledError())
        with pytest.raises(asyncio.CancelledError):
            await worker.embed_audio(b"audio")
        await worker.recovery
        assert not process.alive
        await worker.close()

    asyncio.run(scenario())


def test_worker_rejects_concurrent_jobs_instead_of_queueing_audio():
    worker = worker_type()()
    worker.busy = True
    with pytest.raises(VoiceprintError) as error:
        asyncio.run(worker.embed_audio(b"audio"))
    assert error.value.code == "VOICEPRINT_RATE_LIMITED"


def simulated_native_worker(connection, _library, _model):
    try:
        connection.send({"ready": True})
        while True:
            audio = connection.recv()
            if audio == b"stall":
                time.sleep(30)
            connection.send({"embedding": [0.6, 0.8]})
    except (EOFError, BrokenPipeError):
        pass
    finally:
        connection.close()


def test_real_spawn_process_is_killed_on_timeout_and_replaced():
    worker = worker_type()(context=multiprocessing.get_context("spawn"), timeout=0.1,
                           worker_target=simulated_native_worker)

    async def scenario():
        try:
            await worker.start()
            original = worker.process
            with pytest.raises(VoiceprintError) as error:
                await worker.embed_audio(b"stall")
            assert error.value.code == "VOICEPRINT_TIMEOUT"
            assert not original.is_alive()
            await asyncio.wait_for(worker.recovery, 10)
            assert worker.available and worker.process.pid != original.pid
            assert await worker.embed_audio(b"next") == [0.6, 0.8]
        finally:
            await worker.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("error, expected", [
    (VoiceprintError("VOICEPRINT_AUDIO", "Bad sample"), "VOICEPRINT_AUDIO"),
    (RuntimeError("private path"), "VOICEPRINT_FAILED"),
])
def test_worker_main_sanitizes_errors_and_continues(monkeypatch, error, expected):
    import voiceprint_worker as module
    native = Mock(available=True)
    native.embed_pcm.side_effect = [error, np.array([0.6, 0.8])]
    monkeypatch.setattr(module, "VoiceDetectEngine", Mock(return_value=native))
    monkeypatch.setattr(module, "decode_audio_bounded", lambda data: data)
    connection = FakeConnection([b"bad", b"good", None])
    module.worker_main(connection, "library", "model")
    assert connection.sent[1]["error"][0] == expected
    assert connection.sent[2]["embedding"] == [0.6, 0.8]
    assert "private path" not in str(connection.sent)
    native.close.assert_called_once()
    assert connection.closed


def test_worker_main_returns_safe_decode_error(monkeypatch):
    import voiceprint_worker as module
    from engine import SpeechError
    native = Mock(available=True)
    monkeypatch.setattr(module, "VoiceDetectEngine", Mock(return_value=native))
    monkeypatch.setattr(module, "decode_audio_bounded", Mock(side_effect=SpeechError(400, "INVALID_AUDIO", "private")))
    connection = FakeConnection([b"bad", None])
    module.worker_main(connection, "library", "model")
    assert connection.sent[1]["error"][0] == "VOICEPRINT_AUDIO"
    native.embed_pcm.assert_not_called()


@pytest.mark.parametrize("available", [True, False])
def test_worker_main_stops_on_parent_disconnect_or_unavailable_native(monkeypatch, available):
    import voiceprint_worker as module
    native = Mock(available=available)
    monkeypatch.setattr(module, "VoiceDetectEngine", Mock(return_value=native))
    connection = FakeConnection([EOFError()])
    module.worker_main(connection, "library", "model")
    assert connection.sent == [{"ready": available}]
    native.close.assert_called_once()
    assert connection.closed


def test_worker_main_sanitizes_native_startup_exception(monkeypatch, caplog):
    import voiceprint_worker as module
    monkeypatch.setattr(module, "VoiceDetectEngine", Mock(side_effect=RuntimeError("private path")))
    connection = FakeConnection()
    module.worker_main(connection, "library", "model")
    assert connection.closed and "private path" not in caplog.text


def test_failed_native_startup_is_closed_and_reports_unavailable():
    context, connection, _, process = fake_context([{"ready": False}])
    worker = worker_type()(context=context)
    with pytest.raises(VoiceprintError) as error:
        asyncio.run(worker.start())
    assert error.value.code == "VOICEPRINT_UNAVAILABLE"
    assert not process.alive and connection.closed


def test_worker_validation_failure_does_not_kill_healthy_process():
    context, _, _, process = fake_context([{"ready": True}, {"error": ("VOICEPRINT_AUDIO", "Bad audio")}])
    worker = worker_type()(context=context)

    async def scenario():
        await worker.start()
        with pytest.raises(VoiceprintError) as error:
            await worker.embed_audio(b"bad")
        assert error.value.code == "VOICEPRINT_AUDIO" and process.alive
        await worker.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("messages", [[EOFError()], []])
def test_worker_receive_handles_closed_connection(messages):
    worker = worker_type()()
    worker.connection = FakeConnection(messages)
    with pytest.raises(VoiceprintError):
        asyncio.run(worker._receive(0.01))


def test_worker_without_configuration_leaves_transcription_available(monkeypatch):
    monkeypatch.delenv("VOICEDETECT_LIBRARY", raising=False)
    monkeypatch.delenv("VOICEDETECT_MODEL", raising=False)
    worker = worker_type()()
    asyncio.run(worker.start())
    assert not worker.available and worker.process is None
    with pytest.raises(VoiceprintError) as error:
        asyncio.run(worker.embed_audio(b"audio"))
    assert error.value.code == "VOICEPRINT_UNAVAILABLE"


def test_close_cancels_recovery_and_prevents_restarting():
    worker = worker_type()()

    async def scenario():
        worker.recovery = asyncio.create_task(asyncio.sleep(30))
        await worker.close()
        assert worker.recovery.cancelled()
        await worker.start()
        assert worker.process is None

    asyncio.run(scenario())


def test_worker_failed_recovery_is_logged_without_private_details(caplog):
    worker = worker_type()()
    worker.start = AsyncMock(side_effect=OSError("private path"))
    asyncio.run(worker._recover())
    assert "restart the speech service" in caplog.text and "private path" not in caplog.text


def test_worker_kills_process_that_ignores_termination():
    context, _, _, process = fake_context()
    worker = worker_type()(context=context)

    async def scenario():
        await worker.start()
        process.terminate = lambda: None
        await worker.close()
        assert process.killed

    asyncio.run(scenario())
