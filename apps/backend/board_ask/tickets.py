"""The tickets of a server project's board, as « Interroger le tableau » reads them.

On the desktop the app hands its cards to the search; on a server the
search runs on the project's clone, so it reads the same files the board
is drawn from (``.workpilot/specs/``, read as ``board_mcp.server`` and the
app read them) and, as on the desktop since lot 4, the roadmap's features
and the ideas not yet turned into cards. Kept a leaf: ``board_mcp`` reaches
``core``, which this package must not pull into the runners' imports. Every card is
read, finished, archived and abandoned ones included: a product owner asks
what was already built.

Each file is read bounded, links not followed, inside the clone; a file
that cannot be read leaves its field empty. Ticket text is what people and
models wrote: it reaches the prompts as quoted data (``answer.py``).
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from board_ask.search import Document, Field

#: Cards read at most, newest first (the snapshot's own limit).
MAX_CARDS = 500
SPEC_BYTES = 16 * 1024
SPEC_CHARS = 1500
DESCRIPTION_CHARS = 2000
MAX_SUBTASKS = 12
MAX_FILES = 20
JSON_BYTES = 1_000_000
#: The source items read per file, and the longest of their lines.
MAX_ITEMS = 500
LINE_CHARS = 300

SPECS = Path(".workpilot") / "specs"
ROADMAP_FILE = Path(".workpilot") / "roadmap" / "roadmap.json"
IDEATION_FILE = Path(".workpilot") / "ideation" / "ideation.json"
#: A card's folder (``board_mcp.server.CARD_ID``).
CARD_ID = re.compile(r"^\d{3,4}-[a-z0-9][a-z0-9-]{0,80}$")

STATES = ("done", "in_review", "in_progress", "planned", "failed", "abandoned")
KINDS = ("roadmap", "idea")

#: A plan's status as the board reads it (``project-store.ts``, ``statusMap``),
#: said the way a product owner reads it.
_PLAN_STATES = {
    "completed": "done",
    "done": "done",
    "pr_created": "in_review",
    "review": "in_review",
    "ai_review": "in_review",
    "human_review": "in_review",
    "planning": "in_progress",
    "in_progress": "in_progress",
    "coding": "in_progress",
    "error": "failed",
    "build_failed": "failed",
}
#: A review that ended on a failure: the board draws it in « Échec ».
FAILED_REVIEWS = frozenset({"errors", "prompt_too_long", "qa_rejected"})

#: How the model is told what a ticket that is not a card is.
KIND_NAMES = {"roadmap": "roadmap feature", "idea": "idea (Ideation)"}


@dataclass
class Ticket:
    id: str
    title: str
    description: str = ""
    spec: str = ""
    subtasks: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    state: str = "planned"
    updated_at: str | None = None
    archived: bool = False
    #: None for a card; "roadmap" or "idea" otherwise.
    kind: str | None = None


def _text(value: Any, limit: int) -> str:
    return str(value).strip()[:limit] if isinstance(value, str | int | float) else ""


def _json(directory: Path, name: str) -> dict[str, Any]:
    path = directory / name
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > JSON_BYTES:
            return {}
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _spec_opening(directory: Path) -> str:
    path = directory / "spec.md"
    try:
        if path.is_symlink() or not path.is_file():
            return ""
        with path.open("rb") as handle:
            raw = handle.read(SPEC_BYTES)
    except OSError:
        return ""
    lines = raw.decode("utf-8", errors="ignore").splitlines()
    text = " ".join(line.lstrip("#").strip() for line in lines)
    return " ".join(text.split())[:SPEC_CHARS]


def card_state(plan: dict[str, Any], meta: dict[str, Any]) -> str:
    """Where a card stands, said the way a product owner reads it."""
    if meta.get("abandoned") is True:
        return "abandoned"
    state = _PLAN_STATES.get(str(plan.get("status") or ""), "planned")
    if (
        plan.get("status") == "human_review"
        and plan.get("reviewReason") in FAILED_REVIEWS
    ):
        return "failed"
    return state


def _plan_steps(plan: dict[str, Any]) -> tuple[list[str], list[str]]:
    steps: list[str] = []
    files: list[str] = []
    for phase in plan.get("phases") or []:
        if not isinstance(phase, dict):
            continue
        for subtask in phase.get("subtasks") or []:
            if not isinstance(subtask, dict):
                continue
            words = " ".join(
                _text(subtask.get(key), 300) for key in ("title", "description")
            ).strip()
            if words and len(steps) < MAX_SUBTASKS:
                steps.append(words)
            for name in subtask.get("files_to_modify") or subtask.get("files") or []:
                if (
                    isinstance(name, str)
                    and name not in files
                    and len(files) < MAX_FILES
                ):
                    files.append(name[:200])
    return steps, files


def card_ticket(directory: Path) -> Ticket:
    """One card of the board, read from its folder."""
    plan = _json(directory, "implementation_plan.json")
    requirements = _json(directory, "requirements.json")
    meta = _json(directory, "task_metadata.json")
    steps, files = _plan_steps(plan)
    task = _text(requirements.get("task_description"), DESCRIPTION_CHARS)
    title = _text(plan.get("feature") or plan.get("title"), 200) or task[:200]
    return Ticket(
        id=directory.name,
        title=" ".join(title.split()) or directory.name,
        description=task or _text(plan.get("description"), DESCRIPTION_CHARS),
        spec=_spec_opening(directory),
        subtasks=steps,
        files=files,
        state=card_state(plan, meta),
        updated_at=_text(plan.get("updated_at"), 40) or None,
        archived=bool(meta.get("archivedAt")),
    )


def card_tickets(root: Path) -> list[Ticket]:
    """Every card of the clone's board, newest first, each folder inside it."""
    specs = root / SPECS
    if not specs.is_dir() or specs.is_symlink():
        return []
    real = os.path.realpath(specs)
    tickets: list[Ticket] = []
    for entry in sorted(specs.iterdir(), reverse=True):
        if len(tickets) >= MAX_CARDS:
            break
        if (
            CARD_ID.match(entry.name)
            and not entry.is_symlink()
            and entry.is_dir()
            and os.path.dirname(os.path.realpath(entry)) == real
        ):
            tickets.append(card_ticket(entry))
    return tickets


