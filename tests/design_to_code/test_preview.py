"""The page the browser opens for each stack."""

from __future__ import annotations

from design_to_code.preview import (
    MAX_PREVIEW_CHARS,
    extract_html,
    html_page,
    mirror_prompt,
)


def test_the_html_stack_renders_its_first_safe_page() -> None:
    files = {"styles.css": "", "../evil.html": "", "pricing/card.HTML": "", "b.htm": ""}
    assert html_page(files) == "pricing/card.HTML"
    assert html_page({"a.css": ""}) is None


def test_the_mirror_prompt_names_the_stack_the_size_and_the_files() -> None:
    prompt = mirror_prompt(
        {"lib/card.dart": "Card()"}, stack_label="Flutter", width=390, height=844
    )
    assert "The Flutter files" in prompt and "390x844 px" in prompt
    assert "<<<FILE lib/card.dart>>>\nCard()\n<<<END FILE>>>" in prompt
    assert "no <script>" in prompt


def test_the_html_of_an_answer_is_kept_from_its_doctype() -> None:
    assert (
        extract_html("```html\n<!DOCTYPE html><p>a</p>\n```")
        == "<!DOCTYPE html><p>a</p>"
    )
    assert extract_html("Here: <html><p>b</p></html>") == "<html><p>b</p></html>"


def test_no_html_or_too_much_of_it_is_none() -> None:
    assert extract_html("") is None
    assert extract_html("sorry") is None
    assert extract_html("<html>" + "x" * MAX_PREVIEW_CHARS) is None
