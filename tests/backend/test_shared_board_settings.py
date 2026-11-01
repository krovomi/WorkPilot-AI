"""Server mode: a card's engine, priority, category and goal.

The app dropped them when it created a card on the server, and an edit in the
task panel landed in its mirror, which the server never reads: a server card
ran on the deployment's default engine with no goal, whatever the card said.
They are now sent, validated and written where the build reads them.
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

ENGINE = {
    "provider": "openai",
    "model": "gpt-5.5",
    "thinkingLevel": "high",
}
GOAL = {"command": "pytest -q", "maxRounds": 3, "protected": ["tests/**"]}


async def _create(tmp_path, settings=None):
    from shared_board.api import CardCreate, create_card

    pid, oid, clone = await _project(tmp_path)
    member = _scope(pid, oid, clone, "member")
    body = CardCreate(title="T", settings=settings)
    async with await _db() as db:
        card = await create_card(body, _request(), member, db)
    return member, clone, card["id"]


def _metadata(clone: Path, card_id: str) -> dict:
    path = clone / ".workpilot/specs" / card_id / "task_metadata.json"
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.mark.asyncio
async def test_a_card_is_created_with_its_engine_priority_and_goal(tmp_path):
    from shared_board.api import get_card
    from shared_board.settings import CardSettings

    settings = CardSettings(
        engine=ENGINE, priority="high", category="bug_fix", goal=GOAL
    )
    scope, clone, card_id = await _create(tmp_path, settings)

    metadata = _metadata(clone, card_id)
    assert metadata["provider"] == "openai"
    assert metadata["model"] == "gpt-5.5"
    assert metadata["thinkingLevel"] == "high"
    assert metadata["engineLocked"] is True
    assert metadata["priority"] == "high"
    assert metadata["category"] == "bug_fix"
    # Written where the build reads it, never in the metadata an agent may write.
    goal_file = clone / ".workpilot/specs" / card_id / ".workpilot-goal.json"
    assert json.loads(goal_file.read_text(encoding="utf-8"))["command"] == "pytest -q"
    assert "goal" not in metadata

    shown = (await get_card(card_id, scope))["settings"]
    assert shown["engine"]["provider"] == "openai"
    assert shown["goal"] == {
        "command": "pytest -q",
        "expectedExit": 0,
        "timeoutSeconds": 600,
        "maxRounds": 3,
        "protected": ["tests/**"],
    }
    assert shown["priority"] == "high"


@pytest.mark.asyncio
async def test_the_build_reads_the_engine_the_card_names(tmp_path):
    from phase_config import get_phase_provider, is_engine_locked
    from shared_board.settings import CardSettings

    _, clone, card_id = await _create(tmp_path, CardSettings(engine=ENGINE))
    spec_dir = clone / ".workpilot/specs" / card_id
    assert get_phase_provider(spec_dir, phase="coding") == "openai"
    assert is_engine_locked(spec_dir)


def test_an_unknown_provider_or_a_strange_model_is_refused():
    from pydantic import ValidationError
    from shared_board.settings import CardEngine

    with pytest.raises(ValidationError):
        CardEngine(provider="evil-corp")
    with pytest.raises(ValidationError):
        CardEngine(provider="claude", model="opus; rm -rf /")
    with pytest.raises(ValidationError):
        CardEngine(provider="claude", phaseProviders={"coding": "nope"})
    # The UI's spelling of Claude is accepted.
    assert CardEngine(provider="anthropic").provider == "anthropic"


@pytest.mark.asyncio
async def test_a_bad_goal_creates_no_card(tmp_path):
    from fastapi import HTTPException
    from shared_board.api import CardCreate, create_card
    from shared_board.settings import CardSettings

    pid, oid, clone = await _project(tmp_path)
    member = _scope(pid, oid, clone, "member")
    body = CardCreate(title="T", settings=CardSettings(goal={"command": "a\nb"}))
    async with await _db() as db:
        with pytest.raises(HTTPException) as exc:
            await create_card(body, _request(), member, db)
    assert exc.value.status_code == 422
    specs = clone / ".workpilot/specs"
    assert not specs.exists() or not any(specs.iterdir())


@pytest.mark.asyncio
async def test_settings_change_after_work_started_and_reach_the_workspace(tmp_path):
    from shared_board.api import update_card_settings
    from shared_board.settings import CardSettings

    scope, clone, card_id = await _create(
        tmp_path, CardSettings(engine=ENGINE, goal=GOAL, priority="low")
    )
    spec = clone / ".workpilot/specs" / card_id
    (spec / "spec.md").write_text("# spec", encoding="utf-8")
    copy = clone / ".workpilot/worktrees/tasks" / card_id / ".workpilot/specs" / card_id
    copy.mkdir(parents=True)
    (copy / "task_metadata.json").write_text(
        json.dumps({"kind": "feature"}), encoding="utf-8"
    )

    body = CardSettings.model_validate(
        {"engine": {"provider": "claude", "model": "claude-opus-4-8"}, "goal": None}
    )
    async with await _db() as db:
        shown = await update_card_settings(card_id, body, _request(), scope, db)

    assert shown["engine"]["provider"] == "claude"
    assert "thinkingLevel" not in shown["engine"]  # the engine is replaced whole
    assert shown["goal"] is None
    assert shown["priority"] == "low"  # left out, so kept
    for directory in (spec, copy):
        metadata = json.loads(
            (directory / "task_metadata.json").read_text(encoding="utf-8")
        )
        assert metadata["model"] == "claude-opus-4-8"
        assert not (directory / ".workpilot-goal.json").exists()
    assert (
        json.loads((copy / "task_metadata.json").read_text(encoding="utf-8"))["kind"]
        == "feature"
    )


@pytest.mark.asyncio
async def test_a_viewer_cannot_change_them_and_a_running_card_is_left_alone(
    tmp_path, monkeypatch
):
    from fastapi import HTTPException
    from server.services import run_manager
    from shared_board.api import update_card_settings
    from shared_board.settings import CardSettings

    member, clone, card_id = await _create(tmp_path)
    viewer = _scope(member.project_id, member.org_id, clone, "viewer")
    body = CardSettings(priority="urgent")
    async with await _db() as db:
        with pytest.raises(HTTPException) as exc:
            await update_card_settings(card_id, body, _request(), viewer, db)
        assert exc.value.status_code == 403

        monkeypatch.setattr(
            run_manager.RunManager, "is_running", lambda self, spec_id: True
        )
        with pytest.raises(HTTPException) as exc:
            await update_card_settings(card_id, body, _request(), member, db)
        assert exc.value.status_code == 409
    assert "priority" not in _metadata(clone, card_id)


@pytest.mark.asyncio
async def test_a_linked_goal_file_is_replaced_not_followed(tmp_path):
    from shared_board.api import update_card_settings
    from shared_board.settings import CardSettings

    scope, clone, card_id = await _create(tmp_path)
    outside = tmp_path / "outside.json"
    outside.write_text("keep", encoding="utf-8")
    link = clone / ".workpilot/specs" / card_id / ".workpilot-goal.json"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlinks unavailable")
    async with await _db() as db:
        await update_card_settings(
            card_id, CardSettings(goal=GOAL), _request(), scope, db
        )
    assert outside.read_text(encoding="utf-8") == "keep"
    assert not link.is_symlink()


def test_changing_them_needs_task_write():
    from server.authz.mounting import permission_for

    assert (
        permission_for("PATCH", "/api/board/cards/{card_id}/settings", "task")
        == "task.write"
    )


@pytest.mark.asyncio
async def test_an_unusable_goal_file_is_reported_without_its_cause(tmp_path):
    from shared_board.api import get_card
    from shared_board.settings import GOAL_UNREADABLE

    scope, clone, card_id = await _create(tmp_path)
    goal_file = clone / ".workpilot/specs" / card_id / ".workpilot-goal.json"
    goal_file.write_text("{not json", encoding="utf-8")
    shown = (await get_card(card_id, scope))["settings"]
    assert shown["goal"] is None
    assert shown["goalError"] == GOAL_UNREADABLE
    assert str(clone) not in shown["goalError"]
