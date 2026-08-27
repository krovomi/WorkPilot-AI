"""Hermes as a proposer; WorkPilot's gates as the authority.

hermes-agent has its own learning loop, and it is a real one: it writes skills
from experience into ``~/.hermes/skills/``, optionally staging them in
``~/.hermes/pending/skills/`` for approval. WorkPilot has one too, with four
gates and a rule that a promotion is a diff a person merges.

Two closed loops writing skills is one loop too many, and the failure mode is
not hypothetical — it is the same one the whole learning-loop design exists to
avoid, with the extra twist that neither loop can see the other's evidence. So
this module does not run a second loop. It does one thing:

    a skill hermes authored becomes a **candidate** under ``skills/_proposed/``.

Why that is worth doing rather than ignoring
--------------------------------------------
Hermes observes sessions WorkPilot never sees. It runs on Telegram, Discord,
Slack and a cron scheduler, on a VPS the laptop is not attached to. Whatever it
learned there is real experience from outside this repo's build pipeline — and
experience is exactly the thing procedural memory is short of.

What it is short of, in turn, is the corroboration WorkPilot has: green tests,
a QA verdict, a clean deterministic detector, a merged PR. Composing the two is
the point. Hermes proposes from breadth, WorkPilot decides from evidence, and a
person reads one diff in one place.

Why it never promotes
---------------------
A candidate written here carries **no external signal**. That is not an
oversight to fix later: hermes's approval gate is a person saying yes inside
hermes, which is an opinion about the skill, not an observation of a build that
used it. Recording it as corroboration would manufacture exactly the evidence
`skill_proposer.evaluate` refuses to invent. So these land in the same review
queue as everything else and go no further on their own.

Nothing under ``skills/<pack>/`` is ever touched. Nothing under ``~/.hermes``
is ever written.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = [
    "HermesIngestReport",
    "HermesCandidate",
    "hermes_home",
    "discover_authored_skills",
    "ingest_hermes_skills",
    "MAX_CANDIDATES_PER_RUN",
]

# A first run against a well-used hermes install could otherwise open several
# hundred candidates at once, which is not a review queue, it is a denial of
# one. The remainder is reported and picked up next time.
MAX_CANDIDATES_PER_RUN = 25

_PREFIX = "hermes"
_SLUG_RE = re.compile(r"[^a-z0-9]+")

# Directories under ~/.hermes/skills that are not skills: hub metadata, the
# bundled-origin manifest, the opt-out marker.
_NOT_SKILLS = ("__pycache__",)


def _slug(text: str) -> str:
    return _SLUG_RE.sub("-", text.lower()).strip("-")


def hermes_home() -> Path:
    """Where hermes keeps its state, following its own resolution order.

    ``HERMES_HOME``, else the platform default — ``%LOCALAPPDATA%\\hermes`` on
    Windows, ``~/.hermes`` elsewhere. Mirrored from hermes_constants.py rather
    than guessed, so a user who moved their home is still found.
    """
    override = os.environ.get("HERMES_HOME", "").strip()
    if override:
        return Path(override).expanduser()
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA", "").strip()
        base = Path(local) if local else Path.home() / "AppData" / "Local"
        return base / "hermes"
    return Path.home() / ".hermes"


def _bundled_names(skills_root: Path) -> set[str]:
    """Skill names hermes shipped, which it did not learn.

    ``.bundled_manifest`` records the skills copied out of the hermes
    repository at install time. Those are upstream content, not experience, and
    proposing them here would fill the queue with a copy of a pack that is
    already vendorable through `skills/hermes/`.
    """
    manifest = skills_root / ".bundled_manifest"
    names: set[str] = set()
    try:
        if not manifest.is_file():
            return names
        import json

        raw = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.debug("could not read the hermes bundled manifest: %s", exc)
        return names

    def _harvest(value) -> None:
        if isinstance(value, dict):
            for key, sub in value.items():
                names.add(Path(str(key)).name)
                _harvest(sub)
        elif isinstance(value, list):
            for item in value:
                _harvest(item)
        elif isinstance(value, str):
            names.add(Path(value).name)

    _harvest(raw)
    return {n for n in names if n and not n.endswith((".md", ".json"))}


@dataclass(frozen=True)
class HermesCandidate:
    """One hermes-authored skill, as read from disk."""

    name: str
    path: Path
    body: str
    description: str
    staged: bool
    """True when it was still awaiting approval inside hermes."""
    category: str = ""

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.body.encode("utf-8")).hexdigest()[:16]

    def filename(self) -> str:
        return f"{_PREFIX}--{_slug(self.name)}.md"


@dataclass
class HermesIngestReport:
    found: int = 0
    written: list[Path] = field(default_factory=list)
    unchanged: int = 0
    deferred: int = 0
    """Candidates left for the next run because of the per-run cap."""
    reason: str = ""
    """Why nothing happened, when nothing happened."""

    def describe(self) -> str:
        if self.reason:
            return f"hermes: {self.reason}"
        if not self.found:
            return ""
        parts = [f"hermes: {self.found} authored skill(s) seen"]
        for path in self.written:
            parts.append(f"  proposed  skills/_proposed/{path.name}")
        if self.unchanged:
            parts.append(f"  unchanged {self.unchanged} already pending review")
        if self.deferred:
            parts.append(f"  deferred  {self.deferred} until the next run")
        return "\n".join(parts)


def discover_authored_skills(home: Path | None = None) -> list[HermesCandidate]:
    """Skills hermes wrote, from its live directory and its approval queue.

    Bundled skills and hub metadata are excluded: this is looking for what the
    agent learned, not for what it was installed with.
    """
    root = home or hermes_home()
    skills_root = root / "skills"
    bundled = _bundled_names(skills_root)

    found: list[HermesCandidate] = []
    for base, staged in ((skills_root, False), (root / "pending" / "skills", True)):
        if not base.is_dir():
            continue
        for skill_file in sorted(base.rglob("SKILL.md")):
            try:
                rel = skill_file.relative_to(base)
            except ValueError:  # pragma: no cover - rglob keeps them relative
                continue
            if any(part.startswith(".") for part in rel.parts):
                continue
            if any(part in _NOT_SKILLS for part in rel.parts):
                continue
            name = skill_file.parent.name
            if name in bundled:
                continue
            candidate = _read(skill_file, name, staged)
            if candidate is not None:
                found.append(candidate)
    return found


def _read(path: Path, name: str, staged: bool) -> HermesCandidate | None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        logger.debug("could not read %s: %s", path, exc)
        return None
    try:
        from skills_registry.frontmatter import parse_frontmatter

        meta, body = parse_frontmatter(text)
    except Exception as exc:  # noqa: BLE001 - a malformed skill is skipped, not fatal
        logger.debug("could not parse %s: %s", path, exc)
        return None
    if not body.strip():
        return None
    category = ""
    hermes_meta = (meta.get("metadata") or {}).get("hermes") or {}
    if isinstance(hermes_meta, dict):
        category = str(hermes_meta.get("category") or "")
    return HermesCandidate(
        name=str(meta.get("name") or name),
        path=path,
        body=body.strip(),
        description=str(meta.get("description") or "").strip(),
        staged=staged,
        category=category,
    )


def _existing_digest(path: Path) -> str | None:
    """The hermes digest recorded in a candidate already in the queue."""
    try:
        head = path.read_text(encoding="utf-8", errors="replace")[:2000]
    except OSError:
        return None
    match = re.search(r"^\s*digest:\s*(\S+)\s*$", head, re.M)
    return match.group(1) if match else None


def _render(candidate: HermesCandidate) -> str:
    origin = "pending approval in hermes" if candidate.staged else "active in hermes"
    return f"""---
