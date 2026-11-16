"""How far a rendering is from its design, measured without a model.

Two measures over the pixels the loop does not mask, both from 0 to 1:

* **pixel match**: the share of pixels whose channels all stay within a
  tolerance of the target's (anti-aliasing, a JPEG's artefacts);
* **SSIM**: the structural similarity of the two grey images over 8×8 windows,
  which sees a shifted edge or a blurred text the pixel count forgives.

The score is their mean. The page is cut in regions (the components the vision
step located, or horizontal bands), and each region that misses the threshold
gets the facts a model can act on: its background colour on both sides, how
far its content moved, how much its content box grew or shrank. Numbers only:
the sentence a model reads is written by ``feedback``.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field

import numpy as np
from PIL import Image, ImageDraw

#: Channel distance under which two pixels count as the same colour.
DEFAULT_TOLERANCE = 12
#: A JPEG target carries block artefacts: the tolerance grows with them.
JPEG_TOLERANCE = 24
#: Mean channel distance between two background colours worth a remark.
_COLOR_DELTA = 18
#: A move or a size change smaller than this is anti-aliasing, not an issue.
_MIN_OFFSET = 2
_MIN_SIZE_DELTA = 4
_MAX_SHIFT = 48
_SSIM_WINDOW = 8
_C1 = (0.01 * 255) ** 2
_C2 = (0.03 * 255) ** 2
#: Width of the pictures sent to the page (the diff map, the renders).
THUMBNAIL_WIDTH = 480


@dataclass(frozen=True)
class Box:
    """A rectangle in pixels of the target."""

    x: int
    y: int
    w: int
    h: int

    def as_dict(self) -> dict[str, int]:
        return {"x": self.x, "y": self.y, "width": self.w, "height": self.h}


@dataclass(frozen=True)
class Region:
    """A named part of the page, compared on its own."""

    name: str
    box: Box


@dataclass
class RegionDiff:
    name: str
    box: Box
    pixel_match: float
    ssim: float
    score: float
    target_color: str
    render_color: str
    offset_x: int = 0
    offset_y: int = 0
    size_dw: int = 0
    size_dh: int = 0
    issues: list[dict] = field(default_factory=list)


@dataclass
class DiffReport:
    width: int
    height: int
    pixel_match: float
    ssim: float
    score: float
    masked_ratio: float
    regions: list[RegionDiff]
    diff_png: bytes


def load_image(data: bytes) -> Image.Image:
    """An RGB image from PNG/JPEG/WebP/GIF bytes, transparency laid on white."""
    with Image.open(io.BytesIO(data)) as source:
        source.load()
        image = source.convert("RGBA")
    white = Image.new("RGBA", image.size, (255, 255, 255, 255))
    return Image.alpha_composite(white, image).convert("RGB")


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def thumbnail(image: Image.Image, width: int = THUMBNAIL_WIDTH) -> bytes:
    """The image as a PNG no wider than ``width``, for the page."""
    if image.width > width:
        height = max(1, round(image.height * width / image.width))
        image = image.resize((width, height), Image.Resampling.LANCZOS)
    return png_bytes(image)


def fraction_box(bounds: dict, width: int, height: int) -> Box | None:
    """A ``{x, y, w, h}`` of fractions as pixels, or None when it is empty."""
    x, y = round(bounds["x"] * width), round(bounds["y"] * height)
    w, h = round(bounds["w"] * width), round(bounds["h"] * height)
    w, h = min(w, width - x), min(h, height - y)
    if w < 4 or h < 4:
        return None
    return Box(x, y, w, h)


def band_regions(width: int, height: int, count: int = 5) -> list[Region]:
    """Horizontal bands, for a design whose zones the vision step did not place."""
    step = height / count
    regions = []
    for index in range(count):
        top, bottom = round(index * step), round((index + 1) * step)
        regions.append(
            Region(f"band {index + 1}/{count}", Box(0, top, width, bottom - top))
        )
    return regions


def _hex(color: np.ndarray) -> str:
    r, g, b = (int(round(float(c))) for c in color[:3])
    return f"#{r:02x}{g:02x}{b:02x}"


def _box_mean(values: np.ndarray, size: int) -> np.ndarray:
    """Mean over each ``size``×``size`` window (valid positions), by integral image."""
    integral = np.pad(values, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    total = (
        integral[size:, size:]
        - integral[:-size, size:]
        - integral[size:, :-size]
        + integral[:-size, :-size]
    )
    return total / (size * size)


def ssim_map(target: np.ndarray, render: np.ndarray) -> np.ndarray:
    """Per-pixel SSIM of two grey images, each window's value on its top-left pixel.

    Returned at the images' size (the last ``window - 1`` rows and columns
    repeat their neighbours) so a region reads it with the same box.
    """
    height, width = target.shape
    size = min(_SSIM_WINDOW, height, width)
    mu_t, mu_r = _box_mean(target, size), _box_mean(render, size)
    var_t = _box_mean(target * target, size) - mu_t * mu_t
    var_r = _box_mean(render * render, size) - mu_r * mu_r
    cov = _box_mean(target * render, size) - mu_t * mu_r
    values = ((2 * mu_t * mu_r + _C1) * (2 * cov + _C2)) / (
        (mu_t * mu_t + mu_r * mu_r + _C1) * (var_t + var_r + _C2)
    )
    pad_y, pad_x = height - values.shape[0], width - values.shape[1]
    return np.pad(values, ((0, pad_y), (0, pad_x)), mode="edge")


def _background(pixels: np.ndarray) -> np.ndarray:
    """The most frequent colour of a region (quantised), as its mean RGB."""
    flat = pixels.reshape(-1, 3)
    keys = (flat // 16).astype(np.int32)
    codes = keys[:, 0] * 256 + keys[:, 1] * 16 + keys[:, 2]
    winner = np.bincount(codes).argmax()
    return flat[codes == winner].mean(axis=0)


def _content_mask(pixels: np.ndarray, background: np.ndarray) -> np.ndarray:
    return np.abs(pixels - background).max(axis=2) > _COLOR_DELTA


def _profile_shift(target: np.ndarray, render: np.ndarray) -> int:
    """How many pixels ``render``'s profile sits after ``target``'s (0 when unsure)."""
    length = len(target)
    limit = min(_MAX_SHIFT, length // 4)
    if limit < 1 or not target.any():
        return 0

    def error(shift: int) -> float:
        if shift >= 0:
            a, b = target[: length - shift], render[shift:]
        else:
            a, b = target[-shift:], render[: length + shift]
        return float(np.abs(a - b).mean())

    errors = {shift: error(shift) for shift in range(-limit, limit + 1)}
    best = min(errors, key=lambda s: (errors[s], abs(s)))
    # A shift only counts when it explains the difference much better.
    return best if errors[best] < errors[0] * 0.8 else 0


def _extent(mask: np.ndarray, axis: int) -> int:
    """Rows (axis=1) or columns (axis=0) the content spans."""
    hits = np.flatnonzero(mask.any(axis=axis))
    return int(hits[-1] - hits[0] + 1) if hits.size else 0


def _region_issues(diff: RegionDiff) -> list[dict]:
    issues: list[dict] = []
    t = np.array([int(diff.target_color[i : i + 2], 16) for i in (1, 3, 5)])
    r = np.array([int(diff.render_color[i : i + 2], 16) for i in (1, 3, 5)])
    if np.abs(t - r).max() > _COLOR_DELTA:
        issues.append(
            {"kind": "color", "target": diff.target_color, "render": diff.render_color}
        )
    for axis, value in (("x", diff.offset_x), ("y", diff.offset_y)):
        if abs(value) >= _MIN_OFFSET:
            issues.append({"kind": "offset", "axis": axis, "px": value})
    for axis, value in (("width", diff.size_dw), ("height", diff.size_dh)):
        if abs(value) >= _MIN_SIZE_DELTA:
            issues.append({"kind": "size", "axis": axis, "px": value})
    if not issues:
        issues.append({"kind": "structure"})
    return issues


def _compare_region(
    region: Region,
    target: np.ndarray,
    render: np.ndarray,
    mismatch: np.ndarray,
    ssim: np.ndarray,
    valid: np.ndarray,
    threshold: float,
) -> RegionDiff | None:
    b = region.box
    window = (slice(b.y, b.y + b.h), slice(b.x, b.x + b.w))
    keep = valid[window]
    if not keep.any():
        return None
    pixel_match = 1.0 - float(mismatch[window][keep].mean())
    similarity = float(np.clip(ssim[window][keep], 0, 1).mean())
    t_pixels, r_pixels = target[window], render[window]
    t_bg, r_bg = _background(t_pixels), _background(r_pixels)
    t_content, r_content = _content_mask(t_pixels, t_bg), _content_mask(r_pixels, r_bg)
    diff = RegionDiff(
        name=region.name,
        box=b,
        pixel_match=round(pixel_match, 4),
        ssim=round(similarity, 4),
        score=round((pixel_match + similarity) / 2, 4),
        target_color=_hex(t_bg),
        render_color=_hex(r_bg),
        offset_x=_profile_shift(t_content.mean(axis=0), r_content.mean(axis=0)),
        offset_y=_profile_shift(t_content.mean(axis=1), r_content.mean(axis=1)),
        size_dw=_extent(r_content, 0) - _extent(t_content, 0),
        size_dh=_extent(r_content, 1) - _extent(t_content, 1),
    )
    if diff.score < threshold:
        diff.issues = _region_issues(diff)
    return diff


def _diff_map(
    target: np.ndarray,
    mismatch: np.ndarray,
    valid: np.ndarray,
    failing: list[RegionDiff],
) -> bytes:
    """The target faded, differing pixels red, masked zones grey, failing regions framed."""
    grey = target.mean(axis=2, keepdims=True)
    picture = np.repeat(grey * 0.35 + 255 * 0.65, 3, axis=2)
    picture[mismatch & valid] = (230, 57, 70)
    picture[~valid] = (176, 176, 176)
    image = Image.fromarray(picture.astype(np.uint8), "RGB")
    draw = ImageDraw.Draw(image)
    for region in failing:
        b = region.box
        draw.rectangle(
            (b.x, b.y, b.x + b.w - 1, b.y + b.h - 1), outline=(245, 158, 11), width=3
        )
    return thumbnail(image)


def compare(
    target_image: Image.Image,
    render_image: Image.Image,
    regions: list[Region],
    *,
    masks: list[Box] | None = None,
    tolerance: int = DEFAULT_TOLERANCE,
    threshold: float = 0.95,
) -> DiffReport:
    """Compare a rendering with its target, region by region.

    The rendering is resized to the target when their sizes differ (a capture
    at another scale): the comparison is always in the target's pixels.
    """
    if render_image.size != target_image.size:
        render_image = render_image.resize(target_image.size, Image.Resampling.LANCZOS)
    target = np.asarray(target_image, dtype=np.float64)
    render = np.asarray(render_image, dtype=np.float64)
    height, width = target.shape[:2]

    valid = np.ones((height, width), dtype=bool)
    for box in masks or []:
        valid[box.y : box.y + box.h, box.x : box.x + box.w] = False
    if not valid.any():
        valid[:] = True

    mismatch = np.abs(target - render).max(axis=2) > tolerance
    ssim = ssim_map(target.mean(axis=2), render.mean(axis=2))
    pixel_match = 1.0 - float(mismatch[valid].mean())
    similarity = float(np.clip(ssim[valid], 0, 1).mean())

    compared = [
        diff
        for region in regions
        if (
            diff := _compare_region(
                region, target, render, mismatch, ssim, valid, threshold
            )
        )
        is not None
    ]
    failing = [d for d in compared if d.issues]
    return DiffReport(
        width=width,
        height=height,
        pixel_match=round(pixel_match, 4),
        ssim=round(similarity, 4),
        score=round((pixel_match + similarity) / 2, 4),
        masked_ratio=round(1.0 - float(valid.mean()), 4),
        regions=compared,
        diff_png=_diff_map(target, mismatch, valid, failing),
    )


def side_by_side(images: list[Image.Image], height: int = 720) -> bytes:
    """The pictures next to each other at one height, for a vision model."""
    scaled = [
        image.resize((max(1, round(image.width * height / image.height)), height))
        for image in images
    ]
    gap = 16
    canvas = Image.new(
        "RGB",
        (sum(i.width for i in scaled) + gap * (len(scaled) - 1), height),
        (40, 40, 40),
    )
    left = 0
    for image in scaled:
        canvas.paste(image, (left, 0))
        left += image.width + gap
    return png_bytes(canvas)
