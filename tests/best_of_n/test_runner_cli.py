"""The best-of-N runner, as the desktop app starts it, on a real repository.

One process per command, as main runs it: prepare the variants, rank them,
ask the arbiter, adopt or discard. The arbiter's model call is a stand-in.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "best_of_n_runner.py"
PARENT = "001-login"
VARIANTS = json.dumps(
    [
        {"provider": "anthropic", "model": "model-a", "effort": "high"},
        {"provider": "openai", "model": "model-b", "effort": "medium"},
    ]
)


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    _git(root, "config", "user.email", "t@example.com")
    _git(root, "config", "user.name", "t")
    (root / "app.py").write_text("X = 1\n", encoding="utf-8")
    (root / ".gitignore").write_text(".workpilot/\n", encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "base")
    spec = root / ".workpilot" / "specs" / PARENT
    spec.mkdir(parents=True)
    (spec / "spec.md").write_text("# Login\n", encoding="utf-8")
    (spec / "task_metadata.json").write_text(
        json.dumps({"title": "Login", "baseBranch": "main"}), encoding="utf-8"
    )
    return root


def _spec(project: Path) -> Path:
    return project / ".workpilot" / "specs" / PARENT


def _run(project: Path, command: str, *args: str, spec: Path | None = None):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    done = subprocess.run(
        [
            sys.executable,
            str(RUNNER),
            command,
            "--project-dir",
            str(project),
            "--spec-dir",
            str(spec or _spec(project)),
            *args,
        ],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        timeout=180,
        check=False,
    )
    return done.returncode, json.loads(done.stdout.splitlines()[-1])


def test_a_run_is_prepared_ranked_then_discarded(project: Path) -> None:
    code, out = _run(project, "prepare", "--variants", VARIANTS)
    assert code == 0
    state = out["state"]
    assert state["phase"] == "running"
    assert [v["specId"] for v in state["variants"]] == [
        f"{PARENT}-bon1",
        f"{PARENT}-bon2",
    ]
    worktrees = project / ".workpilot" / "worktrees" / "tasks"
    assert (worktrees / f"{PARENT}-bon1").is_dir()

    code, out = _run(project, "rank")
    assert code == 0 and out["state"]["phase"] == "ranked"

    assert _run(project, "arbitrate", "--provider", "anthropic", "--model", "m") == (
        2,
        {"error": "fewer than two finished variants: nothing to arbitrate"},
    )
    assert _run(project, "challenge", "--question", "Why the first one?") == (
        2,
        {"error": "there is no verdict to question"},
    )
    assert _run(project, "adopt", "--variant", "nope") == (
        2,
        {"error": "that variant is not part of this run"},
    )
    assert _run(project, "arbiter-metrics") == (0, {"metrics": []})

    code, out = _run(project, "discard")
    assert code == 0 and out["state"]["phase"] == "discarded"
    assert not (worktrees / f"{PARENT}-bon1").exists()


@pytest.mark.parametrize(
    ("command", "args", "error"),
    [
        ("prepare", ["--variants", "x" * 8193], "variants is too long"),
        ("prepare", ["--variants", "[{"], "variants is not JSON"),
        ("arbitrate", ["--provider=-rf"], "invalid provider"),
        ("arbitrate", ["--model", "a b"], "invalid model"),
        ("challenge", ["--question", "   "], "the question must be 1 to 1000"),
        ("challenge", ["--question", "?" * 1001], "the question must be 1 to 1000"),
        ("adopt", ["--variant", "../other"], "invalid variant name"),
        ("adopt", [], "invalid variant name"),
    ],
)
def test_an_argument_main_should_not_send_is_refused(
    project: Path, command, args, error
) -> None:
    code, out = _run(project, command, *args)
    assert code == 2 and out["error"].startswith(error)


def test_a_spec_folder_outside_the_project_is_refused(project, tmp_path) -> None:
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    for command in ("rank", "arbiter-metrics"):
        assert _run(project, command, spec=outside) == (
            2,
            {"error": "the spec directory is outside the project"},
        )
    assert _run(project, "rank", spec=project) == (
        2,
        {"error": "the spec directory is outside the project"},
    )
    odd = project / ".workpilot" / "specs" / "-odd"
    odd.mkdir()
    assert _run(project, "rank", spec=odd) == (2, {"error": "invalid spec name"})


def test_a_missing_project_is_an_error(tmp_path: Path) -> None:
    gone = tmp_path / "gone"
    code, out = _run(gone, "rank", spec=gone / "x")
    assert code == 1 and out["error"].startswith("FileNotFoundError:")
    code, out = _run(gone, "arbiter-metrics", spec=gone / "x")
    assert code == 2 and out["error"]


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("best_of_n_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_arbiter_is_asked_with_the_engine_main_chose(
    runner, monkeypatch, project: Path
) -> None:
    import core.oneshot

    calls = []

    async def oneshot_completion(prompt, **options):
        calls.append((prompt, options))
        return "variant 1"

    monkeypatch.setattr(core.oneshot, "oneshot_completion", oneshot_completion)
    ask = runner._ask(project, {"provider": "openai", "model": "gpt-5"})
    assert ask("You judge.", "Which one?") == "variant 1"
    [(prompt, options)] = calls
    assert prompt == "Which one?"
    assert options == {
        "system_prompt": "You judge.",
        "provider": "openai",
        "model": "gpt-5",
        "project_dir": str(project),
        "max_turns": 1,
    }


def test_an_unexpected_failure_is_reported(runner, monkeypatch, capsys, project):
    def boom(_project, _spec):
        raise RuntimeError("index locked")

    monkeypatch.setattr(runner, "rank", boom)
    monkeypatch.setattr(
        sys,
        "argv",
        ["r", "rank", "--project-dir", str(project), "--spec-dir", str(_spec(project))],
    )
    with pytest.raises(SystemExit) as stop:
        runner.main()
    assert stop.value.code == 1
    assert json.loads(capsys.readouterr().out) == {
        "error": "RuntimeError: index locked"
    }
