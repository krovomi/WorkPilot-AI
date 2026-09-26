"""What hermes learned, filed in the shared brain.

Hermes and the brain answer the same question from two ends. Hermes gathers
experience on surfaces WorkPilot never sees — Telegram, a cron job, a terminal
on a VPS — and writes it down as skills in its own home. The brain is the one
memory every agent reads: Claude Code, Codex, Gemini, Cursor, hermes itself.
Until now the two never met: an adopted hermes skill sat in
``skills/hermes-learned/``, where only this repository's pull requests could
see it, and the brain never heard of it.

So every skill that is **kept** — adopted by the loop after triage, or kept by a
person from the task panel — is also written to the brain as a knowledge note,
``knowledge/hermes/<skill>.md``: what it is for, the procedure hermes wrote,
and the portability table. One ``brain_recall`` then answers "does any of my
agents already know how to do this?", from any agent, on any machine.

Knowledge, not a skill, and not an instruction
----------------------------------------------
The brain has three places a note could go, and two of them would be an
activation nobody decided:

* ``instructions/`` is injected into every agent's prompt on every project;
* ``skills/`` is what connected agents load as procedures.

A hermes skill carries no evidence from a build that used it, and it names
hermes's tools rather than anyone else's. ``knowledge/`` is recalled on demand
and read as data — which is exactly the standing an unverified procedure
deserves. Promoting it to a skill every agent follows stays a person's gesture,
in Obsidian, with the note in front of them.

Nothing here can fail the loop: no brain on this machine, the brain switched
off, git offline — the function logs and returns ``None``.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

logger = logging.getLogger(__name__)

__all__ = ["BrainLink", "FOLDER", "brain_link", "note_rel", "share_skill"]

#: Where hermes's knowledge lives in the brain. One folder, whatever the
#: project: hermes learned it across projects, and the brain is per person.
FOLDER = "knowledge/hermes"

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slug(text: str) -> str:
    return _SLUG_RE.sub("-", (text or "").lower()).strip("-") or "skill"


def note_rel(skill: str) -> str:
    """The brain-relative path of a hermes skill's note."""
    return f"{FOLDER}/{_slug(skill)}.md"


@dataclass(frozen=True)
class BrainLink:
    """Whether the brain is there to be fed, and whether hermes reads it back."""

    active: bool
    """A brain exists and is switched on: kept skills are filed in it."""
    root: str
    notes: int
    """Hermes notes already in the brain."""
    hermes_connected: bool
    """Hermes has the `workpilot-brain` MCP server in its config — the other
    half of the loop: what the brain holds, hermes can recall."""

    def to_dict(self) -> dict:
        return {
            "active": self.active,
            "root": self.root,
            "notes": self.notes,
            "hermesConnected": self.hermes_connected,
        }


def brain_link() -> BrainLink:
    """Read-only, files only. Never raises."""
    try:
        from brain.connect import SERVER_NAME
        from brain.runtime import active
        from brain.vault import Brain

        brain = Brain()
        if not active(brain.root):
            return BrainLink(False, str(brain.root), 0, False)
        folder = brain.root / FOLDER
        notes = len(list(folder.glob("*.md"))) if folder.is_dir() else 0
        connected = False
        try:
            from brain.agents import agent

            config = agent("hermes").mcp_path()
            if config is not None and config.is_file():
                connected = SERVER_NAME in config.read_text(
                    encoding="utf-8", errors="replace"
                )
        except Exception as exc:  # noqa: BLE001 - an unreadable config is "no"
            logger.debug("could not read hermes's MCP config: %s", exc)
        return BrainLink(True, str(brain.root), notes, connected)
    except Exception as exc:  # noqa: BLE001
        logger.debug("brain link unavailable: %s", exc)
        return BrainLink(False, "", 0, False)


def _body(
    skill: str,
    description: str,
    procedure: str,
    portability: str,
    category: str,
    decided_by: str,
) -> str:
    lines = [
        f"# {skill}",
        "",
        description.strip() or "Procédure apprise par hermes-agent.",
        "",
        "## D'où ça vient",
        "",
        "hermes-agent l'a écrite depuis sa propre expérience, sur une surface que "
        "WorkPilot ne voit pas (Telegram, cron, terminal…). "
        + (
            "Une personne l'a gardée depuis le Kanban."
            if decided_by == "person"
            else "La boucle d'apprentissage l'a gardée après triage."
        ),
        "",
        "C'est une **connaissance**, pas une règle : aucun build ne s'en est encore "
        "servi. Lis-la comme une piste, vérifie-la avant de l'appliquer.",
    ]
    if category:
        lines += ["", f"Catégorie hermes : `{category}`."]
    lines += ["", "## Procédure (telle qu'hermes l'a écrite)", "", procedure.strip()]
    if portability.strip():
        lines += ["", "## Portabilité", "", portability.strip()]
    return "\n".join(lines) + "\n"


def share_skill(
    skill: str,
    *,
    description: str,
    procedure: str,
    portability: str = "",
    category: str = "",
    decided_by: str = "loop",
    task: str | None = None,
    brain=None,
) -> str | None:
    """File one kept hermes skill in the brain. Returns the note's path, or None.

    ``task`` is ``<project>/<spec>`` when a person kept it from a task panel:
    the note is then linked to that task's build note, and the task's brain
    card lists it — the brain remembers *where* the decision was taken.
    """
    try:
        from brain.runtime import active
        from brain.vault import Brain

        brain = brain or Brain()
        if not active(brain.root):
            return None
        tags = ["hermes", "skill"]
        if category:
            tags.append(_slug(category))
        result = brain.write(
            f"Skill hermes : {skill}",
            _body(skill, description, procedure, portability, category, decided_by),
            kind="knowledge",
            tags=tags,
            agent="hermes",
            path=note_rel(skill),
            task=task,
        )
        logger.info("brain: filed hermes skill %s at %s", skill, result.rel)
        return result.rel
    except Exception as exc:  # noqa: BLE001 - feeding the brain never fails the loop
        logger.warning("brain: could not file hermes skill (%s)", type(exc).__name__)
        return None
