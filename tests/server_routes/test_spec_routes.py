"""``/projects/{id}/specs``: the specs of a clone, who holds one, its runs.

A run starts a real process: the server's run manager launches its agent from
``BACKEND_DIR``, pointed here at a directory whose ``run.py`` and
``runners/spec_runner.py`` stand in for the agent (they write what they were
given and exit). Everything around them is the server's own: the queue, the
run's environment, its status. Isolation is off, as an operator can set it:
the confinement itself is the server end-to-end test's subject.
"""

from __future__ import annotations

import asyncio
import json
import textwrap
from pathlib import Path

import pytest

AGENT = textwrap.dedent(
    """
    import json, os, sys, time
    from pathlib import Path

    args = sys.argv[1:]
    project = Path(args[args.index("--project-dir") + 1])
    out = project / "agent-calls.jsonl"
    with open(out, "a", encoding="utf-8") as f:
        f.write(json.dumps({
            "script": Path(sys.argv[0]).name,
            "args": args,
            "user": os.environ.get("WORKPILOT_RUN_USER_ID"),
            "stream_token": bool(os.environ.get("WORKPILOT_WS_TOKEN")),
            "server_secret": os.environ.get("WORKPILOT_JWT_SECRET"),
        }) + "\\n")
    if "--hold" in os.environ.get("FAKE_AGENT_MODE", ""):
        time.sleep(30)
    if (project / "fail-next").exists():
        sys.stderr.write("the agent gave up")
        sys.exit(3)
    """
)


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


def write_spec(clone: Path, name: str, status: str | None = None) -> None:
    spec = clone / ".workpilot" / "specs" / name
    spec.mkdir(parents=True, exist_ok=True)
    (spec / "requirements.json").write_text(
        json.dumps({"task_description": f"Do {name}"}), encoding="utf-8"
    )
    if status is not None:
        (spec / "implementation_plan.json").write_text(
            json.dumps({"status": status}), encoding="utf-8"
        )


async def specs(world, who="viewer_a") -> dict[str, dict]:
    listed = await world.ok(who, "GET", f"/projects/{world.projects['a']}/specs")
    return {s["spec_name"]: s for s in listed}


def base(world) -> str:
    return f"/projects/{world.projects['a']}/specs"


async def until_finished(world, spec_id: str, who="viewer_a") -> dict:
    for _ in range(200):
        runs = await world.ok(who, "GET", f"{base(world)}/{spec_id}/runs")
        if runs and runs[0]["finished_at"]:
            return runs[0]
        await asyncio.sleep(0.05)
    raise AssertionError(f"the run never finished: {runs}")


class TestTheSpecList:
    async def test_it_reads_the_specs_of_the_clone(self, world):
        clone = world.clone("a")
        write_spec(clone, "001-login", "in_progress")
        write_spec(clone, "002-export")
        (clone / ".workpilot" / "specs" / ".hidden").mkdir()
        listed = await specs(world)
        assert list(listed) == ["001-login", "002-export"]
        assert listed["001-login"]["status"] == "in_progress"
        assert listed["002-export"]["status"] == "backlog"

    async def test_it_follows_the_clone_as_it_changes(self, world):
        clone = world.clone("a")
        write_spec(clone, "001-login")
        first = (await specs(world))["001-login"]
        write_spec(clone, "001-login", "ai_review")
        write_spec(clone, "003-new")
        again = await specs(world)
        assert again["001-login"]["id"] == first["id"]
        assert again["001-login"]["status"] == "ai_review"
        assert "003-new" in again
        import shutil

        shutil.rmtree(clone / ".workpilot" / "specs" / "003-new")
        assert "003-new" not in await specs(world)

    async def test_an_unreadable_plan_counts_as_backlog(self, world):
        clone = world.clone("a")
        write_spec(clone, "001-login")
        (
            clone / ".workpilot" / "specs" / "001-login" / "implementation_plan.json"
        ).write_text("{not json", encoding="utf-8")
        assert (await specs(world))["001-login"]["status"] == "backlog"

    async def test_a_clone_without_specs_lists_none(self, world):
        assert await specs(world) == {}


