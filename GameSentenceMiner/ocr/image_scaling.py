from __future__ import annotations

from PIL import Image
from dataclasses import dataclass
from typing import Iterable, Optional, Tuple

AspectBucket = Tuple[float, Tuple[int, int]]

DEFAULT_MIN_WIDTH = 1024
DEFAULT_MIN_HEIGHT = 768

# Standard aspect buckets used across the app (ordered high-to-low thresholds)
DEFAULT_ASPECT_BUCKETS: Tuple[AspectBucket, ...] = (
    (2.66, (1920, 540)),  # 32:9
    (2.33, (1920, 800)),  # 21:9
    (1.77, (1280, 720)),  # 16:9
    (1.6, (1280, 800)),   # 16:10
    (1.5, (1080, 720)),   # 3:2
    (1.33, (960, 720)),   # 4:3
    (1.25, (900, 720)),   # 5:4
)


@dataclass(frozen=True)
class ScaledSize:
    """Scaled image dimensions and the per-axis scale factors."""

    width: int
    height: int
    scale_x: float
    scale_y: float

    @property
    def scale(self) -> float:
        return max(self.scale_x, self.scale_y)

    def as_tuple(self) -> Tuple[int, int]:
        return self.width, self.height


def scale_dimensions_with_floor(
    width: int,
    height: int,
    *,
    min_width: Optional[int] = None,
    min_height: Optional[int] = None,
    base_scale: float = 1.0,
    allow_upscale: bool = False,
) -> ScaledSize:
    """Apply a base scale, then enforce minimum dimensions while keeping aspect ratio.

    This mirrors the overlay logic: scale the image (often down), then scale up just
    enough to satisfy the minimum width/height constraints without changing aspect.
    """

    if width == 0 or height == 0:
        return ScaledSize(width, height, 1.0, 1.0)

    target_w = width * base_scale
    target_h = height * base_scale

    min_w = min_width if min_width is not None else DEFAULT_MIN_WIDTH
    min_h = min_height if min_height is not None else DEFAULT_MIN_HEIGHT

    scale_factor = 1.0
    width_adjust = (min_w / target_w) if min_w else 0.0
    height_adjust = (min_h / target_h) if min_h else 0.0

    if width_adjust > 1.0 or height_adjust > 1.0:
        scale_factor = max(width_adjust, height_adjust)

    if not allow_upscale:
        scale_factor = min(scale_factor, 1.0)

    final_w = int(round(target_w * scale_factor))
    final_h = int(round(target_h * scale_factor))

    final_w = max(1, final_w)
    final_h = max(1, final_h)

    return ScaledSize(final_w, final_h, final_w / width, final_h / height)


def scale_dimensions_to_minimum_bounds(
    width: int,
    height: int,
    *,
    min_width: Optional[int] = None,
    min_height: Optional[int] = None,
) -> ScaledSize:
    """Downscale to the smallest size that still meets the minimum bounds.

    If the image is already at or below the minimums, it is returned unchanged.
    """
    # logger.info(f"scale_dimensions_to_minimum_bounds: input width={width}, height={height}, min_width={min_width}, min_height={min_height}")

    if width == 0 or height == 0:
        return ScaledSize(width, height, 1.0, 1.0)

    min_w = min_width if min_width is not None else DEFAULT_MIN_WIDTH
    min_h = min_height if min_height is not None else DEFAULT_MIN_HEIGHT
    if not min_w and not min_h:
        return ScaledSize(width, height, 1.0, 1.0)

    width_scale = (min_w / width) if min_w else 0.0
    height_scale = (min_h / height) if min_h else 0.0
    scale_factor = max(width_scale, height_scale)

    # If scale_factor >= 1 we would be upscaling; keep the original size instead.
    if scale_factor <= 0.0 or scale_factor >= 1.0:
        return ScaledSize(width, height, 1.0, 1.0)

    final_w = int(round(width * scale_factor))
    final_h = int(round(height * scale_factor))

    final_w = max(1, final_w)
    final_h = max(1, final_h)

    # logger.info(f"scale_dimensions_to_minimum_bounds: output {final_w}x{final_h}")
    return ScaledSize(final_w, final_h, final_w / width, final_h / height)


def scale_dimensions_to_bounds(
    width: int,
    height: int,
    *,
    max_width: Optional[int] = None,
    max_height: Optional[int] = None,
    allow_upscale: bool = False,
) -> ScaledSize:
    """Scale dimensions so they fit inside the given bounding box."""

    if width == 0 or height == 0:
        return ScaledSize(width, height, 1.0, 1.0)

    width_scale = (max_width / width) if max_width else float("inf")
    height_scale = (max_height / height) if max_height else float("inf")
    scale_factor = min(width_scale, height_scale)

    if not allow_upscale:
        scale_factor = min(scale_factor, 1.0)

    if scale_factor == float("inf"):
        scale_factor = 1.0

    final_w = int(round(width * scale_factor))
    final_h = int(round(height * scale_factor))

    final_w = max(1, final_w)
    final_h = max(1, final_h)

    return ScaledSize(final_w, final_h, final_w / width, final_h / height)


