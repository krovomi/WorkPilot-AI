"""Which of hermes's skills belong in *this* repository — answered here, by nobody.

The ingest next door answers a different question: *what did hermes write?* It
asks hermes, through hermes's own bookkeeping — ``.usage.json`` for authorship,
``.bundled_manifest`` and ``.hub/lock.json`` for what was merely shipped or
downloaded. That is the right source for that question, and it has one property
this module exists to compensate for: **it is a set of files upstream owns.**
When a release stops writing one, renames one, or starts recording curation
where it used to record authorship, the ingest does not get a smaller answer —
it gets the whole catalogue, and the review queue fills with `airtable`,
`imessage`, `apple-notes` and fifty-eight others. That has now happened twice,
for two different reasons, which is the signal that no third fix to the reading
of upstream's files is the fix.

So this is a second authority, and its inputs are facts **this repository
owns**:

``skills/hermes/pack.json``   the categories of hermes's catalogue this project
                              tracks, and the names it looked at and declined
``skills/<pack>/``            every skill the project already provides
``.agents/skills/``           what is actually emitted to the harnesses
``skills-lock.json``          what the last build owned

Both authorities must agree before a candidate reaches the queue, and they fail
in opposite directions: hermes's bookkeeping fails open (an absent file
excludes nothing), the scope below fails closed (an absent file leaves the
declared default, and an unknown category is out of scope). A flood therefore
needs both to fail at once, and the second one cannot fail by upstream shipping
a new release.

Why this is the autonomous half of the loop
-------------------------------------------
A candidate that is out of scope here is not a judgement call. `airtable` is
not "probably not useful to WorkPilot"; it is a procedure for a product this
repository does not use, in a category this repository declared it does not
track, in a file this repository wrote down before hermes ever ran. Asking a
person to delete sixty of those, one by one, is asking them to re-type an
answer they already gave in ``pack.json``.

What stays with a person is the other half, and it is unchanged: a candidate
that *is* in scope still carries no evidence from a build that used it, so it
is filed, not promoted. `skill_proposer.evaluate` decides that, and it refuses
to invent corroboration. Triage removes the chore; it does not move the gate.

Every drop is recorded with a reason, and the reason is reported — to the build
log, to `GET /api/hermes/status` and to the Kanban card. A filter nobody can
see is indistinguishable from a feature that stopped working, which is the
failure the readiness doctor next door exists to prevent.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = [
    "Verdict",
    "RepoScope",
    "DROP_REASONS",
    "DEFAULT_CATEGORIES",
    "read_scope",
    "verdict_for",
    "is_catalogue_frontmatter",
]

# The hermes categories this repository tracks, used when `skills/hermes/pack.json`
# cannot be read. It is the same list the pack declares, duplicated here for one
# reason: an unreadable pack file must not turn the category rule off. A rule
# that disappears when its configuration does is the fail-open shape this module
# was written to replace.
DEFAULT_CATEGORIES = frozenset(
    {"software-development", "autonomous-ai-agents", "devops"}
)

# Every reason a candidate can be turned away, and what it means to a reader.
# A closed set, for the same reason `hermes.loop.SURFACES` is one: these strings
# are rendered in a panel and counted in a log, so a caller inventing a sixth
# would produce a row nobody can translate.
DROP_REASONS: dict[str, str] = {
    "already-provided": "this repository already provides a skill of that name",
    "declined-here": "the hermes pack looked at it and excluded it on purpose",
    "out-of-scope": "it sits in a hermes category this repository does not track",
    "upstream-catalogue": "its frontmatter is hermes's shipped-contribution shape",
}


@dataclass(frozen=True)
class Verdict:
    """Whether a candidate reaches the review queue, and why not when it does not."""

    keep: bool
    reason: str = ""
    """One of `DROP_REASONS`, empty when kept."""
    detail: str = ""

    @property
    def explanation(self) -> str:
        return DROP_REASONS.get(self.reason, self.reason)


@dataclass(frozen=True)
class RepoScope:
    """What this repository has already decided about hermes's catalogue."""

    categories: frozenset[str] = DEFAULT_CATEGORIES
    """Hermes categories the project tracks, from the pack's `--subdir` list."""
    declined: frozenset[str] = field(default_factory=frozenset)
    """Names the pack names in `--exclude`: looked at, and turned down."""
    provided: frozenset[str] = field(default_factory=frozenset)
    """Skill names this repository already has, from any pack or the emitted set."""


def _pack_bootstrap(repo_root: Path) -> list[str]:
    """The hermes pack's bootstrap command, as a flat argument list."""
    path = Path(repo_root) / "skills" / "hermes" / "pack.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError) as exc:
        logger.debug("could not read the hermes pack declaration: %s", exc)
        return []
    bootstrap = data.get("bootstrap") if isinstance(data, dict) else None
    command = bootstrap.get("command") if isinstance(bootstrap, dict) else None
    return [str(arg) for arg in command] if isinstance(command, list) else []


def _flag_values(argv: list[str], flag: str) -> list[str]:
    """Every value passed to a repeated flag, in order."""
    return [argv[i + 1] for i, arg in enumerate(argv[:-1]) if arg == flag]


