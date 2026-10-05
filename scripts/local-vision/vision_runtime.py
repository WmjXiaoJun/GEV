"""One bounded inference worker; health never waits for imports or inference."""

import asyncio
import importlib.metadata
import math
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from vision_input import VisionError, decode_image
from building_recall import building_tiles, merge_building_detections, simplify_mask, translate_tile_detections

MODEL_FILES = {
    "detect": ("yolo26n.pt",),
    "obb": ("yolo26n-obb.pt",),
    "segment": ("yolo26n-seg.pt",),
    # A project supplied building model wins when present.  The official
    # nano segmentation weight remains a safe, offline fallback for setup and
    # development environments; callers must still inspect supportedClasses.
    "buildings-seg": ("yolov8n-building-seg.pt", "yolo26n-seg.pt"),
}
PROJECT_DIRECTORY = Path(__file__).resolve().parents[2]
MAX_DETECTIONS = 300
MAX_BUILDING_DETECTIONS = 500
MAX_MASK_VERTICES = 256


def load_yolo(path, task):
    os.environ.setdefault("YOLO_CONFIG_DIR", str(PROJECT_DIRECTORY / ".gev-cache" / "ultralytics"))
    Path(os.environ["YOLO_CONFIG_DIR"]).mkdir(parents=True, exist_ok=True)
    os.environ["YOLO_OFFLINE"] = "true"
    os.environ["YOLO_AUTOINSTALL"] = "false"
    os.environ["YOLO_VERBOSE"] = "false"
    from ultralytics import YOLO, settings
    settings.update({"sync": False})
    # ``buildings-seg`` is an application-level profile; Ultralytics accepts
    # the underlying instance-segmentation task name only.
    return YOLO(str(path), task="segment" if task == "buildings-seg" else task)


def _coordinates(values, width, height):
    if len(values) != 4 or not all(math.isfinite(float(value)) for value in values):
        return None
    x1, y1, x2, y2 = values
    x1, x2 = sorted((max(0, min(width, x1)), max(0, min(width, x2))))
    y1, y2 = sorted((max(0, min(height, y1)), max(0, min(height, y2))))
    x1, y1, x2, y2 = (round(v, 2) for v in (x1, y1, x2, y2))
    if x1 == x2 or y1 == y2:
        return None
    return {"x": round(x1, 2), "y": round(y1, 2), "width": round(x2 - x1, 2), "height": round(y2 - y1, 2)}


def _mask_polygon(values, width, height):
    if values is None:
        return None
    try:
        points = values.tolist() if hasattr(values, "tolist") else values
    except (TypeError, ValueError):
        return None
    if not isinstance(points, (list, tuple)) or len(points) < 3:
        return None
    normalized = []
    for point in points:
        # Some Ultralytics builds expose contour rows as strings (for
        # example ``"1252.0 827.0"``) after retina mask conversion.  Parse
        # that representation explicitly so the public contract always
        # contains numeric coordinate pairs.
        if isinstance(point, str):
            fields = point.replace(',', ' ').split()
            if len(fields) != 2:
                return None
            point = fields
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            return None
        try:
            x, y = (float(point[0]), float(point[1]))
        except (TypeError, ValueError):
            return None
        if not math.isfinite(x) or not math.isfinite(y):
            return None
        normalized.append([round(max(0, min(width, x)), 2), round(max(0, min(height, y)), 2)])
    # A clipped mask can collapse to a line or point.  Such a polygon cannot
    # be drawn on the map and should be omitted from the response.
    normalized = simplify_mask(normalized, MAX_MASK_VERTICES)
    if len({(point[0], point[1]) for point in normalized}) < 3:
        return None
    area_twice = sum(point[0] * normalized[(index + 1) % len(normalized)][1]
                     - normalized[(index + 1) % len(normalized)][0] * point[1]
                     for index, point in enumerate(normalized))
    if abs(area_twice) < 1:
        return None
    return normalized


def serialize_result(result, task, width, height, confidence):
    detection_limit = MAX_BUILDING_DETECTIONS if task == "buildings-seg" else MAX_DETECTIONS
    source = result.obb if task == "obb" else result.boxes
    names = result.names
    supported = [str(name)[:80] for name in (names.values() if isinstance(names, dict) else names)]
    if source is None:
        return [], supported, False
    boxes, scores, classes = source.xyxy.tolist(), source.conf.tolist(), source.cls.tolist()
    if task == "obb":
        polygons = source.xyxyxyxy.tolist()
    elif task in {"segment", "buildings-seg"}:
        masks = getattr(result, "masks", None)
        polygons = getattr(masks, "xy", None) if masks is not None else None
        polygons = polygons.tolist() if hasattr(polygons, "tolist") else polygons
        polygons = polygons if isinstance(polygons, (list, tuple)) else [None] * len(boxes)
    else:
        polygons = [None] * len(boxes)
    if len(polygons) < len(boxes):
        polygons = [*polygons, *([None] * (len(boxes) - len(polygons)))]
    detections = []
    for values, score, class_id, polygon in list(zip(boxes, scores, classes, polygons))[:detection_limit]:
        box = _coordinates(values, width, height)
        if box is None or not math.isfinite(score) or not confidence <= score <= 1:
            continue
        item = {"class": str(names[int(class_id)])[:80], "confidence": round(float(score), 4), "box": box}
        if task == "obb" and polygon and len(polygon) == 4 and all(len(p) == 2 and all(math.isfinite(v) for v in p) for p in polygon):
            item = {**item, "polygon": [[round(max(0, min(width, p[0])), 2), round(max(0, min(height, p[1])), 2)] for p in polygon]}
        elif task in {"segment", "buildings-seg"}:
            mask = _mask_polygon(polygon, width, height)
            if mask is None:
                continue
            item = {**item, "polygon": mask}
        detections = [*detections, item]
    return detections, supported, len(boxes) >= detection_limit


