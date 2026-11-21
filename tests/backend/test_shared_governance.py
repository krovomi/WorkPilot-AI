"""Server mode: a project's agent governance, its approvals and its kill switch (#353, lot 4).

What these tests keep away: another tenant reading a project's audit trail or
stopping its agents (404, never 403); a reader approving an agent's call or
stopping a run; an approval that does not say who gave it, or that a person
without the role the policy names gives anyway; the server's paths reaching a
client; "stop my agents" stopping a colleague's; and a kill switch slower than
the issue's two seconds, measured on a real process.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi import HTTPException

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48
_POLICY = """version: 1
schedule:
  timezone: UTC
  allowed_hours: ["00:00-23:59"]
files:
  forbidden: [".env*"]
  requires_review: ["infra/**"]
  reviewers: [security]
budget:
  max_tokens_per_hour: 500000
"""


def _clone(root: Path, name: str, policy: str | None = _POLICY) -> Path:
    clone = root / name
    clone.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(clone)], check=True)
    if policy is not None:
        (clone / "workpilot.policy.yaml").write_text(policy, encoding="utf-8")
    return clone


@pytest.fixture
async def server(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv("WORKPILOT_REPOS_ROOT", str(tmp_path / "repos"))
    monkeypatch.setenv(
        "WORKPILOT_GUARDRAILS_GLOBAL", str(tmp_path / "home" / "none.yaml")
    )
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "gov.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    from server.db import engine as db_engine
    from server.db.models import (
        Organization,
        OrgMember,
        Project,
        ProjectMember,
        Role,
        SpecIndex,
        User,
    )
    from server.services import project_jobs, run_manager

    monkeypatch.setattr(project_jobs, "_jobs", None)
    monkeypatch.setattr(run_manager, "_run_manager", None)
    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()

    repos = tmp_path / "repos"
    clone_a, clone_b = _clone(repos, "a"), _clone(repos, "b")
    async with db_engine.get_session_factory()() as db:
        db.add_all(
            [
                User(id=uid, email=f"{uid}@x.test", display_name=name)
                for uid, name in (
                    ("u-ada", "Ada"),
                    ("u-bob", "Bob"),
                    ("u-vic", "Vic"),
                    ("u-eve", "Eve"),
                )
            ]
        )
        org_a = Organization(id="org-a", name="A", slug="org-a")
        org_b = Organization(id="org-b", name="B", slug="org-b")
        db.add_all([org_a, org_b])
        await db.flush()
        db.add_all(
            [
                Role(
                    id=f"r-{slug}",
                    org_id="org-a",
                    slug=slug,
                    name=slug,
                    scope="org",
                    permissions=[],
                )
                for slug in ("security", "dev")
            ]
        )
        project_a = Project(
            id="p-a",
            org_id="org-a",
            name="Shop",
            repo_url="https://x/a.git",
            server_path=str(clone_a),
        )
        project_b = Project(
            id="p-b",
            org_id="org-b",
            name="Shop",
            repo_url="https://x/b.git",
            server_path=str(clone_b),
        )
        db.add_all([project_a, project_b])
        await db.flush()
        db.add_all(
            [
                OrgMember(org_id="org-a", user_id="u-ada", role_id="r-security"),
                OrgMember(org_id="org-a", user_id="u-bob", role_id="r-dev"),
                ProjectMember(project_id="p-a", user_id="u-ada", role="owner"),
                ProjectMember(project_id="p-a", user_id="u-bob", role="member"),
                ProjectMember(project_id="p-a", user_id="u-vic", role="viewer"),
                ProjectMember(project_id="p-b", user_id="u-eve", role="owner"),
                SpecIndex(id="s-1", project_id="p-a", spec_name="001-a"),
                SpecIndex(id="s-2", project_id="p-a", spec_name="002-b"),
                SpecIndex(id="s-3", project_id="p-b", spec_name="001-a"),
            ]
        )
        await db.commit()
    yield {"clone_a": clone_a, "clone_b": clone_b}
    server_config.reset_settings_cache()


_ALL = frozenset({"audit.read", "audit.export", "review.approve", "agent.cancel"})


def _principal(user: str, org: str = "org-a", permissions=_ALL):
    from server.authz.principal import Principal

    names = {"u-ada": "Ada", "u-bob": "Bob", "u-vic": "Vic", "u-eve": "Eve"}
    return Principal(
        id=user,
        email=f"{user}@x.test",
        display_name=names[user],
        org_id=org,
        permissions=frozenset(permissions),
    )


async def _scope(principal, project: str):
    from server.authz.scope import load_project_scope
    from server.db.engine import get_session_factory

    async with get_session_factory()() as db:
        return await load_project_scope(db, principal, project)


async def _with_db(route, **kwargs):
    from server.db.engine import get_session_factory

    async with get_session_factory()() as db:
        return await route(db=db, **kwargs)


def _pending(clone: Path, path: str = "infra/main.tf") -> str:
    """An agent's call that waits for an approval, as the hook leaves it."""
    from security import guardrail_ledger as ledger
    from security.guardrail_policy import load_policy
    from security.guardrails import CallContext, evaluate_rules

    tool_input = {"file_path": str(clone / path), "content": "x"}
    decision = evaluate_rules(
        load_policy(clone).rules, "Write", tool_input, CallContext(root=clone)
    )
    target = ledger.target_of("Write", tool_input, clone)
    ledger.record(clone, decision, "Write", target, clone, outcome="pending")
    return ledger.pending(clone)[0]["id"]


