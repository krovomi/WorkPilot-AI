"""Before/after pairs read from the captures store, each copy checked before it can leave."""

from __future__ import annotations

import io
import json

from docintel.engines.base import OcrOutcome
from docintel.visual_qa import save_capture, spec_captures
from PIL import Image
from pr_captures.decide import CaptureDecision
from pr_captures.privacy import PageCheck, write_page_check
from pr_captures.publication import (
    MAX_ITEMS,
    PUBLICATION_FILE,
    build_publication,
    load_publication,
)
from pr_captures.settings import CaptureSettings

NEEDED = CaptureDecision(True, "ui-files", ui_files=["src/App.tsx"])


def _png(colour=(200, 200, 200)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (40, 20), colour).save(buffer, format="PNG")
    return buffer.getvalue()


def _file(spec, side, url, platform="web", variant="", checked=True):
    saved = save_capture(
        spec,
        _png(),
        side=side,
        platform=platform,
        source="verifier",
        url=url,
        label=f"{side} {url}",
        variant=variant,
    )
    assert saved.status == "saved"
    if checked:
        write_page_check(spec / saved.path, PageCheck(0, [], []))
    return spec / saved.path


def _no_ocr(monkeypatch):
    monkeypatch.setattr(
        "docintel.ocr.ocr_image",
        lambda *a, **k: OcrOutcome(reason="not-installed", engine="tesseract"),
    )


def test_a_variant_is_its_own_screen_in_the_store(tmp_path):
    spec = tmp_path / "001-x"
    desktop = _file(spec, "task", "http://127.0.0.1:5173/orders")
    phone = _file(spec, "task", "http://127.0.0.1:5173/orders", variant="mobile")
    assert desktop != phone
    assert phone.name == "web--orders--mobile.png"
    keys = {c.key: c for c in spec_captures(spec)}
    assert set(keys) == {"web|orders|", "web|orders||mobile"}
    assert keys["web|orders||mobile"].variant == "mobile"
    assert keys["web|orders||mobile"].locale == ""
    refused = save_capture(spec, _png(), side="task", url="http://x/a", variant="../x")
    assert refused.status == "saved"
    assert refused.path == "captures/task/web--a.png"


def test_base_and_task_of_one_screen_pair_up(tmp_path, monkeypatch):
    _no_ocr(monkeypatch)
    spec = tmp_path / "001-x"
    _file(spec, "base", "http://127.0.0.1:6001/orders")
    _file(spec, "task", "http://127.0.0.1:5173/orders")
    _file(spec, "task", "http://127.0.0.1:5173/orders", variant="mobile")
    _file(spec, "base", "http://127.0.0.1:6001/gone")

    payload = build_publication(spec, decision=NEEDED, settings=CaptureSettings())
    assert [i["key"] for i in payload["items"]] == ["web|orders|", "web|orders||mobile"]
    first = payload["items"][0]
    assert first["before"]["publishable"] and first["after"]["publishable"]
    assert first["after"]["file"] == "captures/published/task/web--orders.png"
    assert (spec / first["after"]["file"]).is_file()
    assert payload["items"][1]["before"] is None
    assert (payload["publishable"], payload["withheld"]) == (2, 0)
    assert load_publication(spec)["items"] == payload["items"]


def test_an_unchecked_capture_stays_on_the_task_unless_the_team_says(
    tmp_path, monkeypatch
):
    _no_ocr(monkeypatch)
    spec = tmp_path / "001-x"
    _file(spec, "task", "", platform="android", checked=False)

    held = build_publication(spec, decision=NEEDED, settings=CaptureSettings())
    item = held["items"][0]
    assert item["publishable"] is False
    assert item["after"]["file"] == ""
    assert item["after"]["privacy"]["status"] == "unchecked"
    assert item["after"]["privacy"]["notes"] == ["ocr:not-installed"]
    assert held["withheld"] == 1
    assert not (spec / "captures" / "published").exists() or not any(
        (spec / "captures" / "published").rglob("*.png")
    )

    allowed = build_publication(
        spec, decision=NEEDED, settings=CaptureSettings(publish_unchecked=True)
    )
    assert allowed["items"][0]["publishable"] is True
    assert (spec / allowed["items"][0]["after"]["file"]).is_file()


def test_a_capture_is_not_checked_twice_while_it_does_not_change(tmp_path, monkeypatch):
    spec = tmp_path / "001-x"
    _file(spec, "task", "http://127.0.0.1:5173/")
    calls: list = []

    def ocr(*_a, **_k):
        calls.append(1)
        return OcrOutcome(reason="empty", engine="tesseract")

    monkeypatch.setattr("docintel.ocr.ocr_image", ocr)
    build_publication(spec, decision=NEEDED, settings=CaptureSettings())
    build_publication(spec, decision=NEEDED, settings=CaptureSettings())
    assert len(calls) == 1
    build_publication(spec, decision=NEEDED, settings=CaptureSettings(mask=False))
    assert len(calls) == 1  # turned off: re-encoded, no OCR


def test_a_task_that_needs_none_lists_why_and_nothing_else(tmp_path, monkeypatch):
    _no_ocr(monkeypatch)
    spec = tmp_path / "001-x"
    _file(spec, "task", "http://127.0.0.1:5173/")
    payload = build_publication(
        spec,
        decision=CaptureDecision(False, "no-ui-files"),
        settings=CaptureSettings(),
    )
    assert payload["items"] == []
    assert payload["decision"]["reason"] == "no-ui-files"
    written = json.loads(
        (spec / "captures" / PUBLICATION_FILE).read_text(encoding="utf-8")
    )
    assert written["settings"] == {
        "publish": "auto",
        "protect": True,
        "publishUnchecked": False,
    }


def test_a_pull_request_shows_a_handful_of_screens(tmp_path, monkeypatch):
    _no_ocr(monkeypatch)
    spec = tmp_path / "001-x"
    for index in range(MAX_ITEMS + 3):
        _file(spec, "task", f"http://127.0.0.1:5173/page-{index:02d}")
    payload = build_publication(spec, decision=NEEDED, settings=CaptureSettings())
    assert len(payload["items"]) == MAX_ITEMS


def test_an_older_publication_shape_is_ignored(tmp_path):
    spec = tmp_path / "001-x"
    (spec / "captures").mkdir(parents=True)
    (spec / "captures" / PUBLICATION_FILE).write_text(
        '{"version": 0}', encoding="utf-8"
    )
    assert load_publication(spec) is None
    (spec / "captures" / PUBLICATION_FILE).write_text("not json", encoding="utf-8")
    assert load_publication(spec) is None
