"""The conflict predictor, run the way the desktop app runs it.

`python runners/conflict_predictor_runner.py --project-path <repo>` compares
every branch and worktree with `main` and streams what may conflict. These
tests build a real repository whose branches touch the same files.
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
RUNNER = BACKEND / "runners" / "conflict_predictor_runner.py"


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def _branch(repo: Path, name: str, files: dict[str, str | None]) -> None:
    _git(repo, "checkout", "-q", "-b", name, "main")
    for rel, text in files.items():
        if text is None:
            _git(repo, "rm", "-q", rel)
        else:
            (repo / rel).write_text(text, encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", name)
    _git(repo, "checkout", "-q", "main")


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    _git(root, "config", "user.email", "dev@example.test")
    _git(root, "config", "user.name", "Dev")
    for name, text in {
        "app.py": "a\n",
        "util.py": "u\n",
        "big.txt": "x\n",
        "package.json": "{}\n",
    }.items():
        (root / name).write_text(text, encoding="utf-8")
    _git(root, "add", ".")
    _git(root, "commit", "-qm", "init")
    lines = "".join(f"{i}\n" for i in range(80))
    _branch(
        root,
        "feat-a",
        {"app.py": "a\nb\n", "util.py": "u\nv\n", "package.json": '{"a": 1}\n'},
    )
    _branch(
        root,
        "feat-b",
        {"app.py": "a\nc\n", "big.txt": "x\n" + lines, "package.json": '{"b": 1}\n'},
    )
    _branch(root, "feat-c", {"util.py": None})
    _branch(root, "feat-d", {"big.txt": "x\n" + lines[:150]})
    _branch(root, "feat-e", {"new.txt": "n\n"})
    # A linked worktree counts once, under its folder name.
    _git(root, "worktree", "add", "-q", str(tmp_path / "feat-f"), "-b", "feat-f")
    return root


def _run(project: Path) -> tuple[int, list[dict], str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project-path", str(project)],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        timeout=180,
        check=False,
    )
    events, last = [], ""
    for line in done.stdout.splitlines():
        if line.startswith("CONFLICT_PREDICTOR_EVENT:"):
            events.append(json.loads(line.split(":", 1)[1]))
        else:
            last = line
    return done.returncode, events, last


def test_branches_that_touch_the_same_files_are_flagged(repo: Path) -> None:
    code, events, last = _run(repo)
    assert code == 0
    assert last.startswith("CONFLICT_PREDICTOR_RESULT:")
    result = json.loads(last.split(":", 1)[1])
    assert events[-1] == {
        "type": "complete",
        "data": result,
        "timestamp": events[-1]["timestamp"],
    }
    assert "+" not in events[-1]["timestamp"]

    # The project's own checkout is not a branch to merge.
    assert result["active_worktrees"] == [
        "feat-f",
        "feat-a",
        "feat-b",
        "feat-c",
        "feat-d",
        "feat-e",
    ]
    found = {
        (c["risk_level"], c["conflict_type"], c["file_path"]): (
            c["worktree1"],
            c["worktree2"],
        )
        for c in result["conflicts_detected"]
    }
    assert found[("medium", "same_file", "app.py")] == ("feat-a", "feat-b")
    assert found[("high", "deletion_conflict", "util.py")] == ("feat-a", "feat-c")
    assert found[("critical", "extensive_overlap", "big.txt")] == ("feat-b", "feat-d")
    assert result["summary"]["critical_conflicts"] == 1
    assert result["summary"]["risk_assessment"].startswith("CRITICAL")
    added = [m for m in result["modified_files"] if m["file_path"] == "new.txt"]
    assert added == [
        {
            "file_path": "new.txt",
            "modification_type": "added",
            "lines_added": 1,
            "lines_removed": 0,
            "worktree_name": "feat-e",
            "branch_name": "feat-e",
        }
    ]
    assert result["safe_merge_order"][:2] == ["feat-e", "feat-f"]

    statuses = [e["data"]["status"] for e in events if e["type"] == "progress"]
    assert "Found 6 active worktrees/branches" in statuses
    assert "Active worktrees: feat-f, feat-a, feat-b, feat-c, feat-d and 1 more" in (
        statuses
    )
    assert "1 files added" in statuses and "1 files deleted" in statuses
    assert "🚨 1 CRITICAL conflicts found!" in statuses
    assert "  • feat-b vs feat-d: big.txt" in statuses
    assert any(s.startswith("1. URGENT: 1 critical") for s in statuses)
    assert "Safe merge order suggested:" in statuses
    assert any(s.startswith("High risk areas to monitor: ") for s in statuses)


def test_a_repository_without_branches_is_safe(tmp_path: Path) -> None:
    _git(tmp_path, "init", "-q", "-b", "main")
    code, events, last = _run(tmp_path)
    assert code == 0
    result = json.loads(last.split(":", 1)[1])
    assert result["total_worktrees"] == 0
    assert result["summary"]["risk_assessment"] == "SAFE - No conflicts detected"
    statuses = [e["data"]["status"] for e in events if e["type"] == "progress"]
    assert "✅ No conflicts detected - safe for parallel development" in statuses


def test_a_missing_project_ends_with_an_error(tmp_path: Path) -> None:
    code, events, last = _run(tmp_path / "gone")
    assert code == 1
    assert events[-1]["type"] == "error"
    assert last == (
        f"CONFLICT_PREDICTOR_ERROR:Project path not found: {tmp_path / 'gone'}"
    )


@pytest.mark.parametrize(
    ("counts", "assessment"),
    [
        ((1, 0, 0), "CRITICAL"),
        ((0, 3, 0), "HIGH"),
        ((0, 1, 0), "MEDIUM"),
        ((0, 0, 4), "MEDIUM"),
        ((0, 0, 1), "LOW"),
        ((0, 0, 0), "SAFE"),
    ],
)
def test_the_overall_risk_follows_the_counts(counts, assessment, monkeypatch) -> None:
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("conflict_runner", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    runner = module.ConflictPredictorRunner()
    assert runner._get_risk_assessment(*counts).startswith(assessment)


# --- the service's edges: no git, a broken branch, odd numstat lines ---------------


@pytest.fixture
def service(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    from services.conflict_predictor_service import ConflictPredictorService

    return ConflictPredictorService()


def test_the_service_refuses_an_empty_path(service) -> None:
    with pytest.raises(ValueError, match="Invalid project path"):
        service.analyze_project_conflicts("")


def test_without_git_there_is_nothing_to_compare(
    service, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import services.conflict_predictor_service as module

    def no_git(*_a, **_k):
        raise FileNotFoundError("git")

    monkeypatch.setattr(module.subprocess, "run", no_git)
    assert service._get_active_worktrees(str(tmp_path)) == []
    assert service._get_worktree_modifications(str(tmp_path), "feat") == []
    assert service._get_line_changes(str(tmp_path), "feat", "a.py") == (0, 0)


def test_a_branch_that_cannot_be_read_is_skipped(
    service, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(_project, worktree):
        if worktree == "bad":
            raise RuntimeError("unreadable")
        return ["ok"]

    monkeypatch.setattr(service, "_get_worktree_modifications", broken)
    assert service._get_modified_files_from_worktrees("/p", ["bad", "good"]) == ["ok"]


def test_binary_and_garbled_numstat_lines(
    service, monkeypatch: pytest.MonkeyPatch
) -> None:
    import services.conflict_predictor_service as module

    answers = iter(["-\t-\tlogo.png\n", "x\ty\tfile\n"])

    def numstat(*_a, **_k):
        return subprocess.CompletedProcess([], 0, next(answers), "")

    monkeypatch.setattr(module.subprocess, "run", numstat)
    assert service._get_line_changes("/p", "feat", "logo.png") == (0, 0)
    assert service._get_line_changes("/p", "feat", "file") == (0, 0)
