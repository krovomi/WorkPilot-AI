"""The walkthrough's failure paths: a video that does not come, a capture that is not one.

`tests/test_verify_walkthrough.py` pins the rules on the paths that work;
here each way the evidence can go wrong must leave the verification as it
is: no video and the reason why, no GIF, never an exception.
"""

from __future__ import annotations

import asyncio
import logging

import pytest
from verify import walkthrough
from verify.walkthrough import (
    WALKTHROUGH_FILE,
    build_walkthrough,
    finish_video,
    step_captures,
)

Image = pytest.importorskip("PIL.Image")
pytest.importorskip("playwright.async_api")


class Video:
    def __init__(self, *, write: bool = True, fail: Exception | None = None):
        self.write = write
        self.fail = fail
        self.deleted = False

    async def save_as(self, path: str) -> None:
        if self.fail:
            raise self.fail
        if self.write:
            with open(path, "wb") as handle:
                handle.write(b"\x1a\x45\xdf\xa3webm")

    async def delete(self) -> None:
        self.deleted = True


class Page:
    def __init__(self, video):
        self.video = video
        self.closed = False

    async def close(self) -> None:
        self.closed = True


def test_a_page_without_a_video_says_so(tmp_path):
    assert asyncio.run(finish_video(object(), tmp_path, keep=True)) == (
        None,
        "the page recorded no video",
    )


def test_a_video_that_cannot_be_saved_is_reported(tmp_path):
    from playwright.async_api import Error as PlaywrightError

    for error in (OSError("disk full"), PlaywrightError("target closed")):
        video, reason = asyncio.run(
            finish_video(Page(Video(fail=error)), tmp_path, keep=True)
        )
        assert video is None
        assert reason.startswith("the video could not be written (")


def test_a_video_saved_nowhere_is_reported(tmp_path):
    page = Page(Video(write=False))
    assert asyncio.run(finish_video(page, tmp_path, keep=True)) == (
        None,
        "the video could not be written",
    )
    assert page.closed and page.video.deleted


def _png(path, width=40, color=(200, 30, 30)):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (width, 20), color).save(path, format="PNG")
    return path


def test_only_reported_files_under_the_screenshots_are_captures(tmp_path):
    shots = tmp_path / "screenshots"
    first = _png(shots / "1.png")
    second = _png(shots / "2.png")
    (shots / "folder.png").mkdir()
    outside = _png(tmp_path / "elsewhere.png")
    record = {
        "scenario_steps": [
            "not a step",
            {"step": "2", "screenshot": str(second)},
            {"step": 3},
            {"step": 4, "screenshot": str(outside)},
            {"step": 5, "screenshot": str(shots / "missing.png")},
            {"step": 6, "screenshot": str(shots / "folder.png")},
            {"step": 2, "screenshot": str(second)},
            {"step": 1, "screenshot": str(first)},
        ]
    }
    assert step_captures(record, tmp_path) == [first.resolve(), second.resolve()]


def test_a_capture_that_is_not_an_image_is_skipped_and_a_wide_one_shrunk(tmp_path):
    shots = tmp_path / "screenshots"
    broken = shots / "1.png"
    broken.parent.mkdir(parents=True)
    broken.write_bytes(b"not a png")
    wide = _png(shots / "2.png", width=2000)
    record = {
        "scenario_steps": [
            {"step": 1, "screenshot": str(broken)},
            {"step": 2, "screenshot": str(wide)},
        ]
    }
    gif = build_walkthrough(record, tmp_path)
    assert gif == tmp_path / WALKTHROUGH_FILE
    with Image.open(gif) as image:
        assert image.width == 960


def test_a_gif_still_too_heavy_with_two_frames_is_dropped(tmp_path, monkeypatch):
    shots = tmp_path / "screenshots"
    record = {
        "scenario_steps": [
            {
                "step": n,
                "screenshot": str(_png(shots / f"{n}.png", color=(n * 60, 0, 0))),
            }
            for n in (1, 2, 3)
        ]
    }
    monkeypatch.setattr(walkthrough, "GIF_MAX_BYTES", 10)
    assert build_walkthrough(record, tmp_path) is None
    assert not (tmp_path / WALKTHROUGH_FILE).exists()


def _one_capture(tmp_path) -> dict:
    return {
        "scenario_steps": [
            {"step": 1, "screenshot": str(_png(tmp_path / "screenshots" / "1.png"))}
        ]
    }


def test_without_pillow_there_is_no_gif(tmp_path, monkeypatch, caplog):
    record = _one_capture(tmp_path)

    def no_pillow(paths):
        raise ImportError("No module named 'PIL'")

    monkeypatch.setattr(walkthrough, "_frames", no_pillow)
    with caplog.at_level(logging.WARNING, logger=walkthrough.__name__):
        assert build_walkthrough(record, tmp_path) is None
    assert "Pillow is not installed" in caplog.text


def test_a_gif_that_cannot_be_written_leaves_nothing(tmp_path, monkeypatch, caplog):
    record = _one_capture(tmp_path)

    def full_disk(frames, dest):
        dest.write_bytes(b"GIF8")
        raise OSError("No space left on device")

    monkeypatch.setattr(walkthrough, "_write_gif", full_disk)
    with caplog.at_level(logging.WARNING, logger=walkthrough.__name__):
        assert build_walkthrough(record, tmp_path) is None
    assert not (tmp_path / WALKTHROUGH_FILE).exists()
    assert "could not be written" in caplog.text
