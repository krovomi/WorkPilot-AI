"""`run_secure`: an allowlisted command, a bounded wait, a result that never raises
unless asked to."""

from __future__ import annotations

import subprocess

import pytest
from security import secure_subprocess as ss
from security.secure_subprocess import (
    MAX_TIMEOUT,
    SubprocessResult,
    SubprocessSecurityError,
    run_secure,
)


def test_an_allowlisted_command_runs(tmp_path):
    result = run_secure(["git", "--version"], cwd=str(tmp_path))
    assert result.success is True
    assert result.stdout.startswith("git version")
    assert result.command == "git --version"


@pytest.mark.parametrize("args", [[], ["curl", "https://example.com"]])
def test_anything_else_is_refused_before_it_runs(args):
    with pytest.raises(SubprocessSecurityError):
        run_secure(args)


def test_check_raises_on_failure_and_returns_otherwise(tmp_path):
    failed = run_secure(["git", "no-such-subcommand"], cwd=str(tmp_path))
    assert (failed.success, failed.returncode != 0) == (False, True)
    with pytest.raises(SubprocessSecurityError, match="failed with return code"):
        run_secure(["git", "no-such-subcommand"], cwd=str(tmp_path), check=True)


def test_the_wait_is_capped_and_a_timeout_is_a_result(monkeypatch):
    seen = {}

    def hang(cmd, timeout, **_kwargs):
        seen["timeout"] = timeout
        raise subprocess.TimeoutExpired(cmd, timeout)

    monkeypatch.setattr(ss.subprocess, "run", hang)

    result = run_secure(["git", "fetch"], timeout=10_000)

    assert seen["timeout"] == MAX_TIMEOUT
    assert (result.timed_out, result.success, result.returncode) == (True, False, -1)


def test_a_missing_tool_is_a_result(monkeypatch):
    def missing(cmd, **_kwargs):
        raise FileNotFoundError(cmd[0])

    monkeypatch.setattr(ss.subprocess, "run", missing)

    result = run_secure(["gh", "auth", "status"])

    assert (result.returncode, result.stderr) == (-1, "Command not found: gh")


def test_success_needs_both_a_zero_code_and_no_timeout():
    assert SubprocessResult(0, "", "", "x").success is True
    assert SubprocessResult(0, "", "", "x", timed_out=True).success is False
