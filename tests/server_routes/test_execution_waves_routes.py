"""``/api/features/execution-waves``: the waves of a server project's backlog,
and the run that starts them in that order, through the real middleware.

A run starts a real process: the run manager launches a stand-in agent from
``BACKEND_DIR`` (as in ``test_spec_routes``) that marks its card merged, or
waits while a ``hold-<card>`` file is there. The run's next wave then starts
on its own, as the person who started the run, when a run of the project
ends; and only while that person may still start runs on the project.
"""

from __future__ import annotations

import asyncio
import json
import os
import textwrap
from pathlib import Path

import pytest

AGENT = textwrap.dedent(
    """
    import json, sys, time
    from pathlib import Path

    args = sys.argv[1:]
    project = Path(args[args.index("--project-dir") + 1])
    script = Path(sys.argv[0]).name
    if script == "run.py":
        card = args[args.index("--spec") + 1]
        folder = project / ".workpilot" / "specs" / card
    else:
        folder = Path(args[args.index("--spec-dir") + 1])
        card = folder.name
    with open(project / "agent-calls.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps({"script": script, "card": card, "args": args}) + "\\n")
    for _ in range(400):
        if not (project / f"hold-{card}").exists():
            break
        time.sleep(0.05)
    plan_path = folder / "implementation_plan.json"
    plan = json.loads(plan_path.read_text(encoding="utf-8")) if plan_path.exists() else {}
    if script == "run.py":
        plan["status"] = "done"
    else:
        (folder / "spec.md").write_text("# spec", encoding="utf-8")
        plan["status"] = "human_review"
    plan_path.write_text(json.dumps(plan), encoding="utf-8")
    """
)

BASE = "/api/features/execution-waves"


@pytest.fixture
def agent(tmp_path, monkeypatch) -> Path:
    from server.services import run_manager

    backend = tmp_path / "fake-backend"
    (backend / "runners").mkdir(parents=True)
    (backend / "run.py").write_text(AGENT, encoding="utf-8")
    (backend / "runners" / "spec_runner.py").write_text(AGENT, encoding="utf-8")
    monkeypatch.setattr(run_manager, "BACKEND_DIR", backend)
    monkeypatch.setenv("WORKPILOT_RUN_ISOLATION", "off")
    return backend


@pytest.fixture(autouse=True)
def _fresh_driver(monkeypatch):
    from shared_features.waves import driver

    monkeypatch.setattr(driver, "_active", set())
    monkeypatch.setattr(driver, "_locks", {})


def card(
    clone: Path,
    name: str,
    files: list[str],
    *,
    spec: bool = True,
    minute: int = 0,
    **meta,
) -> None:
    folder = clone / ".workpilot" / "specs" / name
    folder.mkdir(parents=True, exist_ok=True)
    if files or spec:
        plan = {
            "feature": f"Card {name}",
            "status": "backlog",
            "created_at": f"2026-11-01T10:{minute:02d}:00Z",
            "phases": [{"subtasks": [{"files_to_modify": files}]}],
        }
        (folder / "implementation_plan.json").write_text(
            json.dumps(plan), encoding="utf-8"
        )
    if spec:
        (folder / "spec.md").write_text("# spec", encoding="utf-8")
    meta.setdefault("requireReviewBeforeCoding", False)
    (folder / "task_metadata.json").write_text(json.dumps(meta), encoding="utf-8")


def calls(world) -> list[dict]:
    path = world.clone("a") / "agent-calls.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


async def until(predicate, what: str):
    for _ in range(300):
        value = await predicate()
        if value:
            return value
        await asyncio.sleep(0.05)
    raise AssertionError(f"never happened: {what}")


def url(world, path: str = "", side: str = "a") -> str:
    return f"{BASE}{path}?project_id={world.projects[side]}"