async def _audit_rows(action: str) -> list:
    from server.db.engine import get_session_factory
    from server.db.models import AuditLog
    from sqlalchemy import select

    async with get_session_factory()() as db:
        return list(await db.scalars(select(AuditLog).where(AuditLog.action == action)))


# -- the routes and their permissions --------------------------------------


def test_each_route_answers_to_its_own_permission():
    from server.authz.catalog import domain_for_feature, served_in_server_mode
    from server.authz.mounting import permission_for
    from shared_features import mount_all
    from shared_features.governance import router

    mounted: list[tuple[object, str]] = []
    mount_all(lambda r, feature: mounted.append((r, feature)))
    assert (router, "governance") in mounted
    assert served_in_server_mode("governance")
    domain = domain_for_feature("governance")
    expected = {
        ("GET", "/api/features/governance"): "audit.read",
        ("GET", "/api/features/governance/audit"): "audit.export",
        ("POST", "/api/features/governance/approvals/{request_id}"): "review.approve",
        ("POST", "/api/features/governance/stop"): "agent.cancel",
    }
    paths = {(m, route.path) for route in router.routes for m in route.methods}
    assert paths == set(expected)
    for (method, path), permission in expected.items():
        assert permission_for(method, path, domain) == permission


def test_the_guard_refuses_a_person_without_the_permission(server, monkeypatch):
    """Over HTTP, mounted as provider_api mounts it: the guard answers first."""
    from fastapi import FastAPI, Request
    from fastapi.testclient import TestClient
    from server.authz.mounting import mount_guarded
    from server.authz.scope import ProjectScope, resolve_project_scope
    from shared_features.governance import router

    current = {"principal": _principal("u-vic", permissions={"audit.read"})}
    app = FastAPI()

    @app.middleware("http")
    async def _auth(request: Request, call_next):
        request.state.principal = current["principal"]
        return await call_next(request)

    mount_guarded(app, router, "governance")
    app.dependency_overrides[resolve_project_scope] = lambda: ProjectScope(
        "p-a", "org-a", server["clone_a"], "viewer"
    )
    with TestClient(app) as client:
        assert client.get("/api/features/governance?project_id=p-a").status_code == 200
        for method, path, body in (
            ("GET", "/api/features/governance/audit", None),
            (
                "POST",
                "/api/features/governance/approvals/0123456789ab",
                {"approved": True},
            ),
            ("POST", "/api/features/governance/stop", {"scope": "mine"}),
        ):
            answer = client.request(method, f"{path}?project_id=p-a", json=body)
            assert answer.status_code == 403, path
            assert "Missing permission" in answer.json()["detail"]
        current["principal"] = _principal("u-vic", permissions=set())
        assert client.get("/api/features/governance?project_id=p-a").status_code == 403
        # A request id is a closed shape, never a path.
        current["principal"] = _principal("u-ada")
        bad = client.post(
            "/api/features/governance/approvals/..%2F..%2Fx?project_id=p-a",
            json={"approved": True},
        )
        assert bad.status_code in (404, 422)
        extra = client.post(
            "/api/features/governance/stop?project_id=p-a",
            json={"scope": "mine", "project_dir": "/etc"},
        )
        assert extra.status_code == 422