class TestClaims:
    @pytest.fixture
    async def spec_id(self, world) -> str:
        write_spec(world.clone("a"), "001-login")
        return (await specs(world))["001-login"]["id"]

    async def test_a_member_claims_and_releases(self, world, spec_id):
        claimed = await world.ok(
            "contributor_a", "POST", f"{base(world)}/{spec_id}/claim", json={}
        )
        assert claimed["claimed_by"] == world.users["contributor_a"]
        assert claimed["claimed_by_name"] == "contributor_a"
        released = await world.ok(
            "contributor_a", "POST", f"{base(world)}/{spec_id}/release"
        )
        assert released["claimed_by"] is None

    async def test_someone_else_s_claim_holds(self, world, spec_id):
        await world.ok(
            "contributor_a", "POST", f"{base(world)}/{spec_id}/claim", json={}
        )
        taken = await world.call(
            "grouped_a", "POST", f"{base(world)}/{spec_id}/claim", json={}
        )
        assert taken.status_code == 409
        assert taken.json()["detail"] == "Spec already claimed by contributor_a"
        released = await world.call(
            "grouped_a", "POST", f"{base(world)}/{spec_id}/release"
        )
        assert released.status_code == 403
        assert (
            released.json()["detail"] == "Only the claim holder or an owner can release"
        )
        # Even the owner of the project does not take it over without saying so.
        plain = await world.call(
            "owner_a", "POST", f"{base(world)}/{spec_id}/claim", json={}
        )
        assert plain.status_code == 409

    async def test_an_owner_forces_a_claim_and_it_is_audited(self, world, spec_id):
        await world.ok(
            "contributor_a", "POST", f"{base(world)}/{spec_id}/claim", json={}
        )
        forced = await world.ok(
            "owner_a", "POST", f"{base(world)}/{spec_id}/claim", json={"force": True}
        )
        assert forced["claimed_by"] == world.users["owner_a"]
        actions = [
            row["action"] for row in await world.ok("admin_a", "GET", "/admin/audit")
        ]
        assert "spec.claim.forced" in actions

    async def test_an_organization_administrator_releases_any_claim(
        self, world, spec_id
    ):
        await world.ok(
            "contributor_a", "POST", f"{base(world)}/{spec_id}/claim", json={}
        )
        released = await world.ok("admin_a", "POST", f"{base(world)}/{spec_id}/release")
        assert released["claimed_by"] is None

    async def test_a_member_cannot_force(self, world, spec_id):
        await world.ok(
            "contributor_a", "POST", f"{base(world)}/{spec_id}/claim", json={}
        )
        answer = await world.call(
            "grouped_a", "POST", f"{base(world)}/{spec_id}/claim", json={"force": True}
        )
        assert answer.status_code == 409

    async def test_a_claim_ends_when_the_spec_reaches_review(self, world, spec_id):
        await world.ok(
            "contributor_a", "POST", f"{base(world)}/{spec_id}/claim", json={}
        )
        write_spec(world.clone("a"), "001-login", "human_review")
        assert (await specs(world))["001-login"]["claimed_by"] is None

    async def test_a_spec_of_another_project_is_not_found(self, world, spec_id):
        other = f"/projects/{world.projects['b']}/specs/{spec_id}/claim"
        answer = await world.call("admin_b", "POST", other, json={})
        assert answer.status_code == 404
        assert answer.json()["detail"] == "Spec not found"


