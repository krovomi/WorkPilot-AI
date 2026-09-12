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
import re
from dataclasses import dataclass, field
from pathlib import Path

from hermes.home import hermes_home

logger = logging.getLogger(__name__)

__all__ = [
    "HermesIngestReport",
    "HermesCandidate",
    "hermes_home",
    "discover_authored_skills",
    "ingest_hermes_skills",
    "MAX_CANDIDATES_PER_RUN",
    "DEFAULT_SURFACE",
    "hermes_tools_used",
]

# A first run against a well-used hermes install could otherwise open several
# hundred candidates at once, which is not a review queue, it is a denial of
# one. The remainder is reported and picked up next time.
MAX_CANDIDATES_PER_RUN = 25

# Which feature opened the cycle. Recorded on the candidate so a reviewer
# reading the queue weeks later can tell a build's observation from a person
# pressing a button in the Kanban. `hermes.loop.SURFACES` owns the vocabulary;
# this is only the fallback for a caller that names none.
#
# It names the surface that *first* proposed the candidate, not the last one to
# look: a candidate whose content has not changed is left alone, so a second
# cycle from another surface rewrites nothing. That is the same rule that keeps
# the queue from filling with one copy per build.
DEFAULT_SURFACE = "build"

_PREFIX = "hermes"
_SLUG_RE = re.compile(r"[^a-z0-9]+")

# Directories under ~/.hermes/skills that are not skills: hub metadata, the
# bundled-origin manifest, the opt-out marker.
_NOT_SKILLS = ("__pycache__",)


# Hermes's own tool vocabulary, mapped onto the canonical one this repository
# writes skills in (Claude Code's, because that is what the subagent registry
# uses — see capabilities/harnesses.yaml).
#
# A skill hermes authored is written in the left column: its authoring standard
# tells the agent to say `read_file` and not cat, `search_files` and not grep,
# `patch` and not sed. That is correct *for hermes* and wrong everywhere else —
# a candidate adopted verbatim into `skills/<pack>/` is emitted to Claude Code,
# Copilot, Codex and Cursor naming tools none of them have.
#
# The ingest does not rewrite the body. Translating prose by find-and-replace
# produces a skill that reads like it was written for a tool it never mentions,
# and the surrounding sentence ("invoke through the `terminal` tool") stops
# making sense. What it does instead is *say so*, in the candidate, next to the
# names it found — so adopting one is a conscious rewrite rather than a silent
# breakage discovered by whoever runs the skill first.
_HERMES_TOOLS: dict[str, str] = {
    "terminal": "Bash",
    "read_file": "Read",
    "write_file": "Write",
    "search_files": "Grep / Glob",
    "patch": "Edit",
    "web_extract": "WebFetch",
    "web_search": "WebSearch",
    "execute_code": "Bash",
    "delegate_task": "Task (a subagent)",
    "skill_view": "Read, against .agents/skills/",
    "browser_navigate": "the Chrome DevTools MCP server",
    "vision_analyze": "Read, on an image path",
    "memory": "the mem-search skill",
    "cronjob": "no equivalent — WorkPilot schedules from the Kanban",
    "image_generate": "no equivalent",
    "text_to_speech": "no equivalent",
}

# Matched in backticks only. Hermes's authoring standard requires that form,
# and the bare words are ordinary English — a skill about patching a library or
# reading a file would otherwise be reported as using half the vocabulary.
_TOOL_RE = re.compile(
    r"`(" + "|".join(sorted(_HERMES_TOOLS, key=len, reverse=True)) + r")`"
)


def hermes_tools_used(body: str) -> list[str]:
    """Hermes tool names the candidate names, in the order they are listed above."""
    found = {m.group(1) for m in _TOOL_RE.finditer(body)}
    return [name for name in _HERMES_TOOLS if name in found]


def _portability_section(body: str) -> str:
    """What a reviewer has to change before this can live in `skills/<pack>/`."""
    used = hermes_tools_used(body)
    if not used:
        return (
            "This candidate names no hermes-specific tool, so it is portable as "
            "written: the packs in `skills/` are emitted to every harness, and "
            "nothing here is addressed to one of them.\n"
        )
    rows = "\n".join(f"| `{name}` | {_HERMES_TOOLS[name]} |" for name in used)
    return (
        "This candidate is written in **hermes's tool vocabulary**, which no "
        "other harness has. `skills/<pack>/` is emitted to Claude Code, Copilot, "
        "Codex, Cursor and Gemini alike, so adopting it means rewriting these "
        "references first — the body is left exactly as hermes wrote it, because "
        "a find-and-replace would leave the surrounding sentences describing a "
        "tool they no longer name.\n\n"
        "| hermes | here |\n|---|---|\n" + rows + "\n"
    )