@pytest.mark.asyncio
async def test_another_tenant_s_project_is_not_found(server):
    with pytest.raises(HTTPException) as across:
        await _scope(_principal("u-eve", org="org-b"), "p-a")
    assert across.value.status_code == 404
    with pytest.raises(HTTPException) as back:
        await _scope(_principal("u-ada"), "p-b")
    assert back.value.status_code == 404


# -- reading ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_report_reads_the_clone_and_names_no_server_path(server):
    from security import policy_audit
    from shared_features.governance import audit, governance

    clone = server["clone_a"]
    policy_audit.record(
        clone, decision="deny", tool="Write", reason=f"refused {clone}/.env"
    )
    policy_audit.record(clone, decision="tool_loop", tool="Read")
    request_id = _pending(clone)
    principal = _principal("u-vic", permissions={"audit.read"})
    report = await governance(scope=await _scope(principal, "p-a"), principal=principal)

    assert report["governance"]["files"]["reviewers"] == ["security"]
    assert report["governance"]["schedule"]["openNow"] is True
    assert report["metrics"] == {"blocked24h": 1, "breakerTrips7d": 1}
    assert [p["id"] for p in report["pending"]] == [request_id]
    assert report["pending"][0]["target"] == {
        "kind": "file",
        "summary": "infra/main.tf",
    }
    assert report["agents"] == {"mine": 0, "project": 0}
    # A reader sees, and may do nothing.
    assert report["may"] == {
        "approve": False,
        "stop": False,
        "stopProject": False,
        "export": False,
    }
    text = json.dumps(report)
    assert str(clone) not in text and str(clone.resolve()) not in text
    assert report["sources"][0]["path"] == "workpilot.policy.yaml"
    assert report["events"][1]["reason"].startswith("refused ")

    exported = await audit(limit=10, scope=await _scope(principal, "p-a"))
    assert [e["decision"] for e in exported["events"]] == ["tool_loop", "deny"]
    assert str(clone) not in json.dumps(exported)


@pytest.mark.asyncio
async def test_what_a_member_and_the_owner_may_do(server):
    from shared_features.governance import governance

    bob = _principal("u-bob")
    report = await governance(scope=await _scope(bob, "p-a"), principal=bob)
    assert report["may"] == {
        "approve": True,
        "stop": True,
        "stopProject": False,
        "export": True,
    }
    ada = _principal("u-ada")
    report = await governance(scope=await _scope(ada, "p-a"), principal=ada)
    assert report["may"]["stopProject"] is True


def test_paths_outside_the_clone_are_written_from_home():
    from shared_features.governance import _relative

    clone = Path("/srv/repos/p")
    home = str(Path.home())
    value = {
        "a": [f"{clone}/x.yaml", f"{home}/.workpilot/g.yaml", str(clone)],
        "n": 3,
    }
    assert _relative(value, clone) == {
        "a": ["x.yaml", "~/.workpilot/g.yaml", "."],
        "n": 3,
    }
    assert _relative("y" * 5000, clone) == "y" * 1000


# -- approving ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_approval_names_its_approver_and_lets_one_call_through(server):
    from security import policy_audit
    from security.guardrails import guardrails_hook
    from shared_features.governance import AnswerRequest, answer

    clone = server["clone_a"]
    request_id = _pending(clone)
    ada = _principal("u-ada")
    got = await _with_db(
        answer,
        req=AnswerRequest(approved=True),
        request_id=request_id,
        scope=await _scope(ada, "p-a"),
        principal=ada,
    )
    assert got["answer"]["decision"] == "approved"
    assert got["answer"]["by"] == "Ada"
    assert got["answer"]["roles"] == ["security"]
    approvals = json.loads(
        (clone / ".workpilot" / "guardrail-approvals.json").read_text(encoding="utf-8")
    )["approvals"]
    assert approvals[0]["byId"] == "u-ada" and approvals[0]["verified"] is True
    (row,) = await _audit_rows("governance.approval.answered")
    assert row.user_id == "u-ada" and row.payload["decision"] == "approved"

    # The agent's identical call now goes through, and the trail says who let it.
    call = {
        "tool_name": "Write",
        "tool_input": {"file_path": str(clone / "infra/main.tf"), "content": "x"},
    }
    assert await guardrails_hook(call, project_root=clone) == {}
    approved = next(
        e for e in policy_audit.read_events(clone) if e["decision"] == "approved"
    )
    assert approved["approvedBy"] == "Ada <u-ada> [security]"
    # Used once: the next identical call waits again.
    again = await guardrails_hook(call, project_root=clone)
    assert again["hookSpecificOutput"]["permissionDecision"] == "deny"


