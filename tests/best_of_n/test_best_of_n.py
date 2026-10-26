"""Best-of-N in a real git repository: set up, rank, adopt, discard."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from best_of_n import (
    STATE_FILENAME,
    BestOfNError,
    Variant,
    adopt,
    discard,
    parse_variants,
    prepare,
    rank,
    read_state,
    variant_spec_id,
)
from best_of_n.rank import VariantScore, rank_variants
from goal.check import GoalRun
from goal.spec import GOAL_FILENAME

PARENT = "001-login"
ENGINES = [
    {"provider": "anthropic", "model": "model-a", "effort": "high"},
    {"provider": "openai", "model": "model-b", "effort": "medium"},
]


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


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
    (spec / "requirements.json").write_text("{}", encoding="utf-8")
    (spec / "task_metadata.json").write_text(
        json.dumps({"title": "Login", "baseBranch": "main", "prUrl": "x"}),
        encoding="utf-8",
    )
    return root


def _parent(project: Path) -> Path:
    return project / ".workpilot" / "specs" / PARENT


def _worktree(project: Path, spec_id: str) -> Path:
    return project / ".workpilot" / "worktrees" / "tasks" / spec_id


def _creator(project: Path):
    def create(spec_id: str) -> None:
        _git(
            project,
            "worktree",
            "add",
            "-q",
            "-b",
            f"workpilot/{spec_id}",
            str(_worktree(project, spec_id)),
            "main",
        )

    return create


def _prepare(project: Path, engines=ENGINES) -> dict:
    return prepare(
        project,
        _parent(project),
        parse_variants(engines),
        create_worktree=_creator(project),
    )


def _build(
    project: Path,
    index: int,
    *,
    lines: int,
    qa: str | None = "approved",
    complete: bool = True,
    cost: float | None = 1.0,
) -> None:
    """What run.py leaves behind: commits, a plan, a QA sign-off, a cost line."""
    spec_id = variant_spec_id(PARENT, index)
    worktree = _worktree(project, spec_id)
    (worktree / f"feature{index}.py").write_text(
        "".join(f"line{i}\n" for i in range(lines)), encoding="utf-8"
    )
    _git(worktree, "add", "-A")
    _git(worktree, "commit", "-qm", f"variant {index}")
    plan = {
        "phases": [
            {
                "subtasks": [
                    {"id": "1", "status": "completed"},
                    {"id": "2", "status": "completed" if complete else "pending"},
                ]
            }
        ]
    }
    if qa:
        plan["qa_signoff"] = {"status": qa}
    local = worktree / ".workpilot" / "specs" / spec_id
    local.mkdir(parents=True, exist_ok=True)
    (local / "implementation_plan.json").write_text(json.dumps(plan), encoding="utf-8")
    (
        project / ".workpilot" / "specs" / spec_id / "implementation_plan.json"
    ).write_text(json.dumps(plan), encoding="utf-8")
    (project / ".workpilot" / "specs" / spec_id / "qa_report.md").write_text(
        f"report {index}", encoding="utf-8"
    )
    ledger = project / ".workpilot" / "cost_data.json"
    data = (
        json.loads(ledger.read_text(encoding="utf-8"))
        if ledger.exists()
        else {"usages": []}
    )
    data["usages"].append(
        {
            "spec_id": spec_id,
            "cost": cost or 0.0,
            "input_tokens": 100,
            "output_tokens": 10,
        }
    )
    ledger.write_text(json.dumps(data), encoding="utf-8")


def _exited(project: Path, code: int = 0) -> None:
    state = read_state(_parent(project))
    for entry in state["variants"]:
        entry["exitCode"] = code
    (_parent(project) / STATE_FILENAME).write_text(json.dumps(state), encoding="utf-8")


# --- the request ---------------------------------------------------------


def test_variants_are_validated() -> None:
    assert parse_variants(ENGINES)[1] == Variant("openai", "model-b", "medium")
    with pytest.raises(BestOfNError, match="between 2 and 4"):
        parse_variants(ENGINES[:1])
    with pytest.raises(BestOfNError, match="between 2 and 4"):
        parse_variants(ENGINES * 3)
    with pytest.raises(BestOfNError, match="provider"):
        parse_variants([{**ENGINES[0], "provider": "../x"}, ENGINES[1]])
    with pytest.raises(BestOfNError, match="model"):
        parse_variants([{**ENGINES[0], "model": "a\nb"}, ENGINES[1]])
    with pytest.raises(BestOfNError, match="effort"):
        parse_variants([{**ENGINES[0], "effort": ""}, ENGINES[1]])


def test_a_variant_name_fits_a_spec_name() -> None:
    assert variant_spec_id("001-x", 2) == "001-x-bon2"
    assert len(variant_spec_id("a" * 128, 4)) == 128


# --- prepare -------------------------------------------------------------


def test_prepare_makes_one_spec_and_worktree_per_engine(project: Path) -> None:
    (_parent(project) / "task_logs.json").write_text("{}", encoding="utf-8")
    (_parent(project) / GOAL_FILENAME).write_text(
        json.dumps({"command": "pytest"}), encoding="utf-8"
    )
    state = _prepare(project)

    assert state["phase"] == "running"
    assert [v["specId"] for v in state["variants"]] == [
        "001-login-bon1",
        "001-login-bon2",
    ]
    for index, engine in enumerate(ENGINES, start=1):
        variant = project / ".workpilot" / "specs" / variant_spec_id(PARENT, index)
        meta = json.loads((variant / "task_metadata.json").read_text(encoding="utf-8"))
        assert meta["bestOfN"] == {"parent": PARENT, "index": index}
        assert meta["engineLocked"] is True
        assert meta["phaseProviders"]["qa"] == engine["provider"]
        assert meta["phaseModels"]["planning"] == engine["model"]
        assert meta["thinkingLevel"] == engine["effort"]
        assert meta["baseBranch"] == "main"
        assert "prUrl" not in meta
        assert (variant / "spec.md").is_file()
        assert (variant / GOAL_FILENAME).is_file()
        assert not (variant / "task_logs.json").exists()
        assert _worktree(project, variant.name).is_dir()
    assert read_state(_parent(project))["phase"] == "running"


@pytest.mark.parametrize(
    ("setup", "message"),
    [
        (lambda p: _git(p, "branch", f"workpilot/{PARENT}"), "already has a build"),
        (
            lambda p: (_parent(p) / "implementation_plan.json").write_text(
                json.dumps({"phases": [{"subtasks": [{"status": "completed"}]}]}),
                encoding="utf-8",
            ),
            "already started",
        ),
        (
            lambda p: (_parent(p) / "task_metadata.json").write_text(
                json.dumps({"requireReviewBeforeCoding": True}), encoding="utf-8"
            ),
            "waits for its review",
        ),
        (lambda p: (_parent(p) / "spec.md").unlink(), "no spec"),
        (
            lambda p: (p / ".workpilot" / "specs" / f"{PARENT}-bon2").mkdir(),
            "left over",
        ),
    ],
)
def test_prepare_refuses(project: Path, setup, message: str) -> None:
    setup(project)
    with pytest.raises(BestOfNError, match=message):
        _prepare(project)
    assert not (project / ".workpilot" / "specs" / f"{PARENT}-bon1").exists()


def test_prepare_refuses_a_second_open_run(project: Path) -> None:
    _prepare(project)
    with pytest.raises(BestOfNError, match="already open"):
        _prepare(project)


def test_prepare_undoes_what_it_made_when_a_worktree_fails(project: Path) -> None:
    calls = []

    def flaky(spec_id: str) -> None:
        calls.append(spec_id)
        if len(calls) == 2:
            raise RuntimeError("disk full")
        _creator(project)(spec_id)

    with pytest.raises(BestOfNError, match="disk full"):
        prepare(
            project, _parent(project), parse_variants(ENGINES), create_worktree=flaky
        )
    for index in (1, 2):
        spec_id = variant_spec_id(PARENT, index)
        assert not (project / ".workpilot" / "specs" / spec_id).exists()
        assert not _worktree(project, spec_id).exists()
        assert _git(project, "branch", "--list", f"workpilot/{spec_id}") == ""
    assert read_state(_parent(project)) is None


# --- rank ----------------------------------------------------------------


def test_the_smaller_diff_wins_between_two_passing_builds(project: Path) -> None:
    _prepare(project)
    _build(project, 1, lines=40)
    _build(project, 2, lines=5)
    _exited(project)
    ranking = rank(project, _parent(project))["ranking"]

    assert ranking["criteria"] == ["build", "tests", "diff", "cost"]
    assert ranking["skipped"] == {"goal": "no_goal"}
    first, second = ranking["variants"]
    assert first["spec_id"] == "001-login-bon2" and first["rank"] == 1
    assert first["diff_lines"] == 5 and first["diff_files"] == 1
    assert second["diff_lines"] == 40 and second["rank"] == 2
    assert ranking["recommended"] == "001-login-bon2"


def test_tests_come_before_the_diff(project: Path) -> None:
    _prepare(project)
    _build(project, 1, lines=40)
    _build(project, 2, lines=5, qa="rejected")
    _exited(project)
    ranking = rank(project, _parent(project))["ranking"]
    assert ranking["recommended"] == "001-login-bon1"


def test_the_goal_is_checked_again_in_each_worktree(project: Path) -> None:
    (_parent(project) / GOAL_FILENAME).write_text(
        json.dumps({"command": "pytest"}), encoding="utf-8"
    )
    _prepare(project)
    _build(project, 1, lines=5)
    _build(project, 2, lines=40)
    _exited(project)
    seen = []

    def runner(spec, worktree: Path) -> GoalRun:
        seen.append(worktree.name)
        if worktree.name.endswith("bon2"):
            return GoalRun("met", exit_code=0)
        return GoalRun("unmet", exit_code=1, detail="exited 1")

    ranking = rank(project, _parent(project), goal_runner=runner)["ranking"]
    assert sorted(seen) == ["001-login-bon1", "001-login-bon2"]
    assert ranking["criteria"] == ["build", "tests", "goal", "diff", "cost"]
    assert ranking["recommended"] == "001-login-bon2"


def test_a_goal_that_cannot_be_checked_ranks_nobody(project: Path) -> None:
    (_parent(project) / GOAL_FILENAME).write_text(
        json.dumps({"command": "pytest"}), encoding="utf-8"
    )
    _prepare(project)
    _build(project, 1, lines=5)
    _build(project, 2, lines=40)
    _exited(project)

    def runner(spec, worktree: Path) -> GoalRun:
        if worktree.name.endswith("bon1"):
            return GoalRun("error", detail="program not found")
        return GoalRun("met", exit_code=0)

    ranking = rank(project, _parent(project), goal_runner=runner)["ranking"]
    assert ranking["skipped"] == {"goal": "goal_unchecked"}
    # Decided by the diff, as if there were no goal, not by a half-read goal.
    assert ranking["recommended"] == "001-login-bon1"


def test_a_cost_that_is_only_a_floor_ranks_nobody(project: Path) -> None:
    _prepare(project)
    _build(project, 1, lines=5, cost=None)
    _build(project, 2, lines=5, cost=0.5)
    _exited(project)
    ranking = rank(project, _parent(project))["ranking"]
    assert ranking["skipped"] == {"goal": "no_goal", "cost": "cost_partial"}
    assert [v["rank"] for v in ranking["variants"]] == [1, 1]
    assert ranking["recommended"] is None


def test_an_unfinished_build_is_never_recommended() -> None:
    scores = [
        VariantScore("a", 1, {}, 1, True, subtasks_done=1, subtasks_total=2),
        VariantScore("b", 2, {}, 1, False),
    ]
    summary = rank_variants(scores)
    assert scores[0].spec_id == "a" and scores[0].rank == 1
    assert summary["recommended"] is None


# --- adopt and discard ---------------------------------------------------


def test_adopt_makes_the_winner_the_task_build(project: Path) -> None:
    _prepare(project)
    _build(project, 1, lines=5)
    _build(project, 2, lines=40)
    _exited(project)
    rank(project, _parent(project))
    state = adopt(project, _parent(project), "001-login-bon2")

    assert state["phase"] == "adopted"
    assert state["adopted"]["cleanupProblems"] == []
    target = _worktree(project, PARENT)
    assert (target / "feature2.py").is_file()
    assert _git(target, "branch", "--show-current") == f"workpilot/{PARENT}"
    assert (
        target / ".workpilot" / "specs" / PARENT / "implementation_plan.json"
    ).is_file()
    assert not (target / ".workpilot" / "specs" / "001-login-bon2").exists()

    parent = _parent(project)
    assert (parent / "qa_report.md").read_text(encoding="utf-8") == "report 2"
    meta = json.loads((parent / "task_metadata.json").read_text(encoding="utf-8"))
    assert meta["provider"] == "openai" and meta["model"] == "model-b"
    assert "bestOfN" not in meta and meta["title"] == "Login"

    for index in (1, 2):
        spec_id = variant_spec_id(PARENT, index)
        assert not (project / ".workpilot" / "specs" / spec_id).exists()
        assert not _worktree(project, spec_id).exists()
        assert _git(project, "branch", "--list", f"workpilot/{spec_id}") == ""


def test_adopt_waits_for_every_variant(project: Path) -> None:
    _prepare(project)
    _build(project, 1, lines=5)
    with pytest.raises(BestOfNError, match="still running"):
        adopt(project, _parent(project), "001-login-bon1")


def test_adopt_refuses_a_name_outside_the_run(project: Path) -> None:
    _prepare(project)
    _exited(project)
    with pytest.raises(BestOfNError, match="not part of this run"):
        adopt(project, _parent(project), "002-other")


def test_discard_removes_every_variant_and_keeps_the_task(project: Path) -> None:
    _prepare(project)
    _build(project, 1, lines=5)
    state = discard(project, _parent(project))
    assert state["phase"] == "discarded"
    for index in (1, 2):
        spec_id = variant_spec_id(PARENT, index)
        assert not (project / ".workpilot" / "specs" / spec_id).exists()
        assert not _worktree(project, spec_id).exists()
    assert (_parent(project) / "spec.md").is_file()
    # A closed run lets a new one start.
    assert _prepare(project)["phase"] == "running"


def test_a_tampered_state_file_names_no_path(project: Path) -> None:
    _prepare(project)
    state = read_state(_parent(project))
    state["variants"][0]["specId"] = "../../etc"
    (_parent(project) / STATE_FILENAME).write_text(json.dumps(state), encoding="utf-8")
    with pytest.raises(BestOfNError, match="unexpected variant"):
        discard(project, _parent(project))
