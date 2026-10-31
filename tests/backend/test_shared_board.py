"""Server mode: the shared board's cards, and the runs that work on them.

A server-mode project had a board (indexed specs, claims, runs) but no way to
add, edit, delete or approve a card, and its runs could not write a spec or
open a pull request, and could wait forever on a prompt. These tests hold the
card routes to project members, keep a started card from changing under its
build, and pin what each run phase executes.
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


@pytest.fixture(autouse=True)
def _clean_settings(monkeypatch, tmp_path):
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

    events: list[tuple[str, str]] = []
    monkeypatch.setattr(
        board_api,
        "emit_board_event",
        lambda project_id, event, data: events.append((project_id, event)),
    )
    yield events
    server_config.reset_settings_cache()


async def _project(tmp_path: Path):
    from server.db import engine as db_engine
    from server.db.models import Organization, Project

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    clone = tmp_path / "clone"
    clone.mkdir()
    subprocess.run(["git", "init", "-q", str(clone)], check=True)
    async with db_engine.get_session_factory()() as db:
        org = Organization(name="A", slug="org-a")
        db.add(org)
        await db.flush()
        project = Project(
            org_id=org.id, name="P", repo_url="https://x/p.git", server_path=str(clone)
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


@pytest.mark.asyncio
async def test_a_member_creates_reads_edits_and_deletes_a_card(
    tmp_path, _clean_settings
):
    from server.db.models import SpecIndex
    from shared_board.api import (
        CardCreate,
        CardUpdate,
        create_card,
        delete_card,
        get_card,
        update_card,
    )
    from sqlalchemy import select

    pid, oid, clone = await _project(tmp_path)
    scope = _scope(pid, oid, clone, "member")
    async with await _db() as db:
        card = await create_card(
            CardCreate(
                title="Add  login", description="Users sign in.", require_review=False
            ),
            _request(),
            scope,
            db,
        )
        card_id = card["id"]
        assert card_id.startswith("001-add-login")
        row = await db.scalar(select(SpecIndex).where(SpecIndex.spec_name == card_id))
        assert row is not None and row.created_by == "u-1"

    meta = json.loads(
        (clone / ".workpilot/specs" / card_id / "task_metadata.json").read_text(
            encoding="utf-8"
        )
    )
    assert meta["requireReviewBeforeCoding"] is False and meta["sourceType"] == "server"

    read = await get_card(card_id, scope)
    assert read["description"] == "Users sign in." and read["spec"] is None
    assert read["approval"]["approved"] is False

    await update_card(
        card_id, CardUpdate(description="Users sign in with SSO."), _request(), scope
    )
    assert (await get_card(card_id, scope))["description"] == "Users sign in with SSO."

    async with await _db() as db:
        assert await delete_card(card_id, _request(), scope, db) == {"deleted": card_id}
        row = await db.scalar(select(SpecIndex).where(SpecIndex.spec_name == card_id))
        assert row is None
    assert not (clone / ".workpilot/specs" / card_id).exists()
    assert [e for _, e in _clean_settings] == [
        "spec_created",
        "spec_updated",
        "spec_deleted",
    ]


@pytest.mark.asyncio
async def test_a_viewer_reads_but_cannot_change_a_card(tmp_path):
    from fastapi import HTTPException
    from shared_board.api import (
        CardCreate,
        approve_card,
        create_card,
        delete_card,
        get_card,
    )

    pid, oid, clone = await _project(tmp_path)
    async with await _db() as db:
        card = await create_card(
            CardCreate(title="T"), _request(), _scope(pid, oid, clone, "member"), db
        )
    viewer = _scope(pid, oid, clone, "viewer")
    assert (await get_card(card["id"], viewer))["id"] == card["id"]
    async with await _db() as db:
        for call in (
            lambda: create_card(CardCreate(title="T2"), _request(), viewer, db),
            lambda: delete_card(card["id"], _request(), viewer, db),
            lambda: approve_card(card["id"], _request(), viewer),
        ):
            with pytest.raises(HTTPException) as exc:
                await call()
            assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_unknown_or_escaping_card_ids_are_not_found(tmp_path):
    from fastapi import HTTPException
    from shared_board.api import get_card

    pid, oid, clone = await _project(tmp_path)
    scope = _scope(pid, oid, clone, "member")
    for card_id in ("../../etc", "001-x/../..", "nope", "999-missing"):
        with pytest.raises(HTTPException) as exc:
            await get_card(card_id, scope)
        assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_a_started_card_cannot_be_edited_and_approval_follows_the_spec(tmp_path):
    from fastapi import HTTPException
    from review.state import ReviewState
    from shared_board.api import (
        CardCreate,
        CardUpdate,
        approve_card,
        create_card,
        update_card,
    )

    pid, oid, clone = await _project(tmp_path)
    scope = _scope(pid, oid, clone, "member")
    async with await _db() as db:
        card = await create_card(CardCreate(title="T"), _request(), scope, db)
    directory = clone / ".workpilot/specs" / card["id"]

    with pytest.raises(HTTPException) as exc:
        await approve_card(card["id"], _request(), scope)
    assert exc.value.status_code == 409  # nothing to approve yet

    (directory / "spec.md").write_text("# Spec\n", encoding="utf-8")
    result = await approve_card(card["id"], _request(email="lead@x"), scope)
    assert result == {"approved": True, "approvedBy": "lead@x"}
    assert ReviewState.load(directory).is_approval_valid(directory)

    with pytest.raises(HTTPException) as exc:
        await update_card(card["id"], CardUpdate(title="Other"), _request(), scope)
    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_a_card_with_an_active_run_or_a_workspace_is_not_deleted(
    tmp_path, monkeypatch
):
    from fastapi import HTTPException
    from server.services import run_manager as run_manager_module
    from shared_board.api import CardCreate, create_card, delete_card

    pid, oid, clone = await _project(tmp_path)
    scope = _scope(pid, oid, clone, "owner")
    async with await _db() as db:
        card = await create_card(CardCreate(title="T"), _request(), scope, db)

    class _Busy:
        def is_running(self, spec_id):
            return True

    monkeypatch.setattr(run_manager_module, "get_run_manager", lambda: _Busy())
    async with await _db() as db:
        with pytest.raises(HTTPException) as exc:
            await delete_card(card["id"], _request(), scope, db)
    assert exc.value.status_code == 409

    monkeypatch.setattr(
        run_manager_module, "get_run_manager", lambda: run_manager_module.RunManager()
    )
    (clone / ".workpilot/worktrees/tasks" / card["id"]).mkdir(parents=True)
    async with await _db() as db:
        with pytest.raises(HTTPException) as exc:
            await delete_card(card["id"], _request(), scope, db)
    assert exc.value.status_code == 409
    assert (clone / ".workpilot/specs" / card["id"]).is_dir()


def test_card_routes_carry_their_own_permissions():
    from server.authz.mounting import permission_for

    assert (
        permission_for("DELETE", "/api/board/cards/{card_id}", "task") == "task.delete"
    )
    assert (
        permission_for("POST", "/api/board/cards/{card_id}/approve", "task")
        == "review.approve"
    )
    assert permission_for("PATCH", "/api/board/cards/{card_id}", "task") == "task.write"
    assert permission_for("GET", "/api/board/cards/{card_id}", "task") == "task.read"


# --- what a run executes ----------------------------------------------------


def _card_on_disk(root: Path, name: str, require_review: bool) -> None:
    directory = root / ".workpilot" / "specs" / name
    directory.mkdir(parents=True)
    (directory / "requirements.json").write_text(
        json.dumps({"task_description": "Do the thing; rm -rf / is just text"}),
        encoding="utf-8",
    )
    (directory / "task_metadata.json").write_text(
        json.dumps({"requireReviewBeforeCoding": require_review}), encoding="utf-8"
    )


def test_the_spec_phase_writes_the_spec_without_building(tmp_path):
    from server.services.run_manager import build_command

    _card_on_disk(tmp_path, "001-x", require_review=True)
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    cmd = build_command("spec", "001-x", str(tmp_path), "m-1", scratch)
    assert cmd[1].endswith(str(Path("runners") / "spec_runner.py"))
    assert "--no-build" in cmd and "--auto-approve" not in cmd
    # The description goes through a file, never argv.
    task_file = Path(cmd[cmd.index("--task-file") + 1])
    assert task_file.read_text(encoding="utf-8").startswith("Do the thing")
    assert not any("Do the thing" in part for part in cmd)
    assert cmd[cmd.index("--spec-dir") + 1] == str(tmp_path / ".workpilot/specs/001-x")
    assert cmd[-2:] == ["--model", "m-1"]

    _card_on_disk(tmp_path, "002-y", require_review=False)
    assert "--auto-approve" in build_command(
        "spec", "002-y", str(tmp_path), None, scratch
    )


def test_run_phases_are_non_interactive_and_never_force_the_approval(tmp_path):
    from server.services.run_manager import PHASES, build_command

    assert set(PHASES) == {"spec", "build", "qa", "merge", "pr"}
    build = build_command("build", "001-x", str(tmp_path), None, tmp_path)
    assert "--auto-continue" in build and "--force" not in build
    assert "--create-pr" in build_command("pr", "001-x", str(tmp_path), None, tmp_path)


@pytest.mark.asyncio
async def test_merge_and_pr_runs_need_their_own_permission(tmp_path, monkeypatch):
    from fastapi import HTTPException
    from server.auth.deps import CurrentUser
    from server.routers.specs import start_run
    from server.schemas import StartRunRequest

    pid, _oid, _clone = await _project(tmp_path)
    user = CurrentUser(id="u-1", email="a@x", display_name="A", role="member")
    async with await _db() as db:
        for phase, missing in (("merge", "task.merge"), ("pr", "vcs.pr.create")):
            with pytest.raises(HTTPException) as exc:
                await start_run(
                    project_id=pid,
                    spec_id="s",
                    body=StartRunRequest(phase=phase),
                    request=_request(permissions=frozenset({"agent.execute"})),
                    user=user,
                    db=db,
                )
            assert exc.value.status_code == 403
            assert missing in exc.value.detail