def _provided_names(repo_root: Path) -> set[str]:
    """Skill names the project already has, whichever way it has them.

    Three sources, because they answer at three different moments and a
    candidate only has to collide with one of them to be old news:

    * ``skills/<pack>/<name>/`` — vendored or authored here, listed in
      ``.workpilot/skills.toml`` or not. A pack that is present but not opted
      in is still a decision this project took about that name.
    * ``skills-lock.json`` — what the last ``skills:build`` owned.
    * ``.agents/skills/<name>/`` — what is actually emitted, which is the set a
      harness can load today.

    The one pack left out is `hermes_adopt.ADOPTED_PACK`, and for the reason
    the others are in: those are decisions a person took about a name, and that
    one is this loop's own output. Counting it would make the loop mask its own
    inputs a build later — the candidate would stop being reported as
    "unchanged, already pending" and start being reported as "this repository
    already provides it", which is true of nothing a person did. What keeps an
    adopted name from being adopted twice is the ledger, next door, which also
    remembers the ones somebody deleted.
    """
    from .hermes_adopt import ADOPTED_PACK

    root = Path(repo_root)
    names: set[str] = set()

    skills_root = root / "skills"
    if skills_root.is_dir():
        for pack in skills_root.iterdir():
            if not pack.is_dir() or pack.name.startswith("_"):
                continue
            if pack.name == ADOPTED_PACK:
                continue
            names.update(
                skill.parent.name
                for skill in pack.glob("*/SKILL.md")
                if skill.is_file()
            )

    try:
        lock = json.loads(
            (root / "skills-lock.json").read_text(encoding="utf-8", errors="replace")
        )
        emitted = lock.get("skills") if isinstance(lock, dict) else None
        if isinstance(emitted, dict):
            names.update(str(key) for key in emitted)
    except (OSError, ValueError) as exc:
        logger.debug("could not read skills-lock.json: %s", exc)

    agents_root = root / ".agents" / "skills"
    if agents_root.is_dir():
        names.update(
            skill.parent.name
            for skill in agents_root.glob("*/SKILL.md")
            if skill.is_file()
        )

    return names


def read_scope(repo_root: Path) -> RepoScope:
    """Read this repository's standing decisions about hermes's catalogue.

    Filesystem only — three small files and two directory listings — because
    the Kanban calls the cycle behind a button and a build calls it in the
    `observe` phase, and neither can afford a scope that reaches the network.
    Never raises: an unreadable file leaves the conservative default in place.
    """
    try:
        argv = _pack_bootstrap(repo_root)
        # `--subdir skills/software-development` names a directory in hermes's
        # own tree; the category is its last segment, which is also the
        # directory name hermes keeps it under in `~/.hermes/skills/`.
        categories = {
            value.rsplit("/", 1)[-1].strip()
            for value in _flag_values(argv, "--subdir")
            if value.strip()
        }
        declined = {v.strip() for v in _flag_values(argv, "--exclude") if v.strip()}
        return RepoScope(
            categories=frozenset(categories) if categories else DEFAULT_CATEGORIES,
            declined=frozenset(declined),
            provided=frozenset(_provided_names(repo_root)),
        )
    except Exception as exc:  # noqa: BLE001 - triage never fails its caller
        logger.warning("could not read the repository scope: %s", exc)
        return RepoScope()


def is_catalogue_frontmatter(meta: dict) -> bool:
    """Whether this frontmatter is the shape hermes requires of *contributed* skills.

    hermes has two kinds of skill and one file format. A skill contributed to
    its repository must carry `author` and `license` — its own authoring
    standard says so, and reviewers reject a pull request without them. A skill
    `skill_manage(action='create')` writes into ``~/.hermes/skills/`` from a
    session's experience has to satisfy the validator instead, which requires
    `name`, `description` and a body, and nothing else.

    So the pair is a fingerprint of the catalogue rather than a judgement about
    quality, and it is the one rule here that still holds when hermes's home is
    flat — no category directories, nothing to compare a path against. That is
    the case the scope rules cannot see, and the flood arrived in it.

    A locally authored skill that happens to carry both is turned away, and
    that is the error worth making: it costs one skill nobody had yet, against
    sixty files nobody wanted. The one input where that error is *not* worth
    making is hermes's approval queue — a skill is in ``pending/skills/`` only
    because the agent just wrote it, so the ingest does not ask this of it.
    """
    return bool(str(meta.get("author") or "").strip()) and bool(
        str(meta.get("license") or "").strip()
    )


def verdict_for(
    name: str,
    *,
    category: str = "",
    catalogue: bool = False,
    scope: RepoScope,
) -> Verdict:
    """Decide one candidate from facts, in the order a reader would ask them.

    The order matters only for the reason reported: a skill that is both
    already provided and out of scope is reported as already provided, because
    that is the shorter answer and the one that stays true if the pack's scope
    ever widens.
    """
    skill = (name or "").strip()

    if skill in scope.provided:
        return Verdict(
            False,
            "already-provided",
            f"`{skill}` is already a skill in this repository",
        )

    if skill in scope.declined:
        return Verdict(
            False,
            "declined-here",
            f"skills/hermes/pack.json excludes `{skill}` on purpose",
        )

    known = (category or "").strip()
    if known and known not in scope.categories:
        return Verdict(
            False,
            "out-of-scope",
            f"hermes category `{known}`; this repository tracks "
            + ", ".join(sorted(scope.categories)),
        )

    if catalogue:
        return Verdict(
            False,
            "upstream-catalogue",
            "declares the author/license pair hermes requires of shipped skills",
        )

    return Verdict(True)
