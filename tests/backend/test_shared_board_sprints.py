"""Server mode: the sprints of a project's board, shared by its members.

Kept in the clone's ``.workpilot/sprints.json`` with the desktop's rules: one
active sprint at a time, a closed one no longer changes, only a planned one
is deleted; a viewer reads them and changes nothing.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from tests.backend.test_shared_board import (  # noqa: E402
    _clean_settings,  # noqa: F401 - autouse fixture
    _project,
    _request,
    _scope,
)


async def _member(tmp_path, role="member"):
    pid, oid, clone = await _project(tmp_path)
    return _scope(pid, oid, clone, role), clone


def _stored(clone: Path) -> list[dict]:
    path = clone / ".workpilot" / "sprints.json"
    return json.loads(path.read_text(encoding="utf-8"))["sprints"]


async def test_a_sprint_is_planned_started_and_closed(tmp_path):
    from shared_board.sprints import (
        CompleteBody,
        SprintDraft,
        StartBody,
        complete_sprint,
        list_sprints,
        save_sprint,
        start_sprint,
    )

    scope, clone = await _member(tmp_path)
    draft = SprintDraft(
        name="  Sprint 12 ",
        goal="Checkout ready",
        startDate="2026-12-01",
        endDate="2026-12-14",
    )
    shown = await save_sprint(draft, _request(), scope)
    first = shown["sprints"][0]
    assert first["name"] == "Sprint 12"
    assert first["state"] == "planned"
    assert first["id"].startswith("sp-")
    next_one = (await save_sprint(SprintDraft(name="Sprint 13"), _request(), scope))[
        "sprints"
    ][1]

    renamed = SprintDraft(id=first["id"], name="Sprint 12b")
    assert (await save_sprint(renamed, _request(), scope))["sprints"][0][
        "name"
    ] == "Sprint 12b"

    started = StartBody(committed={"cards": 4, "points": 21})
    await start_sprint(first["id"], started, _request(), scope)
    with pytest.raises(HTTPException) as other:
        await start_sprint(next_one["id"], started, _request(), scope)
    assert other.value.status_code == 409

    report = CompleteBody(
        report={
            "done": 3,
            "donePoints": 13,
            "carried": 1,
            "carriedPoints": 8,
            "carriedTo": next_one["id"],
        }
    )
    await complete_sprint(first["id"], report, _request(), scope)
    closed = _stored(clone)[0]
    assert closed["state"] == "closed"
    assert closed["committed"] == {"cards": 4, "points": 21}
    assert closed["report"]["carriedTo"] == next_one["id"]
    assert "closedAt" in closed

    with pytest.raises(HTTPException) as frozen:
        await save_sprint(SprintDraft(id=first["id"], name="again"), _request(), scope)
    assert frozen.value.status_code == 409
    assert len((await list_sprints(scope))["sprints"]) == 2


async def test_unfinished_cards_go_only_to_a_planned_sprint(tmp_path):
    from shared_board.sprints import (
        CompleteBody,
        SprintDraft,
        StartBody,
        complete_sprint,
        save_sprint,
        start_sprint,
    )

    scope, _clone = await _member(tmp_path)
    sprint = (await save_sprint(SprintDraft(name="S1"), _request(), scope))["sprints"][
        0
    ]
    await start_sprint(
        sprint["id"], StartBody(committed={"cards": 0, "points": 0}), _request(), scope
    )
    report = {"done": 0, "donePoints": 0, "carried": 1, "carriedPoints": 0}
    with pytest.raises(HTTPException) as itself:
        await complete_sprint(
            sprint["id"],
            CompleteBody(report={**report, "carriedTo": sprint["id"]}),
            _request(),
            scope,
        )
    assert itself.value.status_code == 409
    with pytest.raises(HTTPException) as unknown:
        await complete_sprint(
            sprint["id"],
            CompleteBody(report={**report, "carriedTo": "sp-00000000"}),
            _request(),
            scope,
        )
    assert unknown.value.status_code == 404


async def test_only_a_planned_sprint_is_deleted(tmp_path):
    from shared_board.sprints import (
        SprintDraft,
        StartBody,
        delete_sprint,
        save_sprint,
        start_sprint,
    )

    scope, clone = await _member(tmp_path)
    a = (await save_sprint(SprintDraft(name="A"), _request(), scope))["sprints"][0]
    b = (await save_sprint(SprintDraft(name="B"), _request(), scope))["sprints"][1]
    await start_sprint(
        a["id"], StartBody(committed={"cards": 0, "points": 0}), _request(), scope
    )
    with pytest.raises(HTTPException) as active:
        await delete_sprint(a["id"], _request(), scope)
    assert active.value.status_code == 409
    await delete_sprint(b["id"], _request(), scope)
    assert [s["id"] for s in _stored(clone)] == [a["id"]]


async def test_a_viewer_reads_the_sprints_and_changes_nothing(tmp_path):
    from shared_board.sprints import SprintDraft, list_sprints, save_sprint

    scope, clone = await _member(tmp_path, role="viewer")
    assert (await list_sprints(scope)) == {"sprints": []}
    with pytest.raises(HTTPException) as refused:
        await save_sprint(SprintDraft(name="S"), _request(), scope)
    assert refused.value.status_code == 403
    assert not (clone / ".workpilot" / "sprints.json").exists()


def test_a_strange_sprint_is_refused():
    from shared_board.sprints import Report, SprintDraft

    for bad in (
        {"name": ""},
        {"name": "   "},
        {"name": "x" * 81},
        {"name": "two\nlines"},
        {"name": "S", "startDate": "2026-02-30"},
        {"name": "S", "startDate": "2026-12-10", "endDate": "2026-12-01"},
        {"name": "S", "id": "../../etc"},
        {"name": "S", "goal": "x" * 501},
    ):
        with pytest.raises(ValidationError):
            SprintDraft(**bad)
    with pytest.raises(ValidationError):
        Report(done=-1, donePoints=0, carried=0, carriedPoints=0)


async def test_a_malformed_file_or_a_link_in_the_clone_is_not_followed(tmp_path):
    from shared_board.sprints import SprintDraft, list_sprints, save_sprint

    scope, clone = await _member(tmp_path)
    folder = clone / ".workpilot"
    folder.mkdir()
    (folder / "sprints.json").write_text(
        json.dumps({"sprints": [{"id": "bad"}, {"name": "no id"}]}), encoding="utf-8"
    )
    assert (await list_sprints(scope)) == {"sprints": []}

    outside = tmp_path / "outside.json"
    outside.write_text("keep", encoding="utf-8")
    (folder / "sprints.json").unlink()
    (folder / "sprints.json").symlink_to(outside)
    assert (await list_sprints(scope)) == {"sprints": []}
    with pytest.raises(HTTPException):
        await save_sprint(SprintDraft(name="S"), _request(), scope)
    assert outside.read_text(encoding="utf-8") == "keep"


async def test_a_card_gets_its_sprint_even_while_it_runs(tmp_path, monkeypatch):
    """The sprint is the board's: a run does not read it, so it is not refused (409)."""
    from server.services import run_manager
    from shared_board.api import update_card_settings
    from shared_board.settings import CardSettings

    from tests.backend.test_shared_board_settings import _create, _db, _metadata

    member, clone, card_id = await _create(tmp_path)

    class Busy:
        def is_running(self, _run_id):
            return True

    monkeypatch.setattr(run_manager, "get_run_manager", lambda: Busy())
    async with await _db() as db:
        await update_card_settings(
            card_id, CardSettings(sprintId="sp-0123abcd"), _request(), member, db
        )
    assert _metadata(clone, card_id)["sprintId"] == "sp-0123abcd"
    async with await _db() as db:
        with pytest.raises(HTTPException) as running:
            await update_card_settings(
                card_id,
                CardSettings(sprintId="sp-0123abcd", priority="high"),
                _request(),
                member,
                db,
            )
    # With a field a run reads, the card's run still refuses the change.
    assert running.value.status_code == 409
    with pytest.raises(ValidationError):
        CardSettings(sprintId="sprint-1")


