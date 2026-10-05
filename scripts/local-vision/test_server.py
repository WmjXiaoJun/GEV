"""Local vision request-boundary and threaded-runtime regression tests."""

import asyncio
import base64
import io
import json
import threading
import time
import sys
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import server


def test_health_never_loads_inference(monkeypatch):
    def forbidden():
        raise RuntimeError("health must not load a model")
    monkeypatch.setattr(server, "_load_model", forbidden, raising=False)
    with TestClient(server.create_app(), base_url="http://127.0.0.1:8766", client=("127.0.0.1", 5000)) as instance:
        assert instance.get("/health").status_code == 200


def image_url(size=(64, 48), kind="PNG"):
    buffer = io.BytesIO()
    Image.new("RGB", size, "white").save(buffer, format=kind)
    return f"data:image/{kind.lower()};base64," + base64.b64encode(buffer.getvalue()).decode()


class FakeRuntime:
    def __init__(self):
        self.calls = []
        self.failure = None

    def health(self):
        return {"service": "gev-local-vision", "status": "ok", "models": {}, "version": "test"}

    async def detect(self, payload):
        from vision_input import decode_image
        decode_image(payload.image).close()
        self.calls = [*self.calls, payload]
        if self.failure:
            raise self.failure
        return {"model": "fake.pt", "task": payload.task, "image": {"width": 64, "height": 48},
                "detections": [], "supportedClasses": ["plane"]}

    def close(self):
        pass


@pytest.fixture
def runtime():
    return FakeRuntime()


@pytest.fixture
def client(runtime):
    with TestClient(server.create_app(runtime), base_url="http://127.0.0.1:8766", client=("127.0.0.1", 5000)) as instance:
        yield instance


def test_health_does_not_load_model(client, runtime):
    assert client.get("/health").json()["service"] == "gev-local-vision"
    assert runtime.calls == []


def test_node_fetch_mode_only_is_allowed(client):
    assert client.get("/health", headers={"Sec-Fetch-Mode": "cors"}).status_code == 200
    assert client.post("/v1/detect", json={"image": image_url()}, headers={"Sec-Fetch-Mode": "cors"}).status_code == 200


@pytest.mark.parametrize("headers", [
    {"Host": "evil.example"}, {"Host": "127.0.0.1.evil.example"},
    {"Host": "localhost@evil.example"}, {"Origin": "http://localhost:4175"},
    {"Origin": "null"}, {"Sec-Fetch-Site": "same-origin"},
])
def test_refuses_browser_and_rebinding_requests(client, headers):
    assert client.get("/health", headers=headers).status_code == 403


def test_refuses_nonloopback_clients(runtime):
    with TestClient(server.create_app(runtime), base_url="http://localhost:8766", client=("10.0.0.2", 123)) as instance:
        assert instance.get("/health").status_code == 403


@pytest.mark.parametrize("body", [[], None, "text", {}, {"image": 123},
    {"image": "invalid"}, {"image": "data:image/svg+xml;base64,AAAA"},
    {"image": "data:image/png;base64,%%"},
    {"image": image_url(), "confidence": True},
    {"image": image_url(), "confidence": "0.25"},
    {"image": image_url(), "confidence": 0.99},
    {"image": image_url(), "confidence": 0.01},
    {"image": image_url(), "task": "semantic"},
    {"image": image_url(), "model": "https://evil/model.pt"},
])
def test_invalid_body_never_invokes_model(client, runtime, body):
    response = client.post("/v1/detect", content=json.dumps(body), headers={"Content-Type": "application/json"})
    assert response.status_code == 400
    assert runtime.calls == []
    assert "input" not in response.text


def test_request_size_and_content_type(client, runtime):
    assert client.post("/v1/detect", content="{}", headers={"Content-Type": "text/plain"}).status_code == 415
    assert client.post("/v1/detect", content="{}", headers={"Content-Type": "application/json", "Content-Length": str(9 * 1024 * 1024)}).status_code == 413
    assert client.post("/v1/detect", content="{", headers={"Content-Type": "application/json"}).status_code == 400
    assert runtime.calls == []


def test_defaults_and_explicit_task(client, runtime):
    response = client.post("/v1/detect", json={"image": image_url()})
    assert response.status_code == 200
    assert response.json()["task"] == "obb"
    assert runtime.calls[-1].confidence == 0.25
    assert client.post("/v1/detect", json={"image": image_url(), "task": "detect"}).json()["task"] == "detect"


@pytest.mark.parametrize("task", ["segment", "buildings-seg"])
def test_segmentation_tasks_are_accepted(client, runtime, task):
    response = client.post("/v1/detect", json={"image": image_url(), "task": task})
    assert response.status_code == 200
    assert response.json()["task"] == task
    assert runtime.calls[-1].task == task


def test_unexpected_errors_are_redacted(client, runtime):
    runtime.failure = RuntimeError("secret private file and API key")
    response = client.post("/v1/detect", json={"image": image_url()})
    assert response.status_code == 503
    assert "secret" not in response.text