@pytest.mark.asyncio
async def test_only_a_role_the_policy_names_approves_but_anyone_may_refuse(server):
    from shared_features.governance import AnswerRequest, answer

    clone = server["clone_a"]
    request_id = _pending(clone)
    bob = _principal("u-bob")  # a member, role "dev", not "security"
    with pytest.raises(HTTPException) as refused:
        await _with_db(
            answer,
            req=AnswerRequest(approved=True),
            request_id=request_id,
            scope=await _scope(bob, "p-a"),
            principal=bob,
        )
    assert refused.value.status_code == 403
    assert "security" in refused.value.detail
    got = await _with_db(
        answer,
        req=AnswerRequest(approved=False),
        request_id=request_id,
        scope=await _scope(bob, "p-a"),
        principal=bob,
    )
    assert got["answer"]["decision"] == "refused"
    # Answered: it is no longer waiting.
    with pytest.raises(HTTPException) as gone:
        await _with_db(
            answer,
            req=AnswerRequest(approved=False),
            request_id=request_id,
            scope=await _scope(bob, "p-a"),
            principal=bob,
        )
    assert gone.value.status_code == 404


@pytest.mark.asyncio
async def test_without_reviewers_any_member_with_the_right_approves(server):
    from shared_features.governance import AnswerRequest, answer

    clone = server["clone_a"]
    (clone / "workpilot.policy.yaml").write_text(
        _POLICY.replace("  reviewers: [security]\n", ""), encoding="utf-8"
    )
    request_id = _pending(clone)
    bob = _principal("u-bob")
    got = await _with_db(
        answer,
        req=AnswerRequest(approved=True),
        request_id=request_id,
        scope=await _scope(bob, "p-a"),
        principal=bob,
    )
    assert got["answer"]["roles"] == ["dev"]


@pytest.mark.asyncio
async def test_a_reader_never_answers_and_an_unknown_request_is_not_found(server):
    from shared_features.governance import AnswerRequest, answer

    request_id = _pending(server["clone_a"])
    vic = _principal("u-vic")  # holds the permission, but only reads the project
    with pytest.raises(HTTPException) as reader:
        await _with_db(
            answer,
            req=AnswerRequest(approved=False),
            request_id=request_id,
            scope=await _scope(vic, "p-a"),
            principal=vic,
        )
    assert reader.value.status_code == 403
    ada = _principal("u-ada")
    with pytest.raises(HTTPException) as unknown:
        await _with_db(
            answer,
            req=AnswerRequest(approved=True),
            request_id="0123456789ab",
            scope=await _scope(ada, "p-a"),
            principal=ada,
        )
    assert unknown.value.status_code == 404


@pytest.mark.asyncio
async def test_a_request_answered_in_between_is_not_found(server, monkeypatch):
    from security import guardrail_ledger as ledger
    from shared_features.governance import AnswerRequest, answer

    request_id = _pending(server["clone_a"])
    monkeypatch.setattr(ledger, "answer", lambda *a, **k: None)
    ada = _principal("u-ada")
    with pytest.raises(HTTPException) as raced:
        await _with_db(
            answer,
            req=AnswerRequest(approved=True),
            request_id=request_id,
            scope=await _scope(ada, "p-a"),
            principal=ada,
        )
    assert raced.value.status_code == 404


# -- the kill switch ------------------------------------------------------------


_LOOP = "import time\nwhile True:\n    time.sleep(0.05)\n"


