"""Server mode: every status a card goes through, in ``status_history.json``.

The board stored only the status a card is in now, so nothing could say how
long it stayed in progress or how often it went back: no cycle time, no flow
diagram. These tests hold the history's format (the one the desktop app writes
and reads), its bound, its refusal of anything that is not a status change,
and the three places a server card moves: a person creating it, a person
sending its work back, and a run's agents while the run works.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import textwrap
from datetime import UTC, datetime
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402
from server.services import status_history as sh  # noqa: E402

POSIX = os.name == "posix"
_VALID_SECRET = "x" * 48
_AT = datetime(2026, 11, 22, 10, 0, tzinfo=UTC)


def _plan(spec_dir: Path, status: str, reason: str | None = None) -> None:
    spec_dir.mkdir(parents=True, exist_ok=True)
    plan = {"status": status, **({"reviewReason": reason} if reason else {})}
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps(plan), encoding="utf-8"
    )


def _history(spec_dir: Path) -> list[dict]:
    return json.loads((spec_dir / sh.HISTORY_FILE).read_text(encoding="utf-8"))[
        "entries"
    ]


# ---------------------------------------------------------------------------
# The file
# ---------------------------------------------------------------------------


def test_a_change_is_appended_and_the_same_status_is_no_change(tmp_path):
    assert sh.record_status_change(
        tmp_path, "backlog", actor="user", account_id="u-1", at=_AT
    )
    assert sh.record_status_change(tmp_path, "in_progress", actor="agent", at=_AT)
    # A restored status written again is not a move.
    assert not sh.record_status_change(tmp_path, "in_progress", actor="agent")
    assert sh.record_status_change(
        tmp_path, "human_review", actor="agent", reason="completed"
    )
    # Same status, another reason: a move the reports want (review → errors).
    assert sh.record_status_change(
        tmp_path, "human_review", actor="agent", reason="errors"
    )

    entries = _history(tmp_path)
    assert entries[0] == {
        "from": None,
        "to": "backlog",
        "at": "2026-11-22T10:00:00Z",
        "actor": "user",
        "accountId": "u-1",
    }
    assert [(e["from"], e["to"], e.get("reason")) for e in entries] == [
        (None, "backlog", None),
        ("backlog", "in_progress", None),
        ("in_progress", "human_review", "completed"),
        ("human_review", "human_review", "errors"),
    ]
    assert sh.read_status_history(tmp_path) == entries


def test_an_empty_history_starts_from_what_the_plan_said(tmp_path):
    assert not sh.record_status_change(
        tmp_path, "backlog", actor="agent", previous=("backlog", None)
    )
    assert sh.record_status_change(
        tmp_path, "in_progress", actor="agent", previous=("backlog", None)
    )
    assert _history(tmp_path)[0]["from"] == "backlog"


def test_only_statuses_actors_and_ids_the_board_knows_are_written(tmp_path):
    assert not sh.record_status_change(tmp_path, "shipped", actor="agent")
    assert not sh.record_status_change(tmp_path, "done", actor="robot")
    assert sh.record_status_change(
        tmp_path, "done", actor="user", reason="nope", account_id="../../etc"
    )
    (entry,) = _history(tmp_path)
    assert "reason" not in entry and "accountId" not in entry


def test_the_history_is_bounded_and_keeps_the_creation(tmp_path, monkeypatch):
    monkeypatch.setattr(sh, "MAX_ENTRIES", 4)
    for status in ("backlog", "in_progress", "ai_review", "human_review", "done"):
        sh.record_status_change(tmp_path, status, actor="agent")
    assert [e["to"] for e in _history(tmp_path)] == [
        "backlog",
        "ai_review",
        "human_review",
        "done",
    ]


def test_a_damaged_history_keeps_its_valid_entries(tmp_path):
    good = {"from": None, "to": "backlog", "at": "2026-11-22T10:00:00Z"}
    (tmp_path / sh.HISTORY_FILE).write_text(
        json.dumps(
            {
                "entries": [
                    {**good, "actor": "user"},
                    "not an entry",
                    {**good, "actor": "user", "to": "shipped"},
                    {**good, "actor": "user", "from": "nowhere"},
                    {**good, "actor": "ghost"},
                    {**good, "actor": "user", "at": 12},
                    {**good, "actor": "user", "at": "yesterday"},
                ]
            }
        ),
        encoding="utf-8",
    )
    assert sh.read_status_history(tmp_path) == [{**good, "actor": "user"}]

    (tmp_path / sh.HISTORY_FILE).write_text('{"entries": {}}', encoding="utf-8")
    assert sh.read_status_history(tmp_path) == []
    (tmp_path / sh.HISTORY_FILE).write_text("[1, 2]", encoding="utf-8")
    assert sh.read_status_history(tmp_path) == []
    (tmp_path / sh.HISTORY_FILE).write_text("{", encoding="utf-8")
    assert sh.read_status_history(tmp_path) == []


@pytest.mark.skipif(not POSIX, reason="a symbolic link needs no privilege on POSIX")
def test_a_link_where_the_history_goes_is_replaced_not_followed(tmp_path):
    outside = tmp_path / "outside.json"
    outside.write_text("keep", encoding="utf-8")
    card = tmp_path / "card"
    card.mkdir()
    (card / sh.HISTORY_FILE).symlink_to(outside)

    assert sh.record_status_change(card, "backlog", actor="user")
    assert outside.read_text(encoding="utf-8") == "keep"
    assert not (card / sh.HISTORY_FILE).is_symlink()


def test_a_history_that_cannot_be_written_fails_nothing(tmp_path):
    missing = tmp_path / "no-such-card"
    assert not sh.record_status_change(missing, "backlog", actor="user")


def test_the_plan_status_is_read_as_the_board_reads_it(tmp_path):
    assert sh.plan_status(tmp_path) == (None, None)
    _plan(tmp_path, "pending")
    assert sh.plan_status(tmp_path) == ("backlog", None)
    _plan(tmp_path, "human_review", "plan_review")
    assert sh.plan_status(tmp_path) == ("human_review", "plan_review")
    _plan(tmp_path, "whatever", "because")
    assert sh.plan_status(tmp_path) == (None, None)
    (tmp_path / "implementation_plan.json").write_text("[]", encoding="utf-8")
    assert sh.plan_status(tmp_path) == (None, None)
    (tmp_path / "implementation_plan.json").write_text('{"status": 3}', "utf-8")
    assert sh.plan_status(tmp_path) == (None, None)


# ---------------------------------------------------------------------------
# A run's agents
# ---------------------------------------------------------------------------


def test_the_board_s_copy_is_observed_and_the_clone_keeps_the_history(tmp_path):
    main, workspace = sh.card_dirs(tmp_path, "001-x")
    assert not sh.observe(tmp_path, "001-x", "u-1")  # no card yet
    main.mkdir(parents=True)
    assert not sh.observe(tmp_path, "001-x", "u-1")  # no plan yet
    _plan(main, "backlog")
    assert sh.observe(tmp_path, "001-x", "u-1")
    _plan(workspace, "ai_review")
    assert sh.observe(tmp_path, "001-x", "u-1")

    entries = _history(main)
    assert [(e["to"], e["actor"], e["accountId"]) for e in entries] == [
        ("backlog", "agent", "u-1"),
        ("ai_review", "agent", "u-1"),
    ]
    assert not (workspace / sh.HISTORY_FILE).exists()


@pytest.mark.skipif(not POSIX, reason="a symbolic link needs no privilege on POSIX")
def test_a_copy_linked_out_of_the_clone_is_not_read(tmp_path):
    clone = tmp_path / "clone"
    elsewhere = tmp_path / "elsewhere"
    _plan(elsewhere / "001-x", "done")
    main, workspace = sh.card_dirs(clone, "001-x")
    _plan(main, "in_progress")
    workspace.parent.mkdir(parents=True)
    workspace.symlink_to(elsewhere / "001-x")
    assert sh.observe(clone, "001-x", None)
    assert _history(main)[-1]["to"] == "in_progress"

    # The card's own folder linked away is no card at all.
    other = sh.card_dirs(clone, "002-y")[0]
    other.symlink_to(elsewhere / "001-x")
    assert not sh.observe(clone, "002-y", None)


def test_a_link_loop_on_the_way_is_no_card(tmp_path, monkeypatch):
    main, _ = sh.card_dirs(tmp_path, "001-x")
    _plan(main, "backlog")

    def _loop(self, strict=False):
        raise RuntimeError("Symlink loop")

    monkeypatch.setattr(Path, "resolve", _loop)
    assert not sh.observe(tmp_path, "001-x", None)


@pytest.mark.asyncio
async def test_follow_status_records_each_change_and_a_last_look(tmp_path):
    main, workspace = sh.card_dirs(tmp_path, "001-x")
    _plan(main, "backlog")
    follower = asyncio.create_task(sh.follow_status(tmp_path, "001-x", "u-1", 0.01))
    await asyncio.sleep(0.05)
    _plan(workspace, "in_progress")
    await asyncio.sleep(0.05)
    _plan(workspace, "human_review", "completed")
    # Stopped before it looked again: the last look still sees it.
    await sh.stop_following(follower)
    await sh.stop_following(follower)  # already done: nothing to do
    await sh.stop_following(None)

    assert [(e["to"], e.get("reason")) for e in _history(main)] == [
        ("backlog", None),
        ("in_progress", None),
        ("human_review", "completed"),
    ]


# ---------------------------------------------------------------------------
# The board's routes and the run manager
# ---------------------------------------------------------------------------


@pytest.fixture
def _server(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "history.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    from shared_board import api as board_api
    from shared_board import review as board_review

    monkeypatch.setattr(board_api, "emit_board_event", lambda *_a: None)
    monkeypatch.setattr(board_review, "emit_board_event", lambda *_a: None)
    yield
    server_config.reset_settings_cache()


async def _project(tmp_path: Path):
    from server.db import engine as db_engine
    from server.db.models import Organization, Project, User

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    clone = tmp_path / "clone"
    clone.mkdir()
    subprocess.run(["git", "init", "-q", str(clone)], check=True)
    async with db_engine.get_session_factory()() as db:
        org = Organization(name="A", slug="org-a")
        db.add(org)
        db.add(User(id="u-1", email="u-1@test.invalid", display_name="U"))
        await db.flush()
        project = Project(
            org_id=org.id, name="P", repo_url="https://x/p.git", server_path=str(clone)
        )
        db.add(project)
        await db.commit()
        return project.id, org.id, clone, db_engine.get_session_factory()


def _request():
    from server.authz.principal import Principal
    from starlette.requests import Request

    request = Request({"type": "http", "method": "POST", "path": "/", "headers": []})
    request.state.principal = Principal(id="u-1", email="a@x")
    return request


@pytest.mark.usefixtures("_server")
@pytest.mark.asyncio
async def test_a_new_card_starts_its_history_and_the_snapshot_sends_it(tmp_path):
    from server.authz.scope import ProjectScope
    from shared_board.api import CardCreate, board_snapshot, create_card

    pid, oid, clone, factory = await _project(tmp_path)
    scope = ProjectScope(pid, oid, clone, "member")
    async with factory() as db:
        card = await create_card(CardCreate(title="T"), _request(), scope, db)

    directory = clone / ".workpilot/specs" / card["id"]
    (entry,) = _history(directory)
    assert (entry["from"], entry["to"], entry["actor"], entry["accountId"]) == (
        None,
        "backlog",
        "user",
        "u-1",
    )
    snapshot = await board_snapshot(scope)
    sent = json.loads(snapshot["cards"][card["id"]][sh.HISTORY_FILE])
    assert sent["entries"] == [entry]


@pytest.mark.usefixtures("_server")
@pytest.mark.asyncio
async def test_sending_the_work_back_is_a_person_s_move_to_in_progress(
    tmp_path, monkeypatch
):
    from server.authz.scope import ProjectScope
    from shared_board import review
    from shared_board.api import CardCreate, create_card

    pid, oid, clone, factory = await _project(tmp_path)
    scope = ProjectScope(pid, oid, clone, "member")
    async with factory() as db:
        card = await create_card(CardCreate(title="T"), _request(), scope, db)
    card_id = card["id"]
    directory, workspace = sh.card_dirs(clone, card_id)
    _plan(directory, "human_review", "completed")
    _plan(workspace, "human_review", "completed")
    sh.observe(clone, card_id, "u-1")

    async def _no_approval(*_a):
        return None

    monkeypatch.setattr(review, "give_approval", _no_approval)
    async with factory() as db:
        answer = await review.request_changes(
            card_id,
            review.ChangeRequest(feedback="Rename the button"),
            _request(),
            scope,
            db,
        )
    assert answer["requested"] is True
    last = _history(directory)[-1]
    assert (last["from"], last["to"], last["actor"], last["accountId"]) == (
        "human_review",
        "in_progress",
        "user",
        "u-1",
    )


_CHILD = textwrap.dedent(
    """
    import json, os, sys, time
    spec = os.path.join(sys.argv[1], ".workpilot", "specs", "001-x")
    def write(status, reason=None):
        plan = {"status": status}
        if reason:
            plan["reviewReason"] = reason
        with open(os.path.join(spec, "implementation_plan.json"), "w", encoding="utf-8") as f:
            json.dump(plan, f)
    write("in_progress")
    time.sleep(0.4)
    write("ai_review")
    time.sleep(0.4)
    write("human_review", "completed")
    """
)


@pytest.mark.skipif(not POSIX, reason="a run's usage pipe is POSIX")
@pytest.mark.usefixtures("_server")
@pytest.mark.asyncio
async def test_a_run_records_the_statuses_its_agents_give_the_card(
    tmp_path, monkeypatch
):
    from server.db.models import SpecIndex
    from server.services import run_manager as rm

    pid, _oid, clone, factory = await _project(tmp_path)
    main, _ = sh.card_dirs(clone, "001-x")
    _plan(main, "backlog")
    async with factory() as db:
        spec = SpecIndex(project_id=pid, spec_name="001-x", status="backlog")
        db.add(spec)
        await db.commit()
        await db.refresh(spec)

    manager = rm.RunManager()

    async def _env(*_a):
        return {}

    async def _notify(*_a):
        return None

    monkeypatch.setattr(sh, "POLL_S", 0.05)
    monkeypatch.setattr(manager, "_build_env", _env)
    monkeypatch.setattr(manager, "_notify", _notify)
    monkeypatch.setattr(
        rm, "build_command", lambda *_a: [sys.executable, "-c", _CHILD, str(clone)]
    )
    monkeypatch.setattr(rm, "confine", lambda cmd, *_a: cmd)

    await manager.start_run(spec, pid, str(clone), "build", "u-1")
    for _ in range(1000):
        if not manager.is_running(spec.id):
            break
        await asyncio.sleep(0.01)
    assert not manager.is_running(spec.id), "the run never ended"

    entries = _history(main)
    assert [(e["from"], e["to"]) for e in entries] == [
        (None, "backlog"),
        ("backlog", "in_progress"),
        ("in_progress", "ai_review"),
        ("ai_review", "human_review"),
    ]
    assert {e["actor"] for e in entries} == {"agent"}
    assert {e["accountId"] for e in entries} == {"u-1"}
    assert entries[-1]["reason"] == "completed"
