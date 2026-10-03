"""One browser, driven the same way whichever provider asked.

The verification needs a browser for four things: open the page the task
changed, click until the new state shows, read the console and the network,
and trace the page's performance. **Chrome DevTools MCP** does all four, and
it is driven here from Python — through `core.mcp_tools.MCPToolManager`, the
client that already bridges MCP servers for OpenAI, Gemini and the local
models. That is what makes "trace via Chrome DevTools MCP" true on Ollama and
Copilot too: the provider does not have to speak MCP, WorkPilot does.

When `chrome-devtools-mcp` cannot start (no `npx`, no Chrome, a strict airgap
with nothing cached), Playwright drives the same Chromium through the same
methods, and its answers are formatted like the MCP server's — `uid=…` in a
snapshot, `msgid=N [error] …` in the console, `reqid=N GET url [status]` in
the network list — so one parser reads both and the model sees one dialect.
Neither available is an answer (`unavailable`, with the reasons), never a
guess.

Three switches are always on for the MCP server, and they are not cosmetic:
`--isolated` (a throwaway profile, never the user's), `--no-usage-statistics`
and `--no-performance-crux` — the trace of a developer's local page has no
business reaching Google's CrUX API.
"""

from __future__ import annotations

import asyncio
import glob
import logging
import os
import re
import shutil
from pathlib import Path

from .perf import PerfResult, from_summary, page_score, parse_lighthouse_summary

logger = logging.getLogger(__name__)

__all__ = ["BrowserSession", "chrome_executable", "devtools_server_config"]

_CONNECT_TIMEOUT = 120.0
_CALL_TIMEOUT = 90.0
_SERVER_ID = "chrome_devtools"


def chrome_executable(explicit: str = "") -> str:
    """A Chromium/Chrome binary to drive, or "" to let the tool find its own."""
    for candidate in (explicit, os.environ.get("CHROME_PATH", "")):
        if candidate and Path(candidate).is_file():
            return candidate
    roots = [
        os.environ.get("PLAYWRIGHT_BROWSERS_PATH", ""),
        "/opt/pw-browsers",
        str(Path.home() / ".cache" / "ms-playwright"),
    ]
    layouts = (
        "chromium-*/chrome-linux/chrome",
        "chromium-*/chrome-linux64/chrome",
        "chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        "chromium-*/chrome-win/chrome.exe",
    )
    for root in roots:
        if not root:
            continue
        for layout in layouts:
            found = sorted(glob.glob(os.path.join(root, layout)), reverse=True)
            if found:
                return found[0]
    for name in (
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
    ):
        path = shutil.which(name)
        if path:
            return path
    return ""


def _is_root() -> bool:
    try:
        return os.geteuid() == 0  # type: ignore[attr-defined]
    except AttributeError:  # Windows
        return False


def _strict_airgap(project_dir: Path | None) -> bool:
    if project_dir is None:
        return False
    try:
        from core.offline_policy import airgap_status

        return bool(airgap_status(project_dir).get("airgapStrict"))
    except Exception:  # noqa: BLE001 - an unreadable policy is not a reason to fail
        return False


def devtools_server_config(
    *,
    chrome_path: str = "",
    browser_url: str = "",
    project_dir: Path | None = None,
    headless: bool = True,
) -> dict | None:
    """The MCPToolManager entry that starts `chrome-devtools-mcp`, or None."""
    npx = shutil.which("npx")
    if not npx:
        return None
    package = "chrome-devtools-mcp@latest"
    prefix = ["-y"]
    if _strict_airgap(project_dir):
        # Strict airgap: only a copy already in the npx cache may run.
        prefix, package = ["--no"], "chrome-devtools-mcp"
    args = [
        *prefix,
        package,
        "--no-page-id-routing",
        "--no-usage-statistics",
        "--no-performance-crux",
    ]
    if browser_url:
        args += ["--browserUrl", browser_url]
    else:
        args += ["--isolated"]
        if headless:
            args.append("--headless")
        executable = chrome_executable(chrome_path)
        if executable:
            args += ["--executablePath", executable]
        if _is_root():
            # Chrome refuses to run as root with its sandbox (crbug 638180),
            # which is what a CI container is.
            args.append("--chromeArg=--no-sandbox")
    return {"type": "command", "id": _SERVER_ID, "command": npx, "args": args}


