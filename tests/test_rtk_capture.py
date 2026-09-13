"""WorkPilot's own captures — the half the agent hook does not reach.

The rule under test is the one that keeps this feature from breaking things:
rtk is for output a model reads, never for output code parses. There is no
global switch that would route every `subprocess.run` through it; a call site
opts in by calling `capture_for_model`, and that call is a statement about
where the output is going.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "backend"))

from rtk import capture_for_model  # noqa: E402
from rtk import runtime as rtk_runtime  # noqa: E402

from tests.rtk_fake import write_fake_rtk  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in (
        "RTK_ENABLED",
        "RTK_MODEL_FACING",
        "RTK_DISABLED",
        "WORKPILOT_RTK_PATH",
    ):
        monkeypatch.delenv(key, raising=False)
    rtk_runtime.reset_cache()
    yield
    rtk_runtime.reset_cache()


@pytest.fixture
def fake_rtk(tmp_path, monkeypatch):
    """An rtk that turns any command into `echo condensed`."""
    script = write_fake_rtk(tmp_path, rewrite="echo condensed")
    monkeypatch.setenv("WORKPILOT_RTK_PATH", str(script))
    rtk_runtime.reset_cache()
    return script


def test_a_capture_goes_through_rtk_when_it_can(fake_rtk):
    result = capture_for_model(["echo", "verbose"])
    assert result.condensed
    assert result.text.strip() == "condensed"


def test_the_command_that_actually_ran_is_reported(fake_rtk):
    """A reviewer reading a surprising excerpt needs to know it was filtered."""
    result = capture_for_model(["echo", "verbose"])
    assert result.command == "echo condensed"


def test_without_rtk_the_output_is_the_full_output(monkeypatch):
    monkeypatch.setenv("WORKPILOT_RTK_PATH", "/nonexistent/rtk")
    rtk_runtime.reset_cache()
    result = capture_for_model(["echo", "verbose"])
    assert not result.condensed
    assert result.text.strip() == "verbose"
    assert result.ok


def test_the_model_facing_switch_turns_captures_off_on_their_own(fake_rtk, monkeypatch):
    """The narrower switch: agent commands keep being rewritten, captures stop.

    They carry different risk. A rewritten agent command changes what a model
    reads; a condensed capture changes what a WorkPilot code path receives.
    """
    monkeypatch.setenv("RTK_MODEL_FACING", "false")
    result = capture_for_model(["echo", "verbose"])
    assert not result.condensed
    assert result.text.strip() == "verbose"


def test_a_failing_command_reports_its_return_code(monkeypatch):
    monkeypatch.setenv("WORKPILOT_RTK_PATH", "/nonexistent/rtk")
    rtk_runtime.reset_cache()
    result = capture_for_model(["false"])
    assert not result.ok
    assert result.returncode != 0


def test_a_timeout_is_reported_rather_than_raised(monkeypatch):
    monkeypatch.setenv("WORKPILOT_RTK_PATH", "/nonexistent/rtk")
    rtk_runtime.reset_cache()
    result = capture_for_model(["sleep", "5"], timeout=0.2)
    assert result.timed_out
    assert not result.ok


def test_a_missing_program_is_reported_rather_than_raised(monkeypatch):
    monkeypatch.setenv("WORKPILOT_RTK_PATH", "/nonexistent/rtk")
    rtk_runtime.reset_cache()
    result = capture_for_model(["definitely-not-a-program-here"])
    assert not result.ok


def test_a_rewrite_that_needs_a_shell_is_discarded(tmp_path, monkeypatch):
    """There is no shell here, and a rewrite is not a reason to start one.

    rtk composes the rewritten string, so running it through a shell would be
    handing shell syntax to a proxy's output. A rewrite that is not a plain
    argv is dropped and the original command runs: the condensing is worth a
    few hundred bytes and it is not worth that.
    """
    script = write_fake_rtk(tmp_path, rewrite="rtk ls | head -1")
    monkeypatch.setenv("WORKPILOT_RTK_PATH", str(script))
    rtk_runtime.reset_cache()

    result = capture_for_model(["echo", "verbose"])
    assert not result.condensed
    assert result.text.strip() == "verbose"


def test_the_capture_never_runs_through_a_shell():
    """A guard on the implementation, because the failure mode is silent.

    `shell=True` here would take a command line composed by an external binary
    and hand it to a shell. Bandit flags it HIGH, and a reviewer should not
    have to rely on that.
    """
    import rtk.capture as capture_module

    source = Path(capture_module.__file__).read_text(encoding="utf-8")
    assert "shell=True" not in source


def test_self_review_only_condenses_the_excerpt_a_model_reads(fake_rtk, tmp_path):
    """`--name-only` and `--numstat` feed a parser and must stay raw.

    Condensing them would save nothing — neither is ever sent to a model — and
    would silently break the file list and the insertion counter.
    """
    import agents.self_review as self_review

    source = Path(self_review.__file__).read_text(encoding="utf-8")

    # One opt-in, on the one call whose output reaches a prompt.
    assert source.count("for_model=True") == 1
    excerpt_call = '_git(["diff", "HEAD"], project_dir, for_model=True)'
    assert excerpt_call in source

    # And the two calls that feed a parser ask for nothing.
    for parsed in ('"--name-only"', '"--numstat"'):
        line = next(line for line in source.splitlines() if parsed in line)
        assert "for_model" not in line, (
            f"{parsed} is parsed by this module; it must not go through rtk"
        )
