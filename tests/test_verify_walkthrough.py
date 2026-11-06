"""The scenario's walkthrough (F5): a video in the app, a GIF for the PR.

Each test pins a rule of ``verify/walkthrough.py``:

* in ``launch`` mode a card's scenario is filmed (``record_video_dir``); over
  CDP it is not, and the record says why rather than show an empty video;
* a video over its ceiling is dropped, the trace and the captures stay;
* the GIF is made of the captures reported with the steps, in step order, and
  only of this verification's own captures; over its ceiling it keeps the first
  and the last frame;
* the API says whether there is a video or a GIF, never where, and serves only
  the file the record names, inside the spec, with its own name.
"""

from __future__ import annotations

import asyncio
import json
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from verify import walkthrough  # noqa: E402
from verify.devtools import BrowserSession, chrome_executable  # noqa: E402
from verify.loop import _walkthrough  # noqa: E402
from verify.record import new_record, save_record  # noqa: E402
from verify.walkthrough import (  # noqa: E402
    VIDEO_FILE,
    WALKTHROUGH_FILE,
    build_walkthrough,
    clear_walkthrough,
    finish_video,
    step_captures,
)

PIL = pytest.importorskip("PIL.Image")


# -- the browser session -------------------------------------------------------


class _FakeVideo:
    def __init__(self, size: int = 64):
        self.size = size
        self.deleted = False

    async def save_as(self, path: str) -> None:
        data = b"\x1a\x45\xdf\xa3" + b"0" * self.size if self.size >= 0 else b""
        Path(path).write_bytes(data)

    async def delete(self) -> None:
        self.deleted = True


class _FakePage:
    def __init__(self, video=None):
        self.video = video
        self.closed = False

    def on(self, *_args) -> None:
        pass

    async def close(self) -> None:
        self.closed = True


class _FakeContext:
    def __init__(self, kwargs: dict, no_ffmpeg: bool = False):
        self.kwargs = kwargs
        self.no_ffmpeg = no_ffmpeg
        self.pages: list[_FakePage] = []
        self.closed = False

    async def new_page(self) -> _FakePage:
        filming = "record_video_dir" in self.kwargs
        if filming and self.no_ffmpeg:
            raise RuntimeError(
                "BrowserContext.new_page: Executable doesn't exist at /pw/ffmpeg\n╔══╗"
            )
        page = _FakePage(_FakeVideo() if filming else None)
        self.pages.append(page)
        return page

    async def close(self) -> None:
        self.closed = True


class _FakeBrowser:
    def __init__(self, existing: _FakeContext | None = None, no_ffmpeg=False):
        self.contexts = [existing] if existing else []
        self.made: list[_FakeContext] = []
        self.no_ffmpeg = no_ffmpeg

    async def new_context(self, **kwargs) -> _FakeContext:
        context = _FakeContext(kwargs, self.no_ffmpeg)
        self.made.append(context)
        return context

    async def close(self) -> None:
        pass


class _FakePlaywright:
    def __init__(self, browser: _FakeBrowser):
        self.browser = browser
        self.chromium = types.SimpleNamespace(
            launch=self._launch, connect_over_cdp=self._connect
        )

    async def _launch(self, **_kwargs):
        return self.browser

    async def _connect(self, _url):
        return self.browser

    async def stop(self) -> None:
        pass


@pytest.fixture
def fake_playwright(monkeypatch):
    pytest.importorskip("playwright.async_api")
    import playwright.async_api as api

    def install(browser: _FakeBrowser):
        playwright = _FakePlaywright(browser)

        class _Starter:
            async def start(self):
                return playwright

        monkeypatch.setattr(api, "async_playwright", lambda: _Starter())
        return playwright

    return install


def test_a_scenario_in_launch_mode_is_filmed(fake_playwright, tmp_path):
    browser = _FakeBrowser()
    fake_playwright(browser)

    async def run():
        session = BrowserSession(tmp_path, prefer="playwright", record_video=True)
        await session.start()
        first = session._page
        saved = await session.save_video(keep=True)
        # The evidence after the scenario gets a fresh page of the same context.
        assert session._page is not None and session._page is not first
        await session.close()
        return first, saved

    first, saved = asyncio.run(run())
    kwargs = browser.made[0].kwargs
    assert kwargs["record_video_dir"].startswith(str(tmp_path))
    assert kwargs["record_video_size"] == walkthrough.VIDEO_SIZE
    assert first.closed and saved == tmp_path / VIDEO_FILE and saved.is_file()


