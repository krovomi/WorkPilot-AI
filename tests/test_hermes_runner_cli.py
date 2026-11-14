"""The hermes runner, as the Kanban and the CLI start it.

Every run gets its own hermes home (``HERMES_HOME``), home folder and
repository root, so nothing reads or writes the machine's real hermes.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "hermes_runner.py"
MARKER = "__HERMES_RESULT__:"


@pytest.fixture
def world(tmp_path: Path) -> dict[str, Path]:
    places = {name: tmp_path / name for name in ("hermes", "home", "repo")}
    places["home"].mkdir()
    places["repo"].mkdir()
    return places


def _run(world: dict[str, Path], *args: str) -> tuple[int, dict, list[str]]:
    env = {
        **os.environ,
        "HERMES_HOME": str(world["hermes"]),
        "HOME": str(world["home"]),
        "USERPROFILE": str(world["home"]),
        "PATH": os.path.dirname(sys.executable),
    }
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--repo-root", str(world["repo"]), *args],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        timeout=120,
        check=False,
    )
    lines = done.stdout.splitlines()
    return done.returncode, json.loads(lines[-1][len(MARKER) :]), lines[:-1]


def test_without_hermes_the_doctor_names_the_install(world) -> None:
    code, out, lines = _run(world, "--action", "doctor")
    assert code == 0 and out["readiness"]["state"] == "absent"
    assert lines[0] == "hermes: absent"
    assert lines[1].startswith("  install: ")
    assert lines[2].startswith("    -> ")


def test_the_persona_is_installed_once(world) -> None:
    code, out, lines = _run(world, "--action", "install-soul")
    assert code == 0 and out["changed"] is True
    assert (world["hermes"] / "SOUL.md").is_file()
    assert out["soul"]["state"] == "installed"
    assert lines == [f"hermes SOUL.md: {out['message']}"]
    assert "refresh-prompts" in out["message"]

    code, out, lines = _run(world, "--action", "install-soul", "--quiet")
    assert code == 0 and out["changed"] is False and lines == []


def test_status_and_a_dry_cycle_with_a_hermes_home(world) -> None:
    _run(world, "--action", "install-soul")
    code, out, _ = _run(world, "--action", "status")
    assert code == 0
    assert out["readiness"]["installed"] is True
    assert out["soul"]["matches"] is True
    assert out["pending"] == [] and out["adopted"] == []
    assert {s["id"] for s in out["surfaces"]} >= {"cli", "kanban"}

    code, out, lines = _run(
        world, "--action", "cycle", "--surface", "kanban", "--dry-run"
    )
    assert code == 0
    assert out["cycle"]["surface"] == "kanban" and out["cycle"]["ran"] is True
    assert lines == [
        "hermes [kanban]: 0 authored skill(s) seen, 0 proposed, 0 already pending"
    ]
    assert not (world["repo"] / "skills").exists()


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("hermes_runner_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_a_cycle_line_names_what_it_settled(runner, tmp_path: Path) -> None:
    payload = {
        "cycle": {
            "ran": True,
            "surface": "kanban",
            "ingest": {
                "found": 9,
                "proposed": 2,
                "unchanged": 1,
                "adopted": ["a", "b"],
                "droppedTotal": 4,
                "pruned": 3,
            },
        }
    }
    assert runner._summary(payload, tmp_path) == (
        "hermes [kanban]: 9 authored skill(s) seen, 2 proposed, 1 already pending, "
        "2 adopted (emitted nowhere), 4 out of scope, 3 withdrawn"
    )


def test_a_cycle_that_did_not_run_reports_the_readiness(runner, tmp_path) -> None:
    readiness = {
        "state": "degraded",
        "checks": [
            {"name": "install", "ok": True},
            {"name": "trust", "ok": False, "detail": "", "remedy": ""},
        ],
    }
    payload = {"cycle": {"ran": False, "readiness": readiness}}
    assert runner._summary(payload, tmp_path) == "hermes: degraded\n  trust: missing"
    assert runner._summary({}, tmp_path) == "hermes: unknown"


@pytest.mark.parametrize(
    ("sessions", "tail"),
    [
        ("requested", "; running hermes sessions pick it up on their next turn"),
        ("needs-update", "` for running sessions"),
    ],
)
def test_running_sessions_are_told_about_a_new_persona(
    runner, monkeypatch, tmp_path, sessions, tail
) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    monkeypatch.setattr(runner, "refresh_prompts", lambda: sessions)
    out = runner._install_soul(tmp_path, overwrite=False)
    assert out["changed"] is True and out["message"].endswith(tail)
    if sessions == "needs-update":
        assert runner.UPDATE_COMMAND in out["message"]
