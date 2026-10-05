import hashlib
import io

import pytest

import setup_models


@pytest.fixture
def assets(monkeypatch):
    data = b"official-model-test"
    monkeypatch.setattr(setup_models, "ASSETS", {"fake.pt": (len(data), hashlib.sha256(data).hexdigest())})
    return data


def test_download_verified_and_idempotent(tmp_path, assets):
    setup_models.install_models(tmp_path, opener=lambda url, timeout: io.BytesIO(assets))
    assert (tmp_path / "fake.pt").read_bytes() == assets
    setup_models.install_models(tmp_path, opener=lambda *args, **kwargs: pytest.fail("must not redownload"))
    assert len(list(tmp_path.iterdir())) == 1


@pytest.mark.parametrize("data", [b"bad", b"x" * 100])
def test_corrupt_download_removes_only_temporary_file(tmp_path, assets, data):
    with pytest.raises(RuntimeError):
        setup_models.install_models(tmp_path, opener=lambda url, timeout: io.BytesIO(data))
    assert list(tmp_path.iterdir()) == []


def test_different_existing_model_is_not_overwritten(tmp_path, assets):
    target = tmp_path / "fake.pt"
    target.write_bytes(b"custom-model")
    with pytest.raises(RuntimeError, match="move it aside"):
        setup_models.install_models(tmp_path)
    assert target.read_bytes() == b"custom-model"
