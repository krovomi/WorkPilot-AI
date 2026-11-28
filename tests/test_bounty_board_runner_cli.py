"""The Bounty Board runner, as the desktop app starts it.

The round itself (one model per contestant, then a judge) is a stand-in; the
runner's own work is checked: which spec folder, which contestants with which
profile and prompt, and what reaches stdout.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "bounty_board_runner.py"


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("bounty_board_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Result:
    def __init__(self, winner: str) -> None:
        self.winner = winner

    def to_dict(self) -> dict:
        return {"winner": self.winner}


def _main(runner, monkeypatch, project: Path, *args: str) -> int:
    monkeypatch.setattr(
        sys,
        "argv",
        ["runner", "--project-path", str(project), "--spec-id", "001-cart", *args],
    )
    with pytest.raises(SystemExit) as stop:
        runner.main()
    return stop.value.code


def test_each_contestant_gets_its_profile_and_prompt(
    runner, monkeypatch, capsys, tmp_path: Path
) -> None:
    project = tmp_path / "shop"
    legacy = project / ".autonomousbuild" / "specs" / "001-cart"
    legacy.mkdir(parents=True)
    rounds = []

    async def run_bounty(*, spec_dir, project_path, contestants):
        rounds.append((spec_dir, project_path, contestants))
        return Result("openai:gpt-5")

    monkeypatch.setattr(runner, "run_bounty", run_bounty)
    code = _main(
        runner,
        monkeypatch,
        project,
        "--contestants",
        "anthropic:claude-sonnet-4-6, gpt-5 ,ollama:llama3.3,",
        "--profiles",
        "work,home",
        "--prompt-overrides",
        "Refactor aggressively||Match the style",
    )
    assert code == 0
    assert json.loads(capsys.readouterr().out) == {"result": {"winner": "openai:gpt-5"}}
    [(spec_dir, project_path, contestants)] = rounds
    assert spec_dir == legacy and project_path == project
    assert [
        (c.provider, c.model, c.profile_id, c.prompt_override) for c in contestants
    ] == [
        ("anthropic", "claude-sonnet-4-6", "work", "Refactor aggressively"),
        ("anthropic", "gpt-5", "home", "Match the style"),
        ("ollama", "llama3.3", None, None),
    ]


def test_the_current_spec_folder_is_preferred(runner, tmp_path: Path) -> None:
    project = tmp_path / "shop"
    for root in (".workpilot", ".autonomousbuild"):
        (project / root / "specs" / "001-cart").mkdir(parents=True)
    assert runner._resolve_spec_dir(project, "001-cart") == (
        project / ".workpilot" / "specs" / "001-cart"
    )
    assert runner._resolve_spec_dir(project, "002-none") == (
        project / ".workpilot" / "specs" / "002-none"
    )


def test_a_failing_round_ends_with_an_error_line(
    runner, monkeypatch, capsys, tmp_path: Path
) -> None:
    async def run_bounty(**_kwargs):
        raise RuntimeError("judge unavailable")

    monkeypatch.setattr(runner, "run_bounty", run_bounty)
    code = _main(runner, monkeypatch, tmp_path, "--contestants", "gpt-5")
    assert code == 1
    assert json.loads(capsys.readouterr().out) == {"error": "judge unavailable"}


def test_a_round_without_contestants_is_refused(tmp_path: Path) -> None:
    done = subprocess.run(
        [
            sys.executable,
            str(RUNNER),
            "--project-path",
            str(tmp_path),
            "--spec-id",
            "001-cart",
            "--contestants",
            " , ,",
        ],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    assert done.returncode == 1
    assert json.loads(done.stdout) == {
        "error": "No contestants provided (--contestants)"
    }
