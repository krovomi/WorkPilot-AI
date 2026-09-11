"""The autonomous learning cycle, and the surfaces that may open it.

What "autonomous" means here, and what it deliberately does not
--------------------------------------------------------------
Hermes closes its own loop: it authors skills from its own experience and, with
``skills.auto_approve`` on, activates them without anyone reading a diff. That
loop runs on surfaces WorkPilot never sees — a Telegram thread, a cron job on a
VPS, a terminal on someone's laptop — and what it learns there is real
experience this repository's pipeline could never have gathered.

What it does not carry is **evidence**. Hermes's approval gate is a person
saying yes to a text; it is not an observation of a build that used the skill.
So this cycle is autonomous in the half that should be — nobody has to remember
to run it, and every feature that finishes a unit of work can open it — and
emphatically not autonomous in the half that must not be: a candidate lands in
``skills/_proposed/`` and is promoted by nothing. `skill_proposer.evaluate`
refuses to invent corroboration, and counting hermes's own approval as
corroboration is precisely inventing it.

Why a cycle rather than a call
------------------------------
`learning_loop/observe.py` called the ingest directly, which was right when the
end of a build was the only moment it could happen. It is not the only moment:
the Kanban wants the answer while a person is looking at a card, the CLI wants
it on demand, and the next feature to want it should not have to rediscover
that the readiness question exists. So the three steps that always go together
— *can this run here*, *what did hermes author*, *who asked* — are one function,
and a surface is a name rather than a code path.

The surface is recorded on the candidate. A reviewer reading
``skills/_proposed/`` six weeks later can then answer "what was happening when
this was proposed", which is the difference between a queue and a pile.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from .readiness import HermesReport, doctor

logger = logging.getLogger(__name__)

__all__ = ["SURFACES", "CycleReport", "run_cycle", "normalise_surface"]

# The features that may open the loop. A closed set on purpose: the surface is
# written into a file a person reviews, so it has to mean something to them,
# and a free-text field would fill with whatever string each caller happened to
# pass. Adding one is a line here plus the caller.
SURFACES: dict[str, str] = {
    "build": "the observe phase at the end of an autonomous build",
    "kanban": "the task panel, opened by a person",
    "cli": "skills_cli / the hermes runner, typed by a person",
    "self-healing": "an incident response cycle",
    "github": "a pull request or issue workflow",
}

_DEFAULT_SURFACE = "build"


def normalise_surface(surface: str | None) -> str:
    """A known surface name, or the default. Never raises on caller input."""
    text = (surface or "").strip().lower()
    return text if text in SURFACES else _DEFAULT_SURFACE


@dataclass
class CycleReport:
    """One turn of the loop: whether it could run, and what it filed."""

    surface: str
    readiness: HermesReport
    ingest: object | None = None
    """A `learning_loop.hermes_ingest.HermesIngestReport`, when one ran."""

    @property
    def ran(self) -> bool:
        return self.ingest is not None

    @property
    def proposed(self) -> int:
        written = getattr(self.ingest, "written", None)
        return len(written) if written else 0

    def to_dict(self) -> dict:
        ingest = self.ingest
        return {
            "surface": self.surface,
            "surfaceDescription": SURFACES[self.surface],
            "readiness": self.readiness.to_dict(),
            "ran": self.ran,
            "proposed": self.proposed,
            "ingest": {
                "found": getattr(ingest, "found", 0),
                "proposed": self.proposed,
                # Only the file names: the review queue lives in this
                # repository, and a name is what a reviewer needs to open it.
                "files": [Path(p).name for p in getattr(ingest, "written", [])],
                "unchanged": getattr(ingest, "unchanged", 0),
                "deferred": getattr(ingest, "deferred", 0),
                "reason": getattr(ingest, "reason", ""),
            }
            if ingest is not None
            else None,
        }

    def describe(self) -> str:
        if not self.ran:
            return self.readiness.describe()
        summary = getattr(self.ingest, "describe", lambda: "")()
        head = self.readiness.describe() if self.readiness.degraded else ""
        return "\n".join(p for p in (head, summary) if p)


def run_cycle(
    repo_root: Path,
    *,
    surface: str = _DEFAULT_SURFACE,
    home: Path | None = None,
    write: bool = True,
) -> CycleReport:
    """Check, ingest, report. Never raises — observation never fails a caller.

    A missing hermes is not a failure and not a warning: it is the answer
    "this feature is not in use on this machine", and every caller renders it
    the same way because it is the same object.
    """
    name = normalise_surface(surface)
    project_root = Path(repo_root)
    report = doctor(project_root, home=home)
    if not report.installed:
        return CycleReport(surface=name, readiness=report)

    try:
        from learning_loop.hermes_ingest import ingest_hermes_skills

        ingest = ingest_hermes_skills(
            project_root, home=home, write=write, surface=name
        )
    except Exception as exc:  # noqa: BLE001 - a broken ingest is not a broken build
        logger.warning("hermes cycle skipped: %s", exc)
        return CycleReport(surface=name, readiness=report)
    return CycleReport(surface=name, readiness=report, ingest=ingest)