def test_without_ffmpeg_the_session_runs_without_a_video(fake_playwright, tmp_path):
    browser = _FakeBrowser(no_ffmpeg=True)
    fake_playwright(browser)

    async def run():
        session = BrowserSession(tmp_path, prefer="playwright", record_video=True)
        await session.start()
        saved = await session.save_video()
        await session.close()
        return session, saved

    session, saved = asyncio.run(run())
    assert session.engine == "playwright" and saved is None
    filming, plain = browser.made
    assert filming.closed and "record_video_dir" not in plain.kwargs
    assert session.video_note.startswith("no video: BrowserContext.new_page")
    assert "╔" not in session.video_note  # one line, not Playwright's banner


def test_no_scenario_no_video(fake_playwright, tmp_path):
    browser = _FakeBrowser()
    fake_playwright(browser)

    async def run():
        session = BrowserSession(tmp_path, prefer="playwright")
        await session.start()
        saved = await session.save_video()
        await session.close()
        return saved

    assert asyncio.run(run()) is None
    assert "record_video_dir" not in browser.made[0].kwargs


def test_over_cdp_there_is_no_video_and_the_record_says_why(fake_playwright, tmp_path):
    existing = _FakeContext({})
    browser = _FakeBrowser(existing)
    fake_playwright(browser)

    async def run():
        session = BrowserSession(
            tmp_path,
            prefer="playwright",
            browser_url="http://127.0.0.1:9222",
            record_video=True,
        )
        await session.start()
        saved = await session.save_video()
        await session.close()
        return session, saved

    session, saved = asyncio.run(run())
    assert saved is None and not browser.made  # the app's own context, reused
    assert "CDP" in session.video_note
    record = new_record(scenario_requested=["Open the app"])
    _walkthrough(record, tmp_path, session)
    assert "video" not in record and "CDP" in record["video_note"]


def test_a_video_over_its_ceiling_is_dropped(monkeypatch, tmp_path):
    monkeypatch.setattr(walkthrough, "VIDEO_MAX_BYTES", 10)
    page = _FakePage(_FakeVideo(size=100))
    saved, why = asyncio.run(finish_video(page, tmp_path, keep=True))
    assert saved is None and "dropped" in why
    assert not (tmp_path / VIDEO_FILE).exists()


def test_an_empty_video_is_not_kept(tmp_path):
    saved, why = asyncio.run(
        finish_video(_FakePage(_FakeVideo(size=-4)), tmp_path, keep=True)
    )
    assert saved is None and "empty" in why


def test_a_video_not_kept_is_deleted_not_written(tmp_path):
    video = _FakeVideo()
    saved, why = asyncio.run(finish_video(_FakePage(video), tmp_path, keep=False))
    assert saved is None and why == "" and video.deleted
    assert not (tmp_path / VIDEO_FILE).exists()


def test_a_real_scenario_page_is_filmed(tmp_path):
    """Playwright and Chromium for real: a WebM lands next to the trace."""
    if not chrome_executable():
        pytest.skip("no Chromium on this machine")

    async def run():
        async with BrowserSession(
            tmp_path, prefer="playwright", record_video=True
        ) as browser:
            if browser.engine != "playwright":
                pytest.skip(f"playwright unavailable: {'; '.join(browser.reasons)}")
            if browser.video_note:
                pytest.skip(f"no video on this machine: {browser.video_note}")
            await browser.navigate("data:text/html,<h1>Orders</h1>")
            await asyncio.sleep(0.5)
            saved = await browser.save_video(keep=True)
            if saved is None:
                pytest.skip(f"no video on this machine: {browser.video_note}")
            # The page after the video still answers.
            await browser.navigate("data:text/html,<h1>After</h1>")
            return saved

    saved = asyncio.run(run())
    assert saved == tmp_path / VIDEO_FILE
    assert saved.read_bytes()[:4] == b"\x1a\x45\xdf\xa3"  # EBML: a WebM
    assert not (tmp_path / ".scenario-video").exists() or not any(
        (tmp_path / ".scenario-video").iterdir()
    )


# -- the GIF -------------------------------------------------------------------


def _png(path: Path, color: tuple[int, int, int], size=(1600, 1000)) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    PIL.new("RGB", size, color).save(path)
    return path


def _steps(base: Path, *steps: tuple[int, Path | None]) -> dict:
    record = new_record(scenario_requested=["a", "b", "c"])
    record["scenario_steps"] = [
        {"step": n, "outcome": "pass", **({"screenshot": str(p)} if p else {})}
        for n, p in steps
    ]
    return record


