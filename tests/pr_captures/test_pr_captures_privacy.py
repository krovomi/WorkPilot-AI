"""Personal data replaced by fakes: in the page before the shot, on the image after."""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from docintel.engines.base import OcrBox, OcrOutcome
from PIL import Image, ImageDraw
from pr_captures import privacy
from pr_captures.privacy import (
    PageCheck,
    apply_script,
    collect_script,
    find_spans,
    local_ocr_env,
    page_mapping,
    protect_capture,
    read_page_check,
    restore_script,
    write_page_check,
)

KEY = b"k" * 32


def _answer(payload: dict) -> str:
    encoded = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
    return f"Script ran on page and returned:\n'WPPAGE:{encoded}:WPPAGE'"


def test_spans_find_each_kind_and_leave_dates_alone():
    line = (
        "Jeanne j.martin@acme.fr +33 6 12 34 56 78 "
        "FR76 3000 6000 0112 3456 7890 189 4111 1111 1111 1111 le 2026-11-28 10:30"
    )
    kinds = [kind for _s, _e, kind in find_spans(line)]
    assert kinds == ["email", "phone", "iban", "card"]
    assert find_spans("Commande du 2026-11-28 10:30:00, total 1 234,50 €") == []
    # Not a Luhn number: not a card (it may still read as a phone).
    assert "card" not in [k for _s, _e, k in find_spans("4111 1111 1111 1112")]


def test_the_page_answer_becomes_a_mapping_without_keeping_text_around():
    answer = _answer(
        {
            "lang": "fr-FR",
            "fields": [
                ["email", "jeanne@acme.fr"],
                ["name", "Jeanne Martin"],
                ["auto", "06 12 34 56 78"],
                ["phone", "12"],
                ["card", "4111 1111 1111 1112"],
            ],
            "texts": ["jeanne@acme.fr", "paul@acme.fr"],
        }
    )
    mapping, kinds = page_mapping(answer, KEY)
    assert set(mapping) == {
        "jeanne@acme.fr",
        "Jeanne Martin",
        "06 12 34 56 78",
        "paul@acme.fr",
    }
    assert mapping["jeanne@acme.fr"].endswith("@exemple.fr")
    assert kinds == ["email", "name", "phone"]


@pytest.mark.parametrize(
    "answer",
    ["MCP tool error: page closed", "WPPAGE:!!!:WPPAGE", _answer({"x": 1})[:-10], ""],
)
def test_an_unreadable_page_is_none_not_an_empty_mapping(answer):
    assert page_mapping(answer, KEY) is None


def test_selectors_reach_the_script_as_data():
    script = collect_script(['"]); alert(1); (["'])
    assert "alert(1)" in script
    # json.dumps quoted it: the selector is one string of the array.
    assert json.dumps('"]); alert(1); (["') in script
    mapping_script = apply_script({"a'b": "c</script>"})
    assert json.dumps([["a'b", "c</script>"]], ensure_ascii=False) in mapping_script


def test_the_page_check_is_kept_beside_its_capture(tmp_path):
    image = tmp_path / "shot.png"
    image.write_bytes(b"x")
    assert read_page_check(image) is None
    assert write_page_check(image, PageCheck(2, ["email"], ["a@exemple.fr"]))
    assert read_page_check(image) == PageCheck(2, ["email"], ["a@exemple.fr"])
    (tmp_path / "shot.png.privacy.json").write_text(
        '{"page": {"replaced": "2"}}', encoding="utf-8"
    )
    assert read_page_check(image) is None


def test_only_local_ocr_engines_are_asked():
    env = local_ocr_env(
        {"DOCINTEL_OCR_ENGINE": "azure-document-intelligence,tesseract"}
    )
    assert env["DOCINTEL_OCR_ENGINE"] == "tesseract"
    assert (
        local_ocr_env({"DOCINTEL_OCR_ENGINE": "azure-document-intelligence"})[
            "DOCINTEL_OCR_ENGINE"
        ]
        == "tesseract"
    )


# -- the image -----------------------------------------------------------------


def _screen(path: Path) -> Path:
    picture = Image.new("RGB", (400, 80), (250, 250, 250))
    draw = ImageDraw.Draw(picture)
    draw.rectangle((10, 10, 200, 30), fill=(20, 20, 20))
    from PIL import PngImagePlugin

    meta = PngImagePlugin.PngInfo()
    meta.add_text("Comment", "jeanne@acme.fr")
    picture.save(path, pnginfo=meta)
    return path


