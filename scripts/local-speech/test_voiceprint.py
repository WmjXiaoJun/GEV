import json

import numpy as np
import pytest

from voiceprint import VoiceprintError, VoiceprintStore, cosine_distance


def test_cosine_distance_handles_normalized_vectors():
    assert cosine_distance([1, 0], [1, 0]) == pytest.approx(0.0)
    assert cosine_distance([1, 0], [0, 1]) == pytest.approx(1.0)


def test_store_enroll_verify_and_delete(tmp_path):
    store = VoiceprintStore(tmp_path / "voiceprints.json", engine=FakeEngine())
    embedding = store.enroll("owner", np.array([1.0, 0.0], dtype=np.float32))
    assert embedding["id"] == "owner"
    assert store.verify(np.array([0.99, 0.01], dtype=np.float32), "owner", 0.2)["verified"] is True
    assert store.delete("owner") is True
    assert store.verify(np.array([1.0, 0.0], dtype=np.float32), "owner", 0.2)["verified"] is False


def test_store_persists_only_embeddings(tmp_path):
    path = tmp_path / "voiceprints.json"
    store = VoiceprintStore(path, engine=FakeEngine())
    store.enroll("owner", np.array([3.0, 4.0], dtype=np.float32))
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["version"] == 1
    assert payload["profiles"]["owner"]["embedding"] == [0.6, 0.8]
    assert "audio" not in path.read_text(encoding="utf-8")


def test_store_rejects_bad_ids_and_dimensions(tmp_path):
    store = VoiceprintStore(tmp_path / "voiceprints.json", engine=FakeEngine())
    with pytest.raises(VoiceprintError):
        store.enroll("../owner", np.array([1.0], dtype=np.float32))
    with pytest.raises(VoiceprintError):
        store.enroll("owner", np.zeros(2, dtype=np.float32))


def test_store_ignores_corrupt_profiles_and_non_finite_embeddings(tmp_path):
    path = tmp_path / "voiceprints.json"
    path.write_text(json.dumps({"version": 1, "profiles": {
        "owner": {"embedding": [1.0, 0.0]},
        "empty": {"embedding": []},
        "zero": {"embedding": [0.0, 0.0]},
        "nan": {"embedding": [float("nan"), 1.0]},
        "nested": {"embedding": "not-a-vector"},
        "../escape": {"embedding": [1.0, 0.0]},
        "not-a-profile": "invalid",
    }}), encoding="utf-8")
    store = VoiceprintStore(path, engine=FakeEngine())
    assert store.profiles() == [{"id": "owner", "dimension": 2}]
    assert store.verify(np.array([1.0, 0.0], dtype=np.float32))["profileId"] == "owner"


def test_store_rejects_non_finite_enrollment(tmp_path):
    store = VoiceprintStore(tmp_path / "voiceprints.json", engine=FakeEngine())
    for embedding in (np.array([np.nan, 1.0]), np.array([np.inf, 1.0]), ["bad"]):
        with pytest.raises(VoiceprintError):
            store.enroll("owner", embedding)


def test_store_write_uses_atomic_random_temp_file(tmp_path):
    path = tmp_path / "voiceprints.json"
    store = VoiceprintStore(path, engine=FakeEngine())
    store.enroll("owner", np.array([1.0, 0.0], dtype=np.float32))
    assert path.exists()
    assert not list(tmp_path.glob("*.tmp"))


def test_store_write_failure_rolls_back_profiles(tmp_path, monkeypatch):
    path = tmp_path / "voiceprints.json"
    store = VoiceprintStore(path, engine=FakeEngine())
    monkeypatch.setattr(store, "_write", lambda: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        store.enroll("owner", np.array([1.0, 0.0], dtype=np.float32))
    assert store.profiles() == []


@pytest.mark.parametrize("payload", [[], None, "broken", 42, True])
def test_store_ignores_invalid_top_level_json_without_disabling_speech(tmp_path, payload):
    path = tmp_path / "voiceprints.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    assert VoiceprintStore(path, engine=FakeEngine()).profiles() == []


def test_cosine_distance_clamps_float_rounding_to_valid_range(monkeypatch):
    monkeypatch.setattr(np, "dot", lambda *_: np.float32(1.0000001))
    assert cosine_distance([1.0, 0.0], [1.0, 0.0]) == 0.0


class FakeEngine:
    def embed_pcm(self, audio):
        return np.asarray(audio, dtype=np.float32)