def test_rate_limit_expensive_requests(client):
    responses = [client.post("/v1/detect", json={"image": image_url()}) for _ in range(14)]
    assert responses[-1].status_code == 429


def test_rejects_dimensions_before_pixel_decode(monkeypatch):
    from vision_input import decode_image, VisionError
    encoded = image_url((4097, 1))
    def forbidden_load(*args, **kwargs):
        raise AssertionError("pixels must not be decoded")
    monkeypatch.setattr(Image.Image, "load", forbidden_load)
    with pytest.raises(VisionError):
        decode_image(encoded)


@pytest.mark.parametrize("kind", ["PNG", "JPEG", "WEBP"])
def test_valid_in_memory_decode(kind):
    from vision_input import decode_image
    image = decode_image(image_url(kind=kind))
    assert image.size == (64, 48)
    assert image.mode == "RGB"
    image.close()


def test_rejects_format_mismatch_and_oversize():
    from vision_input import decode_image, VisionError, MAX_IMAGE_BYTES
    with pytest.raises(VisionError):
        decode_image(image_url().replace("image/png", "image/jpeg"))
    with pytest.raises(VisionError):
        decode_image("data:image/png;base64," + "A" * ((MAX_IMAGE_BYTES + 5) * 4 // 3))


class Values:
    def __init__(self, values):
        self.values = values

    def tolist(self):
        return self.values


class FakeModel:
    def __init__(self, task, wait=None):
        self.task = task
        self.names = {0: "building", 1: "ship"}
        self.wait = wait
        self.options = None

    def predict(self, **options):
        self.options = options
        if self.wait:
            self.wait()
        boxes = SimpleNamespace(xyxy=Values([[1, 2, 30, 40]]), conf=Values([0.9]), cls=Values([0]))
        obb = SimpleNamespace(xyxy=boxes.xyxy, conf=boxes.conf, cls=boxes.cls,
                              xyxyxyxy=Values([[[1, 2], [30, 2], [30, 40], [1, 40]]]))
        masks = SimpleNamespace(xy=Values([[[1, 2], [30, 2], [30, 40], [1, 40]]]))
        return [SimpleNamespace(names=self.names, boxes=boxes, obb=obb if self.task == "obb" else None,
                                masks=masks if self.task == "segment" else None)]


@pytest.mark.parametrize("task", ["detect", "obb", "segment", "buildings-seg"])
def test_real_runtime_contract_and_no_disk_output(tmp_path, task):
    from vision_runtime import VisionRuntime
    from vision_input import DetectionRequest
    (tmp_path / "yolo26n.pt").touch()
    (tmp_path / "yolo26n-obb.pt").touch()
    (tmp_path / "yolo26n-seg.pt").touch()
    model = FakeModel("segment" if task == "buildings-seg" else task)
    runtime = VisionRuntime(model_dir=tmp_path, loader=lambda path, task: model)
    try:
        assert runtime.health()["models"][task]["loaded"] is False
        result = asyncio.run(runtime.detect(DetectionRequest(image=image_url(), task=task)))
        assert result["task"] == task
        assert result["supportedClasses"] == ["building", "ship"]
        assert result["detections"][0]["box"] == {"x": 1, "y": 2, "width": 29, "height": 38}
        assert ("polygon" in result["detections"][0]) == (task in {"obb", "segment", "buildings-seg"})
        if task == "obb":
            assert result["detections"][0]["polygon"] == [[1, 2], [30, 2], [30, 40], [1, 40]]
        if task in {"segment", "buildings-seg"}:
            assert result["detections"][0]["polygon"] == [[1, 2], [30, 2], [30, 40], [1, 40]]
        assert runtime.health()["models"][task]["loaded"] is True
        assert model.options["save"] is False and model.options["save_txt"] is False
        assert len(list(tmp_path.iterdir())) == 3
    finally:
        runtime.close()


def test_missing_models_do_not_trigger_loader(tmp_path):
    from vision_runtime import VisionRuntime
    from vision_input import DetectionRequest, VisionError
    def forbidden(*args):
        raise AssertionError("no runtime downloads")
    runtime = VisionRuntime(model_dir=tmp_path, loader=forbidden)
    try:
        assert runtime.health()["status"] == "degraded"
        with pytest.raises(VisionError, match="VISION_UNAVAILABLE"):
            asyncio.run(runtime.detect(DetectionRequest(image=image_url())))
    finally:
        runtime.close()


def test_timeout_retains_slot_until_worker_finishes_and_health_responds(tmp_path):
    from vision_runtime import VisionRuntime
    from vision_input import DetectionRequest, VisionError
    (tmp_path / "yolo26n-obb.pt").touch()
    finished = threading.Event()
    entered = threading.Event()
    def block():
        entered.set()
        finished.wait(3)
    runtime = VisionRuntime(model_dir=tmp_path, loader=lambda path, task: FakeModel(task, block), timeout=0.02)
    async def run():
        try:
            with pytest.raises(VisionError, match="VISION_TIMEOUT"):
                await runtime.detect(DetectionRequest(image=image_url()))
            assert entered.is_set()
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.create_app(runtime), client=("127.0.0.1", 123)), base_url="http://127.0.0.1") as client:
                assert (await client.get("/health")).status_code == 200
            with pytest.raises(VisionError, match="VISION_BUSY"):
                await runtime.detect(DetectionRequest(image=image_url()))
        finally:
            finished.set()
    try:
        asyncio.run(run())
    finally:
        runtime.close()