_FAILED = re.compile(
    r"Chrome failed to start|Could not find Chrome|Failed to launch|ECONNREFUSED", re.I
)


class BrowserSession:
    """An async browser session. Use as ``async with BrowserSession(...) as b``."""

    def __init__(
        self,
        base: Path,
        *,
        project_dir: Path | None = None,
        chrome_path: str = "",
        browser_url: str = "",
        prefer: str = "auto",
    ):
        self.base = base
        self.project_dir = project_dir
        self.chrome_path = chrome_path
        self.browser_url = browser_url
        self.prefer = (prefer or "auto").lower()
        self.engine = ""
        self.reasons: list[str] = []
        self._mcp = None
        self._pw = None
        self._browser = None
        self._context = None
        self._page = None
        self._console: list[tuple[str, str]] = []
        self._network: list[tuple[str, str, str]] = []
        self._uids_ready = False

    # -- lifecycle -----------------------------------------------------------

    async def __aenter__(self) -> BrowserSession:
        await self.start()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.close()

    @property
    def available(self) -> bool:
        return bool(self.engine)

    async def start(self) -> None:
        if self.prefer == "off":
            self.reasons.append("the browser is turned off (VERIFY_BROWSER=off)")
            return
        order = {
            "devtools": ("devtools",),
            "playwright": ("playwright",),
        }.get(self.prefer, ("devtools", "playwright"))
        for engine in order:
            try:
                ok = await (
                    self._start_devtools()
                    if engine == "devtools"
                    else self._start_playwright()
                )
            except Exception as exc:  # noqa: BLE001 - one engine never sinks the other
                ok = False
                self.reasons.append(f"{engine}: {exc}")
            if ok:
                self.engine = (
                    "chrome-devtools-mcp" if engine == "devtools" else "playwright"
                )
                return

    async def _start_devtools(self) -> bool:
        config = devtools_server_config(
            chrome_path=self.chrome_path,
            browser_url=self.browser_url,
            project_dir=self.project_dir,
        )
        if config is None:
            self.reasons.append("chrome-devtools-mcp: npx not found")
            return False
        from core.mcp_tools import MCPToolManager

        manager = MCPToolManager(
            str(self.project_dir) if self.project_dir else None, [config]
        )
        try:
            await asyncio.wait_for(manager.connect(), timeout=_CONNECT_TIMEOUT)
        except (asyncio.TimeoutError, Exception) as exc:  # noqa: BLE001
            await manager.aclose()
            self.reasons.append(
                f"chrome-devtools-mcp: could not connect ({exc or 'timeout'})"
            )
            return False
        if not manager.has_tool(self._tool("navigate_page")):
            await manager.aclose()
            self.reasons.append("chrome-devtools-mcp: server exposed no browser tools")
            return False
        self._mcp = manager
        # Chrome starts on the first page-scoped call: prove it does now, so a
        # Chrome that cannot launch falls back here rather than mid-scenario.
        answer = await self._call("list_pages", {})
        if _FAILED.search(answer or ""):
            self.reasons.append(
                f"chrome-devtools-mcp: {answer.strip().splitlines()[0][:200]}"
            )
            await manager.aclose()
            self._mcp = None
            return False
        return True

    async def _start_playwright(self) -> bool:
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            self.reasons.append("playwright: not installed")
            return False
        self._pw = await async_playwright().start()
        try:
            if self.browser_url:
                self._browser = await self._pw.chromium.connect_over_cdp(
                    self.browser_url
                )
                self._context = (
                    self._browser.contexts[0]
                    if self._browser.contexts
                    else await self._browser.new_context()
                )
                pages = self._context.pages
                self._page = pages[0] if pages else await self._context.new_page()
            else:
                kwargs: dict = {"headless": True}
                executable = chrome_executable(self.chrome_path)
                if executable:
                    kwargs["executable_path"] = executable
                if _is_root():
                    kwargs["args"] = ["--no-sandbox"]
                self._browser = await self._pw.chromium.launch(**kwargs)
                self._context = await self._browser.new_context(
                    viewport={"width": 1280, "height": 800}
                )
                self._page = await self._context.new_page()
        except Exception as exc:  # noqa: BLE001
            self.reasons.append(f"playwright: {exc}")
            await self._pw.stop()
            self._pw = None
            return False
        self._wire_page(self._page)
        return True

    def _wire_page(self, page) -> None:
        page.on("console", lambda msg: self._console.append((msg.type, msg.text)))
        page.on(
            "pageerror", lambda err: self._console.append(("error", f"Uncaught {err}"))
        )
        page.on(
            "response",
            lambda resp: self._network.append(
                (resp.request.method, resp.url, str(resp.status))
            ),
        )
        page.on(
            "requestfailed",
            lambda req: self._network.append(
                (req.method, req.url, f"failed - {req.failure or 'net::ERR_FAILED'}")
            ),
        )

    async def close(self) -> None:
        if self._mcp is not None:
            await self._mcp.aclose()
            self._mcp = None
        if self._pw is not None:
            try:
                if self._browser is not None and not self.browser_url:
                    await self._browser.close()
            except Exception:  # noqa: BLE001
                pass
            await self._pw.stop()
            self._pw = None

    # -- MCP plumbing --------------------------------------------------------

    @staticmethod
    def _tool(name: str) -> str:
        return f"mcp__{_SERVER_ID}__{name}"

    async def _call(self, name: str, args: dict, timeout: float = _CALL_TIMEOUT) -> str:
        assert self._mcp is not None
        try:
            return await asyncio.wait_for(
                self._mcp.call(self._tool(name), args), timeout=timeout
            )
        except asyncio.TimeoutError:
            return f"MCP tool error: {name} timed out after {int(timeout)}s"
        except Exception as exc:  # noqa: BLE001
            return f"MCP tool error: {exc}"

    # -- actions -------------------------------------------------------------

    async def navigate(self, url: str) -> str:
        if self._mcp is not None:
            return await self._call("navigate_page", {"type": "url", "url": url})
        page = self._page
        try:
            response = await page.goto(url, wait_until="load", timeout=60_000)
        except Exception as exc:  # noqa: BLE001
            return f"Navigation failed: {exc}"
        self._uids_ready = False
        status = response.status if response is not None else "?"
        return f"Successfully navigated to {page.url} (HTTP {status})."

    async def snapshot(self) -> str:
        if self._mcp is not None:
            return await self._call("take_snapshot", {})
        rows = await self._page.evaluate(_SNAPSHOT_JS)
        self._uids_ready = True
        lines = [
            "## Latest page snapshot",
            f'uid=0 RootWebArea "{await self._page.title()}" url="{self._page.url}"',
        ]
        lines += [f"  {row}" for row in rows]
        return "\n".join(lines)

    async def click(self, uid: str) -> str:
        if self._mcp is not None:
            return await self._call("click", {"uid": uid})
        locator = await self._locate(uid)
        if isinstance(locator, str):
            return locator
        try:
            await locator.click(timeout=10_000)
            await self._page.wait_for_load_state("networkidle", timeout=10_000)
        except Exception as exc:  # noqa: BLE001
            return f"MCP tool error: {exc}"
        self._uids_ready = False
        return "Successfully clicked on the element"

    async def fill(self, uid: str, value: str) -> str:
        if self._mcp is not None:
            return await self._call("fill", {"uid": uid, "value": value})
        locator = await self._locate(uid)
        if isinstance(locator, str):
            return locator
        try:
            await locator.fill(value, timeout=10_000)
        except Exception as exc:  # noqa: BLE001
            return f"MCP tool error: {exc}"
        return "Successfully filled out the element"

    async def press(self, key: str) -> str:
        if self._mcp is not None:
            return await self._call("press_key", {"key": key})
        await self._page.keyboard.press(key)
        return f"Successfully pressed {key}"

    async def wait_for(self, texts: list[str], timeout_ms: int = 10_000) -> str:
        if self._mcp is not None:
            return await self._call("wait_for", {"text": texts, "timeout": timeout_ms})
        try:
            await self._page.wait_for_function(
                "(texts) => texts.some(t => document.body && document.body.innerText.includes(t))",
                arg=texts,
                timeout=timeout_ms,
            )
        except Exception:  # noqa: BLE001
            return f"MCP tool error: Error: Timed out after waiting {timeout_ms}ms"
        return "Element with the text appeared on the page"

    async def evaluate(self, function: str) -> str:
        if self._mcp is not None:
            return await self._call("evaluate_script", {"function": function})
        try:
            value = await self._page.evaluate(function)
        except Exception as exc:  # noqa: BLE001
            return f"MCP tool error: {exc}"
        return f"Script ran on page and returned:\n{value!r}"

    async def console(self) -> str:
        if self._mcp is not None:
            return await self._call("list_console_messages", {})
        lines = ["## Console messages"]
        lines += [
            f"msgid={i} [{level}] {text}"
            for i, (level, text) in enumerate(self._console, 1)
        ]
        return "\n".join(lines)

    async def network(self) -> str:
        if self._mcp is not None:
            return await self._call("list_network_requests", {})
        lines = ["## Network requests"]
        lines += [
            f"reqid={i} {m} {u} [{s}]" for i, (m, u, s) in enumerate(self._network, 1)
        ]
        return "\n".join(lines)

    async def emulate(self, viewport: str) -> str:
        """``mobile`` (390x844, touch), ``desktop`` (1280x800) or a raw spec."""
        spec = {"mobile": "390x844x3,mobile,touch", "desktop": "1280x800x1"}.get(
            viewport, viewport
        )
        if self._mcp is not None:
            return await self._call("emulate", {"viewport": spec})
        match = re.match(r"(\d+)x(\d+)", spec)
        if not match:
            return "MCP tool error: invalid viewport"
        await self._page.set_viewport_size(
            {"width": int(match.group(1)), "height": int(match.group(2))}
        )
        return f"Emulating viewport {spec}"

    async def screenshot(self, path: Path, full_page: bool = False) -> bool:
        path.parent.mkdir(parents=True, exist_ok=True)
        if self._mcp is not None:
            answer = await self._call(
                "take_screenshot",
                {"filePath": str(path), "fullPage": full_page, "format": "png"},
            )
            return path.is_file() and "error" not in answer.lower()[:40]
        try:
            await self._page.screenshot(path=str(path), full_page=full_page)
        except Exception:  # noqa: BLE001
            return False
        return path.is_file()

    async def perf_trace(self, url: str, trace_path: Path) -> PerfResult:
        """Navigate to ``url`` and trace its load. Never raises."""
        trace_path.parent.mkdir(parents=True, exist_ok=True)
        if self._mcp is not None:
            nav = await self.navigate(url)
            if "error" in nav.lower()[:40]:
                return PerfResult(url=url, engine=self.engine, reason=nav[:200])
            summary = await self._call(
                "performance_start_trace",
                {"reload": True, "autoStop": True, "filePath": str(trace_path)},
                timeout=180,
            )
            result = from_summary(url, summary, engine=self.engine)
            if trace_path.is_file():
                result.trace_path = str(trace_path)
            if not result.measured and summary.startswith("MCP tool error"):
                result.reason = summary[:200]
            return result
        return await self._playwright_perf(url, trace_path)

    async def _playwright_perf(self, url: str, trace_path: Path) -> PerfResult:
        page = self._page
        result = PerfResult(url=url, engine=self.engine)
        try:
            await page.add_init_script(_VITALS_INIT_JS)
            tracing = False
            try:
                await self._browser.start_tracing(
                    page=page, path=str(trace_path), screenshots=False
                )
                tracing = True
            except Exception:  # noqa: BLE001 - tracing is a bonus, the metrics are the point
                pass
            await page.goto(url, wait_until="load", timeout=60_000)
            await page.wait_for_timeout(1500)
            metrics = await page.evaluate(
                "() => window.__verifyVitals ? window.__verifyVitals() : null"
            )
            if tracing:
                try:
                    await self._browser.stop_tracing()
                    result.trace_path = str(trace_path)
                except Exception:  # noqa: BLE001
                    pass
        except Exception as exc:  # noqa: BLE001
            result.reason = f"trace failed: {exc}"
            return result
        if isinstance(metrics, dict):
            result.lcp_ms = _num(metrics.get("lcp"))
            result.cls = _num(metrics.get("cls"))
            result.fcp_ms = _num(metrics.get("fcp"))
            result.tbt_ms = _num(metrics.get("tbt"))
            result.ttfb_ms = _num(metrics.get("ttfb"))
        if not result.measured:
            result.reason = "the page reported no metric"
        self._uids_ready = False
        return page_score(result)

    async def lighthouse(self, device: str = "desktop") -> dict[str, int]:
        """Lighthouse category scores (accessibility, best practices, SEO).

        Chrome DevTools MCP only; the fallback has no Lighthouse and says
        nothing rather than inventing a number.
        """
        if self._mcp is None:
            return {}
        answer = await self._call(
            "lighthouse_audit",
            {
                "mode": "snapshot",
                "device": device,
                "outputDirPath": str(self.base / "lighthouse"),
            },
            timeout=180,
        )
        return parse_lighthouse_summary(answer)

    async def _locate(self, uid: str):
        if not self._uids_ready:
            return "MCP tool error: Error: No snapshot found for page. Use take_snapshot to capture one."
        if not re.fullmatch(r"[\w-]{1,20}", str(uid)):
            return "MCP tool error: invalid uid"
        locator = self._page.locator(f'[data-verify-uid="{uid}"]')
        if await locator.count() == 0:
            return f"MCP tool error: no element with uid {uid}; take a new snapshot"
        return locator.first


