"""The wrapper around the vendored table: its settings, its skips, its cap.

Everything here is about WorkPilot's own code. What the table itself does with
a given codepoint is `test_watermarks_vendor.py`'s question — the two are kept
apart so that moving the pin fails the contract test with a useful message
instead of scattering failures through the wrapper's suite.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from watermarks import clean as wm_clean  # noqa: E402
from watermarks import settings as wm_settings  # noqa: E402
from watermarks.clean import clean_generated  # noqa: E402

ZWSP = "​"
NBSP = " "


def test_ascii_content_takes_the_fast_path():
    result = clean_generated("def add(a, b):\n    return a + b\n")
    assert result.changed is False
    assert result.skipped == "ascii"


def test_a_zero_width_space_is_stripped_and_reported():
    result = clean_generated(f"const a ={ZWSP} 1;")
    assert result.text == "const a = 1;"
    assert result.changed is True
    assert result.skipped == ""
    assert result.removed_count == 1
    assert any("200B" in label for label in result.removed)


def test_a_no_break_space_survives_by_default():
    """French typography, and every `fr/*.json` this repository ships."""
    source = f"Voulez-vous continuer{NBSP}?"
    assert clean_generated(source).text == source


def test_a_no_break_space_is_normalised_when_asked():
    source = f"Voulez-vous continuer{NBSP}?"
    result = clean_generated(source, env={wm_settings.NORMALIZE_SPACES_ENV: "1"})
    assert result.text == "Voulez-vous continuer ?"
    assert result.changed is True
    assert result.replaced_count == 1


def test_a_well_formed_bidi_run_survives_by_default_and_not_under_hardening():
    source = "name = ‫مرحبا‬"
    assert clean_generated(source).text == source
    hardened = clean_generated(source, env={wm_settings.STRIP_BIDI_ENV: "1"})
    assert hardened.text == "name = مرحبا"
    assert hardened.changed is True


def test_the_master_switch_turns_it_off():
    source = f"a{ZWSP}b"
    result = clean_generated(source, env={wm_settings.ENABLED_ENV: "0"})
    assert result.text == source
    assert result.changed is False
    assert result.skipped == "disabled"


def test_content_above_the_cap_is_passed_through_and_says_so():
    source = f"{ZWSP}" + "é" * 100
    result = clean_generated(source, env={wm_settings.MAX_BYTES_ENV: "10"})
    assert result.text == source
    assert result.changed is False
    assert result.skipped == "too-large"


def test_a_nonsense_cap_falls_back_to_the_default_rather_than_disabling():
    """`WATERMARKS_ENABLED=0` is how you turn it off; a size is not."""
    for raw in ("0", "-1", "banana", ""):
        result = clean_generated(f"a{ZWSP}b", env={wm_settings.MAX_BYTES_ENV: raw})
        assert result.text == "ab", f"cap {raw!r} silently disabled cleaning"


def test_a_checkout_without_the_vendored_tree_writes_what_the_model_produced(
    monkeypatch,
):
    monkeypatch.setattr(wm_clean, "engine", lambda: None)
    source = f"a{ZWSP}b"
    result = clean_generated(source)
    assert result.text == source
    assert result.skipped == "no-engine"


def test_an_engine_that_raises_never_reaches_the_caller(monkeypatch):
    class Exploding:
        @staticmethod
        def clean_text(*args, **kwargs):
            raise RuntimeError("upstream changed its mind")

    monkeypatch.setattr(wm_clean, "engine", lambda: Exploding)
    source = f"a{ZWSP}b"
    result = clean_generated(source)
    assert result.text == source
    assert result.skipped == "error"


@pytest.mark.parametrize("value", ["", None, 42, [], {}])
def test_empty_and_non_string_input_is_returned_untouched(value):
    result = clean_generated(value)
    assert result.text == value
    assert result.changed is False


def test_project_env_is_read_from_workpilot_dotenv(tmp_path):
    workpilot = tmp_path / ".workpilot"
    workpilot.mkdir()
    (workpilot / ".env").write_text(
        "\n".join(
            [
                "# a comment",
                "UNRELATED_KEY=ignored",
                'WATERMARKS_NORMALIZE_SPACES="true"',
                "WATERMARKS_ENABLED=0",
            ]
        ),
        encoding="utf-8",
    )
    values = wm_settings.project_env(tmp_path)
    assert values == {
        "WATERMARKS_NORMALIZE_SPACES": "true",
        "WATERMARKS_ENABLED": "0",
    }


def test_an_exported_variable_wins_over_the_project_file(tmp_path, monkeypatch):
    workpilot = tmp_path / ".workpilot"
    workpilot.mkdir()
    (workpilot / ".env").write_text("WATERMARKS_ENABLED=0\n", encoding="utf-8")
    monkeypatch.setenv("WATERMARKS_ENABLED", "1")
    applied = wm_settings.apply_project_env(tmp_path)
    assert applied == {}
    assert wm_settings.is_enabled() is True
