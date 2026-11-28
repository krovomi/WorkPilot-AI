"""The verification's side: protected screenshots, the base side's screens, the step after."""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path

import pytest
from docintel.engines.base import OcrOutcome
from docintel.visual_qa import spec_captures
from PIL import Image
from pr_captures.privacy import read_page_check
from verify import captures_step
from verify.captures_step import after_verify, capture_side, protected_screenshot


def _collected(payload: dict) -> str:
    encoded = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
    return f"'WPPAGE:{encoded}:WPPAGE'"


class FakeBrowser:
    available = True

    def __init__(self, payload: dict | None = None, *, fail: bool = False):
        self.payload = payload or {"lang": "fr", "fields": [["email", "j@acme.fr"]]}
        self.calls: list[str] = []
        self.fail = fail
        self.url = ""

    async def evaluate(self, function: str) -> str:
        if "TextEncoder" in function:
            self.calls.append("collect")
            return "MCP tool error: gone" if self.fail else _collected(self.payload)
        if "__workpilotPseudonyms = undo" in function:
            self.calls.append("apply")
            assert "j@acme.fr" in function
            return "replaced=1"
        self.calls.append("restore")
        return "restored=1"

    async def screenshot(self, path: Path, full_page: bool = False) -> bool:
        self.calls.append("screenshot")
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (30, 20), (240, 240, 240)).save(path)
        return True

    async def navigate(self, url: str) -> str:
        self.url = url
        self.calls.append(f"navigate {url}")
        return "ok"

    async def emulate(self, viewport: str) -> str:
        self.calls.append(f"emulate {viewport}")
        return "ok"


async def test_the_page_is_swapped_for_the_shot_and_put_back(tmp_path):
    browser = FakeBrowser()
    shot = tmp_path / "verify" / "screenshots" / "home.png"
    ok = await protected_screenshot(
        browser, shot, project_dir=tmp_path, spec_dir=tmp_path, base=tmp_path / "verify"
    )
    assert ok
    assert browser.calls == ["collect", "apply", "screenshot", "restore"]
    check = read_page_check(shot)
    assert (check.replaced, check.kinds) == (1, ["email"])
    assert check.fakes and check.fakes[0].endswith("@exemple.fr")
    assert (tmp_path / "captures" / ".pseudonym-key").is_file()


async def test_an_unreadable_page_leaves_the_capture_to_ocr(tmp_path):
    browser = FakeBrowser(fail=True)
    shot = tmp_path / "s.png"
    assert await protected_screenshot(
        browser, shot, project_dir=tmp_path, spec_dir=None, base=tmp_path
    )
    assert browser.calls == ["collect", "screenshot"]
    assert read_page_check(shot) is None


async def test_turned_off_the_page_is_not_read(tmp_path, monkeypatch):
    monkeypatch.setenv("CAPTURES_MASK", "false")
    browser = FakeBrowser()
    assert await protected_screenshot(
        browser, tmp_path / "s.png", project_dir=tmp_path, spec_dir=None, base=tmp_path
    )
    assert browser.calls == ["screenshot"]


class FakeTarget:
    def __init__(self, name="web", kind="web-frontend"):
        self.name, self.kind = name, kind


class FakeToolbox:
    def __init__(
        self, root: Path, browser: FakeBrowser, origin="http://127.0.0.1:6100"
    ):
        self.project_dir = root
        self.base = root / "verify"
        self._browser = browser
        self._origin = origin

    def target(self, wanted, kinds=()):
        return FakeTarget()

    def url_of(self, target):
        return self._origin

    async def browser(self, target):
        return self._browser


RECORD = {
    "screenshots": [
        {"path": "a.png", "label": "web final state", "target": "web",
         "platform": "web", "url": "http://127.0.0.1:5173/orders?tab=2"},
        {"path": "b.png", "label": "web mobile view", "target": "web",
         "platform": "web", "url": "http://127.0.0.1:5173/orders?tab=2", "variant": "mobile"},
        {"path": "c.png", "label": "again", "platform": "web",
         "url": "http://127.0.0.1:5173/orders?tab=2"},
        {"path": "d.png", "label": "Base branch", "platform": "web",
         "url": "http://127.0.0.1:5173/", "compare": "base"},
        {"path": "e.png", "label": "window", "platform": "desktop", "url": ""},
        {"path": "f.png", "label": "file", "platform": "web", "url": "file:///etc/passwd"},
    ]
}  # fmt: skip


async def test_the_base_side_opens_each_captured_page_on_its_own_app(tmp_path):
    spec = tmp_path / "001-x"
    browser = FakeBrowser()
    toolbox = FakeToolbox(tmp_path, browser)
    filed = await capture_side(toolbox, RECORD, "base", spec, tmp_path / "shots")
    assert filed == 2
    navigations = [c for c in browser.calls if c.startswith("navigate")]
    assert navigations == [
        "navigate http://127.0.0.1:6100/orders?tab=2",
        "navigate http://127.0.0.1:6100/orders?tab=2",
    ]
    assert "emulate mobile" in browser.calls and browser.calls[-1] == "emulate desktop"
    captures = {c.key: c for c in spec_captures(spec)}
    assert set(captures) == {"web|orders|", "web|orders||mobile"}
    assert all(c.side == "base" for c in captures.values())
    # The page check travelled with the filed capture.
    for capture in captures.values():
        assert read_page_check(spec / capture.path) is not None


def _record_shot(spec: Path) -> None:
    from docintel.visual_qa import save_capture

    buffer = io.BytesIO()
    Image.new("RGB", (30, 20)).save(buffer, format="PNG")
    save_capture(spec, buffer.getvalue(), side="task", url="http://127.0.0.1:5173/")


@pytest.mark.parametrize(
    ("changed", "status", "compares"),
    [
        (["src/App.tsx"], "pass", True),
        (["src/App.tsx"], "unknown", False),
        (["api/orders.py"], "pass", False),
    ],
)
async def test_after_the_loop_the_base_runs_only_for_a_screen_change(
    tmp_path, monkeypatch, changed, status, compares
):
    monkeypatch.setattr(
        "docintel.ocr.ocr_image",
        lambda *a, **k: OcrOutcome(reason="not-installed", engine="tesseract"),
    )
    spec = tmp_path / "spec"
    _record_shot(spec)
    seen: list = []

    async def compare(project, spec_dir):
        seen.append(spec_dir)

    payload = await after_verify(
        tmp_path, spec, {"status": status}, changed, compare=compare
    )
    assert bool(seen) is compares
    assert payload["decision"]["needed"] is (changed == ["src/App.tsx"])
    assert (spec / "captures" / "publication.json").is_file()


async def test_a_broken_comparison_still_prepares_the_publication(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(
        "docintel.ocr.ocr_image",
        lambda *a, **k: OcrOutcome(reason="empty", engine="tesseract"),
    )
    spec = tmp_path / "spec"
    _record_shot(spec)

    async def compare(project, spec_dir):
        raise RuntimeError("base branch gone")

    payload = await after_verify(
        tmp_path, spec, {"status": "pass"}, ["a.vue"], compare=compare
    )
    assert payload["publishable"] == 1


async def test_nothing_happens_without_a_spec_and_nothing_raises(tmp_path, monkeypatch):
    assert await after_verify(tmp_path, None, {}, []) is None

    def broken(*_a, **_k):
        raise RuntimeError("boom")

    monkeypatch.setattr("pr_captures.publication.build_publication", broken)
    assert await after_verify(tmp_path, tmp_path / "s", {"status": "x"}, []) is None
    assert captures_step  # the module stays importable on its own