async def test_the_plan_of_the_backlog(world):
    clone = world.clone("a")
    card(clone, "001-login", ["src/auth.py", "package.json"], minute=1)
    card(clone, "002-cart", ["src/cart.py", "package.json"], minute=2)
    card(clone, "003-help", ["docs/help.md"], minute=3)
    plan = await world.ok("viewer_a", "GET", url(world, "/plan"))
    assert plan["projectId"] == world.projects["a"]
    assert [sorted(w["taskIds"]) for w in plan["waves"]] == [
        ["001-login", "003-help"],
        ["002-cart"],
    ]
    assert plan["pairs"][0]["sharedFiles"] == ["package.json"]
    assert plan["fragileZones"]["enabled"] and plan["codeLinks"]["enabled"]
    assert str(clone) not in json.dumps(plan)
    narrow = await world.ok(
        "viewer_a",
        "GET",
        url(world, "/plan")
        + "&max_parallel=1&fragile_zones=false&code_links=false&tolerance=5",
    )
    assert [len(w["taskIds"]) for w in narrow["waves"]] == [1, 1, 1]
    for bad in ("tolerance=-1", "max_parallel=99", "unplanned_policy=maybe"):
        answer = await world.call("viewer_a", "GET", url(world, "/plan") + f"&{bad}")
        assert answer.status_code == 422, bad


async def test_the_parallelism_never_exceeds_the_organization_s_run_ceiling(world):
    from server.db.engine import get_session_factory
    from server.db.models import OrgQuota

    async with get_session_factory()() as db:
        db.add(OrgQuota(org_id=world.orgs["a"], max_concurrent_runs=1))
        await db.commit()
    card(world.clone("a"), "001-a", ["a.py"])
    card(world.clone("a"), "002-b", ["b.py"])
    plan = await world.ok("viewer_a", "GET", url(world, "/plan") + "&max_parallel=4")
    assert plan["maxParallel"] == 1 and len(plan["waves"]) == 2


async def test_a_run_goes_wave_after_wave_on_its_own_and_is_recorded(world, agent):
    clone = world.clone("a")
    card(clone, "001-login", ["src/shared.py"], minute=1)
    card(clone, "002-cart", ["src/shared.py"], minute=2)
    started = await world.ok(
        "contributor_a", "POST", url(world, "/run"), json={"advanceWhen": "merged"}
    )
    run = started["run"]
    assert run["waves"] == [["001-login"], ["002-cart"]]
    assert run["started"] == ["001-login"] and run["failures"] == {}
    assert run["avoided"] == {"conflicts": 1, "risk": 1}
    assert "startedBy" not in run
    assert {c["id"]: c["running"] for c in started["cards"]}["001-login"] is True

    async def ended():
        answer = await world.ok("viewer_a", "GET", url(world, "/run"))
        return answer["run"] is None and answer

    await until(ended, "the run ended on its own")
    assert [c["card"] for c in calls(world)] == ["001-login", "002-cart"]
    assert all(c["script"] == "run.py" for c in calls(world))
    history = await world.ok("viewer_a", "GET", url(world, "/history"))
    assert history["ignored"] is False
    assert history["records"][0]["outcome"] == "done"
    assert history["records"][0]["started"] == 2
    assert (
        history["summary"]["runs"] == 1 and history["summary"]["conflictsAvoided"] == 1
    )

    from server.db.engine import get_session_factory
    from server.db.models import AuditLog
    from sqlalchemy import select

    async with get_session_factory()() as db:
        audits = (
            await db.scalars(
                select(AuditLog).where(AuditLog.action == "spec.run.started")
            )
        ).all()
    assert [a.payload["spec"] for a in audits] == ["001-login", "002-cart"]
    assert all(a.user_id == world.users["contributor_a"] for a in audits)


async def test_steps_respect_the_parallelism_and_stop_leaves_cards_running(
    world, agent
):
    clone = world.clone("a")
    for i, name in enumerate(("001-a", "002-b", "003-c")):
        card(clone, name, [f"src/{name}.py"], minute=i)
        (clone / f"hold-{name}").write_text("", encoding="utf-8")
    started = await world.ok(
        "contributor_a",
        "POST",
        url(world, "/run"),
        json={"options": {"maxParallel": 2}, "advanceWhen": "review"},
    )
    assert started["run"]["started"] == ["001-a", "002-b"]
    second = await world.call("contributor_a", "POST", url(world, "/run"), json={})
    assert second.status_code == 409
    stepped = await world.ok("contributor_a", "POST", url(world, "/run/step"))
    assert stepped["run"]["started"] == ["001-a", "002-b"]
    stopped = await world.ok("contributor_a", "DELETE", url(world, "/run"))
    assert stopped == {"run": None, "ended": "stopped", "ignored": False}
    assert (await world.ok("viewer_a", "GET", url(world, "/run")))["run"] is None
    history = await world.ok("viewer_a", "GET", url(world, "/history"))
    assert history["records"][0]["outcome"] == "stopped"
    assert (
        await world.call("contributor_a", "DELETE", url(world, "/run"))
    ).status_code == 404
    assert (await world.ok("contributor_a", "POST", url(world, "/run/step")))[
        "run"
    ] is None
    for name in ("001-a", "002-b", "003-c"):
        (clone / f"hold-{name}").unlink()

    async def both_done():
        return len(calls(world)) == 2 and all(
            json.loads(
                (
                    clone / ".workpilot" / "specs" / n / "implementation_plan.json"
                ).read_text(encoding="utf-8")
            )["status"]
            == "done"
            for n in ("001-a", "002-b")
        )

    await until(both_done, "the cards it started finished")
    await asyncio.sleep(0.2)
    # Stopped: the third card was never started.
    assert sorted(c["card"] for c in calls(world)) == ["001-a", "002-b"]


