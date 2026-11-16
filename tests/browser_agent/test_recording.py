"""A recording read back from JSON keeps only what the closed lists allow."""

from __future__ import annotations

from browser_agent.recording import (
    MAX_STEPS,
    MAX_VALUE,
    RecordedStep,
    Recording,
    Selector,
    clean_line,
    clean_value,
    is_web_url,
)

BUTTON = {"strategy": "role", "role": "button", "value": "Save"}


def test_page_text_is_one_bounded_line() -> None:
    assert clean_line("  Sign\n\tin \x00 now ") == "Sign in now"
    assert clean_line(42) == ""
    assert len(clean_line("x" * 500)) == 200
    assert clean_value("a\nb\x07") == "a\nb"
    assert clean_value(None) == ""
    assert len(clean_value("y" * 5000)) == MAX_VALUE


def test_a_selector_outside_the_closed_lists_is_dropped() -> None:
    assert Selector.from_dict(BUTTON) == Selector("role", "Save", "button")
    assert (
        Selector.from_dict({"strategy": "role", "role": "evil", "value": "x"}) is None
    )
    assert Selector.from_dict({"strategy": "xpath", "value": "//a"}) is None
    assert Selector.from_dict({"strategy": "css", "value": ""}) is None
    assert Selector.from_dict("css") is None
    css = Selector.from_dict({"strategy": "css", "value": "#a", "role": "button"})
    assert css == Selector("css", "#a") and css.to_dict() == {
        "strategy": "css",
        "value": "#a",
    }


def test_each_kind_of_step_round_trips() -> None:
    steps = [
        {"id": "s1", "kind": "navigate", "url": "https://shop.test/", "selectors": []},
        {"id": "s2", "kind": "click", "selectors": [BUTTON]},
        {"id": "s3", "kind": "fill", "selectors": [BUTTON], "value": "Ada"},
        {
            "id": "s4",
            "kind": "fill",
            "selectors": [BUTTON],
            "secretEnv": "E2E_PASSWORD",
        },
        {"id": "s5", "kind": "select", "selectors": [BUTTON], "value": "fr"},
        {"id": "s6", "kind": "press", "selectors": [BUTTON], "key": "Enter"},
        {"id": "s7", "kind": "assert_text", "selectors": [BUTTON], "text": "Saved"},
    ]
    recording = Recording.from_dict({"steps": steps})
    assert [s.to_dict() for s in recording.steps] == steps
    assert recording.to_dict()["truncated"] is False


def test_an_invalid_step_is_dropped() -> None:
    bad = [
        "s1",
        {"id": "x1", "kind": "click", "selectors": [BUTTON]},
        {"id": "s1", "kind": "eval", "selectors": [BUTTON]},
        {"id": "s1", "kind": "navigate", "url": "javascript:alert(1)"},
        {"id": "s1", "kind": "click", "selectors": "button"},
        {"id": "s1", "kind": "click", "selectors": [{"strategy": "xpath"}]},
        {"id": "s1", "kind": "press", "selectors": [BUTTON], "key": "F12"},
        {"id": "s1", "kind": "assert_text", "selectors": [BUTTON], "text": " "},
    ]
    assert all(RecordedStep.from_dict(item) is None for item in bad)


def test_a_secret_env_name_outside_the_pattern_keeps_no_secret() -> None:
    step = RecordedStep.from_dict(
        {"id": "s1", "kind": "fill", "selectors": [BUTTON], "secretEnv": "x; rm -rf"}
    )
    assert step is not None and step.secret_env == "" and step.value == ""


def test_duplicates_are_dropped_and_the_length_is_capped() -> None:
    click = {"kind": "click", "selectors": [BUTTON]}
    items = [{"id": f"s{i}", **click} for i in range(1, MAX_STEPS + 3)]
    recording = Recording.from_dict({"steps": [items[0], *items]})
    assert len(recording.steps) == MAX_STEPS and recording.truncated is True
    assert Recording.from_dict([]).steps == []
    assert Recording.from_dict({"steps": "all"}).steps == []


def test_only_web_urls_are_navigated_to() -> None:
    assert is_web_url("http://localhost:3000/login")
    assert not is_web_url("file:///etc/passwd")
    assert not is_web_url("https://")
