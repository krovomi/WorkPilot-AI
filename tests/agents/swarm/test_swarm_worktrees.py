"""A swarm in a real git checkout: one worktree per subtask, merged per wave.

Each subtask is a real process of a worker stand-in that does what
``run.py --subtask`` does to the disk: it writes the subtask's files in the
directory it is given and marks the subtask completed in that directory's copy
of the plan. Everything else (worktrees, branches, commits, merges, the task's
plan) is the production code on a real repository.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest
from agents.swarm import subtask_worktree
from agents.swarm.orchestrator import SwarmOrchestrator
from agents.swarm.types import SwarmConfig, SwarmPhase
from agents.swarm.wave_executor import SWARM_EVENT_PREFIX

SPEC = "003-shop"

WORKER = r"""
import json, os, sys
from pathlib import Path

args = sys.argv
subtask = args[args.index("--subtask") + 1]
spec = args[args.index("--spec") + 1]
project = Path(args[args.index("--project-dir") + 1])
steps = json.loads(Path(os.environ["SWARM_FAKE_STEPS"]).read_text(encoding="utf-8"))
step = steps[subtask]
if step.get("fail"):
    sys.stderr.write("could not build " + subtask)
    sys.exit(1)
seen = {
    "cwd": os.getcwd(),
    "confined_to": os.environ.get("AUTO_CLAUDE_PROJECT_DIR"),
    "files": sorted(p.name for p in project.iterdir()),
}
seen_dir = Path(os.environ["SWARM_FAKE_SEEN"])
(seen_dir / (subtask + ".json")).write_text(json.dumps(seen), encoding="utf-8")
for name, text in step.get("write", {}).items():
    (project / name).write_text(text, encoding="utf-8")
plan_file = project / ".workpilot" / "specs" / spec / "implementation_plan.json"
plan = json.loads(plan_file.read_text(encoding="utf-8"))
for phase in plan["phases"]:
    for entry in phase["subtasks"]:
        if entry["id"] == subtask:
            entry["status"] = "completed"
            entry["notes"] = "built in " + project.name
