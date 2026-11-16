"""The diff of the render loop, on pictures drawn for each case."""

from __future__ import annotations

import io

import numpy as np
from design_to_code.diff import (
    Box,
    Region,
    band_regions,
    compare,
    fraction_box,
    load_image,
    side_by_side,
    ssim_map,
    thumbnail,
)
from PIL import Image


def _page(
    *,
    header="#e63946",
    card_top=120,
    card_left=40,
    card_width=200,
    size=(400, 300),
) -> Image.Image:
    image = Image.new("RGB", size, "#ffffff")
    pixels = np.asarray(image).copy()
    rgb = tuple(int(header[i : i + 2], 16) for i in (1, 3, 5))
    pixels[:80, :] = rgb
    pixels[card_top : card_top + 60, card_left : card_left + card_width] = (29, 53, 87)
    return Image.fromarray(pixels)


HEADER = Region("Header", Box(0, 0, 400, 80))
CARD = Region("Card", Box(0, 80, 400, 220))


def _issues(report, name):
    return next(r for r in report.regions if r.name == name).issues


def test_the_same_picture_scores_one_with_no_issue() -> None:
    report = compare(_page(), _page(), [HEADER, CARD])
    assert report.score == 1.0 and report.pixel_match == 1.0
    assert all(not r.issues for r in report.regions)
    assert report.masked_ratio == 0.0
    diff_size = Image.open(io.BytesIO(report.diff_png)).size
    assert diff_size == (400, 300)


def test_a_wrong_colour_is_reported_with_both_values() -> None:
    report = compare(_page(), _page(header="#f08030"), [HEADER, CARD])
    assert _issues(report, "Header") == [
        {"kind": "color", "target": "#e63946", "render": "#f08030"}
    ]
    assert _issues(report, "Card") == []
    assert report.score < 0.95


def test_a_moved_block_is_reported_as_an_offset() -> None:
    down = compare(_page(), _page(card_top=132), [CARD], threshold=0.999)
    assert {"kind": "offset", "axis": "y", "px": 12} in _issues(down, "Card")
    right = compare(_page(), _page(card_left=30), [CARD], threshold=0.999)
    assert {"kind": "offset", "axis": "x", "px": -10} in _issues(right, "Card")


def test_a_wider_block_is_reported_as_a_size_change() -> None:
    report = compare(_page(), _page(card_width=240), [CARD], threshold=0.99)
    assert {"kind": "size", "axis": "width", "px": 40} in _issues(report, "Card")


def test_a_difference_nothing_explains_is_structural() -> None:
    target = _page()
    noisy = np.asarray(target).copy()
    rng = np.random.default_rng(1)
    noisy[150:170, 50:230] = rng.integers(0, 255, (20, 180, 3))
    noisy[150:170, 50:230, :] = np.where(noisy[150:170, 50:230] > 128, 255, 0)
    noisy[150:170, 50:230] = np.maximum(noisy[150:170, 50:230], (29, 53, 87))
    report = compare(target, Image.fromarray(noisy), [CARD], threshold=0.999)
    issues = _issues(report, "Card")
    assert issues and issues[-1]["kind"] in {"structure", "size", "offset"}


def test_masked_pixels_do_not_count() -> None:
    mask = Box(0, 0, 400, 80)
    report = compare(_page(), _page(header="#000000"), [HEADER, CARD], masks=[mask])
    assert report.score == 1.0
    assert report.masked_ratio == round(80 / 300, 4)
    # A region entirely masked is not compared at all.
    assert [r.name for r in report.regions] == ["Card"]


def test_a_mask_over_everything_is_ignored_rather_than_dividing_by_zero() -> None:
    report = compare(
        _page(), _page(header="#000000"), [HEADER], masks=[Box(0, 0, 400, 300)]
    )
    assert report.score < 1.0


def test_a_render_of_another_size_is_compared_in_the_targets_pixels() -> None:
    report = compare(_page(), _page().resize((800, 600)), [CARD])
    assert report.width == 400 and report.score > 0.95


def test_the_tolerance_forgives_small_colour_noise() -> None:
    noisy = Image.fromarray(
        np.clip(np.asarray(_page()).astype(int) + 10, 0, 255).astype(np.uint8)
    )
    assert compare(_page(), noisy, [CARD], tolerance=12).pixel_match == 1.0
    assert compare(_page(), noisy, [CARD], tolerance=4).pixel_match < 1.0


def test_ssim_is_one_on_identical_images_and_lower_on_different_ones() -> None:
    a = np.asarray(_page(), dtype=float).mean(axis=2)
    assert np.allclose(ssim_map(a, a), 1.0)
    b = np.asarray(_page(card_top=150), dtype=float).mean(axis=2)
    assert ssim_map(a, b).mean() < 1.0
    tiny = np.zeros((3, 5))
    assert ssim_map(tiny, tiny).shape == (3, 5)


def test_boxes_from_fractions_are_clamped_and_tiny_ones_dropped() -> None:
    assert fraction_box({"x": 0.5, "y": 0.5, "w": 1.0, "h": 1.0}, 400, 300) == Box(
        200, 150, 200, 150
    )
    assert fraction_box({"x": 0.0, "y": 0.0, "w": 0.001, "h": 0.5}, 400, 300) is None
    assert fraction_box({"x": 0.0, "y": 0.0, "w": 0.5, "h": 0.001}, 400, 300) is None


def test_a_box_reads_as_pixels() -> None:
    assert Box(1, 2, 3, 4).as_dict() == {"x": 1, "y": 2, "width": 3, "height": 4}


def test_bands_cover_the_page() -> None:
    bands = band_regions(400, 301, count=3)
    assert [b.name for b in bands] == ["band 1/3", "band 2/3", "band 3/3"]
    assert sum(b.box.h for b in bands) == 301


def test_a_transparent_png_is_laid_on_white() -> None:
    buffer = io.BytesIO()
    Image.new("RGBA", (4, 4), (0, 0, 0, 0)).save(buffer, format="PNG")
    assert load_image(buffer.getvalue()).getpixel((0, 0)) == (255, 255, 255)


def test_thumbnails_keep_small_pictures_and_shrink_large_ones() -> None:
    small = Image.open(io.BytesIO(thumbnail(Image.new("RGB", (100, 50)))))
    large = Image.open(io.BytesIO(thumbnail(Image.new("RGB", (960, 600)), width=480)))
    assert small.size == (100, 50) and large.size == (480, 300)


def test_side_by_side_puts_the_pictures_at_one_height() -> None:
    png = side_by_side(
        [Image.new("RGB", (400, 300)), Image.new("RGB", (200, 300))], height=150
    )
    size = Image.open(io.BytesIO(png)).size
    assert size == (200 + 16 + 100, 150)


def test_an_empty_profile_gives_no_offset() -> None:
    white = Image.new("RGB", (400, 300), "#ffffff")
    report = compare(white, white, [Region("tiny", Box(0, 0, 400, 3))])
    assert report.regions[0].offset_y == 0
