"""A task too big for one small pull request splits itself into several cards.

The ceilings (card, project, defaults), the cut (phases kept whole, a heavy
phase cut into runs, the planner's slice names, dependencies read
conservatively), the cards written on disk, and the build step that tells the
board. No model, no git: the cut reads the plan's JSON only.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from core.task_event import TaskEventEmitter
from foundation.build_signals import BuildSplit
from review.state import ReviewState
from task_split import (
    SplitError,
    SplitPolicy,
    child_spec_id,
    plan_slices,
    resolve_policy,
    split_spec,
)
from task_split import step as split_step
from task_split.slices import MAX_SLICES, subtask_lines

POLICY = SplitPolicy(enabled=True, max_lines=400, max_files=25)


def _subtask(sid: str, lines: int, *files: str) -> dict:
    return {
        "id": sid,
        "description": f"do {sid}",
        "files_to_modify": list(files),
        "estimated_lines": lines,
        "status": "pending",
    }


def _phase(pid: str, *subtasks: dict, depends_on=None, **extra) -> dict:
    phase = {"id": pid, "name": pid.title(), "type": "implementation", **extra}
    if depends_on is not None:
        phase["depends_on"] = depends_on
    phase["subtasks"] = list(subtasks)
    return phase


def _plan(*phases: dict) -> dict:
    return {
        "feature": "Add OAuth login",
        "workflow_type": "feature",
        "phases": list(phases),
    }


# --- policy -----------------------------------------------------------------


def test_the_card_ceiling_wins_over_the_project_and_the_default():
    env = {"WORKPILOT_SPLIT_MAX_LINES": "800", "WORKPILOT_SPLIT_MAX_FILES": "40"}
    assert resolve_policy({}, {}) == SplitPolicy(True, 400, 25, "default")
    assert resolve_policy({}, env) == SplitPolicy(True, 800, 40, "project")
    card = resolve_policy({"splitMaxLines": 250}, env)
    assert (card.max_lines, card.max_files, card.source) == (250, 40, "card")


@pytest.mark.parametrize("value", [3, 0, -5, "abc", True, 10**9, 12.5])
def test_a_ceiling_out_of_range_is_ignored_not_clamped(value):
    assert resolve_policy({"splitMaxLines": value}, {}).max_lines == 400


def test_splitting_is_off_for_a_card_that_says_so_or_a_project_that_does():
    assert not resolve_policy({"noSplit": True}, {}).enabled
    assert not resolve_policy({}, {"WORKPILOT_AUTO_SPLIT": "0"}).enabled
    assert resolve_policy({}, {"WORKPILOT_AUTO_SPLIT": "1"}).enabled


# --- weight -----------------------------------------------------------------


def test_a_subtask_weighs_its_estimate_or_its_files():
    assert subtask_lines({"estimated_lines": 120}) == 120
    assert (
        subtask_lines({"files_to_create": ["a.cs"], "files_to_modify": ["b.cs"]}) == 110
    )
    assert subtask_lines({}) == 20
    assert subtask_lines({"estimated_lines": "lots", "files_to_modify": ["x.go"]}) == 30


# --- the cut ----------------------------------------------------------------


def test_a_plan_under_the_ceiling_stays_one_card():
    plan = _plan(
        _phase("api", _subtask("1", 150, "a.py")),
        _phase("ui", _subtask("2", 150, "b.tsx")),
    )
    assert plan_slices(plan, POLICY) is None


def test_phases_are_kept_whole_and_dependent_ones_chained():
    plan = _plan(
        _phase("backend", _subtask("1", 300, "Api/Controller.cs"), depends_on=[]),
        _phase(
            "frontend",
            _subtask("2", 300, "src/app.component.ts"),
            depends_on=["backend"],
        ),
        _phase("docs", _subtask("3", 200, "README.md"), depends_on=[]),
    )
    slices = plan_slices(plan, POLICY)
    assert [s.index for s in slices] == [1, 2, 3]
    assert [[p["id"] for p in s.phases] for s in slices] == [
        ["backend"],
        ["frontend"],
        ["docs"],
    ]
    # frontend needs backend's code; docs needs nothing and starts at once.
    assert [s.after for s in slices] == [None, 1, None]


def test_small_phases_share_a_slice_until_the_ceiling():
    plan = _plan(
        _phase("a", _subtask("1", 150, "a.rs"), depends_on=[]),
        _phase("b", _subtask("2", 150, "b.rs"), depends_on=["a"]),
        _phase("c", _subtask("3", 300, "c.rs"), depends_on=["b"]),
    )
    slices = plan_slices(plan, POLICY)
    assert [[p["id"] for p in s.phases] for s in slices] == [["a", "b"], ["c"]]
    assert [s.after for s in slices] == [None, 1]
    assert slices[0].lines == 300


def test_a_phase_without_depends_on_waits_for_the_one_before():
    plan = _plan(
        _phase("a", _subtask("1", 350, "a.go")), _phase("b", _subtask("2", 350, "b.go"))
    )
    assert [s.after for s in plan_slices(plan, POLICY)] == [None, 1]


def test_an_integration_phase_waits_for_everything_before_it():
    plan = _plan(
        _phase("a", _subtask("1", 350, "a.kt"), depends_on=[]),
        _phase("b", _subtask("2", 350, "b.kt"), depends_on=[]),
        _phase("e2e", _subtask("3", 100, "e2e.kt"), depends_on=[], type="integration"),
    )
    slices = plan_slices(plan, POLICY)
    assert slices[-1].depends_on == [1, 2]
    assert [s.after for s in slices] == [None, 1, 2]


def test_an_unknown_dependency_is_read_as_everything_before():
    plan = _plan(
        _phase("a", _subtask("1", 350, "a.php"), depends_on=[]),
        _phase("b", _subtask("2", 350, "b.php"), depends_on=["does-not-exist"]),
    )
    assert plan_slices(plan, POLICY)[1].depends_on == [1]


def test_a_phase_heavier_than_the_ceiling_is_cut_into_chained_runs():
    plan = _plan(
        _phase(
            "big",
            _subtask("1", 250, "a.swift"),
            _subtask("2", 250, "b.swift"),
            _subtask("3", 250, "c.swift"),
            depends_on=[],
        ),
        _phase("after", _subtask("4", 100, "d.swift"), depends_on=["big"]),
    )
    slices = plan_slices(plan, POLICY)
    assert [[s["id"] for p in sl.phases for s in p["subtasks"]] for sl in slices] == [
        ["1"],
        ["2"],
        ["3", "4"],
    ]
    assert [s.after for s in slices] == [None, 1, 2]
    assert slices[0].phases[0]["name"] == "Big (1/3)"


def test_the_file_ceiling_cuts_too():
    many = [f"src/file{i}.dart" for i in range(20)]
    plan = _plan(
        _phase("a", _subtask("1", 50, *many), depends_on=[]),
        _phase(
            "b", _subtask("2", 50, *[f"lib/{i}.dart" for i in range(20)]), depends_on=[]
        ),
    )
    assert len(plan_slices(plan, POLICY)) == 2


def test_the_planner_slice_names_keep_phases_apart():
    plan = _plan(
        _phase("a", _subtask("1", 50, "a.java"), depends_on=[], slice="API"),
        _phase("b", _subtask("2", 50, "b.java"), depends_on=["a"], slice="API"),
        _phase("c", _subtask("3", 350, "c.java"), depends_on=["b"], slice="UI"),
    )
    slices = plan_slices(plan, POLICY)
    assert [s.name for s in slices] == ["API", "UI"]


def test_a_started_plan_is_never_cut():
    plan = _plan(
        _phase("a", _subtask("1", 350, "a.py")), _phase("b", _subtask("2", 350, "b.py"))
    )
    plan["phases"][0]["subtasks"][0]["status"] = "completed"
    assert plan_slices(plan, POLICY) is None


def test_a_huge_plan_is_cut_into_at_most_max_slices():
    phases = [_phase(f"p{i}", _subtask(str(i), 390, f"f{i}.c")) for i in range(30)]
    slices = plan_slices(_plan(*phases), POLICY)
    assert 1 < len(slices) <= MAX_SLICES


def test_a_disabled_policy_keeps_the_plan_whole():
    plan = _plan(
        _phase("a", _subtask("1", 900, "a.py")), _phase("b", _subtask("2", 900, "b.py"))
    )
    assert plan_slices(plan, SplitPolicy(False, 400, 25)) is None


# --- the cards on disk ------------------------------------------------------


@pytest.fixture
def specs(tmp_path) -> Path:
    root = tmp_path / ".workpilot" / "specs"
    parent = root / "012-add-oauth"
    parent.mkdir(parents=True)
    (parent / "spec.md").write_text(
        "# Specification: Add OAuth login\n\nBody.\n", encoding="utf-8"
    )
    (parent / "requirements.json").write_text(
        json.dumps(
            {
                "task_description": "Add OAuth",
                "display_title": "Ajouter la connexion OAuth",
            }
        ),
        encoding="utf-8",
    )
    (parent / "context.json").write_text("{}", encoding="utf-8")
    (parent / "task_logs.json").write_text("{}", encoding="utf-8")
    (parent / "task_metadata.json").write_text(
        json.dumps(
            {
                "provider": "openai",
                "model": "gpt-5.5",
                "prUrl": "x",
                "baseBranch": "develop",
            }
        ),
        encoding="utf-8",
    )
    plan = _plan(
        _phase("backend", _subtask("1", 300, "Api/Auth.cs"), depends_on=[]),
        _phase("frontend", _subtask("2", 300, "src/login.vue"), depends_on=["backend"]),
    )
    (parent / "implementation_plan.json").write_text(json.dumps(plan), encoding="utf-8")
    return root


def _json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_the_split_writes_queued_approved_children_and_archives_the_parent(specs):
    parent = specs / "012-add-oauth"
    result = split_spec(parent, env={})
    assert [c.spec_id for c in result.children] == [
        "012-add-oauth-part1",
        "012-add-oauth-part2",
    ]

    first, second = (specs / c.spec_id for c in result.children)
    plan = _json(second / "implementation_plan.json")
    assert plan["status"] == "queue"
    assert [p["id"] for p in plan["phases"]] == ["frontend"]
    assert plan["phases"][0]["depends_on"] == []  # backend is the blocker's
    assert plan["feature"] == "Ajouter la connexion OAuth (2/2): Frontend"

    meta = _json(second / "task_metadata.json")
    assert meta["blockedBy"] == ["012-add-oauth-part1"]
    assert meta["splitGroup"] == {
        "parent": "012-add-oauth",
        "title": "Ajouter la connexion OAuth",
        "index": 2,
        "total": 2,
        "name": "Frontend",
    }
    assert meta["provider"] == "openai" and meta["baseBranch"] == "develop"
    assert "prUrl" not in meta
    assert "blockedBy" not in _json(first / "task_metadata.json")

    spec = (second / "spec.md").read_text(encoding="utf-8")
    assert spec.startswith("> **Part 2 of 2**") and "Body." in spec
    assert _json(second / "requirements.json")["display_title"].endswith(
        "(2/2): Frontend"
    )
    assert not (second / "task_logs.json").exists()
    assert (second / "context.json").exists()
    assert ReviewState.load(second).is_approval_valid(second)

    parent_meta = _json(parent / "task_metadata.json")
    assert parent_meta["splitGroup"]["children"] == [c.spec_id for c in result.children]
    assert parent_meta["archivedAt"]
    parent_plan = _json(parent / "implementation_plan.json")
    assert parent_plan["status"] == "done" and parent_plan["split"]["total"] == 2


def test_a_child_or_a_split_parent_is_never_split_again(specs):
    parent = specs / "012-add-oauth"
    split_spec(parent, env={})
    assert split_spec(parent, env={}) is None
    child = specs / "012-add-oauth-part1"
    plan = _json(parent / "implementation_plan.json")
    (child / "implementation_plan.json").write_text(json.dumps(plan), encoding="utf-8")
    assert split_spec(child, env={}) is None


def test_a_leftover_child_directory_keeps_the_task_whole(specs):
    (specs / "012-add-oauth-part2").mkdir()
    with pytest.raises(SplitError):
        split_spec(specs / "012-add-oauth", env={})
    assert not (specs / "012-add-oauth-part1").exists()
    assert "splitGroup" not in _json(specs / "012-add-oauth" / "task_metadata.json")


def test_the_worktree_copy_of_the_plan_is_settled_too(specs, tmp_path):
    parent = specs / "012-add-oauth"
    copy = tmp_path / "worktree" / "012-add-oauth"
    copy.mkdir(parents=True)
    (copy / "implementation_plan.json").write_text(
        (parent / "implementation_plan.json").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    (parent / "implementation_plan.json").write_text("{}", encoding="utf-8")
    result = split_spec(parent, plan_dir=copy, env={})
    assert len(result.children) == 2
    assert _json(copy / "implementation_plan.json")["status"] == "done"


def test_child_ids_are_card_ids_the_server_board_accepts():
    from board_mcp.server import CARD_ID

    assert child_spec_id("001-a", 2) == "001-a-part2"
    long = "012-" + "-".join(["word"] * 30)
    for index in (1, 10):
        assert CARD_ID.match(child_spec_id(long, index))
        assert not child_spec_id(long, index).replace(f"-part{index}", "").endswith("-")
    assert len(child_spec_id("x" * 200, 3)) == 128


# --- the build step ---------------------------------------------------------


def test_the_step_tells_the_board_and_unwinds_the_build(specs, monkeypatch, capsys):
    monkeypatch.delenv("WORKPILOT_AUTO_SPLIT", raising=False)
    monkeypatch.delenv("WORKPILOT_SPLIT_MAX_LINES", raising=False)
    with pytest.raises(BuildSplit) as raised:
        split_step.raise_if_split(specs / "012-add-oauth", TaskEventEmitter)
    assert raised.value.children == ["012-add-oauth-part1", "012-add-oauth-part2"]
    out = capsys.readouterr().out
    line = next(line for line in out.splitlines() if line.startswith("__TASK_EVENT__:"))
    event = json.loads(line.split(":", 1)[1])
    assert event["type"] == "TASK_SPLIT"
    assert [c["after"] for c in event["children"]] == [None, "012-add-oauth-part1"]


def test_the_step_builds_the_task_whole_when_the_split_cannot_be_written(
    specs, monkeypatch
):
    (specs / "012-add-oauth-part1").mkdir()
    assert (
        split_step.split_before_build(specs / "012-add-oauth", TaskEventEmitter) == []
    )


def test_the_step_does_nothing_when_the_project_turned_splitting_off(
    specs, monkeypatch
):
    monkeypatch.setenv("WORKPILOT_AUTO_SPLIT", "0")
    split_step.raise_if_split(specs / "012-add-oauth", TaskEventEmitter)
    assert not (specs / "012-add-oauth-part1").exists()