async def test_cards_that_cannot_start_say_why(world, agent):
    clone = world.clone("a")
    card(clone, "001-claimed", ["a.py"], minute=1)
    card(clone, "002-review", ["b.py"], minute=2, requireReviewBeforeCoding=True)
    card(clone, "003-nospec", [], spec=False, minute=3)
    (clone / "hold-003-nospec").write_text("", encoding="utf-8")
    listed = await world.ok("viewer_a", "GET", f"/projects/{world.projects['a']}/specs")
    claimed = next(s for s in listed if s["spec_name"] == "001-claimed")
    await world.ok(
        "owner_a",
        "POST",
        f"/projects/{world.projects['a']}/specs/{claimed['id']}/claim",
        json={},
    )
    started = await world.ok(
        "contributor_a",
        "POST",
        url(world, "/run"),
        json={"options": {"unplannedPolicy": "independent"}},
    )
    run = started["run"]
    assert run["failures"] == {"001-claimed": "claimed", "002-review": "needs_approval"}
    assert set(run["started"]) == {"001-claimed", "002-review", "003-nospec"}
    await until(lambda: asyncio.sleep(0, result=bool(calls(world))), "the spec run")
    assert calls(world)[0]["script"] == "spec_runner.py"
    assert "--no-build" in calls(world)[0]["args"]
    (clone / "hold-003-nospec").unlink()


async def test_nothing_to_plan_and_viewers_who_try(world):
    empty = await world.call("contributor_a", "POST", url(world, "/run"), json={})
    assert empty.status_code == 409 and empty.json()["detail"] == "Nothing to plan"
    card(world.clone("a"), "001-a", ["a.py"])
    for method, path in (("POST", "/run"), ("POST", "/run/step"), ("DELETE", "/run")):
        answer = await world.call("viewer_a", method, url(world, path), json={})
        assert answer.status_code == 403, (method, path)
    # An analyst reads, but is no member who may change the board.
    bad = await world.call(
        "contributor_a", "POST", url(world, "/run"), json={"options": {"evil": 1}}
    )
    assert bad.status_code == 422


async def test_a_linked_run_file_is_refused(world, tmp_path):
    clone = world.clone("a")
    card(clone, "001-a", ["a.py"])
    elsewhere = tmp_path / "elsewhere.json"
    elsewhere.write_text("{}", encoding="utf-8")
    os.symlink(elsewhere, clone / ".workpilot" / "execution-waves-run.json")
    answer = await world.ok("viewer_a", "GET", url(world, "/run"))
    assert answer == {"run": None, "ended": None, "ignored": True}
    refused = await world.call("contributor_a", "POST", url(world, "/run"), json={})
    assert (
        refused.status_code == 409
        and refused.json()["detail"] == "Run file unavailable"
    )
    assert elsewhere.read_text(encoding="utf-8") == "{}"