def _slug(text: str) -> str:
    return _SLUG_RE.sub("-", text.lower()).strip("-")


# Re-exported, not redefined. `hermes.home` is the one resolution of
# ``HERMES_HOME``; this module had its own copy back when it was the only
# reader, and two copies is two answers for a user who moved their home.


def _manifest_names(skills_root: Path) -> set[str]:
    """Skill names hermes shipped, from ``.bundled_manifest``.

    The file is ``name:hash`` per line — hermes's own
    ``tools/skill_usage._read_bundled_manifest_names`` is the reference. It was
    read as JSON here at first, so every line raised, the exception was
    swallowed, and the exclusion silently matched nothing: one build proposed
    sixty upstream skills, home automation and iMessage included.

    That bug is fixed below, but the deeper lesson is in `_authored_names`: an
    exclusion list is a denylist against a catalogue upstream keeps growing,
    and it fails open. This is now the second belt, not the rule.
    """
    names: set[str] = set()
    manifest = skills_root / ".bundled_manifest"
    try:
        if not manifest.is_file():
            return names
        for line in manifest.read_text(encoding="utf-8", errors="replace").splitlines():
            name = line.split(":", 1)[0].strip()
            if name:
                names.add(name)
    except OSError as exc:
        logger.debug("could not read the hermes bundled manifest: %s", exc)
    return names


def _hub_names(skills_root: Path) -> set[str]:
    """Skill names installed from the hermes hub — downloaded, not learned."""
    names: set[str] = set()
    lock = skills_root / ".hub" / "lock.json"
    try:
        if not lock.is_file():
            return names
        import json

        data = json.loads(lock.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError) as exc:
        logger.debug("could not read the hermes hub lock: %s", exc)
        return names
    installed = data.get("installed") if isinstance(data, dict) else None
    if isinstance(installed, dict):
        names.update(str(k) for k in installed)
    return names


def _authored_names(skills_root: Path) -> set[str]:
    """Skill names hermes records as **its own**, from ``.usage.json``.

    This is the rule, and the previous denylist was the mistake. `skill_manage`
    writes ``created_by: agent`` (older records: ``agent_created: true``) when
    the agent authors a skill, and writes nothing of the sort for a skill that
    was shipped or downloaded. So the question "what did hermes learn?" has a
    positive answer on disk, and asking it directly is bounded by what hermes
    actually wrote — where "everything except the list I know about" is bounded
    by nothing and fails open on every upstream release.

    Hermes's own docstring is careful that ``created_by`` is a curation opt-in
    rather than a proof of authorship, and `curator adopt` can set it on a
    skill a person wrote. That is the right error to make here: a skill someone
    adopted into curation is at worst an odd proposal a reviewer deletes, while
    the failure in the other direction is the sixty-file flood.
    """
    names: set[str] = set()
    usage = skills_root / ".usage.json"
    try:
        if not usage.is_file():
            return names
        import json

        data = json.loads(usage.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError) as exc:
        logger.debug("could not read the hermes usage records: %s", exc)
        return names
    if not isinstance(data, dict):
        return names
    for name, record in data.items():
        if not isinstance(record, dict):
            continue
        if record.get("created_by") == "agent" or record.get("agent_created") is True:
            names.add(str(name))
    return names


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

    Two sources, and they are admitted on different grounds:

    * ``skills/`` holds everything hermes has — shipped, downloaded and
      authored, side by side. Only what ``.usage.json`` marks as the agent's
      own is taken (`_authored_names`), and the shipped and hub lists are
      subtracted on top, so a record that says "agent" about a skill the
      manifest also lists is treated as shipped. Nothing is proposed from here
      on a machine whose hermes recorded no authorship — proposing nothing is
      a recoverable disappointment, and the alternative was sixty files.
    * ``pending/skills/`` is hermes's approval queue: a skill is in it only
      because the agent just wrote it and is waiting to be told yes. There is
      nothing to filter, and filtering it on ``.usage.json`` would drop exactly
      the newest candidates, whose record is written on approval.
    """
    root = home or hermes_home()
    skills_root = root / "skills"
    authored = _authored_names(skills_root)
    not_learned = _manifest_names(skills_root) | _hub_names(skills_root)

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
            if not staged and (name not in authored or name in not_learned):
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


def _render(candidate: HermesCandidate, surface: str = DEFAULT_SURFACE) -> str:
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
      surface: {surface}
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

## Portability

{_portability_section(candidate.body)}
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
    surface: str = DEFAULT_SURFACE,
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
                path.write_text(_render(candidate, surface), encoding="utf-8")
            report.written.append(path)
    except Exception as exc:  # noqa: BLE001 - observation never fails a build
        logger.warning("hermes ingest skipped: %s", exc)
        report.reason = f"skipped: {exc}"
    return report