def _num(value) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


# Interactive and textual elements, numbered in a `data-verify-uid` attribute
# so the next action can name one. Written to read like the MCP snapshot.
_SNAPSHOT_JS = r"""
() => {
  const rows = [];
  const sel = 'a,button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[onclick],h1,h2,h3,h4,label,[role=alert],[role=status],p,li,td,th';
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
    n += 1;
    if (n > 300) break;
    const uid = String(n);
    el.setAttribute('data-verify-uid', uid);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || ({a:'link',button:'button',input:(el.type==='checkbox'?'checkbox':'textbox'),select:'combobox',textarea:'textbox',h1:'heading',h2:'heading',h3:'heading',h4:'heading',summary:'button'}[tag] || 'text');
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || '').trim().replace(/\s+/g,' ').slice(0, 120);
    const value = (tag === 'input' || tag === 'textarea') && el.value ? ` value="${String(el.value).slice(0,80)}"` : '';
    rows.push(`uid=${uid} ${role} "${name}"${value}`);
  }
  return rows;
}
"""

# Web vitals read in the page: LCP, CLS, FCP, TTFB, and TBT approximated as
# the sum of long-task time over 50 ms — the lab definition, without the
# FCP-to-TTI window, which a 1.5 s observation cannot bound anyway.
_VITALS_INIT_JS = r"""
(() => {
  const v = {lcp: null, cls: 0, fcp: null, tbt: 0};
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) v.lcp = e.startTime; }).observe({type: 'largest-contentful-paint', buffered: true}); } catch (e) {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) v.cls += e.value; }).observe({type: 'layout-shift', buffered: true}); } catch (e) {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') v.fcp = e.startTime; }).observe({type: 'paint', buffered: true}); } catch (e) {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) v.tbt += Math.max(0, e.duration - 50); }).observe({type: 'longtask', buffered: true}); } catch (e) {}
  window.__verifyVitals = () => {
    const nav = performance.getEntriesByType('navigation')[0];
    return {lcp: v.lcp, cls: v.cls, fcp: v.fcp, tbt: v.tbt, ttfb: nav ? nav.responseStart : null};
  };
})();
"""
