"""Runs a server restart interrupted: offered, resumed, or set aside.

Before: a restart marked every queued or running run failed, and nothing
offered to resume the card's work. Now ``settle_orphans`` marks them
``interrupted``; ``GET /users/me/interrupted-runs`` lists those its caller
started (and every one of a project they own), ``POST .../runs/{id}/resume``
starts the same phase again where it stopped, with the permission starting a
run takes, and ``POST /users/me/interrupted-runs/later`` sets them aside.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest

from tests.server_routes.test_spec_routes import (
    agent,  # noqa: F401  (fixture)
    base,
    specs,
    until_finished,
    write_spec,
)

LIST = "/users/me/interrupted-runs"

PLAN = {
    "feature": "Sign in with a passkey",
    "status": "in_progress",
    "phases": [
        {
            "subtasks": [
                {"id": "1", "title": "Store the keys", "status": "completed"},
                {"id": "2", "title": "Ask for the key", "status": "in_progress"},
                {"id": "3", "description": "Explain it", "status": "pending"},
            ]
        }
    ],
}


def write_plan(world, name: str, plan: dict) -> None:
    write_spec(world.clone("a"), name)
    path = world.clone("a") / ".workpilot" / "specs" / name / "implementation_plan.json"
    path.write_text(json.dumps(plan), encoding="utf-8")


async def add_run(
    spec_id: str,
    who: str,
    *,
    phase: str = "build",
    status: str = "running",
    model: str | None = "a-model",
    started_approved: bool = False,
    minutes_ago: int = 10,
) -> str:
    from server.db.engine import get_session_factory
    from server.db.models import AgentRun

    async with get_session_factory()() as db:
        run = AgentRun(
            spec_id=spec_id,
            phase=phase,
            started_by=who,
            model=model,
            status=status,
            started_approved=started_approved,
            started_at=datetime.now(UTC) - timedelta(minutes=minutes_ago),
        )
        db.add(run)
        await db.commit()
        return run.id


async def restart() -> int:
    """What a new server process does first: settle what the last one left."""
    from server.services.run_manager import RunManager

    return await RunManager().settle_orphans()


@pytest.fixture
async def card(world, agent) -> str:  # noqa: F811
    write_plan(world, "001-passkey", PLAN)
    return (await specs(world))["001-passkey"]["id"]


async def offered(world, who: str) -> list[dict]:
    return (await world.ok(who, "GET", LIST))["runs"]


class TestWhatIsOffered:
    async def test_a_restart_interrupts_the_run_and_offers_it_to_its_starter(
        self, world, card
    ):
        run_id = await add_run(card, world.users["contributor_a"])
        assert await restart() == 1
        (row,) = await offered(world, "contributor_a")
        assert row["run_id"] == run_id
        assert row["spec_id"] == card
        assert row["card_id"] == "001-passkey"
        assert row["project_id"] == world.projects["a"]
        assert row["project_name"] == "Project A"
        assert row["title"] == "Sign in with a passkey"
        assert (row["run_phase"], row["phase"]) == ("build", "coding")
        assert (row["subtasks_done"], row["subtasks_total"]) == (1, 3)
        # The subtask the dead process was on is the one the resume reopens.
        assert row["next_subtask"] == "Ask for the key"
        assert row["model"] == "a-model"
        assert row["mine"] is True and row["started_by_name"] is None
        assert row["blocker"] is None
        assert row["interrupted_at"]
        runs = await world.ok("viewer_a", "GET", f"{base(world)}/{card}/runs")
        assert runs[0]["status"] == "interrupted"

    async def test_an_owner_sees_the_project_s_and_others_see_none(self, world, card):
        await add_run(card, world.users["contributor_a"])
        await restart()
        (owned,) = await offered(world, "owner_a")
        assert owned["mine"] is False
        assert owned["started_by_name"] == "contributor_a"
        # An administrator of the organization owns each of its projects.
        assert len(await offered(world, "admin_a")) == 1
        assert await offered(world, "grouped_a") == []
        assert await offered(world, "viewer_a") == []
        assert await offered(world, "member_b") == []

    async def test_the_phase_reads_where_the_work_stopped(self, world, card):
        write_plan(world, "002-empty", {"status": "in_progress"})
        write_plan(
            world,
            "003-done",
            {"phases": [{"subtasks": [{"id": "1", "status": "completed"}]}]},
        )
        write_spec(world.clone("a"), "004-spec")
        write_spec(world.clone("a"), "005-qa")
        ids = {name: row["id"] for name, row in (await specs(world)).items()}
        me = world.users["contributor_a"]
        await add_run(ids["002-empty"], me)
        await add_run(ids["003-done"], me)
        await add_run(ids["004-spec"], me, phase="spec")
        await add_run(ids["005-qa"], me, phase="qa")
        await restart()
        phases = {
            row["card_id"]: row["phase"]
            for row in await offered(world, "contributor_a")
        }
        assert phases == {
            "002-empty": "planning",
            "003-done": "qa_review",
            "004-spec": "spec",
            "005-qa": "qa_review",
        }

    async def test_a_merge_a_later_run_or_a_finished_run_is_not_offered(
        self, world, card
    ):
        write_spec(world.clone("a"), "006-merge")
        merge = (await specs(world))["006-merge"]["id"]
        me = world.users["contributor_a"]
        await add_run(merge, me, phase="merge")
        await add_run(card, me, minutes_ago=30)
        await add_run(card, me, status="succeeded", minutes_ago=5)
        await restart()
        assert await offered(world, "contributor_a") == []

    async def test_a_card_whose_folder_is_gone_says_so(self, world, card):
        import shutil

        await add_run(card, world.users["contributor_a"])
        await restart()
        shutil.rmtree(world.clone("a") / ".workpilot" / "specs" / "001-passkey")
        (row,) = await offered(world, "contributor_a")
        assert row["blocker"] == "spec_missing"
        assert row["title"] == "001-passkey"

    async def test_a_workspace_copy_leading_out_of_the_clone_is_not_read(
        self, world, card, tmp_path
    ):
        outside = tmp_path / "elsewhere" / ".workpilot" / "specs" / "001-passkey"
        outside.mkdir(parents=True)
        (outside / "implementation_plan.json").write_text(
            json.dumps({"feature": "Not this one"}), encoding="utf-8"
        )
        tasks = world.clone("a") / ".workpilot" / "worktrees" / "tasks"
        tasks.mkdir(parents=True)
        (tasks / "001-passkey").symlink_to(tmp_path / "elsewhere")
        await add_run(card, world.users["contributor_a"])
        await restart()
        (row,) = await offered(world, "contributor_a")
        assert row["title"] == "Sign in with a passkey"

    async def test_the_workspace_copy_a_build_writes_is_read(self, world, card):
        copy = (
            world.clone("a")
            / ".workpilot"
            / "worktrees"
            / "tasks"
            / "001-passkey"
            / ".workpilot"
            / "specs"
            / "001-passkey"
        )
        copy.mkdir(parents=True)
        plan = json.loads(json.dumps(PLAN))
        plan["phases"][0]["subtasks"][1]["status"] = "completed"
        (copy / "implementation_plan.json").write_text(
            json.dumps(plan), encoding="utf-8"
        )
        await add_run(card, world.users["contributor_a"])
        await restart()
        (row,) = await offered(world, "contributor_a")
        assert row["subtasks_done"] == 2
        assert row["next_subtask"] == "Explain it"


class TestResume:
    def resume(self, world, card: str, run_id: str) -> str:
        return f"{base(world)}/{card}/runs/{run_id}/resume"

    async def test_the_starter_resumes_the_same_phase_with_the_same_model(
        self, world, card
    ):
        old = await add_run(card, world.users["contributor_a"])
        await restart()
        answer = await world.call(
            "contributor_a", "POST", self.resume(world, card, old)
        )
        assert answer.status_code == 202, answer.text
        new = answer.json()
        assert (new["phase"], new["model"], new["status"]) == (
            "build",
            "a-model",
            "queued",
        )
        assert new["started_by"] == world.users["contributor_a"]
        assert (await until_finished(world, card))["status"] == "succeeded"
        calls = (world.clone("a") / "agent-calls.jsonl").read_text(encoding="utf-8")
        (call,) = [json.loads(line) for line in calls.splitlines()]
        assert call["script"] == "run.py"
        assert call["args"][-2:] == ["--model", "a-model"]
        # Answered: not offered again, and a second resume is refused.
        assert await offered(world, "contributor_a") == []
        again = await world.call("contributor_a", "POST", self.resume(world, card, old))
        assert again.status_code == 409

    async def test_it_is_audited(self, world, card):
        from server.db.engine import get_session_factory
        from server.db.models import AuditLog
        from sqlalchemy import select

        old = await add_run(card, world.users["contributor_a"])
        await restart()
        new = await world.ok("contributor_a", "POST", self.resume(world, card, old))
        await until_finished(world, card)
        async with get_session_factory()() as db:
            entry = await db.scalar(
                select(AuditLog).where(AuditLog.action == "spec.run.resumed")
            )
        assert entry.payload == {
            "spec": "001-passkey",
            "phase": "build",
            "run_id": new["id"],
            "resumed": old,
        }

    async def test_an_owner_resumes_a_teammate_s_run_once_the_claim_is_free(
        self, world, card
    ):
        old = await add_run(card, world.users["contributor_a"])
        await restart()
        answer = await world.call("owner_a", "POST", self.resume(world, card, old))
        assert answer.status_code == 202, answer.text
        await until_finished(world, card)

    async def test_someone_else_on_the_project_may_not(self, world, card):
        old = await add_run(card, world.users["contributor_a"])
        await restart()
        answer = await world.call("grouped_a", "POST", self.resume(world, card, old))
        assert answer.status_code == 403
        assert "Only who started" in answer.text
        assert len(await offered(world, "contributor_a")) == 1

    async def test_a_reviewer_lacks_the_permission_starting_a_run_takes(
        self, world, card
    ):
        # Started by them before their role changed: they still may not run.
        old = await add_run(card, world.users["reviewer_a"])
        await restart()
        answer = await world.call("reviewer_a", "POST", self.resume(world, card, old))
        assert answer.status_code == 403
        assert "agent.execute" in answer.text

    async def test_a_run_of_another_card_or_none_is_not_found(self, world, card):
        write_spec(world.clone("a"), "007-other")
        other = (await specs(world))["007-other"]["id"]
        old = await add_run(other, world.users["contributor_a"])
        await restart()
        for run_id in (old, "no-such-run"):
            answer = await world.call(
                "contributor_a", "POST", self.resume(world, card, run_id)
            )
            assert answer.status_code == 404

    async def test_a_run_that_was_not_interrupted_is_not_resumed(self, world, card):
        done = await add_run(card, world.users["contributor_a"], status="failed")
        answer = await world.call(
            "contributor_a", "POST", self.resume(world, card, done)
        )
        assert answer.status_code == 409

    async def test_a_build_that_started_approved_keeps_its_approval(
        self, world, card, monkeypatch
    ):
        from server.services import run_manager

        carried: list[str] = []
        monkeypatch.setattr(
            run_manager, "keep_approval", lambda spec_dir: carried.append(spec_dir.name)
        )
        approved = await add_run(
            card, world.users["contributor_a"], started_approved=True
        )
        await restart()
        await world.ok("contributor_a", "POST", self.resume(world, card, approved))
        await until_finished(world, card)
        assert carried == ["001-passkey"]

    async def test_a_build_that_did_not_start_approved_carries_nothing(
        self, world, card, monkeypatch
    ):
        from server.services import run_manager

        carried: list[str] = []
        monkeypatch.setattr(
            run_manager, "keep_approval", lambda spec_dir: carried.append(spec_dir.name)
        )
        old = await add_run(card, world.users["contributor_a"])
        await restart()
        await world.ok("contributor_a", "POST", self.resume(world, card, old))
        await until_finished(world, card)
        assert carried == []

    async def test_a_build_records_that_it_started_approved(
        self, world, card, monkeypatch
    ):
        from server.db.engine import get_session_factory
        from server.db.models import AgentRun
        from server.services import run_manager

        monkeypatch.setattr(run_manager, "_approval_holds", lambda spec_dir: True)
        monkeypatch.setattr(run_manager, "_carry_approval", lambda spec_dir: None)
        started = await world.ok(
            "contributor_a",
            "POST",
            f"{base(world)}/{card}/runs",
            json={"phase": "build"},
        )
        await until_finished(world, card)
        async with get_session_factory()() as db:
            run = await db.get(AgentRun, started["id"])
        assert run.started_approved is True


class TestLater:
    async def test_set_aside_runs_are_not_offered_again(self, world, card):
        old = await add_run(card, world.users["contributor_a"])
        await restart()
        answer = await world.ok(
            "contributor_a", "POST", f"{LIST}/later", json={"run_ids": [old, "other"]}
        )
        assert answer == {"set_aside": [old]}
        assert await offered(world, "contributor_a") == []
        assert await offered(world, "owner_a") == []
        # The card keeps its Start: a new run is not refused.
        assert (await specs(world))["001-passkey"]["claimed_by"] is None

    async def test_only_the_runs_one_is_offered_are_set_aside(self, world, card):
        old = await add_run(card, world.users["contributor_a"])
        await restart()
        answer = await world.ok(
            "grouped_a", "POST", f"{LIST}/later", json={"run_ids": [old]}
        )
        assert answer == {"set_aside": []}
        assert len(await offered(world, "contributor_a")) == 1

    async def test_the_answer_is_bounded(self, world, card):
        answer = await world.call(
            "contributor_a",
            "POST",
            f"{LIST}/later",
            json={"run_ids": ["x" * 65]},
        )
        assert answer.status_code == 422
        answer = await world.call(
            "contributor_a",
            "POST",
            f"{LIST}/later",
            json={"run_ids": [str(i) for i in range(201)]},
        )
        assert answer.status_code == 422