def _ocr(monkeypatch, outcome: OcrOutcome) -> list:
    calls: list = []

    def fake(image, env, *, policy_paths=(), preview=False):
        calls.append(env)
        return outcome

    monkeypatch.setattr("docintel.ocr.ocr_image", fake)
    return calls


def test_ocr_found_data_is_repainted_with_its_fake(tmp_path, monkeypatch):
    source = _screen(tmp_path / "shot.png")
    outcome = OcrOutcome(
        text="Contact jeanne@acme.fr",
        engine="tesseract",
        boxes=(
            OcrBox("Contact", 10, 10, 60, 20, line=0),
            OcrBox("jeanne@acme.fr", 80, 10, 120, 20, line=0),
        ),
    )
    _ocr(monkeypatch, outcome)
    target = tmp_path / "out" / "shot.png"
    result = protect_capture(source, target, key=KEY, env={})
    assert result.status == "pseudonymized"
    assert result.kinds == ["email"]
    assert result.checks == ["ocr:tesseract"]
    with Image.open(source) as before, Image.open(target) as after:
        assert "Comment" not in after.info
        # The word before the e-mail is left as it was.
        assert before.getpixel((30, 20)) == after.getpixel((30, 20))
        region = [after.getpixel((x, 20)) for x in range(80, 200)]
        assert region != [before.getpixel((x, 20)) for x in range(80, 200)]


def test_a_value_without_a_place_on_the_image_withholds_it(tmp_path, monkeypatch):
    source = _screen(tmp_path / "shot.png")
    _ocr(
        monkeypatch,
        OcrOutcome(text="jeanne@acme.fr", engine="tesseract", boxes=()),
    )
    result = protect_capture(source, tmp_path / "o.png", key=KEY, env={})
    assert (result.status, result.notes) == ("withheld", ["ocr:no-boxes"])
    assert not (tmp_path / "o.png").exists()


def test_no_check_at_all_is_unchecked_and_writes_nothing(tmp_path, monkeypatch):
    source = _screen(tmp_path / "shot.png")
    _ocr(monkeypatch, OcrOutcome(reason="not-installed", engine="tesseract"))
    result = protect_capture(source, tmp_path / "o.png", key=KEY, env={})
    assert result.status == "unchecked"
    assert result.notes == ["ocr:not-installed"]
    assert not result.checked
    assert not (tmp_path / "o.png").exists()


def test_a_page_checked_before_the_shot_is_enough_without_ocr(tmp_path, monkeypatch):
    source = _screen(tmp_path / "shot.png")
    write_page_check(source, PageCheck(3, ["email"], ["camille.robert@exemple.fr"]))
    _ocr(monkeypatch, OcrOutcome(reason="not-installed", engine="tesseract"))
    result = protect_capture(source, tmp_path / "o.png", key=KEY, env={})
    assert (result.status, result.replaced, result.checks) == (
        "pseudonymized",
        3,
        ["page"],
    )
    assert (tmp_path / "o.png").is_file()


def test_ocr_leaves_the_page_s_own_fakes_alone(tmp_path, monkeypatch):
    source = _screen(tmp_path / "shot.png")
    write_page_check(source, PageCheck(1, ["email"], ["camille.robert@exemple.fr"]))
    _ocr(
        monkeypatch,
        OcrOutcome(
            text="camille.robert@exemple.fr",
            engine="tesseract",
            boxes=(OcrBox("camille.robert@exemple.fr", 10, 10, 190, 20, line=0),),
        ),
    )
    result = protect_capture(source, tmp_path / "o.png", key=KEY, env={})
    assert result.status == "pseudonymized"
    assert result.replaced == 1
    with Image.open(source) as before, Image.open(tmp_path / "o.png") as after:
        assert before.convert("RGB").tobytes() == after.convert("RGB").tobytes()


def test_a_broken_secret_table_fails_closed(tmp_path, monkeypatch):
    source = _screen(tmp_path / "shot.png")
    _ocr(
        monkeypatch,
        OcrOutcome(
            text="token", engine="tesseract", boxes=(OcrBox("token", 1, 1, 5, 5),)
        ),
    )

    def broken(_text):
        raise RuntimeError("no table")

    monkeypatch.setattr("docintel.redact.find_secrets", broken)
    result = protect_capture(source, tmp_path / "o.png", key=KEY, env={})
    assert result.status == "withheld"