name: {_slug(candidate.name)}
description: {candidate.description or candidate.name}
metadata:
  workpilot:
    proposal:
      origin: hermes-agent
      skill: {candidate.name}
      category: {candidate.category or "uncategorised"}
      state: {origin}
      digest: {candidate.digest}
---

<!--
  Proposed from a skill hermes-agent authored from its own experience.

  Nothing here is active: a file under skills/_proposed/ is not a pack, so the
  resolver ignores it and no harness sees it. To adopt it, fold it into a real
  skill under skills/<pack>/ and delete this file. To reject it, delete this
  file.

  It carries NO external verification signal, and that is deliberate. Hermes's
  own approval gate is a person saying yes to the text; it is not an
  observation of a build that used it. Counting it as corroboration would
  manufacture exactly the evidence the promotion rules refuse to invent.
-->

## Proposed skill

{candidate.body}

## Provenance

Read from `{candidate.path}` ({origin}). WorkPilot never writes into the
hermes home, and this file is the only thing it writes here.
"""


def ingest_hermes_skills(
    repo_root: Path,
    *,
    home: Path | None = None,
    write: bool = True,
    limit: int = MAX_CANDIDATES_PER_RUN,
) -> HermesIngestReport:
    """File hermes-authored skills as candidates. Never raises.

    Returns what happened. A candidate already in the queue with the same
    content is left alone — re-proposing the same thing on every build turns
    the review queue into noise, which is the failure mode the rest of the
    learning loop already guards against.
    """
    report = HermesIngestReport()
    try:
        root = home or hermes_home()
        if not root.is_dir():
            report.reason = "not installed here (no hermes home)"
            return report

        candidates = discover_authored_skills(root)
        report.found = len(candidates)
        if not candidates:
            report.reason = "no authored skills to propose"
            return report

        from .skill_proposer import proposal_dir

        target_dir = proposal_dir(repo_root)
        if write:
            target_dir.mkdir(parents=True, exist_ok=True)

        for candidate in candidates:
            path = target_dir / candidate.filename()
            if path.exists() and _existing_digest(path) == candidate.digest:
                report.unchanged += 1
                continue
            if len(report.written) >= limit:
                report.deferred += 1
                continue
            if write:
                path.write_text(_render(candidate), encoding="utf-8")
            report.written.append(path)
    except Exception as exc:  # noqa: BLE001 - observation never fails a build
        logger.warning("hermes ingest skipped: %s", exc)
        report.reason = f"skipped: {exc}"
    return report
