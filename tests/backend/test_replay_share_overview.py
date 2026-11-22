"""Server mode: a person's own team links on every project, and a project's
usage figures (#347).

`/mine` lists only the caller's links, only in the organization they act
in, only on projects they still reach (each authorized again), so that the
app's Settings can revoke them. `/usage` gives one project's aggregates over
four weeks: links made, opened, opens, annotated, sharers. Nothing names a
person, a title or a link there.
"""

from __future__ import annotations

import base64
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import HTTPException

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48


@pytest.fixture(autouse=True)
def server(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv("WORKPILOT_REPOS_ROOT", str(tmp_path / "repos"))
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "overview.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


def _db():
    from server.db.engine import get_session_factory

    return get_session_factory()()


async def _world(tmp_path: Path) -> dict[str, str]:
    """Org A with projects p, q, r (Ada a member of p and q, Bob of p) and
    org B with project z."""
    from server.db import engine as db_engine
    from server.db.models import Organization, Project, ProjectMember, User

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    ids: dict[str, str] = {}
    async with _db() as db:
        for slug in ("a", "b"):
            org = Organization(name=slug.upper(), slug=f"org-{slug}")
            db.add(org)
            await db.flush()
            ids[f"org-{slug}"] = org.id
        for uid, name in (("u-1", "Ada"), ("u-2", "Bob")):
            db.add(User(id=uid, email=f"{uid}@x", display_name=name))
        for name, org in (("p", "a"), ("q", "a"), ("r", "a"), ("z", "b")):
            clone = tmp_path / "repos" / name
            clone.mkdir(parents=True)
            subprocess.run(["git", "init", "-q", str(clone)], check=True)
            project = Project(
                org_id=ids[f"org-{org}"],
                name=f"Project {name}",
                repo_url=f"https://x/{name}.git",
                server_path=str(clone),
            )
            db.add(project)
            await db.flush()
            ids[name] = project.id
        for project, user in (("p", "u-1"), ("q", "u-1"), ("p", "u-2")):
            db.add(ProjectMember(project_id=ids[project], user_id=user, role="member"))
        await db.commit()
    return ids


def _principal(user="u-1", name="Ada", org_id=None, permissions=(), **extra):
    from server.authz.principal import Principal

    return Principal(
        id=user,
        email=f"{user}@x",
        display_name=name,
        org_id=org_id,
        permissions=frozenset(permissions),
        **extra,
    )


def _scope(ids, project, role="member", org="org-a"):
    from server.authz.scope import ProjectScope

    return ProjectScope(ids[project], ids[org], Path("/unused"), role)


def _bundle(bookmarks=0) -> str:
    from replay.bundle import ExportOptions, build_bundle, encode
    from replay.models import Bookmark, ReplaySession, ReplayStep, ReplayStepType

    session = ReplaySession(
        session_id="s-1",
        agent_name="coder",
        task_description="Fix it",
        steps=[ReplayStep(id="s0", step_index=0, step_type=ReplayStepType.TOOL_CALL)],
        bookmarks=[Bookmark(step_index=0, note=f"n{i}") for i in range(bookmarks)],
        status="completed",
    )
    return base64.b64encode(encode(build_bundle(session, ExportOptions()))).decode()


async def _create(scope, principal, bookmarks=0):
    from shared_features.replay_shares import CreateShareRequest, create_share

    async with _db() as db:
        return await create_share(
            CreateShareRequest(content_base64=_bundle(bookmarks)), scope, principal, db
        )


async def _mine(principal):
    from shared_features.replay_share_overview import my_shares

    async with _db() as db:
        return (await my_shares(principal, db))["shares"]


async def _usage(scope):
    from shared_features.replay_share_overview import project_usage

    async with _db() as db:
        return await project_usage(scope, db)


async def test_mine_lists_only_the_callers_links_on_projects_they_reach(tmp_path):
    ids = await _world(tmp_path)
    ada = _principal(org_id=ids["org-a"])
    bob = _principal("u-2", "Bob", org_id=ids["org-a"])
    first = await _create(_scope(ids, "p"), ada)
    second = await _create(_scope(ids, "q"), ada)
    third = await _create(_scope(ids, "p"), ada)
    await _create(_scope(ids, "p"), bob)
    # Made while Ada was on r, which she has since left; and on another tenant.
    await _create(_scope(ids, "r"), ada)
    await _create(_scope(ids, "z", org="org-b"), ada)

    listed = await _mine(ada)

    assert [s["id"] for s in listed] == [
        third["share"]["id"],
        second["share"]["id"],
        first["share"]["id"],
    ]
    assert {s["project_name"] for s in listed} == {"Project p", "Project q"}
    assert {s["project_id"] for s in listed} == {ids["p"], ids["q"]}
    assert all(s["can_revoke"] and s["state"] == "active" for s in listed)
    assert all("token" not in s and "bundle" not in s for s in listed)
    (bobs,) = await _mine(bob)
    assert bobs["created_by"] == "Bob"
    # Acting in no organization, or in the other one, lists nothing of org A.
    assert await _mine(_principal()) == []
    (other,) = await _mine(_principal(org_id=ids["org-b"], platform_role="admin"))
    assert other["project_id"] == ids["z"]


async def test_mine_is_for_server_mode_only():
    from shared_features.replay_share_overview import my_shares

    with pytest.raises(HTTPException) as refused:
        await my_shares(_principal(is_local=True), None)
    assert refused.value.status_code == 400


async def test_a_projects_usage_is_aggregates_over_four_weeks(tmp_path):
    from server.db.models import ReplayShare

    ids = await _world(tmp_path)
    ada = _principal(org_id=ids["org-a"])
    bob = _principal("u-2", "Bob", org_id=ids["org-a"])
    scope = _scope(ids, "p", "viewer")
    opened = await _create(_scope(ids, "p"), ada, bookmarks=2)
    plain = await _create(_scope(ids, "p"), bob)
    before = await _create(_scope(ids, "p"), bob)
    unknown = await _create(_scope(ids, "p"), ada)
    old = await _create(_scope(ids, "p"), ada, bookmarks=1)
    await _create(_scope(ids, "q"), ada, bookmarks=1)
    now = datetime.now(UTC)
    async with _db() as db:
        row = await db.get(ReplayShare, opened["share"]["id"])
        row.open_count = 2
        (await db.get(ReplayShare, plain["share"]["id"])).expires_at = now - timedelta(
            minutes=1
        )
        # A share from before the bookmark count, its author since removed.
        made_before = await db.get(ReplayShare, before["share"]["id"])
        made_before.bookmarks = None
        made_before.created_by = None
        made_before.created_at = now - timedelta(days=9)
        (await db.get(ReplayShare, unknown["share"]["id"])).bookmarks = None
        # Outside the window, but still open: counted as active only.
        (await db.get(ReplayShare, old["share"]["id"])).created_at = now - timedelta(
            days=29
        )
        await db.commit()

    report = await _usage(scope)

    assert report["window_days"] == 28
    assert report["links"] == 4
    assert report["opened_links"] == 1
    assert report["opens"] == 2
    assert report["open_rate"] == 0.25
    assert report["active"] == 4
    assert report["annotated"] == 1
    assert report["annotated_ratio"] == 0.5
    assert report["sharers"] == 2
    created = [w["created"] for w in report["weeks"]]
    assert created == [0, 0, 1, 3]
    assert report["weeks"][-1]["opened"] == 1
    assert datetime.fromisoformat(report["weeks"][-1]["end"]) <= datetime.now(UTC)
    # Nothing in it names a person, a title or a link.
    flat = repr(report)
    assert "Ada" not in flat and "coder" not in flat and opened["token"] not in flat


async def test_a_project_without_links_has_no_ratios(tmp_path):
    ids = await _world(tmp_path)
    report = await _usage(_scope(ids, "q"))
    assert report["links"] == 0
    assert report["open_rate"] is None
    assert report["annotated_ratio"] is None


async def test_both_routes_ask_for_lab_read_once_mounted(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from server.authz.mounting import mount_guarded
    from server.authz.principal import get_principal
    from shared_features.replay_share_overview import router

    ids = await _world(tmp_path)
    app = FastAPI()
    mount_guarded(app, router, "replay_shares")
    client = TestClient(app)
    base = "/api/features/replay-shares"

    app.dependency_overrides[get_principal] = lambda: _principal(org_id=ids["org-a"])
    for path in ("/mine", f"/usage?project_id={ids['p']}"):
        refused = client.get(base + path)
        assert refused.status_code == 403
        assert refused.json()["detail"] == "Missing permission: lab.read"

    app.dependency_overrides[get_principal] = lambda: _principal(
        org_id=ids["org-a"], permissions={"lab.read"}
    )
    assert client.get(base + "/mine").json() == {"shares": []}
    assert client.get(f"{base}/usage?project_id={ids['p']}").json()["links"] == 0
    # Another tenant's project is not found, never forbidden.
    assert client.get(f"{base}/usage?project_id={ids['z']}").status_code == 404
