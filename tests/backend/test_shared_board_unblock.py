"""Server mode: answering a blocked subtask of a server card from the app.

The subtask panel's four answers (done, not needed, retry, reply) are written
to the card's plans on the server, by ``project_id``, for project members;
a retry or a reply asks the app to start a build run, and is refused while
one is already working on the card.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.backend.test_shared_board_review import (  # noqa: F401  (fixture)
    _build,
    _card,
    _db,
    _events,
    _project,
    _request,
    _scope,
)


@pytest.fixture(autouse=True)
def _unblock_events(monkeypatch, _events):
    from shared_board import unblock

    monkeypatch.setattr(
        unblock,
        "emit_board_event",
        lambda project_id, event, data: _events.append((project_id, event)),
    )


def _block(clone: Path, workspace: Path, card_id: str) -> None:
    for spec in (
        clone / ".workpilot/specs" / card_id,
        workspace / ".workpilot/specs" / card_id,
    ):
        path = spec / "implementation_plan.json"
        plan = json.loads(path.read_text(encoding="utf-8"))
        plan["phases"][0]["subtasks"].append(
            {
                "id": "verify",
                "status": "blocked",
                "_blocked_reason": "Manual testing required",
            }
        )
        path.write_text(json.dumps(plan), encoding="utf-8")


def _plans(clone: Path, workspace: Path, card_id: str) -> list[dict]:
    return [
        json.loads(
            (spec / card_id / "implementation_plan.json").read_text(encoding="utf-8")
        )
        for spec in (clone / ".workpilot/specs", workspace / ".workpilot/specs")
    ]


def _verify(plan: dict) -> dict:
    return next(s for s in plan["phases"][0]["subtasks"] if s["id"] == "verify")


@pytest.mark.asyncio
async def test_a_reply_reopens_both_plans_and_asks_for_a_build(tmp_path, _events):
    from shared_board.unblock import UnblockRequest, unblock_subtask

    pid, oid, clone = await _project(tmp_path)
    card_id = await _card(pid, oid, clone)
    workspace = _build(clone, card_id)
    _block(clone, workspace, card_id)

    async with await _db() as db:
        result = await unblock_subtask(
            card_id,
            "verify",
            UnblockRequest(action="answer", reply="test.txt is at the repo root"),
            _request(),
            _scope(pid, oid, clone, "member"),
            db,
        )
    assert result["restart"] is True
    assert result["subtask"]["status"] == "pending"
    for plan in _plans(clone, workspace, card_id):
        subtask = _verify(plan)
        assert subtask["status"] == "pending"
        assert subtask["human_reply"] == "test.txt is at the repo root"
        assert "_blocked_reason" not in subtask and "unblocked_at" in subtask
        assert plan["status"] == "in_progress"
        assert plan["qa_signoff"]["status"] == "pending"
    assert _events[-1] == (pid, "spec_updated")


@pytest.mark.asyncio
async def test_done_needs_no_build_and_is_allowed_during_a_run(tmp_path, monkeypatch):
    from server.services import run_manager
    from shared_board.unblock import UnblockRequest, unblock_subtask

    pid, oid, clone = await _project(tmp_path)
    card_id = await _card(pid, oid, clone)
    workspace = _build(clone, card_id)
    _block(clone, workspace, card_id)

    class Busy:
        def is_running(self, spec_id):
            return True

    monkeypatch.setattr(run_manager, "get_run_manager", lambda: Busy())
    async with await _db() as db:
        result = await unblock_subtask(
            card_id,
            "verify",
            UnblockRequest(action="complete"),
            _request(),
            _scope(pid, oid, clone, "member"),
            db,
        )
    assert result["restart"] is False
    for plan in _plans(clone, workspace, card_id):
        subtask = _verify(plan)
        assert subtask["status"] == "completed"
        assert subtask["human_resolution"]["action"] == "complete"
        assert subtask["human_resolution"]["reason"] == "Manual testing required"


@pytest.mark.asyncio
async def test_retry_is_refused_during_a_run_and_bad_answers_are_refused(
    tmp_path, monkeypatch
):
    from fastapi import HTTPException
    from server.services import run_manager
    from shared_board.unblock import UnblockRequest, unblock_subtask

    pid, oid, clone = await _project(tmp_path)
    card_id = await _card(pid, oid, clone)
    workspace = _build(clone, card_id)
    _block(clone, workspace, card_id)
    member = _scope(pid, oid, clone, "member")

    async def call(subtask_id: str, body: UnblockRequest, scope=member) -> int:
        async with await _db() as db:
            with pytest.raises(HTTPException) as exc:
                await unblock_subtask(card_id, subtask_id, body, _request(), scope, db)
        return exc.value.status_code

    assert await call("verify", UnblockRequest(action="answer", reply=" ")) == 422
    assert await call("1", UnblockRequest(action="complete")) == 409  # not blocked
    assert await call("nope", UnblockRequest(action="complete")) == 404
    assert await call("../x", UnblockRequest(action="complete")) == 404
    viewer = _scope(pid, oid, clone, "viewer")
    assert await call("verify", UnblockRequest(action="complete"), viewer) == 403

    class Busy:
        def is_running(self, spec_id):
            return True

    monkeypatch.setattr(run_manager, "get_run_manager", lambda: Busy())
    assert await call("verify", UnblockRequest(action="retry")) == 409
    for plan in _plans(clone, workspace, card_id):
        assert _verify(plan)["status"] == "blocked"
