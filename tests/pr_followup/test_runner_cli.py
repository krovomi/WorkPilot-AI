"""The PR follow-through runner, as the desktop app starts it, against a fake `gh`.

The pull request answers come from a stand-in `gh` (`tests/gh_fake.py`); the
runner, the policy and the round run for real. The QA fixer, the push and the
poll interval are stand-ins in the in-process tests.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from gh_fake import write_fake_gh  # noqa: E402

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "pr_followup_runner.py"
PR_URL = "https://github.com/acme/shop/pull/7"
THREADS = {"data": {"repository": {"pullRequest": {"reviewThreads": {"nodes": []}}}}}


def _layout(tmp_path: Path) -> Path:
    project = tmp_path / "project"
    (project / ".workpilot" / "worktrees" / "tasks" / "001-x").mkdir(parents=True)
    (project / ".workpilot" / "specs" / "001-x").mkdir(parents=True)
    return project


def _answers(state: str) -> dict[str, dict]:
    view = {
        "number": 7,
        "state": state,
        "headRefOid": "abc123",
        "headRefName": "workpilot/001-x",
        "baseRefName": "develop",
    }
    return {
        "--version": {"stdout": "gh version 2.80.0\n"},
        "pr view 7": {"stdout": json.dumps(view)},
        "pr checks 7": {"stdout": "[]"},
        "api graphql": {"stdout": json.dumps(THREADS)},
    }


def _run(project: Path, gh_dir: Path, *args: str) -> tuple[int, list[dict]]:
    gh = gh_dir / ("gh.cmd" if os.name == "nt" else "gh")
    done = subprocess.run(
        [
            sys.executable,
            str(RUNNER),
            "--project-dir",
            str(project),
            "--spec-dir",
            str(project / ".workpilot" / "specs" / "001-x"),
            "--spec-name",
            "001-x",
            *args,
        ],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, "GITHUB_CLI_PATH": str(gh)},
        timeout=120,
        check=False,
    )
    return done.returncode, [json.loads(line) for line in done.stdout.splitlines()]


def test_a_merged_pull_request_ends_the_follow_through(tmp_path: Path) -> None:
    project = _layout(tmp_path)
    gh = write_fake_gh(tmp_path / "gh", _answers("MERGED"))
    code, lines = _run(project, gh.directory, "--pr-url", PR_URL)
    assert code == 0
    [round_line, result] = lines
    assert round_line["event"] == "round"
    assert round_line["round"]["decision"] == "merged"
    assert result == {"result": round_line["round"]}
    views = [c for c in gh.calls() if c[:2] == ["pr", "view"]]
    assert views
    assert views[0][:5] == ["pr", "view", "7", "-R", "acme/shop"]


def test_only_a_github_pull_request_can_be_followed(tmp_path: Path) -> None:
    project = _layout(tmp_path)
    code, lines = _run(
        project, tmp_path, "--pr-url", "https://gitlab.com/acme/shop/-/merge_requests/7"
    )
    assert code == 2
    assert lines == [
        {
            "error": "only GitHub pull requests can be followed for now; "
            "this URL is not one"
        }
    ]


def test_a_worktree_outside_the_project_is_an_error(tmp_path: Path) -> None:
    project = _layout(tmp_path)
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    code, lines = _run(
        project, tmp_path, "--pr-url", PR_URL, "--worktree-dir", str(outside)
    )
    assert code == 1 and lines == [{"error": "the worktree is outside the project"}]


# --- in-process: polling, the fixer, the push and the lesson -------------------


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("pr_followup_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _args(project: Path, **overrides) -> argparse.Namespace:
    values = {
        "project_dir": str(project),
        "spec_dir": str(project / ".workpilot" / "specs" / "001-x"),
        "spec_name": "001-x",
        "worktree_dir": None,
        "pr_url": PR_URL,
        "once": False,
        "interval": 1,
        "max_polls": 3,
        "max_rounds": 2,
        "no_review_threads": False,
    }
    values.update(overrides)
    return argparse.Namespace(**values)


class Round:
    def __init__(self, finished: bool, action: str = "none", threads=()):
        self.finished = finished
        self.action = action
        self.decision = argparse.Namespace(threads=list(threads))

    def to_dict(self) -> dict:
        return {"finished": self.finished, "action": self.action}


def test_an_open_pull_request_is_polled_until_it_is_done(
    runner, monkeypatch, capsys, tmp_path: Path
) -> None:
    project = _layout(tmp_path)
    rounds = iter([Round(False), Round(True, "fixed", ["thread-1"])])
    naps: list[float] = []
    lessons: list[tuple] = []
    configs = []

    async def run_round(**kwargs):
        configs.append(kwargs["config"])
        return next(rounds)

    async def sleep(seconds):
        naps.append(seconds)

    import learning_loop.review_lessons

    monkeypatch.setattr(runner, "run_round", run_round)
    monkeypatch.setattr(runner.asyncio, "sleep", sleep)
    monkeypatch.setattr(
        learning_loop.review_lessons,
        "record_review_threads",
        lambda *args: lessons.append(args),
    )
    code = asyncio.run(runner._run(_args(project, no_review_threads=True)))
    assert code == 0
    lines = [json.loads(ln) for ln in capsys.readouterr().out.splitlines()]
    assert [ln.get("event") for ln in lines] == ["round", "round", None]
    assert lines[-1] == {"result": {"finished": True, "action": "fixed"}}
    # Never polled faster than every fifteen seconds.
    assert naps == [runner.MIN_INTERVAL_SECONDS]
    assert lessons == [(project.resolve(), PR_URL, ["thread-1"])]
    assert configs[0].max_rounds == 2 and configs[0].fix_review_threads is False


def test_the_fixer_runs_on_the_tasks_qa_engine_in_the_worktree(
    runner, monkeypatch, tmp_path: Path
) -> None:
    import core.client
    import qa.fixer

    project = _layout(tmp_path)
    worktree = project / ".workpilot" / "worktrees" / "tasks" / "001-x"
    spec = project / ".workpilot" / "specs" / "001-x"
    clients: list[dict] = []

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

    def create_agent_client(**options):
        clients.append(options)
        return Client()

    async def run_qa_fixer_session(client, spec_dir, session, verbose, project_dir):
        return "fixed", f"session {session} in {project_dir.name}"

    monkeypatch.setattr(core.client, "create_agent_client", create_agent_client)
    monkeypatch.setattr(qa.fixer, "run_qa_fixer_session", run_qa_fixer_session)
    monkeypatch.delenv("PROJECT_DIR", raising=False)
    assert asyncio.run(runner._qa_fixer(worktree, spec, 2)) == (
        "fixed",
        "session 2 in 001-x",
    )
    [options] = clients
    assert options["agent_type"] == "qa_fixer"
    assert options["project_dir"] == worktree


def test_the_push_is_never_forced(runner, monkeypatch, tmp_path: Path) -> None:
    import core.worktree

    pushes = []

    class Manager:
        def __init__(self, project):
            self.project = project

        def push_branch(self, name, force):
            pushes.append((self.project, name, force))
            return {"success": False, "error": "rejected"}

    monkeypatch.setattr(core.worktree, "WorktreeManager", Manager)
    assert runner._pusher(tmp_path, "001-x")() == (False, "rejected")
    assert pushes == [(tmp_path, "001-x", False)]


def test_a_round_without_a_fixed_thread_teaches_nothing(runner, tmp_path) -> None:
    runner._learn_from_review(tmp_path, PR_URL, Round(True, "fixed"))
    runner._learn_from_review(tmp_path, PR_URL, Round(True, "none", ["t"]))
    assert not (tmp_path / ".workpilot").exists()