@pytest.fixture
def real_runs(monkeypatch):
    """Runs that start a real process standing for the agent, unconfined."""
    from server.services import run_manager as rm

    async def env(self, user_id, run_id):
        return {"PATH": rm.os.environ.get("PATH", "")}

    monkeypatch.setattr(
        rm, "build_command", lambda *a, **k: [sys.executable, "-c", _LOOP]
    )
    monkeypatch.setattr(rm, "confine", lambda cmd, *a, **k: cmd)
    monkeypatch.setattr(rm, "card_environment", lambda *a, **k: {})
    monkeypatch.setattr(rm.RunManager, "_build_env", env)

    async def quiet(self, *a, **k):
        return None

    monkeypatch.setattr(rm.RunManager, "_notify", quiet)
    return rm


async def _start(
    rm, spec_id: str, spec_name: str, user: str, clone: Path, project="p-a"
):
    from server.db.models import SpecIndex

    manager = rm.get_run_manager()
    run = await manager.start_run(
        spec=SpecIndex(id=spec_id, project_id=project, spec_name=spec_name),
        project_id=project,
        server_path=str(clone),
        phase="build",
        user_id=user,
    )
    for _ in range(400):
        if run.id in manager._active:
            return run.id, manager._active[run.id]
        await asyncio.sleep(0.01)
    raise AssertionError("the run never started")


async def _status(run_id: str) -> str:
    from server.db.engine import get_session_factory
    from server.db.models import AgentRun

    async with get_session_factory()() as db:
        return (await db.get(AgentRun, run_id)).status


@pytest.mark.asyncio
async def test_the_kill_switch_stops_the_agents_within_two_seconds(server, real_runs):
    """Measured, not estimated: from the request to the processes gone."""
    from shared_features.governance import StopRequest, stop

    clone = server["clone_a"]
    started = [
        await _start(real_runs, "s-1", "001-a", "u-ada", clone),
        await _start(real_runs, "s-2", "002-b", "u-ada", clone),
    ]
    ada = _principal("u-ada")
    scope = await _scope(ada, "p-a")
    began = time.monotonic()
    got = await _with_db(
        stop, req=StopRequest(scope="mine"), scope=scope, principal=ada
    )
    await asyncio.wait_for(
        asyncio.gather(*(proc.wait() for _, proc in started)), timeout=10
    )
    elapsed = time.monotonic() - began
    assert got == {"scope": "mine", "stoppedRuns": 2, "stoppedJobs": 0}
    assert elapsed < 2.0, f"agents stopped after {elapsed:.3f} s"
    for run_id, proc in started:
        assert proc.returncode is not None
        for _ in range(200):
            if await _status(run_id) == "cancelled":
                break
            await asyncio.sleep(0.01)
        assert await _status(run_id) == "cancelled"
    (row,) = await _audit_rows("governance.stop_all")
    assert row.payload == {"scope": "mine", "runs": 2, "jobs": 0}
    print(f"\nkill switch: {len(started)} agents stopped in {elapsed * 1000:.0f} ms")


@pytest.mark.asyncio
async def test_stopping_mine_leaves_a_colleague_s_and_the_owner_stops_all(
    server, real_runs
):
    from shared_features.governance import StopRequest, stop

    clone = server["clone_a"]
    bob_run, bob_proc = await _start(real_runs, "s-1", "001-a", "u-bob", clone)
    ada_run, ada_proc = await _start(real_runs, "s-2", "002-b", "u-ada", clone)
    eve_run, eve_proc = await _start(
        real_runs, "s-3", "001-a", "u-eve", server["clone_b"], project="p-b"
    )
    bob, ada = _principal("u-bob"), _principal("u-ada")
    try:
        mine = await _with_db(
            stop, req=StopRequest(), scope=await _scope(bob, "p-a"), principal=bob
        )
        assert mine["stoppedRuns"] == 1
        await asyncio.wait_for(bob_proc.wait(), timeout=10)
        assert ada_proc.returncode is None

        # The whole project is the owner's to stop.
        with pytest.raises(HTTPException) as member:
            await _with_db(
                stop,
                req=StopRequest(scope="project"),
                scope=await _scope(bob, "p-a"),
                principal=bob,
            )
        assert member.value.status_code == 403
        everyone = await _with_db(
            stop,
            req=StopRequest(scope="project"),
            scope=await _scope(ada, "p-a"),
            principal=ada,
        )
        assert everyone["stoppedRuns"] == 1
        await asyncio.wait_for(ada_proc.wait(), timeout=10)
        # Another tenant's run is untouched.
        assert eve_proc.returncode is None
    finally:
        await real_runs.get_run_manager().stop_project("p-b", timeout=10)
    assert eve_proc.returncode is not None


