"""Opt-in native acceptance; uses a repository fixture, never microphone audio."""

import asyncio
import json
import os
from pathlib import Path

import pytest

from voiceprint import VoiceprintStore
from voiceprint_worker import VoiceprintWorker


@pytest.mark.skipif(os.getenv("GEV_TEST_NATIVE_VOICEPRINT") != "1", reason="Native runtime acceptance is opt-in.")
def test_native_worker_enrolls_verifies_reloads_and_deletes_without_audio_files(tmp_path, monkeypatch):
    project = Path(__file__).resolve().parents[2]
    runtime = project / "models" / "speech" / "voiceprint"
    monkeypatch.setenv("VOICEDETECT_LIBRARY", str(runtime / "voicedetect.dll"))
    monkeypatch.setenv("VOICEDETECT_MODEL", str(runtime / "campplus-zh-cn.gguf"))
    monkeypatch.setenv("PATH", str(runtime) + os.pathsep + os.environ.get("PATH", ""))
    fixture = project / "scripts" / "fixtures" / "voice" / "full-globe-turn-on-radio.wav"
    store_path = tmp_path / "profiles.json"

    async def scenario():
        worker = VoiceprintWorker()
        await worker.start()
        try:
            assert worker.available
            store = VoiceprintStore(store_path, worker)
            audio = fixture.read_bytes()
            result = await store.enroll_audio("qa_fixture", audio)
            assert result["dimension"] == 192
            verdict = await store.verify_audio(audio, "qa_fixture")
            assert verdict["verified"] is True
            assert 0 <= verdict["distance"] < 0.001
            reloaded = VoiceprintStore(store_path, worker)
            assert reloaded.profiles() == [{"id": "qa_fixture", "dimension": 192}]
            payload = json.loads(store_path.read_text(encoding="utf-8"))
            assert set(payload["profiles"]["qa_fixture"]) == {"embedding"}
            assert [path.name for path in tmp_path.iterdir()] == ["profiles.json"]
            assert reloaded.delete("qa_fixture") is True
            assert VoiceprintStore(store_path, worker).profiles() == []
        finally:
            await worker.close()

    asyncio.run(scenario())
