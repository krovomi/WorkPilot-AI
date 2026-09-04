"""Requirement identity, open questions, and requirement-to-subtask coverage.

Three questions the pipeline could not answer before this module existed:

* **Which requirement is this one?** `spec.md` numbered its functional
  requirements `1.`, `2.`, `3.` — positions, not names. Insert a requirement in
  the middle and every reference to the ones below it silently points at
  something else, so nothing downstream could reference a requirement at all.
  An `FR-003` survives reordering, which is the whole point of an identifier.

* **What is still unknown?** `spec_writer.md` told the agent to "make
  reasonable assumptions" when the context was thin. It does, and the
  assumption then reads exactly like a decision somebody made: an ambiguity
  resolved by a guess is indistinguishable, in the finished document, from one
  resolved by an answer. A `[NEEDS CLARIFICATION: …]` marker keeps the two
  apart and makes the second kind countable.

* **What will nobody implement?** `implementation_plan.json` holds subtasks
  with verification steps, but nothing tying a subtask back to the requirement
  it exists to satisfy. So "which requirement is covered by no subtask" was
  unanswerable until QA read the finished branch — the most expensive moment to
  learn it.

The parsing is deliberately forgiving. These artifacts are written by a model
following a prompt, not by a serializer, so the reader accepts the shapes a
model actually produces (`**FR-001**: …`, `- FR-001 — …`, `1. **FR-001**`) and
treats anything it cannot parse as absent rather than as an error.

The parsing takes text and a parsed plan, never paths, so the validators, a
workflow phase and a test all use it the same way. The one part that does touch
disk is kept to the bottom of the file and to a single artifact,
`traceability.json`: the record the Kanban, the QA stage and the `analyze` phase
read instead of each re-deriving it from `spec.md` — three parsers of the same
document is how three answers to one question start.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

__all__ = [
    "CLARIFICATION_MARKER",
    "TRACEABILITY_FILENAME",
    "Coverage",
    "OpenQuestion",
    "Requirement",
    "collect",
    "compute_coverage",
    "parse_open_questions",
    "parse_requirements",
    "plan_requirement_refs",
    "write_record",
]

# `FR-001` (functional) and `NFR-001` (non-functional). Digits are not padded
# to a fixed width on purpose: a spec that writes `FR-1` is readable and the
# id still survives reordering, which is the property being bought.
_REQUIREMENT_ID = r"(?:FR|NFR)-\d+"

# A *declaration*: the id opens the line, allowing for a list marker, an
# ordinal and markdown emphasis. A mention of `FR-001` in the middle of a
# sentence elsewhere in the document is a reference, not a second declaration.
_DECLARATION_RE = re.compile(
    rf"^\s{{0,8}}(?:#{{1,6}}\s+|[-*+]\s+|\d+[.)]\s+)?[*_`]{{0,3}}"
    rf"(?P<id>{_REQUIREMENT_ID})\b[*_`]{{0,3}}\s*(?P<title>.*)$",
    re.IGNORECASE,
)

_REFERENCE_RE = re.compile(_REQUIREMENT_ID, re.IGNORECASE)

CLARIFICATION_MARKER = "[NEEDS CLARIFICATION"

# The marker spec-kit uses, kept verbatim so a spec written by either tool
# reads the same. The question is optional: `[NEEDS CLARIFICATION]` on its own
# still counts, because a marker with no question is a real thing an agent
# writes and dropping it would under-report.
_CLARIFICATION_RE = re.compile(
    r"\[NEEDS\s+CLARIFICATION(?:\s*[:-]\s*(?P<question>[^\]]*))?\]",
    re.IGNORECASE,
)

_HEADING_RE = re.compile(r"^(#{1,6})\s+(?P<title>.+?)\s*#*$")

# Leading/trailing markdown noise on a requirement title: separators, emphasis
# and the colon a model puts after the id.
_TITLE_TRIM = re.compile(r"^[\s:\u2014\u2013—–-]+|[\s*_`]+$")


@dataclass(frozen=True)
class Requirement:
    """A requirement declared in `spec.md`, by identifier."""

    id: str
    title: str
    line: int


@dataclass(frozen=True)
class OpenQuestion:
    """An unresolved point the spec writer flagged rather than guessed."""

    question: str
    section: str
    line: int

    def describe(self) -> str:
        where = f" ({self.section})" if self.section else ""
        return f"{self.question or 'unspecified'}{where}"


@dataclass(frozen=True)
class Coverage:
    """Which requirements the plan claims, and which it leaves to nobody.

    ``applicable`` is False when the question cannot be asked — a spec with no
    identifiers, or no plan to compare it against. That is reported as "not
    applicable, because …" rather than as 0%: a legacy spec scoring zero on
    every build would train everyone to ignore the line.
    """

    applicable: bool
    reason: str = ""
    requirements: tuple[Requirement, ...] = ()
    covered: dict[str, tuple[str, ...]] = field(default_factory=dict)
    uncovered: tuple[str, ...] = ()
    unknown_refs: dict[str, tuple[str, ...]] = field(default_factory=dict)

    @property
    def percent(self) -> float:
        """Share of declared requirements claimed by at least one subtask."""
        if not self.requirements:
            return 0.0
        claimed = len(self.requirements) - len(self.uncovered)
        return round(100.0 * claimed / len(self.requirements), 1)

    def summary(self) -> str:
        if not self.applicable:
            return f"coverage not checked: {self.reason}"
        total = len(self.requirements)
        return (
            f"{total - len(self.uncovered)}/{total} requirements "
            f"claimed by a subtask ({self.percent:.0f}%)"
        )


def parse_requirements(spec_text: str) -> list[Requirement]:
    """Requirements declared in ``spec_text``, in document order.

    A repeated id keeps its first declaration: a spec that restates `FR-002`
    under "QA Acceptance Criteria" is referring to the requirement, not
    declaring a second one.
    """
    found: dict[str, Requirement] = {}

    for number, line in enumerate(spec_text.splitlines(), start=1):
        match = _DECLARATION_RE.match(line)
        if not match:
            continue
        req_id = match.group("id").upper()
        if req_id in found:
            continue
        # A marker sitting on the declaration line belongs to the open
        # questions, not to the requirement's name.
        title = _CLARIFICATION_RE.sub("", match.group("title") or "")
        found[req_id] = Requirement(
            id=req_id,
            title=_TITLE_TRIM.sub("", title).strip(),
            line=number,
        )

    return list(found.values())


def parse_open_questions(spec_text: str) -> list[OpenQuestion]:
    """Every `[NEEDS CLARIFICATION: …]` marker, with the section it sits in."""
    questions: list[OpenQuestion] = []
    section = ""

    for number, line in enumerate(spec_text.splitlines(), start=1):
        heading = _HEADING_RE.match(line)
        if heading:
            section = heading.group("title").strip()
            # A heading can carry a marker too ("## Data model [NEEDS
            # CLARIFICATION: …]"), so fall through rather than continue.

        for match in _CLARIFICATION_RE.finditer(line):
            questions.append(
                OpenQuestion(
                    question=(match.group("question") or "").strip(),
                    section=section,
                    line=number,
                )
            )

    return questions


def plan_requirement_refs(plan: dict) -> dict[str, tuple[str, ...]]:
    """Requirement ids each subtask claims, keyed by subtask id.

    A subtask declares them in a ``requirements`` field; a phase may declare
    them once for all of its subtasks. Both are accepted, and a bare string is
    read as a one-element list — a model asked for a list writes one often
    enough, and rejecting it would lose the reference for no gain.
    """
    refs: dict[str, tuple[str, ...]] = {}

    for index, phase in enumerate(plan.get("phases") or []):
        if not isinstance(phase, dict):
            continue
        inherited = _as_ids(phase.get("requirements"))

        for position, subtask in enumerate(phase.get("subtasks") or [], start=1):
            if not isinstance(subtask, dict):
                continue
            subtask_id = str(
                subtask.get("id") or f"phase-{index + 1}-subtask-{position}"
            )
            claimed = _as_ids(subtask.get("requirements")) or inherited
            if claimed:
                refs[subtask_id] = claimed

    return refs


def compute_coverage(spec_text: str, plan: dict | None) -> Coverage:
    """Match the plan's requirement references against the spec's declarations."""
    requirements = parse_requirements(spec_text)

    if not requirements:
        return Coverage(
            applicable=False,
            reason="spec.md declares no FR-### requirement identifiers",
        )
    if not plan:
        return Coverage(
            applicable=False,
            reason="no implementation plan to check against",
            requirements=tuple(requirements),
        )

    refs = plan_requirement_refs(plan)
    if not refs:
        return Coverage(
            applicable=False,
            reason="no subtask references a requirement id",
            requirements=tuple(requirements),
        )

    declared = {req.id for req in requirements}
    covered: dict[str, list[str]] = {}
    unknown: dict[str, list[str]] = {}

    for subtask_id, claimed in refs.items():
        for req_id in claimed:
            target = covered if req_id in declared else unknown
            target.setdefault(req_id, []).append(subtask_id)

    return Coverage(
        applicable=True,
        requirements=tuple(requirements),
        covered={key: tuple(value) for key, value in covered.items()},
        uncovered=tuple(req.id for req in requirements if req.id not in covered),
        unknown_refs={key: tuple(value) for key, value in unknown.items()},
    )


def _as_ids(raw: object) -> tuple[str, ...]:
    """Requirement ids out of whatever the plan put in a ``requirements`` field."""
    if raw is None:
        return ()
    if isinstance(raw, str):
        items: list[str] = [raw]
    elif isinstance(raw, (list, tuple, set)):
        items = [str(item) for item in raw]
    else:
        return ()

    ids: list[str] = []
    for item in items:
        for match in _REFERENCE_RE.finditer(item):
            found = match.group(0).upper()
            if found not in ids:
                ids.append(found)
    return tuple(ids)


# ---------------------------------------------------------------------------
# Reading a spec directory
# ---------------------------------------------------------------------------

TRACEABILITY_FILENAME = "traceability.json"


def collect(spec_dir: Path) -> dict:
    """The traceability record for a spec directory.

    Always returns a record. A missing `spec.md`, an unreadable plan or invalid
    JSON produce a record saying coverage was not checked and why — the callers
    are a build step, an API endpoint and a review phase, none of which should
    have to distinguish "no answer" from "the file was not there".
    """
    spec_text = _read_text(spec_dir / "spec.md")
    plan = _read_json(spec_dir / "implementation_plan.json")

    coverage = compute_coverage(spec_text, plan)
    questions = parse_open_questions(spec_text)

    return {
        "spec": spec_dir.name,
        "requirements": [
            {"id": req.id, "title": req.title, "line": req.line}
            for req in (coverage.requirements or parse_requirements(spec_text))
        ],
        "open_questions": [
            {"question": q.question, "section": q.section, "line": q.line}
            for q in questions
        ],
        "coverage": {
            "applicable": coverage.applicable,
            "reason": coverage.reason,
            "percent": coverage.percent if coverage.applicable else None,
            "covered": {key: list(value) for key, value in coverage.covered.items()},
            "uncovered": list(coverage.uncovered),
            "unknown_refs": {
                key: list(value) for key, value in coverage.unknown_refs.items()
            },
            "summary": coverage.summary(),
        },
    }


def write_record(spec_dir: Path) -> dict:
    """Write `traceability.json` into ``spec_dir`` and return what was written.

    Best-effort on the write: a spec directory that cannot be written to is a
    real problem, but not one this record should be the messenger for — the
    caller still gets the record and the build still runs.
    """
    record = collect(spec_dir)
    try:
        (spec_dir / TRACEABILITY_FILENAME).write_text(
            json.dumps(record, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    except OSError:
        pass
    return record


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def _read_json(path: Path) -> dict | None:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return loaded if isinstance(loaded, dict) else None
