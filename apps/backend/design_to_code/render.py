"""Render generated files headless, at the target's size, and nothing else.

The files come from a model that read an external picture: they are rendered
as data. The page runs in a headless Chromium (the caller names the binary:
the verification's, ``verify.devtools.chrome_executable``) with JavaScript off and the network
emulated offline; every request is aborted unless it is a ``file:`` URL inside
the folder the files were written to. A page can therefore neither reach the
network nor show a file of the machine on the capture that goes to a model.

``RenderError`` says why no capture could be made (no Playwright, no browser,
a page that never loads); the loop reports it instead of failing the run.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

#: Fonts the page asks for and the machine lacks, measured against a fallback.
_FONT_PROBE = """(families) => {
  const ctx = document.createElement('canvas').getContext('2d');
  const width = (font) => { ctx.font = '40px ' + font; return ctx.measureText('mmmmmmmmmmlli').width; };
  return families.filter((f) => ['monospace', 'serif'].every((g) => width('"' + f + '", ' + g) === width(g)));
}"""
_LOAD_TIMEOUT_MS = 15_000
_MAX_VIEWPORT = 8_000
_GENERIC_FONTS = {
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-sans-serif",
    "ui-serif",
    "ui-monospace",
    "inherit",
    "initial",
}


class RenderError(RuntimeError):
    """No capture: ``code`` is one of ``no_playwright``, ``no_browser``, ``load_failed``."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


def viewport_for(width: int, height: int) -> tuple[int, int, int]:
    """(viewport width, viewport height, device scale) for a target of this size.

    A capture of 2400 px or more is taken as a 2x screen: the layout a design
    of 2880 px shows is the one of a 1440 px page.
    """
    scale = 2 if width >= 2400 else 1
    return (
        min(_MAX_VIEWPORT, max(1, width // scale)),
        min(_MAX_VIEWPORT, max(1, height // scale)),
        scale,
    )


def safe_relative(path: str) -> str | None:
    """``path`` when it stays inside the folder it is written to, else None."""
    if not path or "\x00" in path:
        return None
    normalised = path.replace("\\", "/")
    parts = [p for p in normalised.split("/") if p not in ("", ".")]
    if (
        normalised.startswith("/")
        or ":" in (parts[0] if parts else "")
        or ".." in parts
    ):
        return None
    return "/".join(parts) or None


def write_files(root: Path, files: dict[str, str]) -> None:
    """Write the files under ``root``; a path that would leave it is skipped."""
    base = root.resolve()
    for path, content in files.items():
        relative = safe_relative(path)
        if relative is None:
            continue
        target = (base / relative).resolve()
        if base not in target.parents:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


def inside(url: str, root: Path) -> bool:
    """Whether ``url`` is a ``file:`` URL of a path inside ``root``."""
    parts = urlsplit(url)
    if parts.scheme != "file" or parts.netloc not in ("", "localhost"):
        return False
    path = unquote(parts.path)
    # file:///C:/x on Windows carries a leading slash before the drive.
    if len(path) > 2 and path[0] == "/" and path[2] == ":":
        path = path[1:]
    resolved = Path(path).resolve()
    base = root.resolve()
    return resolved == base or base in resolved.parents


def font_families(typography: dict[str, Any] | None) -> list[str]:
    """The named font families of the spec's typography, generics left out."""
    found: list[str] = []
    for props in (typography or {}).values():
        if not isinstance(props, dict):
            continue
        for family in str(props.get("fontFamily", "")).split(","):
            name = family.strip().strip("'\"")
            if name and name.lower() not in _GENERIC_FONTS and name not in found:
                found.append(name[:60])
    return found[:8]


def _is_root() -> bool:
    geteuid = getattr(os, "geteuid", None)
    return bool(geteuid and geteuid() == 0)


Launcher = Callable[[str], Awaitable[tuple[Any, Any]]]


async def _launch(executable: str = "") -> tuple[Any, Any]:
    """(playwright, browser) on ``executable`` (Playwright's own when empty), or RenderError."""
    try:
        from playwright.async_api import Error as PlaywrightError
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise RenderError("no_playwright") from exc

    playwright = await async_playwright().start()
    options: dict[str, Any] = {"headless": True}
    if executable:
        options["executable_path"] = executable
    if _is_root():
        options["args"] = ["--no-sandbox"]
    try:
        browser = await playwright.chromium.launch(**options)
    except PlaywrightError as exc:
        await playwright.stop()
        raise RenderError("no_browser", str(exc).splitlines()[0][:200]) from exc
    return playwright, browser


class Renderer:
    """One browser for the whole loop; each ``capture`` a fresh offline context."""

    def __init__(
        self,
        width: int,
        height: int,
        *,
        executable: str = "",
        launcher: Launcher = _launch,
    ) -> None:
        self.viewport = viewport_for(width, height)
        self._launcher = launcher
        self._executable = executable
        self._playwright: Any = None
        self._browser: Any = None
        self._dir: Path | None = None
        self.missing_fonts: list[str] = []

    async def __aenter__(self) -> Renderer:
        self._playwright, self._browser = await self._launcher(self._executable)
        self._dir = Path(tempfile.mkdtemp(prefix="wp-design-render-"))
        return self

    async def __aexit__(self, *_exc: object) -> None:
        if self._browser is not None:
            await self._browser.close()
        if self._playwright is not None:
            await self._playwright.stop()
        if self._dir is not None:
            shutil.rmtree(self._dir, ignore_errors=True)

    async def capture(
        self, files: dict[str, str], page: str, fonts: list[str] | None = None
    ) -> bytes:
        """PNG of ``page`` (one of ``files``) at the target's size."""
        from playwright.async_api import Error as PlaywrightError

        if self._dir is None:
            raise RenderError("load_failed", "renderer not started")
        root = self._dir / f"v{len(list(self._dir.iterdir()))}"
        root.mkdir()
        write_files(root, files)
        relative = safe_relative(page)
        entry = root / relative if relative else None
        if entry is None or not entry.is_file():
            raise RenderError("load_failed", "no page to render")

        width, height, scale = self.viewport
        context = await self._browser.new_context(
            viewport={"width": width, "height": height},
            device_scale_factor=scale,
            java_script_enabled=False,
            offline=True,
        )

        async def guard(route: Any) -> None:
            if inside(route.request.url, root):
                await route.continue_()
            else:
                await route.abort()

        try:
            await context.route("**/*", guard)
            tab = await context.new_page()
            try:
                await tab.goto(
                    entry.resolve().as_uri(),
                    wait_until="load",
                    timeout=_LOAD_TIMEOUT_MS,
                )
            except PlaywrightError as exc:
                raise RenderError(
                    "load_failed", str(exc).splitlines()[0][:200]
                ) from exc
            if fonts:
                self.missing_fonts = list(await tab.evaluate(_FONT_PROBE, fonts))
            return await tab.screenshot(type="png")
        finally:
            await context.close()
