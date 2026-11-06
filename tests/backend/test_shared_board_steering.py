"""Server mode: messages to a server card's running task (killer feature F1).

Sent by ``project_id``, written in the card's folder and its build
workspace's copy of the spec, for project writers; sending is
``agent.execute``, reading the board's read.
"""

from __future__ import annotations

import pytest

from tests.backend.test_shared_board_review import (  # noqa: F401  (fixture)
    _build,
    _card,
    _events,
    _project,
    _request,
    _scope,
)


@pytest.fixture(autouse=True)
def _steering_events(monkeypatch, _events):
    from shared_board import steering

    monkeypatch.setattr(
        steering,
        "emit_board_event",
        lambda project_id, event, data: _events.append((project_id, event)),
    )


@pytest.mark.asyncio
async def test_a_message_reaches_both_copies_and_lists_back(tmp_path, _events):
    from foundation.steering import load_messages
    from shared_board.steering import SteeringRequest, card_steering, steer_card

    pid, oid, clone = await _project(tmp_path)
    card_id = await _card(pid, oid, clone)
    workspace = _build(clone, card_id)
    body = SteeringRequest(text="Keep the old route", source="mobile")
    result = await steer_card(
        card_id, body, _request(), _scope(pid, oid, clone, "member")
    )
    [message] = result["messages"]
    assert message["text"] == "Keep the old route" and message["source"] == "mobile"
    for spec in (
        clone / ".workpilot/specs" / card_id,
        workspace / ".workpilot/specs" / card_id,
    ):
        assert [m.text for m in load_messages(spec)] == ["Keep the old route"]
    listed = await card_steering(card_id, _scope(pid, oid, clone, "viewer"))
    assert listed["messages"][0]["deliveredAt"] is None
    assert _events[-1] == (pid, "spec_updated")


@pytest.mark.asyncio
async def test_a_viewer_cannot_send_and_bad_targets_are_refused(tmp_path):
    from fastapi import HTTPException
    from shared_board.steering import SteeringRequest, steer_card

    pid, oid, clone = await _project(tmp_path)
    card_id = await _card(pid, oid, clone)
    with pytest.raises(HTTPException) as exc:
        await steer_card(
            card_id,
            SteeringRequest(text="x"),
            _request(),
            _scope(pid, oid, clone, "viewer"),
        )
    assert exc.value.status_code == 403
    with pytest.raises(HTTPException) as exc:
        await steer_card(
            card_id,
            SteeringRequest(text="x", target_subtask_id="../plan"),
            _request(),
            _scope(pid, oid, clone, "member"),
        )
    assert exc.value.status_code == 422


def test_sending_needs_agent_execute_and_reading_the_board_read():
    from server.authz.mounting import ROUTE_OVERRIDES, permission_for

    assert (
        ROUTE_OVERRIDES[("POST", "/api/board/cards/{card_id}/steering")]
        == "agent.execute"
    )
    assert (
        permission_for("GET", "/api/board/cards/{card_id}/steering", "task")
        == "task.read"
    )
