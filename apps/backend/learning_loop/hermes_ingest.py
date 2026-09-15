"""Hermes as a proposer; WorkPilot's gates as the authority.

hermes-agent has its own learning loop, and it is a real one: it writes skills
from experience into ``~/.hermes/skills/``, optionally staging them in
``~/.hermes/pending/skills/`` for approval. WorkPilot has one too, with four
gates and a rule that a promotion is a diff a person merges.

Two closed loops writing skills is one loop too many, and the failure mode is
not hypothetical — it is the same one the whole learning-loop design exists to
avoid, with the extra twist that neither loop can see the other's evidence. So
this module does not run a second loop. It does one thing:

    a skill hermes authored **and this repository has a use for** becomes a
    candidate under ``skills/_proposed/``.

The second half of that sentence is `hermes_triage`, and it is what makes the
loop autonomous rather than a source of chores. Hermes ships a catalogue of
hundreds — Airtable, iMessage, Apple Notes, songwriting — and every rule that
told those apart from experience read a file upstream owns, so every one of
them has failed open at least once. Triage asks the same question of files
*this* repository owns instead: the categories ``skills/hermes/pack.json``
tracks, the names it excluded on purpose, the skills the packs already provide.
A candidate turned away there is not filed, and one already in the queue that a
fresh reading turns away is withdrawn — because sixty files filed under an old
rule are one bug, not sixty decisions somebody took.

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

from .hermes_triage import (
    DROP_REASONS,
    RepoScope,
    is_catalogue_frontmatter,
    read_scope,
    verdict_for,
)

logger = logging.getLogger(__name__)

__all__ = [
    "HermesIngestReport",
    "HermesCandidate",
    "hermes_home",
    "discover_authored_skills",
    "ingest_hermes_skills",
    "prune_queue",
    "queue_state",
    "recorded_facts",
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
    """The directory hermes keeps it under — its own catalogue's category name.

    Read from the path rather than the frontmatter, because upstream's skills
    do not declare one: ``~/.hermes/skills/<maybe-category>/<name>/SKILL.md`` is
    hermes's own layout, and the segment above the skill is the category it was
    shipped in. Empty for a skill sitting flat in the home, which is what
    ``skill_manage(action='create')`` writes.
    """
    catalogue: bool = False
    """True when the frontmatter is hermes's shipped-contribution shape."""

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
    dropped: dict[str, int] = field(default_factory=dict)
    """How many candidates triage turned away, by reason. See `DROP_REASONS`."""
    pruned: list[Path] = field(default_factory=list)
    """Candidates already in the queue that this run withdrew, for the same reasons."""
    adopted: list[Path] = field(default_factory=list)
    """Candidates written straight into `skills/hermes-learned/` (`hermes_adopt`)."""
    already_adopted: int = 0
    """Names the adoption ledger had already settled — adopted once, or deleted
    since, which is how a person says no. Counted apart from `unchanged`
    because "still waiting to be read" and "already answered" are different
    news, and reporting the second as the first is how a loop looks stuck."""
    reason: str = ""
    """Why nothing happened, when nothing happened."""

    @property
    def dropped_total(self) -> int:
        return sum(self.dropped.values())

    def describe(self) -> str:
        lines = self._triage_lines()
        if self.reason:
            lines.insert(0, f"hermes: {self.reason}")
            return "\n".join(lines)
        if not self.found:
            return "\n".join(lines)
        parts = [f"hermes: {self.found} authored skill(s) seen"]
        for path in self.adopted:
            parts.append(
                f"  adopted   skills/{path.parent.parent.name}/{path.parent.name}/"
            )
        for path in self.written:
            parts.append(f"  proposed  skills/_proposed/{path.name}")
        if self.unchanged:
            parts.append(f"  unchanged {self.unchanged} already pending review")
        if self.already_adopted:
            parts.append(
                f"  settled   {self.already_adopted} already adopted or declined here"
            )
        if self.deferred:
            parts.append(f"  deferred  {self.deferred} until the next run")
        return "\n".join(parts + lines)

    def _triage_lines(self) -> list[str]:
        """What the loop decided on its own, spelled out.

        A filter nobody can see is indistinguishable from a feature that
        stopped working, so the counts are printed even when the run proposed
        nothing — that is precisely the run where a reader wants to know
        whether hermes wrote nothing or whether this repository turned it all
        away.
        """
        lines = []
        if self.adopted:
            lines.append(
                "  note      adopted into a pack no project lists yet — emitted nowhere"
            )
        for reason, count in sorted(self.dropped.items()):
            lines.append(f"  skipped   {count} × {DROP_REASONS.get(reason, reason)}")
        if self.pruned:
            lines.append(
                f"  withdrew  {len(self.pruned)} candidate(s) already in the queue"
            )
        return lines


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
            # `<category>/<name>/SKILL.md` is hermes's own layout and the only
            # place the category is written down — the frontmatter of an
            # upstream skill does not carry one. A flat `<name>/SKILL.md` has
            # no category, which is exactly what a locally authored skill looks
            # like, so the absence is information too.
            category = rel.parts[-3] if len(rel.parts) >= 3 else ""
            candidate = _read(skill_file, name, staged, category=category)
            if candidate is not None:
                found.append(candidate)
    return found


