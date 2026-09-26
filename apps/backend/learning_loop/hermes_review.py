"""The hermes review queue, as a person reads it and answers it.

`hermes_ingest.queue_state` answers "what is left to read" with file names, and
the task panel used to print exactly that: thirty-four paths under
``skills/_proposed/`` and no way to act on any of them. A queue whose only exit
is opening an editor, reading a file, and deleting it by hand is a queue that
turns into a list nobody reads — which is what a person reported, word for word:
*« je ne sais pas ce que je dois faire de tout ce texte »*.

This module gives each candidate what a decision needs — what it is for, which
hermes category it came from, whether hermes still has it pending approval, and
the first lines of the procedure — and two answers:

``adopt``    the same `hermes_adopt.adopt` the loop runs after triage, so a skill
             kept by hand and one kept by the loop are the same file in the
             same pack. It is then filed in the shared brain
             (`hermes.brain_link`), linked to the task the person was looking
             at, so every agent can recall it.
``decline``  a ledger entry (`hermes_adopt.decline`) and the candidate file
             removed. The name is never proposed or adopted again, and the
             loop stops mirroring it into the queue.

What does not change: adopting is not activating. The pack is still absent from
``.workpilot/skills.toml``, so no harness loads an adopted skill until a person
lists the pack; and the brain note is knowledge, not an instruction.

Only file names the queue itself produced are accepted — ``hermes--<slug>.md``,
inside ``skills/_proposed/``, written by the ingest (`recorded_facts`). A name
from the request is never joined to a path before it has matched that pattern,
and a proposal from the learning loop's own gates is never ours to decide here.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from .hermes_ingest import (
    HermesCandidate,
    _portability_section,
    hermes_tools_used,
    queue_state,
    recorded_facts,
)

logger = logging.getLogger(__name__)

__all__ = [
    "DECISIONS",
    "ReviewOutcome",
    "candidate_details",
    "decide",
]

DECISIONS = ("adopt", "decline")

_FILE_RE = re.compile(r"^hermes--[a-z0-9][a-z0-9-]{0,120}\.md$")
_EXCERPT_LINES = 14
_EXCERPT_CHARS = 1400


def _field(head: str, key: str) -> str:
    match = re.search(rf"^\s*{key}:\s*(.+?)\s*$", head, re.M)
    return match.group(1).strip().strip('"') if match else ""


def _procedure(text: str) -> str:
    """The body hermes wrote, as the ingest rendered it between its two headings."""
    start = text.find("## Proposed skill")
    if start < 0:
        return ""
    start = text.find("\n", start) + 1
    end = text.rfind("\n## Portability")
    body = text[start:end] if end > start else text[start:]
    return body.strip()


def _excerpt(body: str) -> str:
    lines = [line.rstrip() for line in body.splitlines()]
    text = "\n".join(lines[:_EXCERPT_LINES]).strip()
    if len(text) > _EXCERPT_CHARS:
        text = text[: _EXCERPT_CHARS - 1].rstrip() + "…"
    elif len(lines) > _EXCERPT_LINES:
        text += "\n…"
    return text


def _candidate_from_file(path: Path) -> HermesCandidate | None:
    """Rebuild the candidate the ingest filed, from the file alone.

    The hermes home it came from may be gone — renamed, approved elsewhere, on
    another machine — and the file carries what adopting it requires.
    """
    facts = recorded_facts(path)
    if facts is None:
        return None
    name, category, catalogue = facts
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    body = _procedure(text)
    if not body:
        return None
    head = text[:2000]
    source = re.search(r"Read from `([^`]+)`", text)
    return HermesCandidate(
        name=name,
        path=Path(source.group(1)) if source else path,
        body=body,
        description=_field(head, "description"),
        staged=_field(head, "state") == "pending approval in hermes",
        category=category,
        catalogue=catalogue,
    )


def candidate_details(repo_root: Path) -> list[dict]:
    """Every candidate still waiting for a person, with what deciding needs.

    Same order and same membership as `queue_state` — it is the reader — so the
    list the panel shows and the count it announces cannot disagree.
    """
    from .skill_proposer import proposal_dir

    pending, _ = queue_state(repo_root)
    folder = proposal_dir(repo_root)
    out: list[dict] = []
    for filename in pending:
        path = folder / filename
        candidate = _candidate_from_file(path)
        if candidate is None:
            continue
        head = path.read_text(encoding="utf-8", errors="replace")[:2000]
        out.append(
            {
                "file": filename,
                "name": candidate.name,
                "description": candidate.description,
                "category": candidate.category,
                "pendingInHermes": candidate.staged,
                "surface": _field(head, "surface") or "build",
                "tools": hermes_tools_used(candidate.body),
                "excerpt": _excerpt(candidate.body),
                "lines": len(candidate.body.splitlines()),
            }
        )
    return out


@dataclass
class ReviewOutcome:
    adopted: list[str] = field(default_factory=list)
    declined: list[str] = field(default_factory=list)
    skipped: list[dict] = field(default_factory=list)
    brain_notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "adopted": self.adopted,
            "declined": self.declined,
            "skipped": self.skipped,
            "brainNotes": self.brain_notes,
        }


def decide(
    repo_root: Path,
    files: list[str],
    decision: str,
    *,
    surface: str = "kanban",
    task: str | None = None,
) -> ReviewOutcome:
    """Apply one person's answer to one or several candidates. Never raises.

    Each file is judged on its own: an unknown name, a file the ingest did not
    write, or an adoption that could not be written is reported in ``skipped``
    with a reason, and the others go through.
    """
    from .hermes_adopt import adopt, decline
    from .skill_proposer import proposal_dir

    outcome = ReviewOutcome()
    if decision not in DECISIONS:
        outcome.skipped = [{"file": f, "reason": "unknown-decision"} for f in files]
        return outcome

    folder = proposal_dir(repo_root)
    for filename in dict.fromkeys(files):
        if not isinstance(filename, str) or not _FILE_RE.match(filename):
            outcome.skipped.append({"file": str(filename), "reason": "invalid-name"})
            continue
        path = folder / filename
        if not path.is_file():
            outcome.skipped.append({"file": filename, "reason": "not-found"})
            continue
        candidate = _candidate_from_file(path)
        if candidate is None:
            outcome.skipped.append(
                {"file": filename, "reason": "not-a-hermes-candidate"}
            )
            continue

        if decision == "decline":
            if not decline(repo_root, candidate, surface=surface):
                outcome.skipped.append({"file": filename, "reason": "write-failed"})
                continue
            path.unlink(missing_ok=True)
            outcome.declined.append(candidate.name)
            continue

        portability = _portability_section(candidate.body)
        adoption = adopt(repo_root, candidate, portability=portability, surface=surface)
        if adoption is None:
            outcome.skipped.append({"file": filename, "reason": "write-failed"})
            continue
        if not adoption.written and not adoption.path.is_file():
            # The ledger already carries the name and its file is gone: a
            # person deleted an earlier adoption, which is how they said no.
            # Keeping it now would need that deletion undone, by them.
            outcome.skipped.append({"file": filename, "reason": "already-decided"})
            continue
        # `written=False` means an adoption was already there — kept by the
        # loop earlier, or rewritten by a person since. Either way the answer
        # to "is this kept?" is yes, and the queue stops asking.
        outcome.adopted.append(candidate.name)
        from hermes.brain_link import share_skill

        note = share_skill(
            candidate.name,
            description=candidate.description,
            procedure=candidate.body,
            portability=portability,
            category=candidate.category,
            decided_by="person",
            task=task,
        )
        if note:
            outcome.brain_notes.append(note)
    return outcome
