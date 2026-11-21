"""A replay as a WebM video (#347): played step by step, offline, bounded.

The recording is driven through a stand-in Playwright that keeps every call,
so what is checked is how the context is opened (JavaScript off, offline,
every request aborted, the video in a folder made for it), the order the
steps are opened in, and how a missing piece is answered. One test records
for real when this machine has Chromium and Playwright's video encoder.
"""

from __future__ import annotations

import asyncio
import base64
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from foundation.platform.browser import chrome_executable
from playwright.async_api import Error as PlaywrightError
from replay import api as replay_api
from replay import recorder as recorder_module
from replay import video
from replay.models import ReplaySession, ReplayStep, ReplayStepType
from replay.viewer import render_viewer

WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 16


def _page(steps: int = 3) -> str:
    bundle = {
        "thinking": "none",
        "options": {},
        "session": {
            "agent_name": "coder",
            "steps": [
                {"step_index": i, "step_type": "tool_call", "label": f"Step {i}"}
                for i in range(steps)
            ],
        },
    }
    return render_viewer(bundle)


class FakeLocator:
    def __init__(self, page: FakePage, name: str) -> None:
        self.page = page
        self.name = name

    async def count(self) -> int:
        # A comparison page has columns, each with its own steps.
        columns = self.page.columns
        if self.name == "main.pair > section.side":
            return len(columns)
        for position, steps in enumerate(columns):
            if self.name == f"main.pair > section.side[{position}] .steps > details":
                return steps
        return self.page.steps

    def nth(self, position: int) -> FakeLocator:
        return FakeLocator(self.page, f"{self.name}[{position}]")

    def locator(self, selector: str) -> FakeLocator:
        return FakeLocator(self.page, f"{self.name} {selector}")

    async def scroll_into_view_if_needed(self) -> None:
        self.page.calls.append(("scroll", self.name))

    async def click(self) -> None:
        self.page.calls.append(("click", self.name))


class FakeVideo:
    def __init__(self, path: Path) -> None:
        self._path = path

    async def path(self) -> str:
        return str(self._path)


class FakePage:
    def __init__(self, context: FakeContext, steps: int) -> None:
        self.calls: list[tuple] = []
        self.steps = steps
        self.columns: list[int] = list(context.browser.columns)
        folder = Path(context.options["record_video_dir"])
        self.video: FakeVideo | None = FakeVideo(folder / "page@1.webm")
        self.context = context

    async def set_content(self, html: str, **options) -> None:
        self.calls.append(("content", html[:15], options["wait_until"]))

    def locator(self, selector: str) -> FakeLocator:
        return FakeLocator(self, selector)

    async def wait_for_timeout(self, ms: int) -> None:
        self.calls.append(("wait", ms))


class FakeRoute:
    def __init__(self) -> None:
        self.aborted = False

    async def abort(self) -> None:
        self.aborted = True


class FakeContext:
    def __init__(self, browser: FakeBrowser, options: dict) -> None:
        self.browser = browser
        self.options = options
        self.page: FakePage | None = None
        self.closed = False

    async def route(self, pattern: str, handler) -> None:
        self.browser.routes.append((pattern, handler))

    async def new_page(self) -> FakePage:
        if self.browser.page_error:
            raise PlaywrightError(self.browser.page_error)
        self.page = FakePage(self, self.browser.steps)
        if self.browser.no_video:
            self.page.video = None
        return self.page

    async def close(self) -> None:
        self.closed = True
        folder = Path(self.options["record_video_dir"])
        (folder / "page@1.webm").write_bytes(self.browser.content)


class FakeBrowser:
    def __init__(self, steps: int = 3, content: bytes = WEBM) -> None:
        self.steps = steps
        self.content = content
        self.page_error = ""
        self.no_video = False
        self.columns: list[int] = []
        self.routes: list = []
        self.contexts: list[FakeContext] = []
        self.closed = False

    async def new_context(self, **options) -> FakeContext:
        context = FakeContext(self, options)
        self.contexts.append(context)
        return context

    async def close(self) -> None:
        self.closed = True


class FakeChromium:
    def __init__(self, error: str = "") -> None:
        self.error = error
        self.options: dict = {}

    async def launch(self, **options) -> FakeBrowser:
        self.options = options
        if self.error:
            raise PlaywrightError(self.error)
        return FakeBrowser()


class FakePlaywright:
    def __init__(self, error: str = "") -> None:
        self.chromium = FakeChromium(error)
        self.stopped = False

    async def stop(self) -> None:
        self.stopped = True


def _launcher(browser: FakeBrowser, playwright: FakePlaywright | None = None):
    playwright = playwright or FakePlaywright()
    seen: list[str] = []

    async def launcher(executable: str):
        seen.append(executable)
        return playwright, browser

    launcher.seen = seen  # type: ignore[attr-defined]
    launcher.playwright = playwright  # type: ignore[attr-defined]
    return launcher


