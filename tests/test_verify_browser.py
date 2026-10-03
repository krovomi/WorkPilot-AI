"""The verification's browser, driven for real.

`BrowserSession` has two engines — Chrome DevTools MCP driven from Python,
Playwright when it cannot start — and promises the same dialect from both:
`uid=` rows in a snapshot, `msgid=N [error]` in the console, a trace that
yields LCP/CLS and a score. These tests drive a real page through each engine
that is installed, and skip the one that is not: a runner without Chromium is
not a defect here.
"""

from __future__ import annotations

import asyncio
import functools
import http.server
import socketserver
import sys
import threading
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from verify.devtools import BrowserSession, chrome_executable  # noqa: E402
from verify.errors import console_errors  # noqa: E402

PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Orders</title></head>
<body><h1>Orders</h1>
<button onclick="document.getElementById('r').textContent='Saved!'">Save</button>
<p id="r"></p>
<script>console.error("boom from page")</script></body></html>"""


@pytest.fixture(scope="module")
def site(tmp_path_factory):
    root = tmp_path_factory.mktemp("site")
    (root / "index.html").write_text(PAGE, encoding="utf-8")
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=str(root)
    )

    class Quiet(handler.func):  # type: ignore[misc]
        def log_message(self, *args):
            pass

    server = socketserver.TCPServer(
        ("127.0.0.1", 0), functools.partial(Quiet, directory=str(root))
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}/"
    server.shutdown()


def _uid_of(snapshot: str, needle: str) -> str:
    for line in snapshot.splitlines():
        if needle in line and "uid=" in line:
            return line.strip().split()[0].split("=", 1)[1]
    raise AssertionError(f"{needle} not in snapshot:\n{snapshot}")


async def _scenario(engine: str, url: str, base: Path) -> dict:
    async with BrowserSession(base, prefer=engine) as browser:
        if not browser.available:
            pytest.skip(f"{engine} unavailable: {'; '.join(browser.reasons)}")
        await browser.navigate(url)
        snapshot = await browser.snapshot()
        await browser.click(_uid_of(snapshot, '"Save"'))
        appeared = await browser.wait_for(["Saved!"], timeout_ms=5000)
        console = await browser.console()
        shot = base / "shot.png"
        took = await browser.screenshot(shot)
        perf = await browser.perf_trace(url, base / "trace.json.gz")
        return {
            "engine": browser.engine,
            "appeared": appeared,
            "console": console,
            "shot": took,
            "perf": perf,
        }


@pytest.mark.parametrize("engine", ["playwright", "devtools"])
def test_the_same_scenario_on_each_engine(engine, site, tmp_path):
    if not chrome_executable():
        pytest.skip("no Chromium on this machine")
    result = asyncio.run(_scenario(engine, site, tmp_path))
    assert not result["appeared"].startswith("MCP tool error"), result["appeared"]
    assert [e.message for e in console_errors(result["console"])] == ["boom from page"]
    assert result["shot"]
    perf = result["perf"]
    assert perf.measured, perf.reason
    assert perf.lcp_ms is not None and perf.score is not None
