"""Bounded in-memory image inputs. No URLs, paths, or model names from callers."""

import base64
import binascii
import io
import warnings
from typing import Literal

from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_DIMENSION = 4096
MAX_PIXELS = MAX_DIMENSION * MAX_DIMENSION
MAX_ENCODED_LENGTH = 4 * ((MAX_IMAGE_BYTES + 2) // 3)
IMAGE_FORMATS = {"data:image/png;base64": "PNG", "data:image/jpeg;base64": "JPEG", "data:image/webp;base64": "WEBP"}


class VisionError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(code)
        self.code, self.message, self.status = code, message, status


def invalid_image():
    return VisionError("VISION_INVALID_REQUEST", "Provide a valid PNG, JPEG, or WebP image up to 4096 pixels per side.")


def image_parts(value):
    if not isinstance(value, str) or "," not in value:
        raise invalid_image()
    header, encoded = value.split(",", 1)
    if header not in IMAGE_FORMATS or not encoded:
        raise invalid_image()
    if len(encoded) > MAX_ENCODED_LENGTH:
        raise VisionError("VISION_REQUEST_TOO_LARGE", "Image exceeds the 5 MiB limit.", 413)
    return header, encoded


class DetectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    image: str = Field(min_length=1, max_length=MAX_ENCODED_LENGTH + 32)
    confidence: float = Field(default=0.25, ge=0.05, le=0.95, allow_inf_nan=False)
    task: Literal["detect", "obb", "segment", "buildings-seg"] = "obb"

    @field_validator("image")
    @classmethod
    def validate_image(cls, value):
        image_parts(value)
        return value


def decode_image(value):
    header, encoded = image_parts(value)
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise invalid_image() from None
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise VisionError("VISION_REQUEST_TOO_LARGE", "Image exceeds the 5 MiB limit.", 413)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as opened:
                width, height = opened.size
                if (opened.format != IMAGE_FORMATS[header] or getattr(opened, "n_frames", 1) != 1
                        or not 0 < width <= MAX_DIMENSION or not 0 < height <= MAX_DIMENSION
                        or width * height > MAX_PIXELS):
                    raise invalid_image()
                # Validate headers before decompression/allocation of RGB pixels.
                opened.load()
                return opened.convert("RGB")
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise invalid_image() from None
