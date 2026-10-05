"""Regression coverage for complementary full-frame and tiled building masks."""

import asyncio
import math
from types import SimpleNamespace

from test_server import FakeModel, Values, image_url


def detection(points, score=0.8):
    xs, ys = zip(*points)
    return {"class": "building", "confidence": score, "polygon": points,
            "box": {"x": min(xs), "y": min(ys), "width": max(xs) - min(xs), "height": max(ys) - min(ys)}}


def rectangle(x, y, width, height, score=0.8):
    return detection([[x, y], [x + width, y], [x + width, y + height], [x, y + height]], score)


def test_dense_retina_contours_are_simplified_instead_of_dropped():
    from vision_runtime import _mask_polygon
    points = [[100 + 80 * math.cos(i * math.tau / 1000), 100 + 60 * math.sin(i * math.tau / 1000)] for i in range(1000)]
    simplified = _mask_polygon(points, 200, 200)
    assert simplified is not None
    assert 3 <= len(simplified) <= 256
    assert min(point[0] for point in simplified) == 20
    assert max(point[1] for point in simplified) == 160


def test_collinear_masks_are_not_building_outlines():
    from vision_runtime import _mask_polygon
    assert _mask_polygon([[0, 0], [5, 5], [10, 10]], 20, 20) is None


def test_tiles_cover_large_image_with_overlap_and_bounded_work():
    from building_recall import building_tiles
    assert building_tiles(640, 480) == []
    tiles = building_tiles(1902, 1055)
    assert len(tiles) == 2
    assert tiles[0][0] == 0 and tiles[1][2] == 1902
    assert tiles[0][2] > tiles[1][0]
    assert all(top == 0 and bottom == 1055 for _, top, _, bottom in tiles)
    assert len(building_tiles(4096, 4096)) == 4


def test_tiled_results_translate_coordinates_and_discard_only_internal_seams():
    from building_recall import translate_tile_detections
    tile = (100, 0, 1100, 800)
    translated = translate_tile_detections([
        rectangle(10, 0, 80, 50), rectangle(0, 100, 60, 90), rectangle(950, 100, 50, 90)
    ], tile, 1902, 800)
    assert len(translated) == 1
    assert translated[0]["polygon"][0] == [110, 0]
    assert translated[0]["box"] == {"x": 110, "y": 0, "width": 80, "height": 50}


def test_merge_retains_full_frame_footprints_and_adds_unique_tile_building():
    from building_recall import merge_building_detections
    original = rectangle(10, 10, 80, 100, 0.7)
    duplicate = rectangle(11, 11, 78, 98, 0.95)
    novel = rectangle(200, 100, 60, 70)
    merged, truncated = merge_building_detections([original], [duplicate, novel], 300)
    assert merged == [original, novel]
    assert truncated is False
    assert original["polygon"][0] == [10, 10]


def test_merge_does_not_suppress_distinct_concave_buildings_with_overlapping_boxes():
    from building_recall import merge_building_detections
    upper_left = detection([[0, 0], [100, 0], [100, 20], [20, 20], [20, 100], [0, 100]])
    lower_right = detection([[30, 30], [110, 30], [110, 110], [30, 110], [30, 90], [90, 90], [90, 50], [30, 50]])
    assert len(merge_building_detections([upper_left], [lower_right], 300)[0]) == 2


def test_merge_reports_cap_and_ignores_same_roof_fragments():
    from building_recall import merge_building_detections
    full = rectangle(0, 0, 100, 100)
    fragment = rectangle(20, 20, 40, 40)
    assert merge_building_detections([full], [fragment], 300) == ([full], False)
    extra = rectangle(200, 0, 100, 100)
    assert merge_building_detections([full], [extra], 1) == ([full], True)


def test_building_runtime_runs_full_frame_and_tile_recall_without_changing_contract(tmp_path):
    from vision_input import DetectionRequest
    from vision_runtime import VisionRuntime
    (tmp_path / "yolov8n-building-seg.pt").touch()

    class RecallModel(FakeModel):
        def __init__(self):
            super().__init__("segment")
            self.calls = []

        def predict(self, **options):
            self.calls = [*self.calls, options["source"].size]
            # Full frame misses the roof found at x=500 in the first crop.
            points = [[30, 30], [80, 30], [80, 80], [30, 80]] if len(self.calls) == 1 else [
                [500, 300], [580, 300], [580, 390], [500, 390]]
            box = [points[0][0], points[0][1], points[2][0], points[2][1]]
            return [SimpleNamespace(names={0: "building"}, boxes=SimpleNamespace(
                xyxy=Values([box]), conf=Values([0.8]), cls=Values([0])), masks=SimpleNamespace(xy=[points]))]

    model = RecallModel()
    runtime = VisionRuntime(model_dir=tmp_path, loader=lambda *_: model)
    try:
        result = asyncio.run(runtime.detect(DetectionRequest(image=image_url((1902, 1055)), task="buildings-seg")))
        assert model.calls[0] == (1902, 1055)
        assert len(model.calls) == 3
        assert result["image"] == {"width": 1902, "height": 1055}
        assert len(result["detections"]) == 3
        assert result["detections"][2]["box"]["x"] > 1200
        assert result["maxDetections"] == 500
    finally:
        runtime.close()
