"""`BrowserSession` around its two engines: how it starts, falls back, speaks.

`tests/test_verify_browser.py` drives a real page through each engine. Here:

* the Chrome DevTools MCP half is played by a stand-in `MCPToolManager`
  that records each call, so what is checked is which tool of
  chrome-devtools-mcp each action reaches, with which arguments, and how a
  server that will not start or a call that hangs is answered;
* the Playwright half runs for real on a local page when Chromium is
  installed (skipped otherwise), on the answers a real page gives to a wrong
  uid, a dead URL or a bad script;
* the server entry and the Chrome binary are resolved on real files.
"""

from __future__ import annotations

import asyncio
import functools
import glob
import http.server
import json
import os
import socketserver
import threading
from pathlib import Path

import core.mcp_tools as mcp_tools_module
import pytest
import verify.devtools as devtools_module
from foundation.platform import is_windows
from verify.devtools import BrowserSession, chrome_executable, devtools_server_config

# -- the Chrome binary and the server entry --------------------------------


def _on_path(directory: Path, name: str) -> Path:
    """A program `shutil.which` finds: Windows only runs a known extension."""
    return _executable(directory / (f"{name}.cmd" if is_windows() else name))


def _executable(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")
    path.chmod(0o755)
    return path


@pytest.fixture
def no_chrome(tmp_path, monkeypatch):
    """A machine where no Chrome is installed anywhere it is looked for."""
    for name in ("CHROME_PATH", "PLAYWRIGHT_BROWSERS_PATH"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("PATH", str(tmp_path / "empty-bin"))
    monkeypatch.setattr(devtools_module.Path, "home", lambda: tmp_path / "home")
    real_glob = glob.glob
    monkeypatch.setattr(
        glob,
        "glob",
        lambda pattern: [] if pattern.startswith("/opt/") else real_glob(pattern),
    )
    return tmp_path


def test_chrome_is_looked_for_in_order(no_chrome, monkeypatch):
    tmp = no_chrome
    assert chrome_executable() == ""

    on_path = _on_path(tmp / "bin", "chromium")
    monkeypatch.setenv("PATH", str(on_path.parent))
    assert Path(chrome_executable()).stem == "chromium"

    cached = _executable(
        tmp
        / "home"
        / ".cache"
        / "ms-playwright"
        / "chromium-1200"
        / "chrome-linux"
        / "chrome"
    )
    assert chrome_executable() == str(cached)

    browsers = tmp / "pw"
    old = _executable(browsers / "chromium-1100" / "chrome-linux64" / "chrome")
    new = _executable(browsers / "chromium-1200" / "chrome-linux64" / "chrome")
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(browsers))
    assert chrome_executable() == str(new) != str(old)

    named = _executable(tmp / "chrome-env")
    monkeypatch.setenv("CHROME_PATH", str(named))
    assert chrome_executable() == str(named)
    explicit = _executable(tmp / "chrome-settings")
    assert chrome_executable(str(explicit)) == str(explicit)
    # A setting that names nothing is ignored, not believed.
    assert chrome_executable(str(tmp / "missing")) == str(named)


def test_no_npx_means_no_devtools_server(no_chrome):
    assert devtools_server_config() is None


def test_the_devtools_server_entry(no_chrome, monkeypatch):
    npx = _on_path(no_chrome / "bin", "npx")
    monkeypatch.setenv("PATH", str(npx.parent))
    monkeypatch.setattr(devtools_module, "_is_root", lambda: False)

    entry = devtools_server_config()
    assert os.path.normcase(entry["command"]) == os.path.normcase(str(npx))
    assert entry["args"][:2] == ["-y", "chrome-devtools-mcp@latest"]
    assert "--isolated" in entry["args"] and "--headless" in entry["args"]
    assert "--executablePath" not in entry["args"]

    chrome = _executable(no_chrome / "chrome")
    monkeypatch.setattr(devtools_module, "_is_root", lambda: True)
    shown = devtools_server_config(chrome_path=str(chrome), headless=False)
    assert "--headless" not in shown["args"]
    assert shown["args"][-3:] == [
        "--executablePath",
        str(chrome),
        "--chromeArg=--no-sandbox",
    ]

    attached = devtools_server_config(browser_url="http://127.0.0.1:9222")
    assert attached["args"][-2:] == ["--browserUrl", "http://127.0.0.1:9222"]
    assert "--isolated" not in attached["args"]


def test_under_strict_airgap_only_the_cached_server_may_run(no_chrome, monkeypatch):
    npx = _on_path(no_chrome / "bin", "npx")
    monkeypatch.setenv("PATH", str(npx.parent))
    project = no_chrome / "project"
    (project / ".workpilot").mkdir(parents=True)
    (project / ".workpilot" / "offline-mode.json").write_text(
        json.dumps({"airgapStrict": True}), encoding="utf-8"
    )
    entry = devtools_server_config(project_dir=project)
    assert entry["args"][:2] == ["--no", "chrome-devtools-mcp"]

    import offline_policy

    def unreadable(*paths):
        raise ValueError("bad policy")

    monkeypatch.setattr(offline_policy, "airgap_status", unreadable)
    assert devtools_server_config(project_dir=project)["args"][0] == "-y"


# -- the Chrome DevTools MCP engine, through a stand-in manager ------------


class StandInManager:
    """`MCPToolManager` as chrome-devtools-mcp would answer it."""

    instances: list[StandInManager] = []
    connect_error: Exception | None = None
    tools = {"mcp__chrome_devtools__navigate_page"}
    answers: dict[str, object] = {}

    def __init__(self, project_dir, servers, pin=True):
        self.servers = servers
        self.calls: list[tuple[str, dict]] = []
        self.closed = False
        StandInManager.instances.append(self)

    async def connect(self):
        if StandInManager.connect_error is not None:
            raise StandInManager.connect_error

    def has_tool(self, name):
        return name in StandInManager.tools

    async def call(self, name, arguments):
        short = name.removeprefix("mcp__chrome_devtools__")
        self.calls.append((short, arguments))
        answer = StandInManager.answers.get(short, f"{short}: ok")
        if isinstance(answer, BaseException):
            raise answer
        if callable(answer):
            return await answer(arguments)
        return answer

    async def aclose(self):
        self.closed = True


@pytest.fixture
def devtools(tmp_path, monkeypatch):
    npx = _on_path(tmp_path / "bin", "npx")
    monkeypatch.setenv("PATH", str(npx.parent))
    StandInManager.instances = []
    StandInManager.connect_error = None
    StandInManager.tools = {"mcp__chrome_devtools__navigate_page"}
    StandInManager.answers = {}
    monkeypatch.setattr(mcp_tools_module, "MCPToolManager", StandInManager)
    return tmp_path


def _session(base, **kwargs) -> BrowserSession:
    return BrowserSession(base, prefer="devtools", **kwargs)


def test_every_action_reaches_its_devtools_tool(devtools):
    async def scenario():
        async with _session(devtools) as browser:
            assert browser.engine == "chrome-devtools-mcp"
            await browser.navigate("http://127.0.0.1:5173/")
            await browser.snapshot()
            await browser.click("1_2")
            await browser.fill("1_1", "a@b.c")
            await browser.press("Enter")
            await browser.wait_for(["Saved"], timeout_ms=3000)
            await browser.evaluate("() => 1")
            await browser.console()
            await browser.network()
            await browser.emulate("mobile")
            await browser.emulate("1024x768x1")
            return StandInManager.instances[-1]

    manager = asyncio.run(scenario())
    assert manager.calls == [
        ("list_pages", {}),
        ("navigate_page", {"type": "url", "url": "http://127.0.0.1:5173/"}),
        ("take_snapshot", {}),
        ("click", {"uid": "1_2"}),
        ("fill", {"uid": "1_1", "value": "a@b.c"}),
        ("press_key", {"key": "Enter"}),
        ("wait_for", {"text": ["Saved"], "timeout": 3000}),
        ("evaluate_script", {"function": "() => 1"}),
        ("list_console_messages", {}),
        ("list_network_requests", {}),
        ("emulate", {"viewport": "390x844x3,mobile,touch"}),
        ("emulate", {"viewport": "1024x768x1"}),
    ]
    assert manager.closed


def test_a_devtools_screenshot_is_the_file_it_wrote(devtools):
    async def take(path):
        Path(path["filePath"]).write_bytes(b"\x89PNG")
        return "Took a screenshot"

    StandInManager.answers = {"take_screenshot": take}
    shot = devtools / "shots" / "a.png"

    async def scenario():
        async with _session(devtools) as browser:
            first = await browser.screenshot(shot, full_page=True)
            StandInManager.answers = {"take_screenshot": "Error: no page"}
            second = await browser.screenshot(devtools / "shots" / "b.png")
            return first, second, StandInManager.instances[-1].calls

    first, second, calls = asyncio.run(scenario())
    assert (first, second) == (True, False)
    assert calls[1] == (
        "take_screenshot",
        {"filePath": str(shot), "fullPage": True, "format": "png"},
    )


def test_a_devtools_trace_and_lighthouse(devtools):
    async def trace(args):
        Path(args["filePath"]).write_bytes(b"gz")
        return "## Summary\n- LCP: 1.2 s\n- CLS: 0.01\n- TTFB: 80 ms\n"

    StandInManager.answers = {
        "performance_start_trace": trace,
        "lighthouse_audit": "- Accessibility: 91 (accessibility)\n- SEO: 100 (seo)\n",
    }
    target = devtools / "traces" / "home.json.gz"

    async def scenario():
        async with _session(devtools) as browser:
            return await browser.perf_trace("http://127.0.0.1:1/", target), (
                await browser.lighthouse()
            )

    result, scores = asyncio.run(scenario())
    assert result.lcp_ms == 1200.0 and result.cls == 0.01
    assert result.score is not None and result.trace_path == str(target)
    assert result.engine == "chrome-devtools-mcp"
    assert scores == {"accessibility": 91, "seo": 100}


def test_a_devtools_trace_that_cannot_load_or_measure_says_why(devtools):
    StandInManager.answers = {"navigate_page": "Error: net::ERR_CONNECTION_REFUSED"}

    async def scenario():
        async with _session(devtools) as browser:
            refused = await browser.perf_trace("http://127.0.0.1:1/", devtools / "t")
            StandInManager.answers = {
                "performance_start_trace": "MCP tool error: the trace never stopped"
            }
            empty = await browser.perf_trace("http://127.0.0.1:1/", devtools / "t")
            return refused, empty

    refused, empty = asyncio.run(scenario())
    assert refused.reason.startswith("Error: net::ERR_CONNECTION_REFUSED")
    assert not empty.measured
    assert empty.reason == "MCP tool error: the trace never stopped"


def test_a_devtools_call_that_hangs_or_raises_is_an_answer(devtools):
    async def hang(args):
        await asyncio.sleep(5)

    StandInManager.answers = {
        "take_snapshot": hang,
        "click": RuntimeError("socket closed"),
    }

    async def scenario():
        async with _session(devtools) as browser:
            hung = await browser._call("take_snapshot", {}, timeout=0.05)
            return hung, await browser.click("1")

    hung, raised = asyncio.run(scenario())
    assert hung == "MCP tool error: take_snapshot timed out after 0s"
    assert raised == "MCP tool error: socket closed"


@pytest.mark.parametrize(
    ("setup", "reason"),
    [
        (
            lambda: setattr(StandInManager, "connect_error", OSError("spawn failed")),
            "chrome-devtools-mcp: could not connect (spawn failed)",
        ),
        (
            lambda: setattr(StandInManager, "tools", set()),
            "chrome-devtools-mcp: server exposed no browser tools",
        ),
        (
            lambda: setattr(
                StandInManager,
                "answers",
                {"list_pages": "Error: Could not find Chrome (ver. 131)\nmore"},
            ),
            "chrome-devtools-mcp: Error: Could not find Chrome (ver. 131)",
        ),
    ],
)
def test_a_devtools_server_that_will_not_serve_is_closed_and_explained(
    devtools, setup, reason
):
    setup()
    browser = asyncio.run(_start(_session(devtools)))
    assert not browser.available
    assert browser.reasons == [reason]
    assert StandInManager.instances[-1].closed


async def _start(browser):
    await browser.start()
    return browser


def test_without_npx_devtools_is_not_an_engine(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    browser = asyncio.run(_start(_session(tmp_path)))
    assert browser.reasons == ["chrome-devtools-mcp: npx not found"]


def test_off_means_no_browser(tmp_path):
    browser = asyncio.run(_start(BrowserSession(tmp_path, prefer="off")))
    assert not browser.available
    assert browser.reasons == ["the browser is turned off (VERIFY_BROWSER=off)"]
    assert asyncio.run(browser.lighthouse()) == {}


def test_one_engine_failing_hands_over_to_the_next(devtools, monkeypatch):
    async def broken(self):
        raise RuntimeError("playwright exploded")

    monkeypatch.setattr(BrowserSession, "_start_playwright", broken)

    async def scenario():
        # A trace is asked for: Playwright first, then DevTools.
        async with BrowserSession(devtools, trace_path=devtools / "t.zip") as browser:
            return browser.engine, list(browser.reasons)

    engine, reasons = asyncio.run(scenario())
    assert engine == "chrome-devtools-mcp"
    assert reasons == ["playwright: playwright exploded"]


def test_without_playwright_installed(tmp_path, monkeypatch):
    import builtins

    real_import = builtins.__import__

    def no_playwright(name, *args, **kwargs):
        if name.startswith("playwright"):
            raise ImportError("No module named 'playwright'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_playwright)
    browser = asyncio.run(_start(BrowserSession(tmp_path, prefer="playwright")))
    assert browser.reasons == ["playwright: not installed"]


# -- the Playwright engine, on a real page ---------------------------------

PAGE = """<!doctype html><html><head><title>Orders</title></head><body>
<h1>Orders</h1><input aria-label="Email"><button>Save</button></body></html>"""


@pytest.fixture(scope="module")
def site(tmp_path_factory):
    root = tmp_path_factory.mktemp("site")
    (root / "index.html").write_text(PAGE, encoding="utf-8")

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    server = socketserver.TCPServer(
        ("127.0.0.1", 0), functools.partial(Quiet, directory=str(root))
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/"
    server.shutdown()


@pytest.fixture
def chromium():
    if not chrome_executable():
        pytest.skip("no Chromium on this machine")


def test_playwright_answers_a_wrong_move_like_devtools(chromium, site, tmp_path):
    async def scenario():
        async with BrowserSession(tmp_path, prefer="playwright") as browser:
            if browser.engine != "playwright":
                pytest.skip("; ".join(browser.reasons))
            out = {"early": await browser.click("1")}
            await browser.navigate(site)
            await browser.snapshot()
            out["bad_uid"] = await browser.fill("x y", "v")
            out["gone"] = await browser.click("999")
            out["filled"] = await browser.fill("2", "a@b.c")
            out["late"] = await browser.wait_for(["never shown"], timeout_ms=300)
            out["script"] = await browser.evaluate("() => { throw new Error('no') }")
            out["value"] = await browser.evaluate("() => 6 * 7")
            out["desktop"] = await browser.emulate("desktop")
            out["bad_viewport"] = await browser.emulate("huge")
            out["press"] = await browser.press("Tab")
            out["network"] = await browser.network()
            out["dead"] = await browser.navigate("http://127.0.0.1:9/")
            return out

    out = asyncio.run(scenario())
    assert out["early"].startswith("MCP tool error: Error: No snapshot found")
    assert out["dead"].startswith("Navigation failed: ")
    assert out["bad_uid"] == "MCP tool error: invalid uid"
    assert out["gone"] == "MCP tool error: no element with uid 999; take a new snapshot"
    assert out["filled"] == "Successfully filled out the element"
    assert out["late"] == "MCP tool error: Error: Timed out after waiting 300ms"
    assert out["script"].startswith("MCP tool error: ")
    assert out["value"].endswith("42")
    assert out["desktop"] == "Emulating viewport 1280x800x1"
    assert out["bad_viewport"] == "MCP tool error: invalid viewport"
    assert out["press"] == "Successfully pressed Tab"
    assert f"GET {site} [200]" in out["network"]


def test_playwright_reads_the_console_of_the_current_page_only(chromium, tmp_path):
    """As chrome-devtools-mcp does: the error the last page printed is not the
    next one's. Kept across pages, it made a fixed page fail forever."""
    root = tmp_path / "pages"
    root.mkdir()
    (root / "broken.html").write_text(
        "<html><body><script>console.error('boom')</script></body></html>",
        encoding="utf-8",
    )
    (root / "fixed.html").write_text("<html><body>ok</body></html>", encoding="utf-8")

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    server = socketserver.TCPServer(
        ("127.0.0.1", 0), functools.partial(Quiet, directory=str(root))
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}"

    async def scenario():
        async with BrowserSession(tmp_path, prefer="playwright") as browser:
            if browser.engine != "playwright":
                pytest.skip("; ".join(browser.reasons))
            await browser.navigate(f"{url}/broken.html")
            before = await browser.console()
            await browser.navigate(f"{url}/fixed.html")
            return before, await browser.console(), await browser.network()

    try:
        before, after, network = asyncio.run(scenario())
    finally:
        server.shutdown()
    assert "[error] boom" in before
    assert "boom" not in after
    assert "broken.html" not in network and "fixed.html" in network


def test_playwright_measures_the_page_without_a_trace_file(chromium, site, tmp_path):
    async def scenario():
        async with BrowserSession(tmp_path, prefer="playwright") as browser:
            if browser.engine != "playwright":
                pytest.skip("; ".join(browser.reasons))
            unreachable = await browser.perf_trace(
                "http://127.0.0.1:9/", tmp_path / "dead.json"
            )
            measured = await browser.perf_trace(site, tmp_path / "t" / "trace.json")
            return unreachable, measured

    unreachable, measured = asyncio.run(scenario())
    assert unreachable.reason.startswith("trace failed: ")
    assert measured.ttfb_ms is not None
    assert measured.engine == "playwright"


def test_playwright_that_cannot_launch_chrome_says_so(tmp_path, monkeypatch):
    pytest.importorskip("playwright")
    monkeypatch.setattr(
        devtools_module, "chrome_executable", lambda explicit="": str(tmp_path / "nope")
    )
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path / "no-browsers"))
    browser = asyncio.run(_start(BrowserSession(tmp_path, prefer="playwright")))
    assert not browser.available
    assert browser.reasons[0].startswith("playwright: ")
    assert browser._pw is None


def test_is_root_follows_the_process(monkeypatch):
    if not hasattr(os, "geteuid"):
        assert devtools_module._is_root() is False
        return
    assert devtools_module._is_root() == (os.geteuid() == 0)
    monkeypatch.delattr(os, "geteuid")
    assert devtools_module._is_root() is False