def _roadmap_state(status: Any) -> str:
    if status in ("done", "completed"):
        return "done"
    return "in_progress" if status == "in_progress" else "planned"


def _items(root: Path, relative: Path, key: str) -> list[dict[str, Any]]:
    """The objects listed under ``key`` in a file of the clone, its folders
    and itself no link."""
    directory = root
    for part in relative.parts[:-1]:
        directory = directory / part
        if directory.is_symlink():
            return []
    items = _json(directory, relative.name).get(key)
    listed = (
        [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []
    )
    return listed[:MAX_ITEMS]


def _lines(value: Any) -> list[str]:
    values = value if isinstance(value, list) else []
    return [line for line in (_text(v, LINE_CHARS) for v in values) if line][
        :MAX_SUBTASKS
    ]


def source_tickets(root: Path, card_ids: set[str]) -> list[Ticket]:
    """The roadmap's features and the ideas not yet turned into a card."""
    out: list[Ticket] = []
    for feature in _items(root, ROADMAP_FILE, "features"):
        feature_id, title = (
            _text(feature.get("id"), 200),
            _text(feature.get("title"), LINE_CHARS),
        )
        if (
            not feature_id
            or not title
            or _text(feature.get("linked_spec_id"), 200) in card_ids
        ):
            continue
        out.append(
            Ticket(
                id=f"roadmap:{feature_id}",
                title=title,
                description=_text(feature.get("description"), DESCRIPTION_CHARS),
                spec=_text(feature.get("rationale"), DESCRIPTION_CHARS),
                subtasks=(
                    _lines(feature.get("acceptance_criteria"))
                    + _lines(feature.get("user_stories"))
                )[:MAX_SUBTASKS],
                state=_roadmap_state(feature.get("status")),
                kind="roadmap",
            )
        )
    for idea in _items(root, IDEATION_FILE, "ideas"):
        idea_id, title = (
            _text(idea.get("id"), 200),
            _text(idea.get("title"), LINE_CHARS),
        )
        if (
            not idea_id
            or not title
            or _text(idea.get("linked_task_id"), 200) in card_ids
        ):
            continue
        status = idea.get("status")
        out.append(
            Ticket(
                id=f"idea:{idea_id}",
                title=title,
                description=_text(idea.get("description"), DESCRIPTION_CHARS),
                spec=_text(idea.get("rationale"), DESCRIPTION_CHARS),
                files=_lines(idea.get("affected_files")),
                state="abandoned" if status in ("dismissed", "archived") else "planned",
                archived=status == "archived",
                kind="idea",
            )
        )
    return out


def board_tickets(root: Path) -> list[Ticket]:
    """The cards, then the other sources: what is searched. Each has a title:
    a card without one is named by its folder, a source item without one is
    left out."""
    cards = card_tickets(root)
    return cards + source_tickets(root, {t.id for t in cards})


def ticket_document(ticket: Ticket) -> Document:
    """The fields the keyword search reads, the title counting most."""
    # "src/admin/AdminPage.tsx" says "admin page" too.
    spaced = re.sub(r"([a-z])([A-Z])", r"\1 \2", " ".join(ticket.files))
    return Document(
        ticket.id,
        (
            Field(ticket.title, 3),
            Field(ticket.description, 1),
            Field(ticket.spec, 1),
            Field("\n".join(ticket.subtasks), 0.7),
            Field(spaced, 0.5),
        ),
    )


def ticket_digest(ticket: Ticket, max_chars: int) -> str:
    """A ticket in a few lines for the model: what it is, where it stands."""
    lines = [f"Title: {ticket.title}"]
    if ticket.kind:
        lines.append(f"Kind: {KIND_NAMES[ticket.kind]}")
    state = ticket.state + (" (archived)" if ticket.archived else "")
    if ticket.updated_at:
        state += f", last change {ticket.updated_at[:10]}"
    lines.append(f"State: {state}")
    if ticket.description:
        lines.append(f"Description: {' '.join(ticket.description.split())[:500]}")
    if ticket.spec:
        lines.append(f"Spec: {ticket.spec[:400]}")
    if ticket.subtasks:
        lines.append("Steps: " + " | ".join(s[:80] for s in ticket.subtasks))
    if ticket.files:
        lines.append("Files: " + ", ".join(ticket.files[:8]))
    text = "\n".join(lines)
    return text if len(text) <= max_chars else text[: max_chars - 1] + "…"