def _read(
    path: Path, name: str, staged: bool, *, category: str = ""
) -> HermesCandidate | None:
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
    hermes_meta = (meta.get("metadata") or {}).get("hermes") or {}
    if isinstance(hermes_meta, dict) and hermes_meta.get("category"):
        # Declared rather than inferred, on the rare skill that says so.
        category = str(hermes_meta.get("category") or "") or category
    return HermesCandidate(
        name=str(meta.get("name") or name),
        path=path,
        body=body.strip(),
        description=str(meta.get("description") or "").strip(),
        staged=staged,
        category=category,
        catalogue=is_catalogue_frontmatter(meta),
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
      state: {origin}
      surface: {surface}
      category: {candidate.category or "uncategorised"}
      catalogue: {"true" if candidate.catalogue else "false"}
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


def recorded_facts(path: Path) -> tuple[str, str, bool] | None:
    """The triage facts a queued candidate recorded about itself.

    A candidate in the queue outlives the hermes home it came from — the source
    may have been renamed, approved into another directory, or be on a machine
    this checkout is no longer attached to. So the file carries what deciding
    it again requires, and re-deciding reads the file rather than the home.

    Returns ``None`` for anything this module did not write. That check is the
    whole safety of `prune_queue`: the queue also holds proposals from the
    learning loop's own gates, and those are somebody's evidence.
    """
    try:
        head = path.read_text(encoding="utf-8", errors="replace")[:2000]
    except OSError:
        return None
    if not re.search(r"^\s*origin:\s*hermes-agent\s*$", head, re.M):
        return None
    skill = re.search(r"^\s*skill:\s*(.+?)\s*$", head, re.M)
    if not skill:
        return None
    category = re.search(r"^\s*category:\s*(.+?)\s*$", head, re.M)
    catalogue = re.search(r"^\s*catalogue:\s*(true|false)\s*$", head, re.M)
    known = category.group(1) if category else ""
    known = "" if known == "uncategorised" else known
    if catalogue is not None:
        return skill.group(1), known, catalogue.group(1) == "true"

    # Written before triage existed, so it recorded neither fact — and those
    # are precisely the files a first run has to judge, because they are the
    # flood. Both are still recoverable from the source path the candidate
    # names in its Provenance section: the directory above the skill is
    # hermes's category, and the file itself, when it is still there, says
    # whether it is a contributed skill.
    return (skill.group(1), *_facts_from_source(head, known))


def _facts_from_source(head: str, known: str) -> tuple[str, bool]:
    """Category and catalogue shape, re-derived from a legacy candidate's source."""
    match = re.search(r"Read from `([^`]+)`", head)
    if not match:
        return known, False
    source = Path(match.group(1))
    parts = source.parts
    # `<home>/skills/<category>/<name>/SKILL.md` — anything else, including the
    # flat `<home>/skills/<name>/SKILL.md` a locally authored skill gets and
    # the `pending/skills/` queue, leaves the category empty.
    category = parts[-3] if len(parts) >= 3 and parts[-3] != "skills" else known
    catalogue = False
    try:
        if source.is_file():
            from skills_registry.frontmatter import parse_frontmatter

            meta, _ = parse_frontmatter(
                source.read_text(encoding="utf-8", errors="replace")
            )
            catalogue = is_catalogue_frontmatter(meta)
    except Exception as exc:  # noqa: BLE001 - a vanished source is not an error
        logger.debug("could not re-read %s: %s", source, exc)
    return category, catalogue


def _adopt_one(
    repo_root: Path, candidate: HermesCandidate, surface: str, *, write: bool
):
    """Adopt one candidate, reusing this module's portability rendering.

    `hermes_adopt` does not re-derive the tool table: the mapping and the
    sentence that goes with it are here, next to the vocabulary they describe,
    and a second copy over there would be a second answer to "what does a
    reviewer have to change".
    """
    from .hermes_adopt import adopt

    return adopt(
        repo_root,
        candidate,
        portability=_portability_section(candidate.body),
        surface=surface,
        write=write,
    )


def queue_state(repo_root: Path) -> tuple[list[str], int]:
    """What the review queue still asks of a person, and what it no longer does.

    Read-only, and the single reader: `hermes/api.py` and `runners/hermes_runner.py`
    both answer "what is pending?" to their own caller, and two readings of one
    directory is two answers to one question — the second of which would list
    the files the first had already written off.

    Returns the candidates still in scope, by file name, and the count of those
    a fresh verdict turns away. The stale ones are counted rather than listed
    because they are not work: the next cycle withdraws them. Nothing is
    deleted here — a read that removes files is a surprise nobody asked for,
    and the panel polls this.

    A candidate whose skill the adoption ledger has already settled is left out
    of both numbers. Its file stays on disk as the live mirror of what hermes
    has — refreshed when hermes edits its own copy — but the question this
    answers is "what is left for a person to read", and that name was answered
    the moment it was adopted or deleted.
    """
    try:
        from .hermes_adopt import ledger_names
        from .skill_proposer import proposal_dir

        scope = read_scope(repo_root)
        settled = ledger_names(repo_root)
        keep: list[str] = []
        stale = 0
        for path in sorted(proposal_dir(repo_root).glob(f"{_PREFIX}--*.md")):
            facts = recorded_facts(path)
            if facts is not None:
                name, category, catalogue = facts
                if name in settled:
                    continue
                if not verdict_for(
                    name, category=category, catalogue=catalogue, scope=scope
                ).keep:
                    stale += 1
                    continue
            keep.append(path.name)
        return keep, stale
    except Exception as exc:  # noqa: BLE001 - an unreadable queue is not an outage
        logger.debug("could not read the proposal queue: %s", exc)
        return [], 0


def prune_queue(
    target_dir: Path, scope: RepoScope, *, write: bool = True
) -> list[Path]:
    """Withdraw queued candidates this repository has since decided against.

    The reason this exists rather than being left to a person: the queue is the
    output of a rule, and a rule that changes has to be applied to what it
    already produced. Sixty files filed before triage existed are not sixty
    decisions somebody took — they are one bug, and asking their owner to
    delete them one by one is asking them to pay for it.

    Only files this module wrote are considered (`recorded_facts` returns
    ``None`` for anything else), and only the ones a fresh verdict turns away.
    A candidate still in scope is never touched, however old.
    """
    withdrawn: list[Path] = []
    try:
        if not target_dir.is_dir():
            return withdrawn
        for path in sorted(target_dir.glob(f"{_PREFIX}--*.md")):
            facts = recorded_facts(path)
            if facts is None:
                continue
            name, category, catalogue = facts
            verdict = verdict_for(
                name, category=category, catalogue=catalogue, scope=scope
            )
            if verdict.keep:
                continue
            if write:
                path.unlink(missing_ok=True)
            withdrawn.append(path)
            logger.info("withdrew %s: %s", path.name, verdict.explanation)
    except Exception as exc:  # noqa: BLE001 - housekeeping never fails a build
        logger.debug("could not prune the hermes queue: %s", exc)
    return withdrawn


def ingest_hermes_skills(
    repo_root: Path,
    *,
    home: Path | None = None,
    write: bool = True,
    limit: int = MAX_CANDIDATES_PER_RUN,
    surface: str = DEFAULT_SURFACE,
) -> HermesIngestReport:
    """File hermes-authored skills as candidates. Never raises.

    Three steps, and the first two are the loop doing its own housekeeping:

    1. **withdraw** what this repository has since decided against, so a rule
       change reaches the files the old rule produced;
    2. **triage** what hermes offers against the scope this repository already
       declared in ``skills/hermes/pack.json``, and count what is turned away
       rather than filing it;
    3. **adopt** what survives into ``skills/hermes-learned/`` (`hermes_adopt`),
       or **file** it in the review queue when adoption is switched off. Either
       way an identical one already there is left alone — re-proposing the same
       thing on every build turns the queue into noise, and rewriting the same
       file puts a diff in every pull request for nothing.

    Nothing is promoted by any of it, and adoption is not promotion: the pack
    is not listed in ``.workpilot/skills.toml``, so the resolver rejects every
    skill in it at the ``pack-pin`` gate and no harness ever sees one. A
    candidate that passes triage still carries no evidence from a build that
    used it, and `skill_proposer.evaluate` still refuses to invent any.
    """
    report = HermesIngestReport()
    try:
        from .skill_proposer import proposal_dir

        target_dir = proposal_dir(repo_root)
        scope = read_scope(repo_root)

        # Before anything hermes has to say: the queue is this repository's,
        # and it is cleaned whether or not hermes is installed on this machine.
        report.pruned = prune_queue(target_dir, scope, write=write)

        root = home or hermes_home()
        if not root.is_dir():
            report.reason = "not installed here (no hermes home)"
            return report

        candidates = discover_authored_skills(root)
        report.found = len(candidates)
        if not candidates:
            report.reason = "no authored skills to propose"
            return report

        keep: list[HermesCandidate] = []
        for candidate in candidates:
            verdict = verdict_for(
                candidate.name,
                category=candidate.category,
                # A skill in hermes's approval queue is authored by definition:
                # it is there because the agent just wrote it and is waiting to
                # be told yes. Whatever frontmatter it copied from a shipped
                # peer says nothing about where it came from, and this is the
                # one input whose provenance is not a record that can fail open
                # — so the catalogue fingerprint is not asked of it.
                catalogue=candidate.catalogue and not candidate.staged,
                scope=scope,
            )
            if verdict.keep:
                keep.append(candidate)
                continue
            report.dropped[verdict.reason] = report.dropped.get(verdict.reason, 0) + 1
            logger.debug("hermes triage: %s — %s", candidate.name, verdict.detail)

        if not keep:
            report.reason = (
                "no authored skills to propose"
                if not report.dropped
                else (
                    f"{report.dropped_total} candidate(s) already covered here "
                    "or out of this repository's scope"
                )
            )
            return report

        from .hermes_adopt import adoption_enabled

        adopting = adoption_enabled()
        if write:
            target_dir.mkdir(parents=True, exist_ok=True)

        for candidate in keep:
            # The queue and the pack answer different questions, so a kept
            # candidate reaches both. `skills/_proposed/hermes--x.md` is a live
            # mirror of what hermes has on *this* machine — gitignored, and
            # refreshed when hermes edits its own skill. The adopted file is
            # the snapshot this project took, committed, and never rewritten
            # afterwards. Folding them into one artifact would mean choosing
            # which of those two properties to lose.
            path = target_dir / candidate.filename()
            fresh = not (path.exists() and _existing_digest(path) == candidate.digest)

            if fresh and len(report.written) >= limit:
                report.deferred += 1
                continue
            if fresh:
                if write:
                    path.write_text(_render(candidate, surface), encoding="utf-8")
                report.written.append(path)
            else:
                report.unchanged += 1

            if not adopting:
                continue
            adoption = _adopt_one(repo_root, candidate, surface, write=write)
            if adoption is None:
                continue
            if adoption.written:
                report.adopted.append(adoption.path)
            else:
                report.already_adopted += 1
    except Exception as exc:  # noqa: BLE001 - observation never fails a build
        logger.warning("hermes ingest skipped: %s", exc)
        report.reason = f"skipped: {exc}"
    return report
