"""The fix of an incident, handed to the project's board as a card.

An incident is fixed the way every change of WorkPilot is made: a card on the
Kanban, whose build plans, codes and runs QA in a worktree of its own, then
waits for a person's review before its pull request (`automations` files its
cards the same way). The card holds the incident's analysis, with what the
repository, the pipeline and the monitoring tool wrote already fenced as data.

Nothing here runs an agent or touches git: the card is written with the
board's own numbering lock (`board_mcp.server.write_card`), and the
incident follows its card from what the board records.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .models import HealingStatus, Incident, IncidentMode, _now_iso

#: The kind each mode's card takes, so its workflow fits (`tasks/`).
CARD_KINDS = {
    IncidentMode.CICD: "bug_fix",
    IncidentMode.PRODUCTION: "bug_fix",
    IncidentMode.PROACTIVE: "test",
}

#: The incident status each column of its card stands for.
_STATUS_BY_COLUMN = {
    "backlog": HealingStatus.FIXING,
    "queue": HealingStatus.FIXING,
    "in_progress": HealingStatus.FIXING,
    "ai_review": HealingStatus.QA_RUNNING,
    "human_review": HealingStatus.QA_RUNNING,
    "pr_created": HealingStatus.PR_CREATED,
    "done": HealingStatus.RESOLVED,
    "build_failed": HealingStatus.FAILED,
    "error": HealingStatus.FAILED,
}

#: The columns from which a card is still being worked on.
OPEN_COLUMNS = frozenset(
    column
    for column, status in _STATUS_BY_COLUMN.items()
    if status in (HealingStatus.FIXING, HealingStatus.QA_RUNNING)
)

CARD_FAILED = "the build of its fix card failed; restart the card or take it from there"
CARD_GONE = (
    "its fix card is no longer on the board, so a person has to take it from here"
)
CUT = "\n\n[The analysis was cut here: it is longer than a card holds.]"

_INTRO = {
    IncidentMode.CICD: "A CI/CD pipeline broke. Find the change that broke it, fix the cause and add a regression test.",
    IncidentMode.PRODUCTION: "An error was reported in production. Fix its root cause and add a test that reproduces it.",
    IncidentMode.PROACTIVE: "This file is fragile. Add the tests it lacks, without changing its behaviour.",
}


@dataclass(frozen=True)
class CardState:
    """Where an incident's fix card stands on the board."""

    column: str
    pr_url: str


def card_title(incident: Incident) -> str:
    return f"Fix: {' '.join(incident.title.split())}"[:200]


def card_body(incident: Incident, analysis: str, limit: int) -> str:
    """The card's description: what to do, then the incident's analysis.

    At most ``limit`` characters: the analysis is cut, and says so, when the
    diff and the logs it quotes are longer than a card holds.
    """
    head = (
        f"{_INTRO[incident.mode]}\n\n"
        f"Filed by Self-Healing for incident {incident.id}.\n\n"
    )
    body = head + analysis
    if len(body) <= limit:
        return body
    return body[: limit - len(CUT)] + CUT


def file_card(project_dir: Path, incident: Incident, analysis: str) -> str:
    """Write the incident's fix card in the backlog; its id."""
    from board_mcp.server import MAX_DESCRIPTION, write_card

    kind = CARD_KINDS[incident.mode]
    metadata = {
        "sourceType": "self-healing",
        "selfHealing": {"incidentId": incident.id, "mode": incident.mode.value},
        # Chosen for the incident's mode: the classifier keeps it.
        "kind": kind,
        "kindSource": "user",
        "kindConfidence": 1,
    }
    directory = write_card(
        project_dir,
        card_title(incident),
        card_body(incident, analysis, MAX_DESCRIPTION),
        metadata,
    )
    return directory.name


def card_state(project_dir: Path, card_id: str) -> CardState | None:
    """The card's column and pull request, or None once it is off the board."""
    from board_mcp.server import card_dir, summary

    directory = card_dir(project_dir, card_id)
    if directory is None:
        return None
    url = str(_read_json(directory / "task_metadata.json").get("prUrl") or "")
    return CardState(summary(directory)["column"], url if _is_web_url(url) else "")


def follow(incident: Incident, state: CardState | None) -> bool:
    """Bring the incident to where its card stands; whether it changed."""
    before = (incident.status, incident.fix_pr_url, incident.error_message)
    if state is None:
        incident.status = HealingStatus.ESCALATED
        incident.error_message = CARD_GONE
    else:
        incident.status = _STATUS_BY_COLUMN.get(state.column, HealingStatus.FIXING)
        incident.error_message = (
            CARD_FAILED if incident.status == HealingStatus.FAILED else None
        )
        if state.pr_url:
            incident.fix_pr_url = state.pr_url
            if incident.status in (HealingStatus.FIXING, HealingStatus.QA_RUNNING):
                incident.status = HealingStatus.PR_CREATED
    if incident.status == HealingStatus.RESOLVED and not incident.resolved_at:
        incident.resolved_at = _now_iso()
    return before != (incident.status, incident.fix_pr_url, incident.error_message)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _is_web_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme == "https" and bool(parsed.netloc)
