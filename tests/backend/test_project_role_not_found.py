"""A project route answers another organization's project as a missing one.

``/projects/{project_id}/...`` (the board's specs, claims, runs, members)
used to answer 403 "Not a member of this project" to a project of another
organization, where the rule (docs/rules/security.md, S5) and every route of
the shared board and features answer 404. The two-organization end-to-end
test (``test_server_two_orgs_e2e.py``) found it; this holds it without a
server.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_settings(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", "x" * 48)
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "roles.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


async def _world() -> dict[str, str]:
    from server.db import engine as db_engine
    from server.db.models import Organization, Project, ProjectMember, User

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    async with db_engine.get_session_factory()() as db:
        org_a, org_b = (
            Organization(name="A", slug="org-a"),
            Organization(name="B", slug="org-b"),
        )
        alice = User(email="alice@example.com", display_name="alice")
        db.add_all([org_a, org_b, alice])
        await db.flush()
        mine = Project(
            org_id=org_a.id,
            name="Mine",
            repo_url="https://x/a.git",
            server_path="/tmp/a",
        )
        colleagues = Project(
            org_id=org_a.id,
            name="Theirs",
            repo_url="https://x/c.git",
            server_path="/tmp/c",
        )
        foreign = Project(
            org_id=org_b.id,
            name="B's",
            repo_url="https://x/b.git",
            server_path="/tmp/b",
        )
        db.add_all([mine, colleagues, foreign])
        await db.flush()
        db.add(ProjectMember(project_id=mine.id, user_id=alice.id, role="member"))
        await db.commit()
        return {
            "org_a": org_a.id,
            "alice": alice.id,
            "mine": mine.id,
            "colleagues": colleagues.id,
            "foreign": foreign.id,
        }


async def _check(w: dict[str, str], project_id: str):
    from server.auth.deps import CurrentUser, require_project_role
    from server.db.engine import get_session_factory
    from starlette.requests import Request

    request = Request({"type": "http", "method": "GET", "path": "/", "headers": []})
    request.state.org_id = w["org_a"]
    user = CurrentUser(
        id=w["alice"], email="alice@example.com", display_name="alice", role="member"
    )
    async with get_session_factory()() as db:
        return await require_project_role("viewer")(project_id, request, user, db)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("project", "status"),
    [("foreign", 404), ("unknown", 404), ("colleagues", 403)],
)
async def test_a_project_without_a_role_is_missing_unless_it_is_of_ones_own_org(
    project, status
):
    from fastapi import HTTPException

    w = await _world()
    with pytest.raises(HTTPException) as refused:
        await _check(w, w.get(project, "00000000-0000-0000-0000-000000000000"))
    assert refused.value.status_code == status


@pytest.mark.asyncio
async def test_a_member_of_the_project_passes():
    w = await _world()
    assert (await _check(w, w["mine"])).id == w["alice"]