def scale_dimensions_by_aspect_buckets(
    width: int,
    height: int,
    buckets: Iterable[AspectBucket] = DEFAULT_ASPECT_BUCKETS,
    *,
    fallback: Optional[Tuple[int, int]] = None,
    allow_upscale: bool = False
) -> ScaledSize:
    """Map an aspect ratio to a preferred target size using ordered buckets."""

    if width == 0 or height == 0:
        return ScaledSize(width, height, 1.0, 1.0)

    aspect_ratio = width / height
    fallback_w, fallback_h = fallback or (width, height)

    for threshold, (target_w, target_h) in buckets:
        if aspect_ratio > threshold:
            if not allow_upscale and (target_w > width or target_h > height):
                continue
            target_w = max(1, int(target_w))
            target_h = max(1, int(target_h))
            return ScaledSize(target_w, target_h, target_w / width, target_h / height)

    fallback_w = max(1, int(fallback_w))
    fallback_h = max(1, int(fallback_h))
    
    if not allow_upscale and (fallback_w > width or fallback_h > height):
        return ScaledSize(width, height, 1.0, 1.0)

    return ScaledSize(fallback_w, fallback_h, fallback_w / width, fallback_h / height)


def scale_dimensions_by_factor(
    width: int,
    height: int,
    scale_factor: float,
    *,
    allow_upscale: bool = True,
) -> ScaledSize:
    """Simple factor-based scaling with optional upscale guard."""

    if width == 0 or height == 0:
        return ScaledSize(width, height, 1.0, 1.0)

    if not allow_upscale and scale_factor > 1.0:
        scale_factor = 1.0

    final_w = int(round(width * scale_factor))
    final_h = int(round(height * scale_factor))

    final_w = max(1, final_w)
    final_h = max(1, final_h)

    return ScaledSize(final_w, final_h, final_w / width, final_h / height)


def scale_pil_image(image: Image.Image, scaled_size: ScaledSize, *, resample: Image.Resampling = Image.Resampling.BILINEAR) -> Image.Image:
    """Resize a PIL image to the provided ScaledSize."""

    if not scaled_size or (image.width == scaled_size.width and image.height == scaled_size.height):
        return image

    return image.resize((scaled_size.width, scaled_size.height), resample)


def scale_pil_image_with_floor(
    image: Image.Image,
    *,
    min_width: Optional[int] = None,
    min_height: Optional[int] = None,
    base_scale: float = 1.0,
    allow_upscale: bool = False,
    resample: Image.Resampling = Image.Resampling.BILINEAR,
) -> Tuple[Image.Image, ScaledSize]:
    """Convenience helper: floor-scale dimensions then resize the image."""

    scaled_size = scale_dimensions_with_floor(
        image.width,
        image.height,
        min_width=min_width,
        min_height=min_height,
        base_scale=base_scale,
        allow_upscale=allow_upscale,
    )
    return scale_pil_image(image, scaled_size, resample=resample), scaled_size


def scale_pil_image_to_bounds(
    image: Image.Image,
    *,
    max_width: Optional[int] = None,
    max_height: Optional[int] = None,
    allow_upscale: bool = False,
    resample: Image.Resampling = Image.Resampling.BILINEAR,
) -> Tuple[Image.Image, ScaledSize]:
    """Scale a PIL image to fit within given bounds."""

    scaled_size = scale_dimensions_to_bounds(
        image.width,
        image.height,
        max_width=max_width,
        max_height=max_height,
        allow_upscale=allow_upscale,
    )
    return scale_pil_image(image, scaled_size, resample=resample), scaled_size


def scale_pil_image_to_minimum_bounds(
    image: Image.Image,
    *,
    min_width: Optional[int] = None,
    min_height: Optional[int] = None,
    resample: Image.Resampling = Image.Resampling.BILINEAR,
) -> Tuple[Image.Image, ScaledSize]:
    """Downscale an image to meet minimum bounds without upscaling smaller images."""

    scaled_size = scale_dimensions_to_minimum_bounds(
        image.width,
        image.height,
        min_width=min_width,
        min_height=min_height,
    )
    return scale_pil_image(image, scaled_size, resample=resample), scaled_size


def scale_pil_image_by_aspect_buckets(
    image: Image.Image,
    buckets: Iterable[AspectBucket] = DEFAULT_ASPECT_BUCKETS,
    *,
    fallback: Optional[Tuple[int, int]] = None,
    resample: Image.Resampling = Image.Resampling.BILINEAR,
) -> Tuple[Image.Image, ScaledSize]:
    """Scale a PIL image using the aspect bucket mapping."""

    scaled_size = scale_dimensions_by_aspect_buckets(
        image.width,
        image.height,
        buckets=buckets,
        fallback=fallback,
    )
    return scale_pil_image(image, scaled_size, resample=resample), scaled_size
