"""Server mode: reviewing a server card's work from the app.

The app's review panel read a card's changes from a workspace on this
computer, which a server card does not have. These tests hold the review
routes to the server's workspace: the changes are read there, by
``project_id``, and sending the work back writes the request where the build
reads it and reopens the plan, for project members holding the review right.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48
_GIT = [
    "git",
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@x",
    "-c",
    "commit.gpgsign=false",
]


@pytest.fixture(autouse=True)
def _events(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "board.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    from shared_board import api as board_api
    from shared_board import review

    events: list[tuple[str, str]] = []

    def record(project_id, event, data):
        events.append((project_id, event))

    monkeypatch.setattr(board_api, "emit_board_event", record)
    monkeypatch.setattr(review, "emit_board_event", record)
    yield events
    server_config.reset_settings_cache()


def _git(cwd: Path, *args: str) -> None:
    subprocess.run([*_GIT, *args], cwd=cwd, check=True, capture_output=True)


async def _project(tmp_path: Path, branch: str = "main"):
    from server.db import engine as db_engine
    from server.db.models import Organization, Project

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    clone = tmp_path / "clone"
    clone.mkdir()
    _git(clone, "init", "-q", "-b", "main")
    (clone / "app.py").write_text("print('hi')\n", encoding="utf-8")
    _git(clone, "add", "app.py")
    _git(clone, "commit", "-q", "-m", "init")
    async with db_engine.get_session_factory()() as db:
        org = Organization(name="A", slug="org-a")
        db.add(org)
        await db.flush()
        project = Project(
            org_id=org.id,
            name="P",
            repo_url="https://x/p.git",
            server_path=str(clone),
            default_branch=branch,
        )
        db.add(project)
        await db.commit()
        return project.id, org.id, clone


def _scope(project_id, org_id, clone, role):
    from server.authz.scope import ProjectScope

    return ProjectScope(project_id, org_id, clone, role)


def _request(**principal):
    from server.authz.principal import Principal
    from starlette.requests import Request

    request = Request({"type": "http", "method": "POST", "path": "/", "headers": []})
    request.state.principal = Principal(**{"id": "u-1", "email": "a@x", **principal})
    return request


async def _db():
    from server.db.engine import get_session_factory

    return get_session_factory()()


async def _card(pid, oid, clone) -> str:
    from shared_board.api import CardCreate, create_card

    async with await _db() as db:
        card = await create_card(
            CardCreate(title="Login"), _request(), _scope(pid, oid, clone, "member"), db
        )
    return card["id"]


def _build(clone: Path, card_id: str) -> Path:
    """What a build leaves: a workspace on ``workpilot/<card>`` with a commit
    and the plan it worked from."""
    workspace = clone / ".workpilot/worktrees/tasks" / card_id
    _git(clone, "worktree", "add", "-q", "-b", f"workpilot/{card_id}", str(workspace))
    (workspace / "app.py").write_text("print('hi')\nprint('login')\n", encoding="utf-8")
    (workspace / "login.py").write_text("def login():\n    pass\n", encoding="utf-8")
    _git(workspace, "add", "app.py", "login.py")
    _git(workspace, "commit", "-q", "-m", "login")
    plan = {
        "status": "human_review",
        "planStatus": "review",
        "qa_signoff": {"status": "approved"},
        "phases": [
            {
                "name": "Implementation",
                "subtasks": [
                    {"id": "1", "status": "completed"},
                    {"id": "2", "status": "failed"},
                ],
            }
        ],
    }
    for spec in (
        clone / ".workpilot/specs" / card_id,
        workspace / ".workpilot/specs" / card_id,
    ):
        spec.mkdir(parents=True, exist_ok=True)
        (spec / "implementation_plan.json").write_text(
            json.dumps(plan), encoding="utf-8"
        )
    return workspace


@pytest.mark.asyncio
async def test_the_changes_are_read_from_the_server_workspace(tmp_path):
    from shared_board.review import card_changes

    pid, oid, clone = await _project(tmp_path)
    card_id = await _card(pid, oid, clone)
    viewer = _scope(pid, oid, clone, "viewer")

    async with await _db() as db:
        assert await card_changes(card_id, viewer, db) == {
            "exists": False,
            "files": [],
            "summary": "",
        }

    _build(clone, card_id)
    async with await _db() as db:
        changes = await card_changes(card_id, viewer, db)
    assert changes["exists"] is True
    assert changes["branch"] == f"workpilot/{card_id}"
    assert changes["baseBranch"] == "main"
    assert changes["commitCount"] == 1
    files = {f["path"]: f for f in changes["files"]}
    assert set(files) == {"app.py", "login.py"}
    assert files["login.py"]["status"] == "added"
    assert files["login.py"]["additions"] == 2
    assert files["app.py"]["status"] == "modified"
    assert "+print('login')" in files["app.py"]["patch"]


@pytest.mark.asyncio
async def test_a_base_branch_that_reads_as_an_option_is_refused(tmp_path):
    from fastapi import HTTPException
    from shared_board.review import card_changes

    pid, oid, clone = await _project(tmp_path, branch="--output=/tmp/x")
    card_id = await _card(pid, oid, clone)
    _build(clone, card_id)
    async with await _db() as db:
        with pytest.raises(HTTPException) as exc:
            await card_changes(card_id, _scope(pid, oid, clone, "member"), db)
    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_a_workspace_linked_out_of_the_checkout_is_not_read(tmp_path):
    from shared_board.review import card_changes

    pid, oid, clone = await _project(tmp_path)
    card_id = await _card(pid, oid, clone)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    tasks = clone / ".workpilot/worktrees/tasks"
    tasks.mkdir(parents=True)
    try:
        (tasks / card_id).symlink_to(elsewhere, target_is_directory=True)
    except OSError:
        pytest.skip("cannot create a symbolic link here")
    async with await _db() as db:
        changes = await card_changes(card_id, _scope(pid, oid, clone, "member"), db)
    assert changes["exists"] is False


@pytest.mark.asyncio
async def test_a_request_for_changes_is_written_where_the_build_reads_it(
    tmp_path, _events
):
    from shared_board.review import ChangeRequest, request_changes

    pid, oid, clone = await _project(tmp_path)
    card_id = await _card(pid, oid, clone)
    workspace = _build(clone, card_id)
    feedback = "Keep the session for 30 days.\nAnd log the sign-in."

    async with await _db() as db:
        result = await request_changes(
            card_id,
            ChangeRequest(feedback=feedback),
            _request(),
            _scope(pid, oid, clone, "member"),
            db,
        )
    assert result == {"requested": True}

    spec = workspace / ".workpilot/specs" / card_id
    request = (spec / "QA_FIX_REQUEST.md").read_text(encoding="utf-8")
    assert "Status: REJECTED" in request and feedback in request
    for plan_dir in (clone / ".workpilot/specs" / card_id, spec):
        plan = json.loads((plan_dir / "implementation_plan.json").read_text("utf-8"))
        assert plan["status"] == "in_progress" and plan["planStatus"] == "in_progress"
        assert plan["qa_signoff"]["status"] == "pending"
        subtasks = plan["phases"][0]["subtasks"]
        assert [s["status"] for s in subtasks] == ["completed", "pending", "pending"]
        assert subtasks[-1]["origin"] == "change_request"
        assert subtasks[-1]["title"] == "Keep the session for 30 days."
    assert _events == [(pid, "spec_created"), (pid, "spec_updated")]


@pytest.mark.asyncio
async def test_changes_cannot_be_requested_without_work_or_during_a_run(
    tmp_path, monkeypatch
):
    from fastapi import HTTPException
    from server.services import run_manager
    from shared_board.review import ChangeRequest, request_changes

    pid, oid, clone = await _project(tmp_path)
    card_id = await _card(pid, oid, clone)
    member = _scope(pid, oid, clone, "member")
    body = ChangeRequest(feedback="Again")

    async with await _db() as db:
        with pytest.raises(HTTPException) as exc:
            await request_changes(
                card_id, ChangeRequest(feedback="  \n "), _request(), member, db
            )
    assert exc.value.status_code == 422  # nothing to say

    async with await _db() as db:
        with pytest.raises(HTTPException) as exc:
            await request_changes(card_id, body, _request(), member, db)
    assert exc.value.status_code == 409  # nothing built yet

    workspace = _build(clone, card_id)

    class Busy:
        def is_running(self, spec_id):
            return True

    monkeypatch.setattr(run_manager, "get_run_manager", lambda: Busy())
    async with await _db() as db:
        with pytest.raises(HTTPException) as exc:
            await request_changes(card_id, body, _request(), member, db)
    assert exc.value.status_code == 409
    assert not (workspace / ".workpilot/specs" / card_id / "QA_FIX_REQUEST.md").exists()


@pytest.mark.asyncio
async def test_a_viewer_reads_the_changes_but_cannot_send_the_work_back(tmp_path):
    from fastapi import HTTPException
    from shared_board.review import ChangeRequest, request_changes

    pid, oid, clone = await _project(tmp_path)
    card_id = await _card(pid, oid, clone)
    _build(clone, card_id)
    async with await _db() as db:
        with pytest.raises(HTTPException) as exc:
            await request_changes(
                card_id,
                ChangeRequest(feedback="No"),
                _request(),
                _scope(pid, oid, clone, "viewer"),
                db,
            )
    assert exc.value.status_code == 403


def test_the_review_routes_are_mounted_with_their_permissions():
    from pydantic import ValidationError
    from server.authz.mounting import permission_for
    from shared_board.api import router
    from shared_board.review import ChangeRequest

    paths = {(m, r.path) for r in router.routes for m in getattr(r, "methods", ())}
    assert ("GET", "/api/board/cards/{card_id}/changes") in paths
    assert ("POST", "/api/board/cards/{card_id}/request-changes") in paths
    assert (
        permission_for("GET", "/api/board/cards/{card_id}/changes", "task")
        == "task.read"
    )
    assert (
        permission_for("POST", "/api/board/cards/{card_id}/request-changes", "task")
        == "review.approve"
    )
    for feedback in ("", "x" * 20_001):
        with pytest.raises(ValidationError):
            ChangeRequest(feedback=feedback)


def test_no_path_leaves_the_place_it_names(tmp_path):
    from shared_board.review import _within

    root = tmp_path / "clone"
    (root / "a").mkdir(parents=True)
    assert _within(root, "a") == (root / "a").resolve()
    for parts in (("..",), ("a", "..", "..", "x"), ("/etc",), ("",)):
        assert _within(root, *parts) is None
    outside = tmp_path / "outside"
    outside.mkdir()
    try:
        (root / "link").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("cannot create a symbolic link here")
    assert _within(root, "link") is None
