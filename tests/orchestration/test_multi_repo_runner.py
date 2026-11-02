"""The three steps the desktop app asks of a multi-repo orchestration.

`analyze` (graph, order, master spec), `brief` (one repo's task description)
and `check` (breaking changes after a repo completed), through the runner's
command line, on real git repositories in tmp dirs.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from orchestration import BreakingChangeDetector, CrossRepoSpecManager
from runners import multi_repo_runner as runner


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=str(repo), check=True, capture_output=True)


def _repo(path: Path, files: dict[str, str]) -> Path:
    path.mkdir(parents=True)
    _git(path, "init", "-q", "-b", "main")
    _git(path, "config", "user.email", "test@example.com")
    _git(path, "config", "user.name", "test")
    for name, content in files.items():
        (path / name).write_text(content, encoding="utf-8")
    _git(path, "add", "-A")
    _git(path, "commit", "-q", "-m", "initial")
    return path


def _events(capsys: pytest.CaptureFixture[str]) -> list[dict]:
    out = capsys.readouterr().out
    return [
        json.loads(line.removeprefix("[MULTI_REPO] "))
        for line in out.splitlines()
        if line.startswith("[MULTI_REPO] ")
    ]


@pytest.fixture
def lib_and_app(tmp_path: Path) -> tuple[Path, Path]:
    lib = _repo(
        tmp_path / "lib",
        {
            "package.json": json.dumps({"name": "shared-lib"}),
            "index.ts": "export const a = 1;\nexport const b = 2;\n",
        },
    )
    app = _repo(
        tmp_path / "app",
        {"package.json": json.dumps({"dependencies": {"shared-lib": "1.0.0"}})},
    )
    return lib, app


def _analyze(spec_dir: Path, lib: Path, app: Path) -> int:
    return runner.main(
        [
            "analyze",
            "--spec-dir",
            str(spec_dir),
            "--task",
            "Rename b",
            "--repos",
            f"app::{app},lib::{lib}",
        ]
    )


def test_analyze_orders_providers_first(
    tmp_path: Path, lib_and_app: tuple[Path, Path], capsys
) -> None:
    lib, app = lib_and_app
    spec_dir = tmp_path / "orch"
    # The main process writes the first manifest, with each repo's project.
    CrossRepoSpecManager(spec_dir).create_master_spec(
        "Rename b",
        [
            {"repo": "app", "repo_path": str(app), "project_id": "p-app"},
            {"repo": "lib", "repo_path": str(lib), "project_id": "p-lib"},
        ],
        {},
        ["app", "lib"],
    )

    assert _analyze(spec_dir, lib, app) == 0

    graph = next(e for e in _events(capsys) if e["event"] == "graph")
    assert graph["execution_order"] == ["lib", "app"]
    manifest = CrossRepoSpecManager(spec_dir).load_manifest()
    assert manifest is not None
    assert manifest.execution_order == ["lib", "app"]
    assert {sub.repo: sub.project_id for sub in manifest.repos} == {
        "app": "p-app",
        "lib": "p-lib",
    }
    assert "1. lib" in (spec_dir / "spec.md").read_text(encoding="utf-8")


def test_analyze_refuses_a_dependency_cycle(tmp_path: Path, capsys) -> None:
    a = _repo(
        tmp_path / "a",
        {"package.json": json.dumps({"name": "a", "dependencies": {"b": "1"}})},
    )
    b = _repo(
        tmp_path / "b",
        {"package.json": json.dumps({"name": "b", "dependencies": {"a": "1"}})},
    )
    code = runner.main(
        [
            "analyze",
            "--spec-dir",
            str(tmp_path / "orch"),
            "--task",
            "t",
            "--repos",
            f"a::{a},b::{b}",
        ]
    )
    assert code == 1
    assert any(e["event"] == "error" and e["code"] == "cycle" for e in _events(capsys))


@pytest.mark.parametrize(
    "repos",
    ["only::{tmp}", "one::{tmp},two::{tmp}/missing"],
)
def test_analyze_refuses_bad_repo_lists(tmp_path: Path, repos: str, capsys) -> None:
    code = runner.main(
        [
            "analyze",
            "--spec-dir",
            str(tmp_path / "orch"),
            "--task",
            "t",
            "--repos",
            repos.format(tmp=tmp_path),
        ]
    )
    assert code == 1
    assert _events(capsys)[-1]["event"] == "error"


def _complete_lib_on_a_branch(spec_dir: Path, lib: Path) -> None:
    """What a finished task leaves: a worktree on its branch, one commit ahead."""
    worktree = lib.parent / "lib-wt"
    _git(lib, "worktree", "add", "-q", "-b", "workpilot/001-x", str(worktree))
    (worktree / "index.ts").write_text("export const a = 1;\n", encoding="utf-8")
    _git(worktree, "commit", "-q", "-am", "drop b")

    mgr = CrossRepoSpecManager(spec_dir)
    manifest = mgr.load_manifest()
    assert manifest is not None
    manifest.update_sub_spec_status(
        "lib",
        "completed",
        worktree_path=str(worktree),
        branch_name="workpilot/001-x",
        base_branch="main",
    )
    mgr.save_manifest(manifest)


def test_check_finds_the_removed_export_once(
    tmp_path: Path, lib_and_app: tuple[Path, Path], capsys
) -> None:
    lib, app = lib_and_app
    spec_dir = tmp_path / "orch"
    assert _analyze(spec_dir, lib, app) == 0
    _complete_lib_on_a_branch(spec_dir, lib)
    capsys.readouterr()

    assert runner.main(["check", "--spec-dir", str(spec_dir)]) == 0
    first = next(e for e in _events(capsys) if e["event"] == "breaking_changes")
    assert [(c["source_repo"], c["target_repo"]) for c in first["changes"]] == [
        ("lib", "app")
    ]

    # The same diff checked again adds nothing.
    assert runner.main(["check", "--spec-dir", str(spec_dir)]) == 0
    again = next(e for e in _events(capsys) if e["event"] == "breaking_changes")
    assert again["changes"] == []
    manifest = CrossRepoSpecManager(spec_dir).load_manifest()
    assert manifest is not None
    assert len(manifest.breaking_changes) == 1


def test_brief_carries_what_upstream_changed(
    tmp_path: Path, lib_and_app: tuple[Path, Path], capsys
) -> None:
    lib, app = lib_and_app
    spec_dir = tmp_path / "orch"
    assert _analyze(spec_dir, lib, app) == 0
    _complete_lib_on_a_branch(spec_dir, lib)
    assert runner.main(["check", "--spec-dir", str(spec_dir)]) == 0
    capsys.readouterr()

    assert runner.main(["brief", "--spec-dir", str(spec_dir), "--repo", "app"]) == 0
    brief = next(e for e in _events(capsys) if e["event"] == "brief")["description"]
    assert brief.startswith("Rename b\n")
    assert "**app** part of a change that spans 2 repositories" in brief
    assert "app depends on lib: package (shared-lib)" in brief
    assert "Branch: `workpilot/001-x`" in brief
    assert "index.ts" in brief  # the upstream diff summary
    assert "Breaking changes to address" in brief


def test_brief_of_the_first_repo_has_no_upstream(
    tmp_path: Path, lib_and_app: tuple[Path, Path], capsys
) -> None:
    lib, app = lib_and_app
    spec_dir = tmp_path / "orch"
    assert _analyze(spec_dir, lib, app) == 0
    capsys.readouterr()
    assert runner.main(["brief", "--spec-dir", str(spec_dir), "--repo", "lib"]) == 0
    brief = next(e for e in _events(capsys) if e["event"] == "brief")["description"]
    assert "app depends on lib" in brief
    assert "done before it changed" not in brief


def test_brief_of_an_unknown_repo_fails(
    tmp_path: Path, lib_and_app: tuple[Path, Path], capsys
) -> None:
    lib, app = lib_and_app
    spec_dir = tmp_path / "orch"
    assert _analyze(spec_dir, lib, app) == 0
    assert runner.main(["brief", "--spec-dir", str(spec_dir), "--repo", "nope"]) == 1
    assert _events(capsys)[-1]["code"] == "step_failed"


@pytest.mark.parametrize(
    ("base", "expected"),
    [
        ("main", "main...HEAD"),
        ("release/1.2", "release/1.2...HEAD"),
        ("", ""),
        ("--output=/tmp/x", ""),
        ("-p", ""),
        ("main..evil", ""),
        ("a b", ""),
    ],
)
def test_diff_range_takes_plain_branch_names_only(base: str, expected: str) -> None:
    assert BreakingChangeDetector.diff_range_for(base) == expected
