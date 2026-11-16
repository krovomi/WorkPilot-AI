"""The headless capture: files confined, JavaScript off, offline, a browser at a time."""

from __future__ import annotations

import asyncio
import sys
import types
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import url2pathname

import pytest
from design_to_code import render as render_module
from design_to_code.render import (
    Renderer,
    RenderError,
    font_families,
    inside,
    safe_relative,
    viewport_for,
    write_files,
)
from playwright.async_api import Error as PlaywrightError


class FakeRoute:
    def __init__(self, url: str) -> None:
        self.request = types.SimpleNamespace(url=url)
        self.outcome = ""

    async def continue_(self) -> None:
        self.outcome = "continue"

    async def abort(self) -> None:
        self.outcome = "abort"


class FakePage:
    def __init__(self, world: dict) -> None:
        self.world = world

    async def goto(self, url: str, **options) -> None:
        self.world["goto"] = (url, options)
        if self.world.get("goto_error"):
            raise PlaywrightError("net::ERR_FAILED\nmore")
        # url2pathname turns file:///C:/x into C:\x on Windows, /x elsewhere.
        root = Path(url2pathname(urlsplit(url).path)).parent
        for url_seen in (
            url,
            (root / "s.css").as_uri(),
            "https://example.com/x.css",
            "file:///etc/passwd",
        ):
            route = FakeRoute(url_seen)
            await self.world["guard"](route)
            self.world.setdefault("routes", []).append((url_seen, route.outcome))

    async def evaluate(self, script: str, fonts: list[str]) -> list[str]:
        return [f for f in fonts if f == "NoSuchFont"]

    async def screenshot(self, **options) -> bytes:
        return b"png"


class FakeContext:
    def __init__(self, world: dict) -> None:
        self.world = world

    async def route(self, pattern: str, handler) -> None:
        self.world["guard"] = handler

    async def new_page(self) -> FakePage:
        return FakePage(self.world)

    async def close(self) -> None:
        self.world["context_closed"] = True


class FakeBrowser:
    def __init__(self, world: dict) -> None:
        self.world = world

    async def new_context(self, **options) -> FakeContext:
        self.world["context"] = options
        return FakeContext(self.world)

    async def close(self) -> None:
        self.world["browser_closed"] = True


class FakePlaywright:
    def __init__(self, world: dict) -> None:
        self.world = world
        self.chromium = self

    async def launch(self, **options):
        self.world["launch"] = options
        if self.world.get("launch_error"):
            raise PlaywrightError("Executable doesn't exist\nat /x")
        return FakeBrowser(self.world)

    async def start(self):
        return self

    async def stop(self) -> None:
        self.world["stopped"] = True


def _launcher(world: dict):
    async def launch(executable):
        world["executable"] = executable
        return FakePlaywright(world), FakeBrowser(world)

    return launch


def test_a_capture_is_offline_without_javascript_and_confined_to_its_files() -> None:
    world: dict = {}

    async def scenario():
        async with Renderer(
            400, 300, executable="/opt/chrome", launcher=_launcher(world)
        ) as renderer:
            png = await renderer.capture(
                {"index.html": "<p>x</p>", "s.css": "p{}", "../escape.html": "x"},
                "index.html",
                ["Inter", "NoSuchFont"],
            )
            again = await renderer.capture({"index.html": "<p>y</p>"}, "index.html")
            assert again == b"png" and renderer.missing_fonts == ["NoSuchFont"]
            folder = renderer._dir
            assert folder is not None and not (folder.parent / "escape.html").exists()
            return png, renderer.missing_fonts, folder

    png, missing, folder = asyncio.run(scenario())
    assert png == b"png" and missing == ["NoSuchFont"]
    assert world["executable"] == "/opt/chrome"
    assert world["context"] == {
        "viewport": {"width": 400, "height": 300},
        "device_scale_factor": 1,
        "java_script_enabled": False,
        "offline": True,
    }
    outcomes = [outcome for _, outcome in world["routes"]]
    assert outcomes == ["continue", "continue", "abort", "abort"] * 2
    assert world["context_closed"] and world["browser_closed"] and world["stopped"]
    assert not folder.exists()


def test_a_page_that_does_not_load_is_a_render_error() -> None:
    world: dict = {"goto_error": True}

    async def scenario():
        async with Renderer(400, 300, launcher=_launcher(world)) as renderer:
            await renderer.capture({"index.html": "x"}, "index.html")

    with pytest.raises(RenderError) as error:
        asyncio.run(scenario())
    assert error.value.code == "load_failed" and "ERR_FAILED" in str(error.value)
    assert world["context_closed"]


