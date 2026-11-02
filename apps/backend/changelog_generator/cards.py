"""The done cards of a clone's board, and what the changelog reads of them.

A card is a folder of ``.workpilot/specs`` (``board_mcp.server``); while its
build ran, its plan was written in its build workspace, and the board reads
that copy when there is one (``shared_board.listing.card_source``). A card
counts when its column is ``done`` and it is not archived, as the desktop's
``getCompletedTasks`` keeps it. Each file is read under its size.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from board_mcp.server import SPECS, card_dir, summary
from changelog_generator.prompts import CardSpec

MAX_SPEC = 300_000
MAX_PLAN = 1_000_000
MAX_METADATA = 200_000


def _read(path: Path, limit: int) -> str:
    try:
        if path.is_symlink() or not path.is_file():
            return ""
        with path.open(encoding="utf-8", errors="replace") as handle:
            return handle.read(limit)
    except OSError:
        return ""


def _json(path: Path, limit: int) -> dict[str, Any]:
    try:
        value = json.loads(_read(path, limit) or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def card_copy(root: Path, directory: Path) -> Path:
    """The copy of the card the board shows: its build workspace's when it has one."""
    copy = root / ".workpilot" / "worktrees" / "tasks" / directory.name
    copy = copy / SPECS / directory.name
    if copy.is_dir() and copy.resolve().is_relative_to(root.resolve()):
        return copy
    return directory


def done_card(root: Path, card_id: str) -> CardSpec | None:
    """The card ``card_id`` of the clone if it is done; None otherwise."""
    directory = card_dir(root, card_id)
    if directory is None:
        return None
    source = card_copy(root, directory)
    if summary(source)["column"] != "done":
        return None
    if _json(source / "task_metadata.json", MAX_METADATA).get("archivedAt"):
        return None
    plan = _json(source / "implementation_plan.json", MAX_PLAN)
    workflow = plan.get("workflow_type")
    return CardSpec(
        card_id=directory.name,
        spec=_read(source / "spec.md", MAX_SPEC),
        workflow_type=workflow if isinstance(workflow, str) else "",
    )


def done_cards(root: Path, card_ids: list[str]) -> list[CardSpec]:
    """The done cards among ``card_ids``, in their order, each once."""
    found: list[CardSpec] = []
    seen: set[str] = set()
    for card_id in card_ids:
        if card_id in seen:
            continue
        seen.add(card_id)
        card = done_card(root, card_id)
        if card is not None:
            found.append(card)
    return found