class TestRuns:
    @pytest.fixture
    async def spec_id(self, world, agent) -> str:
        write_spec(world.clone("a"), "001-login")
        return (await specs(world))["001-login"]["id"]

    def calls(self, world) -> list[dict]:
        path = world.clone("a") / "agent-calls.jsonl"
        lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
        return [json.loads(line) for line in lines]

    async def test_a_build_runs_the_agent_and_succeeds(self, world, spec_id):
        started = await world.call(
            "contributor_a",
            "POST",
            f"{base(world)}/{spec_id}/runs",
            json={"phase": "build", "model": "a-model"},
        )
        assert started.status_code == 202, started.text
        assert started.json()["status"] == "queued"
        run = await until_finished(world, spec_id)
        assert run["status"] == "succeeded", run
        assert run["started_by"] == world.users["contributor_a"]
        (call,) = self.calls(world)
        assert call["script"] == "run.py"
        assert call["args"][:2] == ["--spec", "001-login"]
        assert call["args"][-2:] == ["--model", "a-model"]
        assert call["user"] == world.users["contributor_a"]
        assert call["stream_token"] is True
        # The server's own signing key never reaches an agent.
        assert call["server_secret"] is None
        # Starting a run claims the spec for whoever started it.
        assert (await specs(world))["001-login"]["claimed_by"] == world.users[
            "contributor_a"
        ]

    async def test_the_spec_phase_runs_the_spec_runner_from_a_task_file(
        self, world, spec_id
    ):
        await world.ok(
            "contributor_a",
            "POST",
            f"{base(world)}/{spec_id}/runs",
            json={"phase": "spec"},
        )
        assert (await until_finished(world, spec_id))["status"] == "succeeded"
        (call,) = self.calls(world)
        assert call["script"] == "spec_runner.py"
        assert "--task-file" in call["args"]
        assert "--no-build" in call["args"]

    async def test_a_failed_agent_leaves_its_last_words(self, world, spec_id):
        (world.clone("a") / "fail-next").write_text("", encoding="utf-8")
        await world.ok(
            "contributor_a", "POST", f"{base(world)}/{spec_id}/runs", json={}
        )
        run = await until_finished(world, spec_id)
        assert run["status"] == "failed"
        assert run["error"] == "the agent gave up"

    async def test_a_running_spec_takes_no_second_run_and_stops_on_cancel(
        self, world, spec_id, monkeypatch
    ):
        monkeypatch.setenv("FAKE_AGENT_MODE", "--hold")
        first = await world.ok(
            "contributor_a", "POST", f"{base(world)}/{spec_id}/runs", json={}
        )
        second = await world.call(
            "contributor_a", "POST", f"{base(world)}/{spec_id}/runs", json={}
        )
        assert second.status_code == 409
        assert second.json()["detail"] == "A run is already in progress for this spec"
        for _ in range(200):
            if self.calls(world):
                break
            await asyncio.sleep(0.05)
        cancelled = await world.ok(
            "contributor_a",
            "POST",
            f"{base(world)}/{spec_id}/runs/{first['id']}/cancel",
        )
        assert cancelled == {"cancelled": True}
        assert (await until_finished(world, spec_id))["status"] == "cancelled"
        # Over: nothing left to cancel.
        again = await world.ok(
            "contributor_a",
            "POST",
            f"{base(world)}/{spec_id}/runs/{first['id']}/cancel",
        )
        assert again == {"cancelled": False}

    async def test_a_run_of_another_spec_cannot_be_cancelled_through_this_one(
        self, world, spec_id
    ):
        write_spec(world.clone("a"), "002-other")
        other = (await specs(world))["002-other"]["id"]
        run = await world.ok(
            "contributor_a", "POST", f"{base(world)}/{other}/runs", json={}
        )
        answer = await world.call(
            "contributor_a", "POST", f"{base(world)}/{spec_id}/runs/{run['id']}/cancel"
        )
        assert answer.status_code == 404
        assert answer.json()["detail"] == "Run not found for this spec"
        await until_finished(world, other)

    async def test_merging_needs_the_merge_permission(self, world, spec_id):
        answer = await world.call(
            "contributor_a",
            "POST",
            f"{base(world)}/{spec_id}/runs",
            json={"phase": "merge"},
        )
        assert answer.status_code == 403
        assert answer.json()["detail"] == "Missing permission: task.merge"
        allowed = await world.call(
            "maintainer_a",
            "POST",
            f"{base(world)}/{spec_id}/runs",
            json={"phase": "merge"},
        )
        assert allowed.status_code == 202
        call_args = (
            await until_finished(world, spec_id, "maintainer_a"),
            self.calls(world),
        )
        assert "--merge" in call_args[1][0]["args"]

    async def test_a_pull_request_needs_its_permission(self, world, spec_id):
        answer = await world.call(
            "operator_a", "POST", f"{base(world)}/{spec_id}/runs", json={"phase": "pr"}
        )
        assert answer.status_code == 403
        assert answer.json()["detail"] == "Missing permission: vcs.pr.create"

    async def test_an_unknown_phase_is_refused(self, world, spec_id):
        answer = await world.call(
            "contributor_a",
            "POST",
            f"{base(world)}/{spec_id}/runs",
            json={"phase": "deploy"},
        )
        assert answer.status_code == 409
        assert answer.json()["detail"] == "Unknown phase: deploy"

    async def test_someone_else_s_claimed_spec_takes_no_run(self, world, spec_id):
        await world.ok(
            "contributor_a", "POST", f"{base(world)}/{spec_id}/claim", json={}
        )
        answer = await world.call(
            "operator_a", "POST", f"{base(world)}/{spec_id}/runs", json={}
        )
        assert answer.status_code == 409
        assert answer.json()["detail"].startswith("Spec is claimed by another user")

    async def test_the_run_quota_of_the_organization_is_held(self, world, spec_id):
        await world.ok(
            "admin_a", "PUT", "/admin/quotas", json={"max_concurrent_runs": 0}
        )
        answer = await world.call(
            "contributor_a", "POST", f"{base(world)}/{spec_id}/runs", json={}
        )
        assert answer.status_code == 429
        assert "limited to 0" in answer.json()["detail"]
        assert await world.ok("viewer_a", "GET", f"{base(world)}/{spec_id}/runs") == []