async def test_a_run_file_that_cannot_be_written_is_refused_on_step_and_stop(
    world, agent, monkeypatch
):
    from shared_features.waves import run_store

    clone = world.clone("a")
    card(clone, "001-a", ["a.py"])
    card(clone, "002-b", ["a.py"])
    (clone / "hold-001-a").write_text("", encoding="utf-8")
    await world.ok("contributor_a", "POST", url(world, "/run"), json={})

    def refuse(*_args, **_kwargs):
        raise run_store.StoreRefused("linked file")

    monkeypatch.setattr(run_store, "save_run", refuse)
    monkeypatch.setattr(run_store, "end_run", refuse)
    (clone / ".workpilot" / "specs" / "001-a" / "implementation_plan.json").write_text(
        json.dumps({"status": "done", "phases": [{"subtasks": [{"files": ["a.py"]}]}]}),
        encoding="utf-8",
    )
    for method in ("POST", "DELETE"):
        path = "/run/step" if method == "POST" else "/run"
        answer = await world.call("contributor_a", method, url(world, path))
        assert answer.status_code == 409, method
    (clone / "hold-001-a").unlink()


async def test_the_next_wave_waits_for_a_person_who_lost_the_right(world, agent):
    from server.db.engine import get_session_factory
    from server.db.models import ProjectMember
    from sqlalchemy import delete

    clone = world.clone("a")
    card(clone, "001-a", ["a.py"], minute=1)
    card(clone, "002-b", ["a.py"], minute=2)
    (clone / "hold-001-a").write_text("", encoding="utf-8")
    await world.ok("contributor_a", "POST", url(world, "/run"), json={})
    async with get_session_factory()() as db:
        await db.execute(
            delete(ProjectMember).where(
                ProjectMember.user_id == world.users["contributor_a"],
                ProjectMember.project_id == world.projects["a"],
            )
        )
        await db.commit()
    (clone / "hold-001-a").unlink()

    async def first_done():
        plan = clone / ".workpilot" / "specs" / "001-a" / "implementation_plan.json"
        return json.loads(plan.read_text(encoding="utf-8"))["status"] == "done"

    await until(first_done, "the first card finished")
    await asyncio.sleep(0.3)
    assert [c["card"] for c in calls(world)] == ["001-a"]
    # A person who may takes the step.
    stepped = await world.ok("operator_a", "POST", url(world, "/run/step"))
    assert stepped["run"]["current"] == 1 and stepped["run"]["started"][-1] == "002-b"


async def test_a_run_whose_cards_all_refuse_ends_at_once(world, agent):
    clone = world.clone("a")
    card(clone, "001-review", ["a.py"], requireReviewBeforeCoding=True)
    answer = await world.ok("contributor_a", "POST", url(world, "/run"), json={})
    assert answer == {"run": None, "ended": "done", "ignored": False}
    history = await world.ok("viewer_a", "GET", url(world, "/history"))
    assert history["records"][0]["started"] == 1 and calls(world) == []


async def test_a_card_already_running_is_not_started_twice(world, agent):
    clone = world.clone("a")
    card(clone, "001-busy", ["a.py"], minute=1)
    card(clone, "002-free", ["b.py"], minute=2)
    (clone / "hold-001-busy").write_text("", encoding="utf-8")
    listed = await world.ok("viewer_a", "GET", f"/projects/{world.projects['a']}/specs")
    busy = next(s for s in listed if s["spec_name"] == "001-busy")
    await world.ok(
        "contributor_a",
        "POST",
        f"/projects/{world.projects['a']}/specs/{busy['id']}/runs",
        json={"phase": "build"},
    )
    started = await world.ok("contributor_a", "POST", url(world, "/run"), json={})
    assert started["run"]["failures"] == {"001-busy": "already_running"}
    assert "002-free" in started["run"]["started"]
    (clone / "hold-001-busy").unlink()


async def test_the_next_wave_is_planned_again_and_kept_when_the_plan_gives_none(
    world, agent
):
    clone = world.clone("a")
    card(clone, "001-a", ["x.py"], minute=1)
    card(clone, "002-b", ["x.py"], minute=2)
    card(clone, "003-c", ["x.py"], minute=3)
    for name in ("001-a", "002-b"):
        (clone / f"hold-{name}").write_text("", encoding="utf-8")
    started = await world.ok("contributor_a", "POST", url(world, "/run"), json={})
    assert started["run"]["waves"] == [["001-a"], ["002-b"], ["003-c"]]
    # Meanwhile two cards wait on each other: the new plan has no wave for them.
    card(clone, "002-b", ["x.py"], minute=2, blockedBy=["003-c"])
    card(clone, "003-c", ["x.py"], minute=3, blockedBy=["002-b"])
    (clone / "hold-001-a").unlink()

    async def moved():
        answer = await world.ok("viewer_a", "GET", url(world, "/run"))
        return answer["run"]["current"] == 1 and answer

    answer = await until(moved, "the run moved on")
    assert answer["run"]["waves"] == [["001-a"], ["002-b"], ["003-c"]]
    assert answer["blocked"] == []
    stepped = await world.ok("contributor_a", "POST", url(world, "/run/step"))
    assert stepped["blocked"] == ["002-b"]
    (clone / "hold-002-b").unlink()


