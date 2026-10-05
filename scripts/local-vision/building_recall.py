"""Bounded tiled recall; full-frame contours keep priority during merging."""

import math

from PIL import Image, ImageChops, ImageDraw


def building_tiles(width, height):
    """At most four overlapping crops, without repeating a small full frame."""
    def intervals(length):
        if length <= 1280:
            return [(0, length)]
        size = max(960, math.ceil(length * 0.6))
        return [(0, size), (length - size, length)]

    windows = [(left, top, right, bottom) for left, right in intervals(width)
               for top, bottom in intervals(height)]
    return [] if len(windows) == 1 else windows


def translate_tile_detections(detections, tile, width, height):
    """Drop masks cut by interior crop edges, retaining genuine image edges."""
    left, top, right, bottom = tile
    translated = []
    for item in detections:
        points = item["polygon"]
        xs, ys = zip(*points)
        if ((left > 0 and min(xs) <= 2) or (top > 0 and min(ys) <= 2)
                or (right < width and max(xs) >= right - left - 2)
                or (bottom < height and max(ys) >= bottom - top - 2)):
            continue
        translated = [*translated, {**item, "box": {**item["box"],
            "x": round(item["box"]["x"] + left, 2), "y": round(item["box"]["y"] + top, 2)},
            "polygon": [[round(x + left, 2), round(y + top, 2)] for x, y in points]}]
    return translated


def _same_roof(first, second):
    a, b = first["box"], second["box"]
    intersection_width = min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"])
    intersection_height = min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"])
    if intersection_width <= 0 or intersection_height <= 0 or first["class"] != second["class"]:
        return False
    # Bounding boxes alone merge nearby L/U-shaped roofs incorrectly. Compare
    # their filled masks on a bounded local raster, independent of image size.
    left, top = min(a["x"], b["x"]), min(a["y"], b["y"])
    right = max(a["x"] + a["width"], b["x"] + b["width"])
    bottom = max(a["y"] + a["height"], b["y"] + b["height"])
    scale = 190 / max(right - left, bottom - top, 1)
    size = (math.ceil((right - left) * scale) + 2, math.ceil((bottom - top) * scale) + 2)
    with Image.new("L", size) as first_mask, Image.new("L", size) as second_mask:
        for mask, item in ((first_mask, first), (second_mask, second)):
            ImageDraw.Draw(mask).polygon([((x - left) * scale, (y - top) * scale)
                                          for x, y in item["polygon"]], fill=255)
        first_area, second_area = first_mask.histogram()[255], second_mask.histogram()[255]
        with ImageChops.multiply(first_mask, second_mask) as overlap:
            intersection = overlap.histogram()[255]
    union = first_area + second_area - intersection
    return (union > 0 and intersection / union >= 0.55) or (
        min(first_area, second_area) > 0 and intersection / min(first_area, second_area) >= 0.85)


def merge_building_detections(existing, additions, limit):
    merged = [*existing[:limit]]
    truncated = len(existing) > limit
    for item in sorted(additions, key=lambda entry: entry["confidence"], reverse=True):
        if any(_same_roof(item, kept) for kept in merged):
            continue
        if len(merged) >= limit:
            truncated = True
            break
        merged = [*merged, item]
    return merged, truncated


def simplify_mask(points, limit):
    """Simplify dense native-resolution contours instead of dropping a roof."""
    if len(points) <= limit:
        return points
    # These are already installed by Ultralytics; imports stay off /health.
    import cv2
    import numpy as np
    contour = np.asarray(points, dtype=np.float32).reshape((-1, 1, 2))
    epsilon = 0.5
    while True:
        simplified = cv2.approxPolyDP(contour, epsilon, True).reshape((-1, 2)).tolist()
        if len(simplified) <= limit:
            return [[round(x, 2), round(y, 2)] for x, y in simplified]
        epsilon *= 1.5
