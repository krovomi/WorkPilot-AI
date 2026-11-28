"""Server mode: a card's labels (Jira's labels), shared by the project's members.

The board's own field, like the sub-project and the sprint: it changes even
while a run works on the card, and keeps the desktop's limits
(`shared/utils/task-labels.ts`).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from tests.backend.test_shared_board import (  # noqa: E402
    _clean_settings,  # noqa: F401 - autouse fixture
    _request,
)
from tests.backend.test_shared_board_settings import (  # noqa: E402
    _create,
    _db,
    _metadata,
)


@pytest.mark.asyncio
async def test_a_card_gets_its_labels_even_while_it_runs_and_loses_them(
    tmp_path, monkeypatch
):
    from server.services import run_manager
    from shared_board.api import update_card_settings
    from shared_board.settings import CardSettings

    member, clone, card_id = await _create(tmp_path)

    class Busy:
        def is_running(self, _run_id):
            return True

    monkeypatch.setattr(run_manager, "get_run_manager", lambda: Busy())
    async with await _db() as db:
        read = await update_card_settings(
            card_id,
            CardSettings(labels=["  front   end ", "release"]),
            _request(),
            member,
            db,
        )
    assert _metadata(clone, card_id)["labels"] == ["front end", "release"]
    assert read["labels"] == ["front end", "release"]

    async with await _db() as db:
        read = await update_card_settings(
            card_id, CardSettings(labels=[]), _request(), member, db
        )
    assert "labels" not in _metadata(clone, card_id)
    assert read["labels"] is None


def test_labels_keep_the_desktop_limits():
    from shared_board.settings import CardSettings

    assert CardSettings(labels=None).labels is None
    for refused in (
        ["x" * 31],
        [""],
        ["   "],
        ["line\nbreak"],
        [f"l{i}" for i in range(11)],
    ):
        with pytest.raises(ValidationError):
            CardSettings(labels=refused)
