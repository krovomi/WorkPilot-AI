"""Server mode: a card's build log, served to every member who reads the card.

A run on the server wrote its journal to ``task_logs.json`` in the clone, and
nothing served it: the app's Logs tab and the phone showed nothing for a server
card. The route merges the spec folder's copy and the build workspace's as the
app does for a local card, and sends a bounded, masked copy.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from tests.backend.test_shared_board import (  # noqa: E402
    _clean_settings,  # noqa: F401 - autouse fixture
    _db,
    _project,
    _request,
    _scope,
)


def _phase(name: str, status: str, texts: list[str]) -> dict:
    return {
        "phase": name,
        "status": status,
        "started_at": None,
        "completed_at": None,
        "entries": [
            {"timestamp": "2026-11-01T10:00:00Z", "type": "text", "content": t}
            for t in texts
        ],
    }


def _logs(planning, coding, validation, updated="2026-11-01T10:00:00Z") -> dict:
    return {
        "spec_id": "x",
        "created_at": "2026-11-01T09:00:00Z",
        "updated_at": updated,
        "phases": {"planning": planning, "coding": coding, "validation": validation},
    }


def _write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


async def _card(tmp_path):
    from shared_board.api import CardCreate, create_card

    pid, oid, clone = await _project(tmp_path)
    scope = _scope(pid, oid, clone, "viewer")
    member = _scope(pid, oid, clone, "member")
    async with await _db() as db:
        card = await create_card(CardCreate(title="T"), _request(), member, db)
    return scope, clone, card["id"]


@pytest.mark.asyncio
async def test_a_card_without_a_run_has_no_log(tmp_path):
    from shared_board.api import get_card_logs

    scope, _, card_id = await _card(tmp_path)
    assert await get_card_logs(card_id, scope) == {"logs": None}


@pytest.mark.asyncio
async def test_a_viewer_reads_the_spec_folders_log(tmp_path):
    from shared_board.api import get_card_logs

    scope, clone, card_id = await _card(tmp_path)
    _write(
        clone / ".workpilot/specs" / card_id / "task_logs.json",
        _logs(
            _phase("planning", "completed", ["planned"]),
            _phase("coding", "pending", []),
            _phase("validation", "pending", []),
        ),
    )
    logs = (await get_card_logs(card_id, scope))["logs"]
    assert logs["phases"]["planning"]["entries"][0]["content"] == "planned"
    assert logs["phases"]["coding"]["status"] == "pending"
    assert logs["truncated"] is False


@pytest.mark.asyncio
async def test_the_build_workspace_log_is_merged_as_the_app_does(tmp_path):
    from shared_board.api import get_card_logs

    scope, clone, card_id = await _card(tmp_path)
    _write(
        clone / ".workpilot/specs" / card_id / "task_logs.json",
        _logs(
            _phase("planning", "completed", ["p1", "p2"]),
            _phase("coding", "pending", []),
            _phase("validation", "pending", []),
        ),
    )
    copy = clone / ".workpilot/worktrees/tasks" / card_id / ".workpilot/specs" / card_id
    _write(
        copy / "task_logs.json",
        _logs(
            _phase("planning", "completed", ["p1"]),
            _phase("coding", "active", ["writing the endpoint"]),
            _phase("validation", "pending", []),
            updated="2026-11-01T11:00:00Z",
        ),
    )
    logs = (await get_card_logs(card_id, scope))["logs"]
    # Planning from the copy with more entries, coding from the workspace.
    assert [e["content"] for e in logs["phases"]["planning"]["entries"]] == [
        "p1",
        "p2",
    ]
    assert logs["phases"]["coding"]["entries"][0]["content"] == "writing the endpoint"
    assert logs["updated_at"] == "2026-11-01T11:00:00Z"


@pytest.mark.asyncio
async def test_the_log_is_bounded_and_masked(tmp_path):
    from shared_board import logs as logs_module
    from shared_board.api import get_card_logs

    scope, clone, card_id = await _card(tmp_path)
    token = "ghp_" + "a" * 36
    many = [f"line {i}" for i in range(logs_module.MAX_ENTRIES + 5)]
    many[-1] = f"pushed with {token}"
    _write(
        clone / ".workpilot/specs" / card_id / "task_logs.json",
        _logs(
            _phase("planning", "completed", ["y" * (logs_module.MAX_TEXT + 50)]),
            _phase("coding", "active", many),
            _phase("validation", "pending", []),
        ),
    )
    logs = (await get_card_logs(card_id, scope))["logs"]
    coding = logs["phases"]["coding"]["entries"]
    assert len(coding) == logs_module.MAX_ENTRIES
    assert coding[0]["content"] == "line 5"
    assert token not in coding[-1]["content"]
    assert "[REDACTED]" in coding[-1]["content"]
    assert len(logs["phases"]["planning"]["entries"][0]["content"]) == (
        logs_module.MAX_TEXT
    )
    assert logs["truncated"] is True


@pytest.mark.asyncio
async def test_an_unreadable_or_linked_log_is_not_served(tmp_path):
    from shared_board.api import get_card_logs

    scope, clone, card_id = await _card(tmp_path)
    log = clone / ".workpilot/specs" / card_id / "task_logs.json"
    log.write_text("{not json", encoding="utf-8")
    assert (await get_card_logs(card_id, scope))["logs"] is None

    log.unlink()
    outside = tmp_path / "elsewhere.json"
    _write(
        outside,
        _logs(
            _phase("planning", "completed", ["secret"]),
            _phase("coding", "pending", []),
            _phase("validation", "pending", []),
        ),
    )
    try:
        log.symlink_to(outside)
    except OSError:
        pytest.skip("symlinks unavailable")
    assert (await get_card_logs(card_id, scope))["logs"] is None


@pytest.mark.asyncio
async def test_an_unknown_card_is_not_found(tmp_path):
    from fastapi import HTTPException
    from shared_board.api import get_card_logs

    scope, _, _ = await _card(tmp_path)
    with pytest.raises(HTTPException) as exc:
        await get_card_logs("../../etc", scope)
    assert exc.value.status_code == 404


def test_reading_a_cards_log_needs_only_task_read():
    from server.authz.mounting import permission_for

    assert (
        permission_for("GET", "/api/board/cards/{card_id}/logs", "task") == "task.read"
    )