class VisionRuntime:
    def __init__(self, model_dir=None, loader=load_yolo, timeout=60):
        self.model_dir = Path(model_dir or PROJECT_DIRECTORY / "models" / "vision")
        self.loader = loader
        self.timeout = timeout
        self.device = os.getenv("GEV_YOLO_DEVICE", "cpu").strip() or "cpu"
        if self.device.isdecimal():
            self.device = "cuda:" + self.device
        self.models = {}
        self._slot = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gev-vision")

    def health(self):
        models = {}
        for task, candidates in MODEL_FILES.items():
            selected = next((name for name in candidates if (self.model_dir / name).is_file()), candidates[-1])
            models[task] = {"model": selected, "installed": (self.model_dir / selected).is_file(), "loaded": task in self.models}
        version = importlib.metadata.version("ultralytics")
        required = ("detect", "obb", "buildings-seg")
        status = "ok" if all(models[task]["installed"] for task in required) else "degraded"
        return {"service": "gev-local-vision", "status": status,
                "version": version, "device": self.device,
                "model": models["obb"]["model"], "models": models, "busy": self._slot.locked()}

    def _model_path(self, task):
        candidates = MODEL_FILES[task]
        return next((self.model_dir / name for name in candidates if (self.model_dir / name).is_file()), self.model_dir / candidates[-1])

    def _predict(self, image, payload):
        is_building = payload.task == "buildings-seg"
        result = self.models[payload.task].predict(source=image, conf=payload.confidence, verbose=False,
                    device=self.device,
                    imgsz=2048 if is_building else (640 if payload.task == "detect" else 1024),
                    retina_masks=is_building,
                    max_det=MAX_BUILDING_DETECTIONS if is_building else MAX_DETECTIONS,
                    save=False, save_txt=False, save_crop=False, show=False)[0]
        return serialize_result(result, payload.task, image.width, image.height, payload.confidence)

    def _building_recall(self, image, payload, detections, truncated):
        for tile in building_tiles(image.width, image.height):
            with image.crop(tile) as crop:
                found, _, tile_truncated = self._predict(crop, payload)
            additions = translate_tile_detections(found, tile, image.width, image.height)
            detections, merge_truncated = merge_building_detections(detections, additions, MAX_BUILDING_DETECTIONS)
            truncated = truncated or tile_truncated or merge_truncated
        return detections, truncated

    def _infer(self, payload):
        image = decode_image(payload.image)
        try:
            path = self._model_path(payload.task)
            if not path.is_file():
                raise VisionError("VISION_UNAVAILABLE", "Local YOLO weights are not installed. Run local-vision setup.", 503)
            if payload.task not in self.models:
                loaded = self.loader(path, payload.task)
                expected_task = "segment" if payload.task == "buildings-seg" else payload.task
                if loaded.task != expected_task:
                    raise VisionError("VISION_UNAVAILABLE", "The installed model does not match the requested task.", 503)
                self.models = {**self.models, payload.task: loaded}
            # Building footprints are the precision-sensitive path.  A larger
            # inference canvas keeps narrow wings and courtyard cut-outs from
            # disappearing when a 1900px screenshot is reduced to 1024px.
            # ``retina_masks`` asks Ultralytics to project masks back at the
            # original image resolution instead of returning coarse model-grid
            # contours.  Both settings are local-only and are ignored by the
            # box/OBB profiles.
            detections, supported, truncated = self._predict(image, payload)
            if payload.task == "buildings-seg":
                detections, truncated = self._building_recall(image, payload, detections, truncated)
            return {"model": path.name, "task": payload.task, "image": {"width": image.width, "height": image.height},
                    "detections": detections, "supportedClasses": supported, "truncated": truncated,
                    "maxDetections": MAX_BUILDING_DETECTIONS if payload.task == "buildings-seg" else MAX_DETECTIONS}
        finally:
            image.close()

    async def detect(self, payload):
        if not self._slot.acquire(blocking=False):
            raise VisionError("VISION_BUSY", "Local vision is busy. Retry after the current image finishes.", 429)
        try:
            worker = self._executor.submit(self._infer, payload)
        except Exception:
            self._slot.release()
            raise
        # Cancellation/timeouts must not free the slot while native inference still runs.
        worker.add_done_callback(lambda completed: self._slot.release())
        wrapped = asyncio.wrap_future(worker)
        wrapped.add_done_callback(lambda future: None if future.cancelled() else future.exception())
        try:
            return await asyncio.wait_for(asyncio.shield(wrapped), timeout=self.timeout)
        except asyncio.TimeoutError:
            raise VisionError("VISION_TIMEOUT", "Local vision timed out. The current image is still finishing.", 504) from None

    def close(self):
        self._executor.shutdown(wait=False, cancel_futures=True)