async def test_a_wave_with_nothing_left_to_plan_after_it_moves_on(world, agent):
    clone = world.clone("a")
    card(clone, "001-a", ["x.py"], minute=1)
    card(clone, "002-b", ["x.py"], minute=2)
    (clone / "hold-001-a").write_text("", encoding="utf-8")
    await world.ok("contributor_a", "POST", url(world, "/run"), json={})
    # Someone else started the next card meanwhile: nothing is left to plan.
    plan = clone / ".workpilot" / "specs" / "002-b" / "implementation_plan.json"
    plan.write_text(
        json.dumps(
            {**json.loads(plan.read_text(encoding="utf-8")), "status": "in_progress"}
        ),
        encoding="utf-8",
    )
    (clone / "hold-001-a").unlink()

    async def moved():
        answer = await world.ok("viewer_a", "GET", url(world, "/run"))
        return answer["run"]["current"] == 1 and answer

    answer = await until(moved, "the run moved on")
    assert answer["run"]["waves"] == [["001-a"], ["002-b"]]
    assert answer["run"]["started"] == ["001-a"]


async def test_a_step_on_its_own_finds_nothing_to_do_without_a_project_or_a_run(
    world, monkeypatch
):
    from shared_features.waves import driver

    driver.remember("no-such-project", True)
    await driver.advance_as_owner("no-such-project")
    driver.remember(world.projects["a"], True)
    await driver.advance_as_owner(world.projects["a"])
    assert world.projects["a"] not in driver._active
    driver.on_run_ended("not-active")  # nothing scheduled, nothing raised


async def test_a_failed_step_on_its_own_is_logged(caplog):
    from shared_features.waves import driver

    async def boom():
        raise RuntimeError("x")

    task = asyncio.get_running_loop().create_task(boom())
    await asyncio.gather(task, return_exceptions=True)
    driver._log_failure(task)
    assert "RuntimeError" in caplog.text


async def test_a_start_the_run_manager_or_the_quotas_refuse(world, monkeypatch):
    from fastapi import HTTPException
    from server.authz.principal import Principal
    from server.db.engine import get_session_factory
    from server.db.models import Project, SpecIndex
    from server.services import run_manager
    from shared_features.waves import driver
    from shared_features.waves.service import read_cards

    card(world.clone("a"), "001-a", ["a.py"])
    cards = read_cards(world.clone("a"), "main")
    actor = Principal(id=world.users["contributor_a"], email="c@x.test")

    class Refusing:
        def __init__(self, error):
            self.error = error

        def is_running(self, _spec_id):
            return False

        async def start_run(self, **_kwargs):
            raise self.error

    async with get_session_factory()() as db:
        project = await db.get(Project, world.projects["a"])
        row = SpecIndex(project_id=project.id, spec_name="001-a")
        db.add(row)
        await db.commit()
        row_id = row.id
        assert await driver._start_card(db, project, actor, None, cards[0]) == "missing"
        for error, reason in (
            (run_manager.RunManagerError("busy"), "refused"),
            (HTTPException(status_code=429), "quota"),
            (HTTPException(status_code=402), "quota"),
            (HTTPException(status_code=400), "refused"),
        ):
            monkeypatch.setattr(
                run_manager, "get_run_manager", lambda e=error: Refusing(e)
            )
            row = await db.get(SpecIndex, row_id)
            assert await driver._start_card(db, project, actor, row, cards[0]) == reason


async def test_a_project_gone_answers_not_found(world):
    from server.authz.scope import ProjectScope
    from server.db.engine import get_session_factory
    from shared_features.execution_waves import _project

    async with get_session_factory()() as db:
        with pytest.raises(Exception) as gone:
            await _project(db, ProjectScope("gone", "org", Path("."), None))
    assert getattr(gone.value, "status_code", None) == 404