plan_file.write_text(json.dumps(plan), encoding="utf-8")
"""


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=True
    ).stdout


@pytest.fixture
def shop(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    project = tmp_path / "shop"
    project.mkdir()
    git(project, "init", "-q", "-b", "main")
    git(project, "config", "user.email", "swarm@example.invalid")
    git(project, "config", "user.name", "Swarm test")
    (project / ".gitignore").write_text(".workpilot/\n", encoding="utf-8")
    (project / "README.md").write_text("# Shop\n", encoding="utf-8")
    git(project, "add", ".")
    git(project, "commit", "-q", "-m", "start")
    spec = project / ".workpilot" / "specs" / SPEC
    spec.mkdir(parents=True)
    source = tmp_path / "backend"
    source.mkdir()
    (source / "run.py").write_text(WORKER, encoding="utf-8")
    seen = tmp_path / "seen"
    seen.mkdir()
    monkeypatch.setenv("SWARM_FAKE_STEPS", str(tmp_path / "steps.json"))
    monkeypatch.setenv("SWARM_FAKE_SEEN", str(seen))
    return {"project": project, "spec": spec, "source": source, "seen": seen}


def plan(world: dict[str, Path], *phases: list[str]) -> None:
    (world["spec"] / "implementation_plan.json").write_text(
        json.dumps(
            {
                "phases": [
                    {
                        "name": f"phase {n}",
                        "subtasks": [{"id": i, "status": "pending"} for i in ids],
                    }
                    for n, ids in enumerate(phases)
                ]
            }
        ),
        encoding="utf-8",
    )


def steps(world: dict[str, Path], **by_subtask: dict) -> None:
    (world["source"].parent / "steps.json").write_text(
        json.dumps(by_subtask), encoding="utf-8"
    )


def swarm(world: dict[str, Path], **config: object) -> SwarmOrchestrator:
    return SwarmOrchestrator(
        project_dir=world["project"],
        spec_dir=world["spec"],
        config=SwarmConfig(subtask_timeout_seconds=60, **config),  # type: ignore[arg-type]
        python_path=sys.executable,
        source_path=str(world["source"]),
    )


def statuses(world: dict[str, Path]) -> dict[str, tuple]:
    data = json.loads(
        (world["spec"] / "implementation_plan.json").read_text(encoding="utf-8")
    )
    return {
        s["id"]: (s["status"], s.get("notes"))
        for p in data["phases"]
        for s in p["subtasks"]
    }


def seen(world: dict[str, Path], subtask: str) -> dict:
    return json.loads((world["seen"] / f"{subtask}.json").read_text(encoding="utf-8"))


def events(out: str) -> list[dict]:
    return [
        json.loads(line[len(SWARM_EVENT_PREFIX) :])
        for line in out.splitlines()
        if line.startswith(SWARM_EVENT_PREFIX)
    ]


def leftovers(project: Path) -> tuple[list[str], list[str]]:
    worktrees = [
        line
        for line in git(project, "worktree", "list", "--porcelain").splitlines()
        if line.startswith("worktree ")
    ]
    branches = git(project, "branch", "--list", "workpilot/*").split()
    return worktrees, branches


def test_each_subtask_is_built_apart_and_each_wave_is_merged(
    shop: dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    plan(shop, ["api", "db"], ["ui"])
    steps(
        shop,
        api={"write": {"api.py": "api\n"}},
        db={"write": {"db.py": "db\n"}},
        ui={"write": {"ui.py": "ui\n"}},
    )

    status = asyncio.run(swarm(shop).run())

    assert status.phase is SwarmPhase.COMPLETE
    assert (status.completed_subtasks, status.failed_subtasks) == (3, 0)
    assert [w.merge_success for w in status.waves] == [True, True]
    project = shop["project"]
    assert git(project, "ls-files").split() == [
        ".gitignore",
        "README.md",
        "api.py",
        "db.py",
        "ui.py",
    ]
    # Each worker ran in its own worktree, confined to it, and did not see
    # the other subtask of its wave; the second wave started from the first.
    api, db, ui = seen(shop, "api"), seen(shop, "db"), seen(shop, "ui")
    assert Path(api["cwd"]).name == "api" and Path(db["cwd"]).name == "db"
    assert api["confined_to"] == api["cwd"]
    assert "db.py" not in api["files"] and "api.py" not in db["files"]
    assert {"api.py", "db.py"} <= set(ui["files"])
    # The task's plan took what each worker recorded.
    assert statuses(shop) == {
        "api": ("completed", "built in api"),
        "db": ("completed", "built in db"),
        "ui": ("completed", "built in ui"),
    }
    assert leftovers(project) == ([f"worktree {project}"], [])
    merged = [e for e in events(capsys.readouterr().out) if e["type"] == "wave_merged"]
    assert [(e["merged"], e["conflicted"]) for e in merged] == [
        (["api", "db"], []),
        (["ui"], []),
    ]


def test_a_merge_that_conflicts_leaves_the_subtask_to_the_task(
    shop: dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    # Neither subtask says it writes notes.md, so they share a wave.
    plan(shop, ["first", "second"])
    steps(
        shop,
        first={"write": {"notes.md": "first\n"}},
        second={"write": {"notes.md": "second\n"}},
    )

    status = asyncio.run(swarm(shop).run())

    project = shop["project"]
    assert (status.completed_subtasks, status.failed_subtasks) == (1, 1)
    assert status.waves[0].merge_success is False
    assert (project / "notes.md").read_text(encoding="utf-8") == "first\n"
    # The merge was aborted: nothing half merged, and the subtask is pending.
    assert git(project, "status", "--porcelain") == ""
    assert not (project / ".git" / "MERGE_HEAD").exists()
    assert statuses(shop) == {
        "first": ("completed", "built in first"),
        "second": ("pending", None),
    }
    assert leftovers(project) == ([f"worktree {project}"], [])
    [merged] = [
        e for e in events(capsys.readouterr().out) if e["type"] == "wave_merged"
    ]
    assert (merged["merged"], merged["conflicted"]) == (["first"], ["second"])


def test_a_subtask_that_fails_is_not_merged_and_its_worktree_goes(
    shop: dict[str, Path],
) -> None:
    plan(shop, ["good", "bad"])
    steps(shop, good={"write": {"good.py": "ok\n"}}, bad={"fail": True})

    status = asyncio.run(swarm(shop, max_retries_per_subtask=1).run())

    assert (status.completed_subtasks, status.failed_subtasks) == (1, 1)
    assert status.nodes["bad"].error == "could not build bad"
    assert statuses(shop)["bad"] == ("pending", None)
    assert git(shop["project"], "ls-files").split()[-1] == "good.py"
    assert leftovers(shop["project"]) == ([f"worktree {shop['project']}"], [])


def test_fail_fast_removes_the_worktrees_of_the_stopped_wave(
    shop: dict[str, Path],
) -> None:
    plan(shop, ["good", "bad"], ["later"])
    steps(shop, good={}, bad={"fail": True}, later={})

    status = asyncio.run(swarm(shop, fail_fast=True).run())

    assert status.phase is SwarmPhase.FAILED
    assert not (shop["seen"] / "later.json").exists()
    assert leftovers(shop["project"]) == ([f"worktree {shop['project']}"], [])


# -- one worktree ---------------------------------------------------------------


def test_a_worktree_a_stopped_run_left_is_replaced(shop: dict[str, Path]) -> None:
    plan(shop, ["a/b c"])
    stale = subtask_worktree.create(shop["project"], shop["spec"], "a/b c")
    (stale.path / "half-done.txt").write_text("x", encoding="utf-8")

    fresh = subtask_worktree.create(shop["project"], shop["spec"], "a/b c")

    assert fresh.path == stale.path and fresh.branch == "workpilot/swarm/003-shop/a-b-c"
    assert not (fresh.path / "half-done.txt").exists()
    assert (fresh.spec_dir / "implementation_plan.json").is_file()
    assert (fresh.path / ".gitignore").read_text(encoding="utf-8") == ".workpilot/\n"
    subtask_worktree.remove(shop["project"], fresh.path, fresh.branch)
    assert leftovers(shop["project"]) == ([f"worktree {shop['project']}"], [])


def test_the_task_s_env_and_security_files_reach_the_worktree(
    shop: dict[str, Path],
) -> None:
    project = shop["project"]
    (project / ".env").write_text("SHOP_URL=http://localhost\n", encoding="utf-8")
    (project / ".workpilot-allowlist").write_text("make\n", encoding="utf-8")
    plan(shop, ["a"])

    worktree = subtask_worktree.create(project, shop["spec"], "a")

    assert (worktree.path / ".env").read_text(encoding="utf-8").startswith("SHOP_URL")
    assert (worktree.path / ".workpilot-allowlist").read_text(encoding="utf-8") == (
        "make\n"
    )
    subtask_worktree.remove(project, worktree.path, worktree.branch)


def test_outside_a_checkout_no_worktree_is_made(tmp_path: Path) -> None:
    plain = tmp_path / "plain"
    (plain / ".workpilot" / "specs" / SPEC).mkdir(parents=True)

    assert subtask_worktree.is_checkout(plain) is False
    with pytest.raises(subtask_worktree.SubtaskWorktreeError):
        subtask_worktree.create(plain, plain / ".workpilot" / "specs" / SPEC, "a")


def test_a_subdirectory_of_a_checkout_is_not_a_task(shop: dict[str, Path]) -> None:
    inner = shop["project"] / "inner"
    inner.mkdir()

    assert subtask_worktree.is_checkout(shop["project"]) is True
    assert subtask_worktree.is_checkout(inner) is False


def test_work_left_uncommitted_makes_the_task_unclean(shop: dict[str, Path]) -> None:
    project = shop["project"]
    assert subtask_worktree.is_clean(project)
    (project / ".workpilot" / "notes.txt").write_text("ours", encoding="utf-8")
    assert subtask_worktree.is_clean(project)

    (project / "draft.py").write_text("x = 1\n", encoding="utf-8")

    assert not subtask_worktree.is_clean(project)


def test_a_worker_that_did_not_complete_its_subtask_is_not_finished(
    shop: dict[str, Path],
) -> None:
    plan(shop, ["a"])
    worktree = subtask_worktree.create(shop["project"], shop["spec"], "a")
    try:
        assert subtask_worktree.finished(worktree) is False
        (worktree.spec_dir / "implementation_plan.json").write_text(
            "not json", encoding="utf-8"
        )
        assert subtask_worktree.finished(worktree) is False
    finally:
        subtask_worktree.remove(shop["project"], worktree.path, worktree.branch)


# -- the swarm as the build's coding phase --------------------------------------


@pytest.fixture
def phase(shop: dict[str, Path], monkeypatch: pytest.MonkeyPatch):
    """``run_swarm_phase`` with the worker stand-in, the swarm set to 3."""
    from functools import partial

    from agents.swarm import build_phase, orchestrator
    from core.progress import SWARM_SUBTASK_ENV

    monkeypatch.setattr(
        orchestrator,
        "SwarmOrchestrator",
        partial(
            SwarmOrchestrator,
            python_path=sys.executable,
            source_path=str(shop["source"]),
        ),
    )
    monkeypatch.setenv(build_phase.SWARM_ENV, "3")
    monkeypatch.setenv(SWARM_SUBTASK_ENV, "")
    monkeypatch.delenv(SWARM_SUBTASK_ENV)
    return lambda source=None: asyncio.run(
        build_phase.run_swarm_phase(shop["project"], shop["spec"], source)
    )


def test_the_build_s_subtasks_are_built_by_the_swarm_once(
    shop: dict[str, Path], phase, tmp_path: Path, capsys
) -> None:
    plan(shop, ["api", "db"], ["ui"])
    steps(shop, api={"write": {"api.py": ""}}, db={}, ui={})
    source = tmp_path / "project-spec"
    source.mkdir()

    assert phase(source) is True
    assert "Swarm: 3/3 subtasks built in parallel" in capsys.readouterr().out
    # The project's copy of the spec follows, as after any coder session.
    synced = json.loads(
        (source / "implementation_plan.json").read_text(encoding="utf-8")
    )
    assert {s["status"] for p in synced["phases"] for s in p["subtasks"]} == {
        "completed"
    }
    # Once per task and process: the coder loop calls it at every session.
    assert phase(source) is False


def test_what_the_swarm_could_not_finish_is_left_to_the_coder(
    shop: dict[str, Path], phase, capsys
) -> None:
    plan(shop, ["good", "bad"])
    steps(shop, good={}, bad={"fail": True})

    assert phase() is False
    assert "Swarm: 1/2 subtasks built in parallel" in capsys.readouterr().out
    assert statuses(shop)["bad"] == ("pending", None)


@pytest.mark.parametrize(
    ("setup", "reason"),
    [
        (lambda shop: plan(shop, ["one"], ["two"]), "no two subtasks"),
        (
            lambda shop: (
                plan(shop, ["a", "b"]),
                (shop["project"] / "draft.py").write_text("", encoding="utf-8"),
            ),
            "the task's worktree holds uncommitted work",
        ),
        (
            lambda shop: (shop["spec"] / "implementation_plan.json").write_text(
                "{", encoding="utf-8"
            ),
            "the plan cannot be read",
        ),
    ],
)
def test_the_swarm_steps_aside_and_says_why(
    shop: dict[str, Path], phase, capsys, setup, reason
) -> None:
    setup(shop)
    steps(shop, a={}, b={}, one={}, two={})

    assert phase() is False
    out = capsys.readouterr().out
    assert f"Swarm not used: {reason}" in out
    assert not list(shop["seen"].iterdir())


def test_outside_a_checkout_the_swarm_steps_aside(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    from agents.swarm import build_phase

    spec = tmp_path / "plain" / ".workpilot" / "specs" / SPEC
    spec.mkdir(parents=True)
    monkeypatch.setenv(build_phase.SWARM_ENV, "2")
    (spec / "implementation_plan.json").write_text(
        json.dumps({"phases": [{"subtasks": [{"id": "a"}, {"id": "b"}]}]}),
        encoding="utf-8",
    )

    assert asyncio.run(build_phase.run_swarm_phase(spec.parents[2], spec)) is False
    assert "the task is not in a git checkout" in capsys.readouterr().out


@pytest.mark.parametrize("value", [None, "", "1", "many"])
def test_the_swarm_is_off_unless_two_subtasks_may_run_at_once(
    shop: dict[str, Path], phase, monkeypatch, value
) -> None:
    from agents.swarm import build_phase

    if value is None:
        monkeypatch.delenv(build_phase.SWARM_ENV)
    else:
        monkeypatch.setenv(build_phase.SWARM_ENV, value)
    plan(shop, ["a", "b"])
    steps(shop, a={}, b={})

    assert build_phase.swarm_parallelism() == 0
    assert phase() is False
    assert not list(shop["seen"].iterdir())


def test_a_swarm_worker_never_starts_a_swarm(
    shop: dict[str, Path], phase, monkeypatch
) -> None:
    from core.progress import SWARM_SUBTASK_ENV

    monkeypatch.setenv(SWARM_SUBTASK_ENV, "a")
    plan(shop, ["a", "b"])
    steps(shop, a={}, b={})

    assert phase() is False
    assert not list(shop["seen"].iterdir())


@pytest.mark.parametrize(
    ("env", "retries", "fail_fast"),
    [
        ({}, 2, False),
        (
            {"WORKPILOT_SWARM_MAX_RETRIES": "0", "WORKPILOT_SWARM_FAIL_FAST": "1"},
            0,
            True,
        ),
        (
            {"WORKPILOT_SWARM_MAX_RETRIES": "5", "WORKPILOT_SWARM_FAIL_FAST": "no"},
            5,
            False,
        ),
        # What the app never sends keeps the defaults.
        ({"WORKPILOT_SWARM_MAX_RETRIES": "9"}, 2, False),
        ({"WORKPILOT_SWARM_MAX_RETRIES": "two"}, 2, False),
    ],
)
def test_the_swarm_takes_the_app_s_retries_and_fail_fast(
    monkeypatch: pytest.MonkeyPatch, env, retries, fail_fast
) -> None:
    from agents.swarm import build_phase

    for name in (build_phase.RETRIES_ENV, build_phase.FAIL_FAST_ENV):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)

    config = build_phase.swarm_config(4)

    assert config.max_parallel_agents == 4
    assert (config.max_retries_per_subtask, config.fail_fast) == (retries, fail_fast)


def test_with_fail_fast_a_failed_wave_leaves_the_rest_to_the_coder(
    shop: dict[str, Path], phase, monkeypatch, capsys
) -> None:
    from agents.swarm import build_phase

    monkeypatch.setenv(build_phase.FAIL_FAST_ENV, "1")
    monkeypatch.setenv(build_phase.RETRIES_ENV, "0")
    plan(shop, ["good", "bad"], ["later"])
    steps(shop, good={}, bad={"fail": True}, later={})

    assert phase() is False
    assert "Wave 0 failed (fail_fast=true): bad" in capsys.readouterr().out
    assert statuses(shop)["later"][0] == "pending"