async def test_a_sprint_changes_only_from_the_state_that_allows_it(
    tmp_path, monkeypatch
):
    from shared_board import sprints as board_sprints
    from shared_board.sprints import (
        CompleteBody,
        SprintDraft,
        StartBody,
        complete_sprint,
        list_sprints,
        save_sprint,
        start_sprint,
    )

    scope, clone = await _member(tmp_path)
    sprint = (await save_sprint(SprintDraft(name="S"), _request(), scope))["sprints"][0]
    report = CompleteBody(
        report={"done": 0, "donePoints": 0, "carried": 0, "carriedPoints": 0}
    )
    with pytest.raises(HTTPException) as planned:
        await complete_sprint(sprint["id"], report, _request(), scope)
    assert planned.value.status_code == 409
    begun = StartBody(committed={"cards": 0, "points": 0})
    await start_sprint(sprint["id"], begun, _request(), scope)
    with pytest.raises(HTTPException) as again:
        await start_sprint(sprint["id"], begun, _request(), scope)
    assert again.value.status_code == 409

    # A sprint written twice in the file is read once.
    path = clone / ".workpilot" / "sprints.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["sprints"].append(data["sprints"][0])
    path.write_text(json.dumps(data), encoding="utf-8")
    assert len((await list_sprints(scope))["sprints"]) == 1

    monkeypatch.setattr(board_sprints, "MAX_SPRINTS", 1)
    with pytest.raises(HTTPException) as full:
        await save_sprint(SprintDraft(name="T"), _request(), scope)
    assert full.value.status_code == 409
