"""rtk, against whatever rtk the machine really has.

`test_rtk_rewrite.py` proves WorkPilot reads the exit-code protocol correctly.
It cannot prove the protocol is still what rtk implements: every one of its
assertions is fed a string somebody here wrote, so it tests our idea of rtk.

These assert what must hold *whatever* version is installed, and skip when
none is. They never assert that a particular command is condensable — rtk's
table grows and shrinks, and a test that pins one entry of it is a test that
gets disabled within a month. What they pin is the shape of the contract:

  - `rtk rewrite` exists and answers with one of the four documented codes;
  - a rewrite it produces is a command line, not a diagnostic;
  - `rtk gain --format json` yields a summary object;
  - a command rtk rewrote still, when unwrapped, names itself to the allowlist.

That last one is the one that matters. It is the joint between rtk's output
and WorkPilot's security layer, and it is the joint a new rtk release could
move without anyone here noticing.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "backend"))

import rtk  # noqa: E402
from rtk import runtime as rtk_runtime  # noqa: E402
from security.parser import extract_commands  # noqa: E402

pytestmark = pytest.mark.skipif(
    rtk_runtime.rtk_binary() is None,
    reason="rtk is not installed on this machine",
)

#: Commands that are common enough that rtk having *no* opinion on any of them
#: would mean the table is gone, not that one entry moved.
_LIKELY = ["git status", "ls -la", "git diff HEAD"]


def test_rtk_rewrite_exists_and_uses_the_documented_exit_codes():
    binary = rtk_runtime.rtk_binary()
    proc = subprocess.run(
        [binary, "rewrite", "git status"], capture_output=True, text=True, timeout=10
    )
    assert proc.returncode in (0, 1, 2, 3), (
        f"rtk rewrite answered {proc.returncode}; the four documented codes are "
        "0 (rewrite), 1 (no equivalent), 2 (denied), 3 (ask)"
    )


def test_at_least_one_ordinary_command_is_still_condensable():
    assert any(rtk.rewrite_command(command).changed for command in _LIKELY), (
        "rtk rewrote none of " + ", ".join(_LIKELY) + " — the registry moved"
    )


def test_a_rewrite_is_a_command_line_starting_with_rtk():
    for command in _LIKELY:
        result = rtk.rewrite_command(command)
        if not result.changed:
            continue
        assert "rtk" in result.command.split()[0:3], result.command
        assert "\n" not in result.command


def test_a_rewritten_command_still_names_itself_to_the_allowlist():
    """The joint between rtk's table and WorkPilot's security layer.

    Whatever rtk rewrites `git status` into, the allowlist must still see a
    command it can judge — and never the bare word `rtk`.
    """
    for command in _LIKELY:
        result = rtk.rewrite_command(command)
        if not result.changed:
            continue
        seen = extract_commands(result.command)
        assert seen, result.command
        assert seen != ["rtk"], (
            f"{result.command!r} reaches the allowlist as 'rtk' alone — "
            "rtk introduced a subcommand name unwrap_rtk does not know"
        )


def test_rtk_preserves_the_exit_code():
    """The property the whole integration rests on: only the output changes."""
    binary = rtk_runtime.rtk_binary()
    ok = subprocess.run([binary, "true"], capture_output=True, timeout=10)
    ko = subprocess.run([binary, "false"], capture_output=True, timeout=10)
    assert ok.returncode == 0
    assert ko.returncode != 0


def test_gain_reports_a_summary_object():
    binary = rtk_runtime.rtk_binary()
    proc = subprocess.run(
        [binary, "gain", "--format", "json"], capture_output=True, text=True, timeout=10
    )
    if proc.returncode != 0:
        pytest.skip("rtk gain has no ledger on this machine")
    payload = json.loads(proc.stdout)
    assert "summary" in payload
    for field in ("total_commands", "total_input", "total_output", "total_saved"):
        assert field in payload["summary"], field


def test_read_savings_never_raises(tmp_path):
    savings = rtk.read_savings(tmp_path)
    assert isinstance(savings.saved_tokens, int)


def test_the_doctor_answers_without_a_network_or_a_model():
    report = rtk.doctor()
    assert report.installed
    assert report.state in ("active", "degraded", "disabled")
    assert {check.name for check in report.checks} == {
        "install",
        "version",
        "enabled",
        "terminal-hook",
    }