def _record(browser: FakeBrowser, **kwargs):
    return asyncio.run(
        video.record_video(_page(), launcher=_launcher(browser), **kwargs)
    )


class TestStepPlan:
    def test_no_step_plays_nothing(self):
        assert video.step_plan(0) == (0, 0)

    def test_a_short_session_gets_the_longest_dwell(self):
        assert video.step_plan(4) == (4, video.MAX_STEP_MS)

    def test_a_long_session_is_cut_to_the_length_bound(self):
        played, dwell = video.step_plan(10_000)
        assert dwell == video.MIN_STEP_MS
        budget = video.MAX_SECONDS * 1000 - 2 * video.HOLD_MS
        assert played == budget // video.MIN_STEP_MS < 10_000
        assert played * dwell + 2 * video.HOLD_MS <= video.MAX_SECONDS * 1000


class TestRecord:
    def test_the_page_is_played_offline_without_javascript(self):
        browser = FakeBrowser(steps=3)
        launcher = _launcher(browser)
        content, played, total = asyncio.run(
            video.record_video(_page(), executable="/bin/chrome", launcher=launcher)
        )
        assert (content, played, total) == (WEBM, 3, 3)
        assert launcher.seen == ["/bin/chrome"]
        context = browser.contexts[0]
        options = context.options
        assert options["java_script_enabled"] is False
        assert options["offline"] is True
        assert options["record_video_size"] == video.VIDEO_SIZE
        # Every request is aborted, whatever its URL.
        pattern, handler = browser.routes[0]
        route = FakeRoute()
        asyncio.run(handler(route))
        assert pattern == "**/*" and route.aborted
        # The folder made for the video is gone, and everything is closed.
        assert not Path(options["record_video_dir"]).exists()
        assert context.closed and browser.closed and launcher.playwright.stopped

    def test_each_step_opens_after_the_previous_one_closes(self):
        browser = FakeBrowser(steps=2)
        _record(browser)
        page = browser.contexts[0].page
        assert page is not None
        steps = "main > details"
        assert page.calls == [
            ("content", "<!doctype html>", "load"),
            ("wait", video.HOLD_MS),
            ("scroll", f"{steps}[0] summary"),
            ("click", f"{steps}[0] summary"),
            ("wait", video.MAX_STEP_MS),
            ("click", f"{steps}[0] summary"),
            ("scroll", f"{steps}[1] summary"),
            ("click", f"{steps}[1] summary"),
            ("wait", video.MAX_STEP_MS),
            ("wait", video.HOLD_MS),
        ]

    def test_no_video_encoder_is_an_answer(self):
        browser = FakeBrowser()
        browser.page_error = "Video rendering requires ffmpeg binary"
        with pytest.raises(video.VideoUnavailable) as refusal:
            _record(browser)
        assert refusal.value.code == "no_encoder"
        assert browser.closed

    def test_another_browser_failure_is_a_failed_recording(self):
        browser = FakeBrowser()
        browser.page_error = "Target closed"
        with pytest.raises(video.VideoError) as error:
            _record(browser)
        assert error.value.code == "failed"

    def test_a_page_without_a_video_is_a_failed_recording(self):
        browser = FakeBrowser()
        browser.no_video = True
        with pytest.raises(video.VideoError, match="failed"):
            _record(browser)

    def test_a_video_over_the_bound_is_refused(self, monkeypatch):
        monkeypatch.setattr(video, "MAX_VIDEO_BYTES", len(WEBM) - 1)
        with pytest.raises(video.VideoError, match="too_large"):
            _record(FakeBrowser())

    def test_a_recording_past_its_deadline_stops(self, monkeypatch):
        monkeypatch.setattr(video, "DEADLINE_SECONDS", 0.01)

        async def slow(executable: str):
            await asyncio.sleep(1)

        with pytest.raises(video.VideoError, match="timeout"):
            asyncio.run(video.record_video(_page(), launcher=slow))


class TestReadVideo:
    def test_only_a_webm_of_the_folder_is_read(self, tmp_path):
        folder = tmp_path / "videos"
        folder.mkdir()
        (folder / "a.webm").write_bytes(WEBM)
        assert video.read_video(folder, str(folder / "a.webm")) == WEBM
        outside = tmp_path / "b.webm"
        outside.write_bytes(WEBM)
        (folder / "c.txt").write_bytes(WEBM)
        escape = folder / "link.webm"
        escape.symlink_to(outside)
        for written in (outside, folder / "c.txt", escape, folder / "missing.webm"):
            with pytest.raises(video.VideoError, match="failed"):
                video.read_video(folder, str(written))
        assert video.read_video(folder, str(folder / ".." / "videos" / "a.webm"))