def test_loader_disables_network_without_removed_hub_setting(monkeypatch, tmp_path):
    from vision_runtime import load_yolo
    class Settings:
        def update(self, values):
            assert values == {"sync": False}
    fake = SimpleNamespace(settings=Settings(), YOLO=lambda path, task: (path, task))
    monkeypatch.setitem(sys.modules, "ultralytics", fake)
    monkeypatch.setenv("YOLO_CONFIG_DIR", str(tmp_path / "config"))
    assert load_yolo(tmp_path / "yolo26n.pt", "detect")[1] == "detect"


def test_loader_maps_building_profile_to_ultralytics_segment(monkeypatch, tmp_path):
    from vision_runtime import load_yolo
    class Settings:
        def update(self, values):
            assert values == {"sync": False}
    seen = {}
    def fake_yolo(path, task):
        seen["task"] = task
        return (path, task)
    fake = SimpleNamespace(settings=Settings(), YOLO=fake_yolo)
    monkeypatch.setitem(sys.modules, "ultralytics", fake)
    monkeypatch.setenv("YOLO_CONFIG_DIR", str(tmp_path / "config"))
    assert load_yolo(tmp_path / "yolov8n-building-seg.pt", "buildings-seg")[1] == "segment"
    assert seen["task"] == "segment"


def test_serializer_rejects_invalid_boxes_and_caps_results():
    from vision_runtime import serialize_result
    boxes = SimpleNamespace(xyxy=Values([[1, 2, 3, 4]] * 300), conf=Values([0.9] * 300), cls=Values([0] * 300))
    result = SimpleNamespace(boxes=boxes, names={0: "plane"})
    detected, classes, truncated = serialize_result(result, "detect", 64, 48, 0.25)
    assert len(detected) == 300 and truncated
    boxes.xyxy = Values([[0, 0, 0, 0], [0, 0, float("nan"), 0], [1, 2, 3, 4]])
    boxes.conf = Values([0.9, 0.9, 0.1])
    assert serialize_result(result, "detect", 64, 48, 0.25)[0] == []
    result.boxes = None
    assert serialize_result(result, "detect", 64, 48, 0.25) == ([], ["plane"], False)


def test_segmentation_serializer_drops_missing_or_degenerate_masks():
    from vision_runtime import serialize_result
    boxes = SimpleNamespace(xyxy=Values([[1, 2, 30, 40], [1, 2, 30, 40]]), conf=Values([0.9, 0.9]), cls=Values([0, 0]))
    result = SimpleNamespace(boxes=boxes, names={0: "building"}, masks=SimpleNamespace(
        xy=Values([[[1, 2], [30, 2], [30, 40]], [[1, 1], [1, 1], [1, 1]]])))
    detections, _, _ = serialize_result(result, "buildings-seg", 64, 48, 0.25)
    assert len(detections) == 1
    assert detections[0]["polygon"] == [[1, 2], [30, 2], [30, 40]]


def test_rounded_boxes_stay_inside_image_and_keep_positive_size():
    from vision_runtime import _coordinates
    box = _coordinates([1.235, 2.235, 64, 48], 64, 48)
    assert box["x"] + box["width"] <= 64
    assert box["y"] + box["height"] <= 48
    assert _coordinates([1, 1, 1.0001, 1.0001], 64, 48) is None


def test_health_normalizes_cuda_device(monkeypatch, tmp_path):
    from vision_runtime import VisionRuntime
    monkeypatch.setenv("GEV_YOLO_DEVICE", "0")
    runtime = VisionRuntime(model_dir=tmp_path)
    try:
        assert runtime.health()["device"] == "cuda:0"
    finally:
        runtime.close()


def test_health_prefers_project_building_segmentation_weight(tmp_path):
    from vision_runtime import VisionRuntime
    (tmp_path / "yolo26n.pt").touch()
    (tmp_path / "yolo26n-obb.pt").touch()
    (tmp_path / "yolo26n-seg.pt").touch()
    (tmp_path / "yolov8n-building-seg.pt").touch()
    runtime = VisionRuntime(model_dir=tmp_path)
    try:
        assert runtime.health()["models"]["buildings-seg"] == {
            "model": "yolov8n-building-seg.pt", "installed": True, "loaded": False,
        }
    finally:
        runtime.close()


def test_health_is_ok_when_required_building_segmentation_is_installed(tmp_path):
    from vision_runtime import VisionRuntime
    (tmp_path / "yolo26n.pt").touch()
    (tmp_path / "yolo26n-obb.pt").touch()
    (tmp_path / "yolov8n-building-seg.pt").touch()
    runtime = VisionRuntime(model_dir=tmp_path)
    try:
        assert runtime.health()["status"] == "ok"
    finally:
        runtime.close()