@pytest.mark.asyncio
async def test_a_reader_cannot_stop_anything(server):
    from shared_features.governance import StopRequest, stop

    vic = _principal("u-vic")
    with pytest.raises(HTTPException) as reader:
        await _with_db(
            stop, req=StopRequest(), scope=await _scope(vic, "p-a"), principal=vic
        )
    assert reader.value.status_code == 403


@pytest.mark.asyncio
async def test_jobs_are_stopped_by_who_started_them(server, monkeypatch):
    from server.services import project_jobs

    jobs = project_jobs.ProjectJobs()
    cancelled: list[str] = []

    async def cancel(job_id):
        cancelled.append(job_id)
        return True

    jobs._running = {
        ("p-a", "roadmap"): "j-1",
        ("p-a", "ideation"): "j-2",
        ("p-b", "roadmap"): "j-3",
    }
    jobs._starters = {"j-1": "u-ada", "j-2": "u-bob", "j-3": "u-ada"}
    monkeypatch.setattr(jobs, "cancel", cancel)
    assert jobs.active_jobs("p-a") == ["j-1", "j-2"]
    assert await jobs.stop_jobs("p-a", "u-ada") == ["j-1"]
    assert await jobs.stop_jobs("p-a") == ["j-1", "j-2"]
    assert cancelled == ["j-1", "j-1", "j-2"]


def test_an_approval_given_on_the_desktop_says_it_is_not_verified(tmp_path):
    from security import policy_audit

    assert (
        policy_audit.approver_of({"by": "user", "verified": False})
        == "user (local, not verified)"
    )
    assert policy_audit.approver_of({"verified": True}) == "user (local, not verified)"
    assert (
        policy_audit.approver_of({"by": "Ada", "byId": "u-1", "verified": True})
        == "Ada <u-1>"
    )
    # Only an approval carries an approver in the trail.
    event = policy_audit.record(tmp_path, decision="deny", approver="Ada")
    assert event is not None and event["approvedBy"] is None


@pytest.mark.asyncio
async def test_an_org_administrator_outside_the_project_may_stop_it_all(server):
    """No membership row, but the right to manage members: the owner's say."""
    from shared_features.governance import StopRequest, governance, stop

    admin = _principal("u-eve", org="org-a", permissions=_ALL | {"project.member.write"})
    scope = await _scope(admin, "p-a")
    assert scope.project_role is None
    report = await governance(scope=scope, principal=admin)
    assert report["may"]["stopProject"] is True
    got = await _with_db(
        stop, req=StopRequest(scope="project"), scope=scope, principal=admin
    )
    assert got["stoppedRuns"] == 0


def test_a_root_home_is_not_rewritten(monkeypatch):
    from shared_features import governance

    monkeypatch.setattr(governance.Path, "home", classmethod(lambda cls: Path("/")))
    assert governance._relative("/etc/x", Path("/srv/p")) == "/etc/x"


@pytest.mark.asyncio
async def test_a_job_that_cannot_be_recorded_leaves_no_starter(monkeypatch):
    from server.services import project_jobs

    jobs = project_jobs.ProjectJobs()

    async def nothing(project_id):
        return None

    def broken():
        raise RuntimeError("database down")

    monkeypatch.setattr(jobs, "settle_orphans", nothing)
    monkeypatch.setattr(project_jobs, "get_session_factory", broken)
    with pytest.raises(RuntimeError):
        await jobs.start(
            project_id="p-a",
            org_id=None,
            server_path="/srv/p",
            feature="roadmap",
            runner="roadmap_runner.py",
            args=[],
            user_id="u-ada",
        )
    assert jobs._running == {} and jobs._starters == {}