def test_the_gif_follows_the_steps_with_this_verifications_captures(tmp_path):
    shots = tmp_path / "screenshots"
    one = _png(shots / "one.png", (255, 0, 0))
    two = _png(shots / "two.png", (0, 255, 0))
    two_again = _png(shots / "two-again.png", (0, 0, 255))
    outside = _png(tmp_path.parent / f"{tmp_path.name}-secret.png", (9, 9, 9))
    record = _steps(
        tmp_path, (2, two), (1, one), (3, outside), (2, two_again), (3, None)
    )
    # Step order, the last report of a step winning, nothing from elsewhere.
    assert step_captures(record, tmp_path) == [one.resolve(), two_again.resolve()]

    gif = build_walkthrough(record, tmp_path)
    assert gif == tmp_path / WALKTHROUGH_FILE
    with PIL.open(gif) as image:
        assert image.format == "GIF" and image.n_frames == 2
        assert image.width == 960  # scaled down for a PR comment


def test_a_heavy_gif_keeps_the_first_and_last_frames(monkeypatch, tmp_path):
    shots = tmp_path / "screenshots"
    paths = [_png(shots / f"s{i}.png", (i * 60, 0, 0)) for i in range(4)]
    record = _steps(tmp_path, *((i + 1, p) for i, p in enumerate(paths)))
    full = build_walkthrough(record, tmp_path)
    size = full.stat().st_size
    monkeypatch.setattr(walkthrough, "GIF_MAX_BYTES", size - 1)
    gif = build_walkthrough(record, tmp_path)
    with PIL.open(gif) as image:
        assert image.n_frames == 2
    monkeypatch.setattr(walkthrough, "GIF_MAX_BYTES", 10)
    assert build_walkthrough(record, tmp_path) is None
    assert not (tmp_path / WALKTHROUGH_FILE).exists()


def test_no_capture_no_gif_and_a_new_run_clears_the_last_one(tmp_path):
    (tmp_path / WALKTHROUGH_FILE).write_bytes(b"GIF89a")
    (tmp_path / VIDEO_FILE).write_bytes(b"webm")
    assert build_walkthrough(_steps(tmp_path, (1, None)), tmp_path) is None
    assert not (tmp_path / WALKTHROUGH_FILE).exists()
    clear_walkthrough(tmp_path)
    assert not (tmp_path / VIDEO_FILE).exists()


def test_the_loop_names_the_video_and_the_gif(tmp_path):
    one = _png(tmp_path / "screenshots" / "one.png", (1, 2, 3))
    (tmp_path / VIDEO_FILE).write_bytes(b"webm")
    record = _steps(tmp_path, (1, one))
    _walkthrough(record, tmp_path, None)
    assert record["video"] == str(tmp_path / VIDEO_FILE)
    assert record["walkthrough"] == str(tmp_path / WALKTHROUGH_FILE)
    # A card without a scenario has neither.
    plain = new_record()
    _walkthrough(plain, tmp_path, None)
    assert "video" not in plain and "walkthrough" not in plain


# -- the API -------------------------------------------------------------------


def _client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from verify.api import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_the_api_serves_the_named_gif_and_video_without_their_paths(tmp_path):
    base = tmp_path / ".workpilot" / "specs" / "001-x" / "verify"
    base.mkdir(parents=True)
    (base / WALKTHROUGH_FILE).write_bytes(b"GIF89a....")
    (base / VIDEO_FILE).write_bytes(b"\x1a\x45\xdf\xa3....")
    record = new_record(
        status="pass",
        finished_at=1.0,
        walkthrough=str(base / WALKTHROUGH_FILE),
        video=str(base / VIDEO_FILE),
    )
    save_record(base, record)
    client = _client()
    params = {"project_dir": str(tmp_path), "spec_id": "001-x"}
    body = client.get("/api/verify/", params=params).json()["record"]
    assert body["walkthrough"] is True and body["video"] is True
    assert str(tmp_path) not in json.dumps(body)
    gif = client.get("/api/verify/walkthrough", params=params)
    assert gif.status_code == 200 and gif.headers["content-type"] == "image/gif"
    video = client.get("/api/verify/video", params=params)
    assert video.status_code == 200 and video.headers["content-type"] == "video/webm"


def test_the_api_refuses_a_file_outside_the_spec_or_of_another_name(tmp_path):
    spec = tmp_path / ".workpilot" / "specs" / "001-x"
    other = spec / "verify" / "notes.gif"
    other.parent.mkdir(parents=True)
    other.write_bytes(b"GIF89a")
    outside = tmp_path / WALKTHROUGH_FILE
    outside.write_bytes(b"GIF89a")
    client = _client()
    params = {"project_dir": str(tmp_path), "spec_id": "001-x"}
    for path in (outside, other, None):
        save_record(
            spec / "verify",
            new_record(
                status="pass", walkthrough=path and str(path), video=path and str(path)
            ),
        )
        assert client.get("/api/verify/walkthrough", params=params).status_code == 404
        assert client.get("/api/verify/video", params=params).status_code == 404
