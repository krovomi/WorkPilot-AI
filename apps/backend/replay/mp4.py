"""A replay's WebM as an MP4 (#347), for the places that only play MP4.

Playwright records WebM, and its own encoder writes nothing else. An MP4 is
a second encoding, by the ffmpeg of this machine when it has one
(``foundation.platform.find_executable``): H.264 (``libx264``) when that
build has it, MPEG-4 part 2 (built into every ffmpeg) otherwise. No ffmpeg
is an answer (``VideoUnavailable("no_mp4_encoder")``), not an error.

ffmpeg reads and writes only in a folder made for this conversion, gets its
arguments as a list (no shell), an environment of its own (the search path
and the system folders, nothing else of the backend's), no standard input,
and a deadline; the MP4 is read only within ``MAX_VIDEO_BYTES``.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from pathlib import Path

from .video import MAX_VIDEO_BYTES, VideoError, VideoUnavailable

EXTENSION = ".mp4"
DEADLINE_SECONDS = 120
#: What ffmpeg may need from the environment to start, on every OS.
_ENV_KEYS = ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR")
#: The encoders tried in order, each with its own quality setting.
ENCODERS: tuple[tuple[str, ...], ...] = (
    ("-c:v", "libx264", "-preset", "veryfast", "-crf", "23"),
    ("-c:v", "mpeg4", "-q:v", "3"),
)


def find_ffmpeg() -> str | None:
    from foundation.platform import find_executable

    return find_executable("ffmpeg")


def _env() -> dict[str, str]:
    return {key: os.environ[key] for key in _ENV_KEYS if key in os.environ}


async def _encode(
    ffmpeg: str, source: Path, target: Path, codec: tuple[str, ...]
) -> bool:
    try:
        process = await _start(ffmpeg, source, target, codec)
    except OSError as exc:
        raise VideoUnavailable("no_mp4_encoder") from exc
    try:
        code = await asyncio.wait_for(process.wait(), DEADLINE_SECONDS)
    except TimeoutError as exc:
        process.kill()
        await process.wait()
        raise VideoError("timeout") from exc
    return code == 0 and target.is_file()


async def _start(
    ffmpeg: str, source: Path, target: Path, codec: tuple[str, ...]
) -> asyncio.subprocess.Process:
    return await asyncio.create_subprocess_exec(
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        *codec,
        "-pix_fmt",
        "yuv420p",
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-movflags",
        "+faststart",
        "-an",
        "-f",
        "mp4",
        str(target),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        env=_env(),
    )


async def to_mp4(webm: bytes, *, ffmpeg: str | None = None) -> bytes:
    """``webm`` encoded again as an MP4, within ``MAX_VIDEO_BYTES``."""
    executable = ffmpeg if ffmpeg is not None else find_ffmpeg()
    if not executable:
        raise VideoUnavailable("no_mp4_encoder")
    folder = Path(tempfile.mkdtemp(prefix="wp-replay-mp4-")).resolve()
    try:
        source = folder / "replay.webm"
        target = folder / f"replay{EXTENSION}"
        source.write_bytes(webm)
        for codec in ENCODERS:
            if await _encode(executable, source, target, codec):
                with target.open("rb") as handle:
                    data = handle.read(MAX_VIDEO_BYTES + 1)
                if len(data) > MAX_VIDEO_BYTES:
                    raise VideoError("too_large")
                return data
        raise VideoError("failed")
    finally:
        shutil.rmtree(folder, ignore_errors=True)