class TestLaunch:
    def test_the_browser_starts_with_its_network_cut(self, monkeypatch):
        playwright = FakePlaywright()
        monkeypatch.setattr(video, "_is_root", lambda: False)

        async def start():
            return playwright

        got, browser = asyncio.run(video.launch("/bin/chrome", start))
        assert got is playwright and isinstance(browser, FakeBrowser)
        options = playwright.chromium.options
        assert options["headless"] is True
        assert options["executable_path"] == "/bin/chrome"
        assert options["args"] == list(video.NETWORK_OFF)
        assert "--proxy-bypass-list=<-loopback>" in options["args"]

    def test_as_root_the_sandbox_is_off_and_playwright_picks_its_browser(
        self, monkeypatch
    ):
        playwright = FakePlaywright()
        monkeypatch.setattr(video, "_is_root", lambda: True)

        async def start():
            return playwright

        asyncio.run(video.launch("", start))
        options = playwright.chromium.options
        assert "executable_path" not in options
        assert options["args"][-1] == "--no-sandbox"

    def test_no_browser_is_an_answer(self):
        playwright = FakePlaywright(error="Executable doesn't exist")

        async def start():
            return playwright

        with pytest.raises(video.VideoUnavailable) as refusal:
            asyncio.run(video.launch("", start))
        assert refusal.value.code == "no_browser"
        assert playwright.stopped

    def test_no_playwright_is_an_answer(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "playwright.async_api", None)
        with pytest.raises(video.VideoUnavailable) as refusal:
            asyncio.run(video.launch(""))
        assert refusal.value.code == "no_playwright"

    def test_root_is_read_from_the_process(self, monkeypatch):
        monkeypatch.setattr(video.os, "geteuid", lambda: 0, raising=False)
        assert video._is_root()
        monkeypatch.setattr(video.os, "geteuid", lambda: 1000, raising=False)
        assert not video._is_root()


def test_a_real_recording_or_the_name_of_what_is_missing():
    """On this machine's real Playwright: a WebM, or which piece is missing."""
    try:
        content, played, total = asyncio.run(
            video.record_video(_page(2), executable=chrome_executable())
        )
    except video.VideoUnavailable as refusal:
        assert refusal.code in {"no_playwright", "no_browser", "no_encoder"}
        return
    assert content[:4] == b"\x1a\x45\xdf\xa3"
    assert (played, total) == (2, 2)


# -- the route ---------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    store = recorder_module.ReplayRecorder(storage_dir=tmp_path / "replays")
    monkeypatch.setattr(recorder_module, "_replay_recorder", store)
    store.save_session(
        ReplaySession(
            session_id="local-1",
            agent_name="Coder Bot",
            start_time=1_700_000_000.0,
            end_time=1_700_000_100.0,
            status="completed",
            steps=[
                ReplayStep(step_index=0, step_type=ReplayStepType.TOOL_CALL),
                ReplayStep(
                    step_index=1,
                    step_type=ReplayStepType.AGENT_THINKING,
                    reasoning="private",
                ),
            ],
        )
    )
    app = FastAPI()
    app.include_router(replay_api.router)
    return TestClient(app)


class TestRoute:
    def test_the_masked_page_is_recorded_as_asked(self, client, monkeypatch):
        seen: dict = {}

        async def record(html: str, *, executable: str = ""):
            seen["html"] = html
            return WEBM, 1, 1

        monkeypatch.setattr(replay_api.video_module, "record_video", record)
        answer = client.post(
            "/replay/sessions/local-1/video",
            json={"strip_reasoning": True, "language": "fr"},
        ).json()
        assert answer["available"] is True
        assert answer["file_name"].endswith(".webm")
        assert base64.b64decode(answer["content_base64"]) == WEBM
        assert (answer["steps_played"], answer["steps_total"]) == (1, 1)
        assert '<html lang="fr">' in seen["html"]
        assert "private" not in seen["html"]

    def test_a_missing_browser_is_an_answer_not_an_error(self, client, monkeypatch):
        async def record(html: str, *, executable: str = ""):
            raise video.VideoUnavailable("no_browser")

        monkeypatch.setattr(replay_api.video_module, "record_video", record)
        answer = client.post("/replay/sessions/local-1/video", json={})
        assert answer.status_code == 200
        assert answer.json() == {
            "success": True,
            "available": False,
            "refusal": "no_browser",
        }

    def test_failures_and_refusals(self, client, monkeypatch):
        async def record(html: str, *, executable: str = ""):
            raise video.VideoError("timeout")

        monkeypatch.setattr(replay_api.video_module, "record_video", record)
        failed = client.post("/replay/sessions/local-1/video", json={})
        assert (failed.status_code, failed.json()["detail"]) == (422, "video_timeout")
        missing = client.post("/replay/sessions/missing/video", json={})
        assert missing.status_code == 404
        bad = client.post("/replay/sessions/local-1/video", json={"language": "de"})
        assert bad.status_code == 422

    def test_one_recording_at_a_time(self, client, monkeypatch):
        class Busy:
            def locked(self) -> bool:
                return True

        monkeypatch.setattr(replay_api, "_VIDEO_LOCK", Busy())
        busy = client.post("/replay/sessions/local-1/video", json={})
        assert (busy.status_code, busy.json()["detail"]) == (409, "video_busy")