@pytest.mark.parametrize("page", ["missing.html", "../index.html"])
def test_a_page_that_is_not_among_the_files_is_refused(page) -> None:
    async def scenario():
        async with Renderer(400, 300, launcher=_launcher({})) as renderer:
            await renderer.capture({"index.html": "x"}, page)

    with pytest.raises(RenderError, match="no page to render"):
        asyncio.run(scenario())


def test_capture_before_start_is_refused_and_closing_unstarted_is_harmless() -> None:
    renderer = Renderer(10, 10)
    with pytest.raises(RenderError, match="renderer not started"):
        asyncio.run(renderer.capture({}, "index.html"))
    asyncio.run(renderer.__aexit__(None, None, None))


def test_retina_targets_render_at_half_size_twice_as_dense() -> None:
    assert viewport_for(2880, 1800) == (1440, 900, 2)
    assert viewport_for(1280, 20000) == (1280, 8000, 1)


@pytest.mark.parametrize(
    ("path", "safe"),
    [
        ("src/a.html", "src/a.html"),
        ("./src//b.css", "src/b.css"),
        ("src\\c.css", "src/c.css"),
        ("", None),
        (".", None),
        ("/etc/passwd", None),
        ("C:/x.html", None),
        ("a/../../b", None),
        ("a\x00b", None),
    ],
)
def test_only_relative_paths_inside_the_folder_are_written(path, safe) -> None:
    assert safe_relative(path) == safe


def test_write_files_skips_paths_that_leave_the_folder(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    write_files(root, {"a/b.html": "ok", "../x": "no"})
    assert (root / "a" / "b.html").read_text(encoding="utf-8") == "ok"
    assert not (tmp_path / "x").exists()


def test_write_files_does_not_follow_a_link_out_of_the_folder(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    (tmp_path / "outside").mkdir()
    try:
        (root / "link").symlink_to(tmp_path / "outside", target_is_directory=True)
    except OSError:
        pytest.skip("symbolic links are not available here")
    write_files(root, {"link/y": "no"})
    assert not (tmp_path / "outside" / "y").exists()


def test_only_file_urls_inside_the_root_are_allowed(tmp_path: Path) -> None:
    assert inside(tmp_path.as_uri(), tmp_path)
    assert inside((tmp_path / "a b.css").as_uri(), tmp_path)
    assert not inside("file:///etc/passwd", tmp_path)
    assert not inside("file://server/share/x", tmp_path)
    assert not inside("file:///C:/x.css", tmp_path)
    assert not inside("https://example.com", tmp_path)


def test_font_families_leave_out_generics_and_duplicates() -> None:
    typography = {
        "heading": {"fontFamily": "'Inter', system-ui, sans-serif"},
        "body": {"fontFamily": 'Inter, "Roboto Slab"'},
        "small": "not a dict",
    }
    assert font_families(typography) == ["Inter", "Roboto Slab"]
    assert font_families(None) == []


def _fake_playwright_module(monkeypatch, world: dict) -> None:
    module = types.ModuleType("playwright.async_api")
    module.Error = PlaywrightError  # type: ignore[attr-defined]
    module.async_playwright = lambda: FakePlaywright(world)  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "playwright.async_api", module)


def test_the_browser_is_the_verifications_and_runs_without_sandbox_as_root(
    monkeypatch,
) -> None:
    world: dict = {}
    _fake_playwright_module(monkeypatch, world)
    monkeypatch.setattr(render_module, "_is_root", lambda: True)
    playwright, browser = asyncio.run(render_module._launch("/opt/chrome"))
    assert world["launch"] == {
        "headless": True,
        "executable_path": "/opt/chrome",
        "args": ["--no-sandbox"],
    }
    assert isinstance(browser, FakeBrowser)


def test_without_a_browser_the_launch_says_so(monkeypatch) -> None:
    world: dict = {"launch_error": True}
    _fake_playwright_module(monkeypatch, world)
    monkeypatch.setattr(render_module, "_is_root", lambda: False)
    with pytest.raises(RenderError) as error:
        asyncio.run(render_module._launch())
    assert error.value.code == "no_browser"
    assert world["launch"] == {"headless": True} and world["stopped"]


def test_without_playwright_the_launch_says_so(monkeypatch) -> None:
    monkeypatch.setitem(sys.modules, "playwright.async_api", None)
    with pytest.raises(RenderError) as error:
        asyncio.run(render_module._launch())
    assert error.value.code == "no_playwright"


def test_root_is_read_from_the_effective_user(monkeypatch) -> None:
    monkeypatch.setattr(render_module.os, "geteuid", lambda: 0, raising=False)
    assert render_module._is_root() is True
    monkeypatch.delattr(render_module.os, "geteuid", raising=False)
    assert render_module._is_root() is False
