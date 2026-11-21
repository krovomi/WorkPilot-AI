"""A replay as a WebM video (#347): the standalone page, played step by step.

The page is the one `viewer.render_viewer` writes from a bundle already
masked, so the video shows nothing the page would not; or the page of two
sessions side by side (`compare_page.render_comparison`), whose two columns
play at once. It is played in a
headless Chromium (the one ``foundation.platform.browser.chrome_executable``
finds, Playwright's own otherwise) under Playwright's video recording:

* JavaScript is off. The page has no script and none may run in it;
  Playwright opens each step by clicking its ``<summary>``, which the
  browser folds by itself.
* The network is cut twice: the context is offline and aborts every
  request, and the browser is pointed at a proxy that does not exist, its
  background traffic (updates, pings) switched off.
* The length is bounded: each step gets a share of ``MAX_SECONDS``, between
  a floor and a ceiling, and the steps that do not fit are left to the page.
  The whole recording has a deadline, and the file is read only when it is
  no larger than ``MAX_VIDEO_BYTES``.
* Playwright writes the file in a folder made for this recording; its path
  is resolved and checked to be in that folder before it is read, and the
  folder is removed after.

No Playwright, no browser or no video encoder is an answer
(`VideoUnavailable`, with what is missing), not an error.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

EXTENSION = ".webm"
VIDEO_SIZE = {"width": 1280, "height": 720}
MAX_SECONDS = 120
HOLD_MS = 1_500
MIN_STEP_MS = 250
MAX_STEP_MS = 1_500
DEADLINE_SECONDS = MAX_SECONDS + 60
LOAD_TIMEOUT_MS = 15_000
MAX_VIDEO_BYTES = 40 * 1024 * 1024

#: Chromium switches: no traffic of its own, and every request it would still
#: make sent to a proxy on a port nothing listens on, loopback included.
NETWORK_OFF = (
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--no-pings",
    "--proxy-server=127.0.0.1:9",
    "--proxy-bypass-list=<-loopback>",
)


class VideoUnavailable(RuntimeError):
    """This machine cannot record: ``no_playwright``, ``no_browser`` or ``no_encoder``."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class VideoError(RuntimeError):
    """The recording failed: ``timeout``, ``too_large`` or ``failed``."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def step_plan(steps: int) -> tuple[int, int]:
    """(steps played, milliseconds on each), so the video stays within ``MAX_SECONDS``."""
    if steps <= 0:
        return 0, 0
    budget = MAX_SECONDS * 1000 - 2 * HOLD_MS
    dwell = min(MAX_STEP_MS, max(MIN_STEP_MS, budget // steps))
    return min(steps, budget // dwell), dwell


def _is_root() -> bool:
    geteuid = getattr(os, "geteuid", None)
    return bool(geteuid and geteuid() == 0)


Starter = Callable[[], Awaitable[Any]]
Launcher = Callable[[str], Awaitable[tuple[Any, Any]]]


async def launch(executable: str, start: Starter | None = None) -> tuple[Any, Any]:
    """(playwright, browser) on ``executable`` (Playwright's own when empty)."""
    try:
        from playwright.async_api import Error as PlaywrightError
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise VideoUnavailable("no_playwright") from exc

    playwright = await (start or async_playwright().start)()
    options: dict[str, Any] = {"headless": True, "args": list(NETWORK_OFF)}
    if _is_root():
        options["args"].append("--no-sandbox")
    if executable:
        options["executable_path"] = executable
    try:
        browser = await playwright.chromium.launch(**options)
    except PlaywrightError as exc:
        await playwright.stop()
        raise VideoUnavailable("no_browser") from exc
    return playwright, browser


async def _refuse(route: Any) -> None:
    await route.abort()


async def _lanes(page: Any) -> list[Any]:
    """The timelines of the page: one, or the two columns of a comparison."""
    columns = page.locator("main.pair > section.side")
    count = await columns.count()
    if not count:
        return [page.locator("main > details")]
    return [columns.nth(i).locator(".steps > details") for i in range(count)]


async def _play(page: Any, html: str) -> tuple[int, int]:
    """Open the steps one after the other, in every timeline of the page at
    once; (steps played, steps of the longest timeline)."""
    await page.set_content(html, wait_until="load", timeout=LOAD_TIMEOUT_MS)
    lanes = [(lane, await lane.count()) for lane in await _lanes(page)]
    total = max(count for _lane, count in lanes)
    played, dwell = step_plan(total)
    await page.wait_for_timeout(HOLD_MS)
    for position in range(played):
        for steps, count in lanes:
            # A timeline that has run out keeps its last step open.
            if 0 < position < count:
                await steps.nth(position - 1).locator("summary").click()
            if position < count:
                summary = steps.nth(position).locator("summary")
                await summary.scroll_into_view_if_needed()
                await summary.click()
        await page.wait_for_timeout(dwell)
    await page.wait_for_timeout(HOLD_MS)
    return played, total


def read_video(folder: Path, written: str) -> bytes:
    """The video Playwright wrote, only from ``folder`` and only within the bound."""
    path = Path(written).resolve()
    if path.parent != folder.resolve() or path.suffix != EXTENSION:
        raise VideoError("failed")
    if not path.is_file():
        raise VideoError("failed")
    # One read, one more byte than the bound: never more than that in memory.
    with path.open("rb") as handle:
        data = handle.read(MAX_VIDEO_BYTES + 1)
    if len(data) > MAX_VIDEO_BYTES:
        raise VideoError("too_large")
    return data


async def _record(
    html: str, executable: str, launcher: Launcher
) -> tuple[bytes, int, int]:
    from playwright.async_api import Error as PlaywrightError

    playwright, browser = await launcher(executable)
    folder = Path(tempfile.mkdtemp(prefix="wp-replay-video-")).resolve()
    try:
        context = await browser.new_context(
            viewport=VIDEO_SIZE,
            java_script_enabled=False,
            offline=True,
            record_video_dir=str(folder),
            record_video_size=VIDEO_SIZE,
        )
        try:
            await context.route("**/*", _refuse)
            try:
                page = await context.new_page()
            except PlaywrightError as exc:
                if "ffmpeg" in str(exc).lower():
                    raise VideoUnavailable("no_encoder") from exc
                raise
            played, total = await _play(page, html)
        finally:
            await context.close()
        if page.video is None:
            raise VideoError("failed")
        return read_video(folder, await page.video.path()), played, total
    except PlaywrightError as exc:
        raise VideoError("failed") from exc
    finally:
        await browser.close()
        await playwright.stop()
        shutil.rmtree(folder, ignore_errors=True)


async def record_video(
    html: str, *, executable: str = "", launcher: Launcher = launch
) -> tuple[bytes, int, int]:
    """The WebM of ``html`` played step by step: (bytes, steps played, steps)."""
    try:
        return await asyncio.wait_for(
            _record(html, executable, launcher), DEADLINE_SECONDS
        )
    except TimeoutError as exc:
        raise VideoError("timeout") from exc
