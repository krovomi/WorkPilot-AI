"""Whether this machine starts a confined MCP server, as the app is told (#369 lot 6).

A server that must run confined is never started without the OS sandbox
(`core.mcp_confinement`). The app names why next to each such server, from
the same answer the backend applies: `machine_confinement`, printed by
``runners/mcp_sandbox_runner.py``. Each unavailable probe carries a kind the
app translates (`unsupported`, `missing`, `refused`); the English reason
stays the detail.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from core import mcp_confinement
from core.mcp_confinement import MachineConfinement, machine_confinement
from os_sandbox import launch
from os_sandbox.launch import (
    ISOLATED,
    MISSING,
    REFUSED,
    UNAVAILABLE,
    UNSUPPORTED,
    SandboxStatus,
)

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"


@pytest.fixture
def os_is(monkeypatch):
    def pretend(name: str) -> None:
        monkeypatch.setattr(launch, "is_linux", lambda: name == "linux")
        monkeypatch.setattr(launch, "is_macos", lambda: name == "macos")
        monkeypatch.setattr(launch, "is_windows", lambda: name == "windows")

    launch.probe.cache_clear()
    yield pretend
    launch.probe.cache_clear()


def _run_answers(monkeypatch, *, code=0, raises=None):
    def run(argv, **_kwargs):
        if raises is not None:
            raise raises
        return subprocess.CompletedProcess(argv, code, "", "refused")

    monkeypatch.setattr(launch.subprocess, "run", run)


@pytest.mark.parametrize(
    ("bwrap", "answer", "kind"),
    [
        (None, {}, MISSING),
        ("/usr/bin/bwrap", {"code": 1}, REFUSED),
        ("/usr/bin/bwrap", {"raises": OSError("no exec")}, REFUSED),
        ("/usr/bin/bwrap", {}, None),
    ],
)
def test_each_linux_answer_has_its_kind(os_is, monkeypatch, bwrap, answer, kind):
    os_is("linux")
    monkeypatch.setattr(launch, "_bwrap", lambda: bwrap)
    _run_answers(monkeypatch, **answer)
    assert launch.probe().kind == kind


@pytest.mark.parametrize(
    ("present", "answer", "kind"),
    [
        (False, {}, MISSING),
        (True, {"code": 65}, REFUSED),
        (True, {"raises": OSError("no exec")}, REFUSED),
        (True, {}, None),
    ],
)
def test_each_macos_answer_has_its_kind(
    os_is, monkeypatch, tmp_path, present, answer, kind
):
    os_is("macos")
    tool = tmp_path / "sandbox-exec"
    if present:
        tool.write_text("", encoding="utf-8")
    monkeypatch.setattr(launch, "_SANDBOX_EXEC", str(tool))
    _run_answers(monkeypatch, **answer)
    assert launch.probe().kind == kind


@pytest.mark.parametrize("name", ["windows", "other"])
def test_a_platform_without_a_sandbox_is_unsupported(os_is, name):
    os_is(name)
    assert launch.probe().kind == UNSUPPORTED


def test_the_kind_classifies_and_does_not_change_the_status():
    assert SandboxStatus(UNAVAILABLE, "x", "why", MISSING) == SandboxStatus(
        UNAVAILABLE, "x", "why"
    )


def test_a_sandbox_turned_off_starts_no_confined_server(monkeypatch):
    monkeypatch.setenv("WORKPILOT_SANDBOX", "off")
    monkeypatch.setattr(
        launch, "probe", lambda: pytest.fail("the sandbox is not probed when off")
    )
    assert machine_confinement() == MachineConfinement(
        False, "off", None, "the OS sandbox is off (WORKPILOT_SANDBOX=off)"
    )


def test_a_working_sandbox_starts_them(monkeypatch):
    monkeypatch.delenv("WORKPILOT_SANDBOX", raising=False)
    monkeypatch.setattr(launch, "probe", lambda: SandboxStatus(ISOLATED, "bubblewrap"))
    assert machine_confinement() == MachineConfinement(
        True, "available", "bubblewrap", None
    )


def test_a_missing_sandbox_is_named_with_its_kind(monkeypatch):
    monkeypatch.delenv("WORKPILOT_SANDBOX", raising=False)
    monkeypatch.setattr(
        launch,
        "probe",
        lambda: SandboxStatus(UNAVAILABLE, "bubblewrap", "bwrap missing", MISSING),
    )
    assert machine_confinement().to_dict() == {
        "available": False,
        "kind": "missing",
        "backend": "bubblewrap",
        "reason": "bwrap missing",
    }


def test_a_status_without_kind_or_reason_still_says_why(monkeypatch):
    monkeypatch.delenv("WORKPILOT_SANDBOX", raising=False)
    monkeypatch.setattr(launch, "probe", lambda: SandboxStatus(UNAVAILABLE, None))
    assert machine_confinement() == MachineConfinement(
        False, "unsupported", None, "this machine has no OS sandbox"
    )


def test_the_runner_prints_the_answer_the_backend_applies(monkeypatch, capsys):
    import runners.mcp_sandbox_runner as runner

    answer = MachineConfinement(False, "refused", "seatbelt", "sandbox-exec refused")
    monkeypatch.setattr(runner, "machine_confinement", lambda: answer)
    assert runner.main() == 0
    assert json.loads(capsys.readouterr().out) == answer.to_dict()


def test_the_runner_runs_as_the_app_starts_it(monkeypatch):
    # As `main/mcp-security/sandbox-status.ts` starts it: by its path.
    runner = BACKEND / "runners" / "mcp_sandbox_runner.py"
    env = {**os.environ, "WORKPILOT_SANDBOX": "off"}
    done = subprocess.run(
        [sys.executable, str(runner)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        cwd=BACKEND,
        check=False,
        timeout=60,
    )
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout.strip().splitlines()[-1]) == {
        "available": False,
        "kind": "off",
        "backend": None,
        "reason": "the OS sandbox is off (WORKPILOT_SANDBOX=off)",
    }
