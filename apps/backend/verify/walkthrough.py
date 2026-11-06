"""The scenario's walkthrough: a video for the app, a GIF for the pull request.

A card with a scenario (``verifyScenario``) is driven in a browser; besides the
Playwright trace, two files show what the verifier did, readable in seconds:

- ``scenario-video.webm``: Playwright's recording of the scenario's page. Only
  in ``launch`` mode: attached to a running app over CDP, the session reuses a
  context it did not create, which records nothing (the record says why).
- ``scenario-walkthrough.gif``: the captures reported with the scenario's
  steps, in step order. A GIF shows inline in a GitHub comment, linked from the
  branch like the visual proof's screenshots; a video does not.

Both have a size ceiling. A video over it is dropped (the trace and the
captures stay). A GIF over it keeps only its first and last frame rather than
grow the task's branch.

The video shows the app served on loopback with whatever data it holds: it is
published only when the person asks for it, from the PR dialog.
"""

from __future__ import annotations

import logging
import shutil
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = [
    "GIF_MAX_BYTES",
    "VIDEO_FILE",
    "VIDEO_MAX_BYTES",
    "VIDEO_SIZE",
    "WALKTHROUGH_FILE",
    "build_walkthrough",
    "clear_walkthrough",
    "finish_video",
    "step_captures",
    "video_context_options",
]

WALKTHROUGH_FILE = "scenario-walkthrough.gif"
VIDEO_FILE = "scenario-video.webm"
#: Playwright writes the page's video here until the page closes.
_VIDEO_TMP = ".scenario-video"
VIDEO_SIZE = {"width": 1280, "height": 800}
VIDEO_MAX_BYTES = 25 * 1024 * 1024
GIF_MAX_BYTES = 6 * 1024 * 1024
_GIF_WIDTH = 960
_FRAME_MS = 1600
_LAST_FRAME_MS = 3000


def clear_walkthrough(base: Path) -> None:
    """Last run's walkthrough is not this run's proof."""
    for name in (WALKTHROUGH_FILE, VIDEO_FILE):
        (base / name).unlink(missing_ok=True)
    shutil.rmtree(base / _VIDEO_TMP, ignore_errors=True)


def video_context_options(base: Path) -> dict:
    """The ``new_context`` options that record the scenario's page.

    One folder per session: on the Claude path the verifier's browser (the
    MCP server's process) and the loop's own record side by side.
    """
    folder = base / _VIDEO_TMP / uuid.uuid4().hex
    return {"record_video_dir": str(folder), "record_video_size": VIDEO_SIZE}


async def finish_video(page, base: Path, *, keep: bool) -> tuple[Path | None, str]:
    """Close ``page`` so its video is written, then keep it or drop it.

    Returns the video (or None) and why there is none, "" when there is one
    or when ``keep`` is false. Never raises.
    """
    video = getattr(page, "video", None)
    if video is None:
        return None, "the page recorded no video"
    dest = base / VIDEO_FILE
    try:
        await page.close()
        if not keep:
            await video.delete()
            return None, ""
        await video.save_as(str(dest))
        await video.delete()
    except Exception as exc:  # noqa: BLE001 - the video is proof, not the session
        return None, f"the video could not be written ({exc})"
    try:
        size = dest.stat().st_size
    except OSError:
        return None, "the video could not be written"
    if size == 0:
        # Playwright's ffmpeg not of the build it expects writes nothing.
        dest.unlink(missing_ok=True)
        return None, "the video came back empty"
    if size > VIDEO_MAX_BYTES:
        dest.unlink(missing_ok=True)
        return None, (
            f"the video was over {VIDEO_MAX_BYTES // (1024 * 1024)} MB and was "
            "dropped: the trace and the captures remain"
        )
    return dest, ""


def step_captures(record: dict, base: Path) -> list[Path]:
    """The captures reported with the scenario's steps, in step order.

    A step reported twice keeps its last capture. Only files under this
    verification's ``screenshots/`` count: the tool already refused others,
    this keeps a hand-edited record from naming one.
    """
    root = (base / "screenshots").resolve()
    by_step: dict[int, Path] = {}
    for step in record.get("scenario_steps") or []:
        if not isinstance(step, dict) or not isinstance(step.get("step"), int):
            continue
        shot = str(step.get("screenshot") or "")
        if not shot:
            continue
        try:
            path = Path(shot).resolve(strict=True)
            path.relative_to(root)
        except (OSError, ValueError):
            continue
        if path.is_file():
            by_step[step["step"]] = path
    return [by_step[number] for number in sorted(by_step)]


def _frames(paths: list[Path]):
    from PIL import Image

    frames = []
    for path in paths:
        try:
            with Image.open(path) as image:
                frame = image.convert("RGB")
        except (OSError, ValueError) as exc:
            logger.debug("walkthrough: skipped %s: %s", path.name, exc)
            continue
        if frame.width > _GIF_WIDTH:
            height = max(1, round(frame.height * _GIF_WIDTH / frame.width))
            frame = frame.resize((_GIF_WIDTH, height))
        frames.append(frame.quantize(colors=256))
    return frames


def _write_gif(frames: list, dest: Path) -> None:
    durations = [_FRAME_MS] * (len(frames) - 1) + [_LAST_FRAME_MS]
    frames[0].save(
        dest,
        format="GIF",
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        optimize=True,
    )


def build_walkthrough(record: dict, base: Path) -> Path | None:
    """Write ``scenario-walkthrough.gif`` from the step captures; None if none.

    Never raises: a walkthrough that cannot be built leaves the verdict and
    the other evidence as they are.
    """
    dest = base / WALKTHROUGH_FILE
    dest.unlink(missing_ok=True)
    try:
        frames = _frames(step_captures(record, base))
        if not frames:
            return None
        _write_gif(frames, dest)
        if dest.stat().st_size > GIF_MAX_BYTES and len(frames) > 2:
            # Too heavy for the branch: the state before and after.
            _write_gif([frames[0], frames[-1]], dest)
        if dest.stat().st_size > GIF_MAX_BYTES:
            dest.unlink(missing_ok=True)
            return None
        return dest
    except ImportError:
        logger.warning("walkthrough: Pillow is not installed")
    except (OSError, ValueError) as exc:
        logger.warning("walkthrough: could not be written: %s", exc)
    dest.unlink(missing_ok=True)
    return None