def test_too_much_personal_data_withholds_the_capture(tmp_path, monkeypatch):
    source = _screen(tmp_path / "shot.png")
    lines = [f"user{i}@acme.fr" for i in range(privacy.MAX_VALUES + 1)]
    boxes = tuple(OcrBox(t, 1, 1, 10, 2, line=i) for i, t in enumerate(lines))
    _ocr(monkeypatch, OcrOutcome(text="\n".join(lines), engine="t", boxes=boxes))
    result = protect_capture(source, tmp_path / "o.png", key=KEY, env={})
    assert (result.status, result.notes) == ("withheld", ["too-much-personal-data"])


def test_turned_off_the_copy_is_only_re_encoded(tmp_path, monkeypatch):
    source = _screen(tmp_path / "shot.png")
    calls = _ocr(monkeypatch, OcrOutcome(text="x"))
    result = protect_capture(source, tmp_path / "o.png", key=KEY, env={}, enabled=False)
    assert (result.status, result.notes) == ("clean", ["protect:off"])
    assert calls == []
    with Image.open(tmp_path / "o.png") as copy:
        assert "Comment" not in copy.info


def test_an_unreadable_capture_is_not_published(tmp_path):
    bad = tmp_path / "bad.png"
    bad.write_bytes(b"not an image")
    assert protect_capture(bad, tmp_path / "o.png", key=KEY, env={}).status == "failed"


# -- the scripts in a real browser ----------------------------------------------


PAGE = """<!doctype html><html lang="fr"><body>
<h1>Mon compte</h1>
<input id="mail" type="email" value="jeanne@acme.fr">
<input id="pwd" type="password" value="hunter22">
<input id="who" autocomplete="name" value="Jeanne Martin">
<p id="note">Rappeler au +33 6 12 34 56 78 avant le 2026-11-28.</p>
<span id="cust" data-private>Client 0042</span>
<p id="plain">Bonjour</p>
</body></html>"""


def _chromium():
    sync_api = pytest.importorskip("playwright.sync_api")
    playwright = sync_api.sync_playwright().start()
    from foundation.platform.browser import chrome_executable

    options: dict = {"headless": True, "args": ["--no-sandbox"]}
    if chrome_executable():
        options["executable_path"] = chrome_executable()
    try:
        browser = playwright.chromium.launch(**options)
    except Exception as exc:  # noqa: BLE001 - no browser in this environment
        playwright.stop()
        pytest.skip(f"no Chromium: {exc}")
    return playwright, browser


def test_the_scripts_swap_the_page_and_put_it_back():
    playwright, browser = _chromium()
    try:
        page = browser.new_page()
        page.set_content(PAGE)
        answer = f"Script ran on page and returned:\n{page.evaluate(collect_script(['#cust']))!r}"
        mapping, kinds = page_mapping(answer, KEY)
        assert "jeanne@acme.fr" in mapping
        assert "Jeanne Martin" in mapping
        assert "+33 6 12 34 56 78" in mapping
        assert "Client 0042" in mapping
        assert "hunter22" not in mapping
        assert not any("2026" in value for value in mapping)
        assert {"email", "name", "phone"} <= set(kinds)

        assert page.evaluate(apply_script(mapping)).startswith("replaced=")
        assert page.input_value("#mail") == mapping["jeanne@acme.fr"]
        assert page.input_value("#who") == mapping["Jeanne Martin"]
        assert "+33 6" in page.inner_text("#note")
        assert "12 34 56 78" not in page.inner_text("#note")
        assert page.inner_text("#cust") == mapping["Client 0042"]
        assert page.input_value("#pwd") == "hunter22"
        assert page.inner_text("#plain") == "Bonjour"

        page.evaluate(restore_script())
        assert page.input_value("#mail") == "jeanne@acme.fr"
        assert page.input_value("#who") == "Jeanne Martin"
        assert "12 34 56 78" in page.inner_text("#note")
        assert page.inner_text("#cust") == "Client 0042"
    finally:
        browser.close()
        playwright.stop()


def test_a_selector_the_browser_refuses_only_drops_itself():
    playwright, browser = _chromium()
    try:
        page = browser.new_page()
        page.set_content(PAGE)
        raw = page.evaluate(collect_script(["::nonsense(", "#cust"]))
        mapping, _kinds = page_mapping(raw, KEY)
        assert "Client 0042" in mapping
    finally:
        browser.close()
        playwright.stop()
