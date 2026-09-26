"""Adopting a triaged candidate into a pack nobody has opted into yet.

The step this removes
---------------------
After `hermes_triage`, what reaches the queue is a handful of skills this
repository plausibly has a use for. One human act remained, and it was pure
transcription: open ``skills/_proposed/hermes--x.md``, copy the body into
``skills/<pack>/x/SKILL.md``, delete the candidate. Nobody learns anything by
doing that, and a queue whose only exit is a copy-paste is a queue that fills
up.

So the loop does the copy, into ``skills/hermes-learned/``. What it cannot do
is decide that the result belongs in an agent's palette — and it does not have
to, because in this repository those are already two different decisions.

Why a pack that is not in `[packs]`
-----------------------------------
``.workpilot/skills.toml`` is a want-list, not a filter: `resolver.resolve`
rejects every skill of a pack the project has not listed, at the ``pack-pin``
gate, with a reason naming the file to edit. A pack on disk that nobody listed
is therefore emitted **nowhere** — not to ``.agents/skills/``, not to Claude
Code, Copilot, Codex, Cursor or Gemini — and no agent can load it.

That is the whole safety argument, and it is worth being precise about what it
buys. Auto-adoption writes agent-authored prose into the repository; it does
not make any agent follow it. The act that would — adding one line to
``[packs]`` — stays with a person, is taken once rather than per skill, and is
taken with the whole pack visible in front of them. Between here and there, the
adopted file is an ordinary diff in the pull request of the task that adopted
it: reviewed the way everything else in this repository is reviewed, rather
than in a side queue that only exists on one machine.

Which is also why this is committed while ``skills/_proposed/hermes--*.md`` is
ignored. A candidate describes what hermes wrote in *this machine's*
``~/.hermes`` and means nothing in someone else's checkout. An adopted skill is
a statement about the project.

Verbatim, and saying so
-----------------------
The body is hermes's, unchanged. Adopting a candidate properly is a rewrite —
its prose names `read_file`, `search_files` and `patch`, which are hermes's
tools and nobody else's — and a find-and-replace would leave the surrounding
sentences describing a tool they no longer name. So the file carries the
portability table and ``adopted: verbatim``, and the rewrite happens when
somebody decides to list the pack. An adopted skill is a draft in the right
place, not a finished one.

Adoption is one-way, and once
-----------------------------
Nothing here deletes from ``skills/hermes-learned/``, and nothing here rewrites
a file that is already there. `hermes_triage` withdraws candidates from a queue
the loop owns; this is not that. It is committed project content, and the two
things a person does with it are exactly the two things a loop must not undo:

* **rewriting it** — doing the portability pass, cutting it down, making it this
  repository's. An adoption that refreshed the file from hermes would throw that
  away on the next build.
* **deleting it** — which is how you say no. Without a record, the next build
  re-adopts it, and the person deletes it again, for ever. So every adoption is
  written to ``ADOPTED.json``, and a name in that ledger is never adopted twice
  however its file ended up. The ledger is committed for the same reason the
  skill is: the decision is the project's, not the machine's.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = [
    "ADOPTED_PACK",
    "ENABLED_ENV",
    "LEDGER",
    "Adoption",
    "adopt",
    "adoption_enabled",
    "adopted_names",
    "decline",
    "declined_names",
    "ledger_names",
    "pack_dir",
]

#: The pack adopted skills land in. Deliberately not listed in
#: `.workpilot/skills.toml`: see the module docstring.
ADOPTED_PACK = "hermes-learned"

#: The switch. On by default — the pack reaches no harness, so the cost of
#: being wrong is a file in a diff, and the point of the exercise is that
#: nobody has to remember to run anything.
ENABLED_ENV = "HERMES_AUTO_ADOPT"

#: Every name this loop has ever adopted here, whatever became of its file.
LEDGER = "ADOPTED.json"

_PACK_VERSION = "0.1.0"
_PACK_DESCRIPTION = (
    "Skills hermes-agent authored from its own experience, adopted verbatim by "
    "the learning loop. Not listed in .workpilot/skills.toml, so nothing here "
    "is emitted to any harness until someone decides it should be."
)

_SLUG_RE = re.compile(r"[^a-z0-9]+")
_FALSY = ("0", "false", "no", "off")


def adoption_enabled(env: dict | None = None) -> bool:
    """Whether a triaged candidate is adopted as well as filed."""
    source = os.environ if env is None else env
    text = str(source.get(ENABLED_ENV, "true")).strip().lower()
    # Only an explicit "off" turns it off. An unparseable value falls back to
    # the default rather than to the safer-looking answer: a typo in a settings
    # file must not silently disable a feature the user believes is on.
    return text not in _FALSY


def pack_dir(repo_root: Path) -> Path:
    return Path(repo_root) / "skills" / ADOPTED_PACK


def _slug(text: str) -> str:
    return _SLUG_RE.sub("-", text.lower()).strip("-")


@dataclass(frozen=True)
class Adoption:
    """What happened to one candidate."""

    name: str
    path: Path
    written: bool
    """False when an identical adoption was already there."""


def adopted_names(repo_root: Path) -> list[str]:
    """Skills adopted here **and still present**, by name.

    What the UI shows, which is not the same question the ledger answers: a
    name a person deleted is gone from here and still remembered there.
    """
    root = pack_dir(repo_root)
    if not root.is_dir():
        return []
    return sorted(p.parent.name for p in root.glob("*/SKILL.md") if p.is_file())


def _ledger_path(repo_root: Path) -> Path:
    return pack_dir(repo_root) / LEDGER


def ledger_names(repo_root: Path) -> set[str]:
    """Every name ever adopted here. An unreadable ledger reads as empty.

    Failing open is the right way round for this one: the cost is re-adopting a
    skill somebody deleted, which is one file in one diff and visible. Failing
    closed would mean a corrupt ledger silently switching the feature off.
    """
    try:
        data = json.loads(
            _ledger_path(repo_root).read_text(encoding="utf-8", errors="replace")
        )
    except (OSError, ValueError):
        return set()
    return {str(k) for k in data} if isinstance(data, dict) else set()


def declined_names(repo_root: Path) -> set[str]:
    """The names a person turned down from the panel, by slug.

    A subset of `ledger_names`: the ledger already means "never adopt this
    again", and a refusal is exactly that. The distinction is kept only so the
    loop can also stop *mirroring* a refused skill into the review queue — an
    adopted one keeps its live mirror, a refused one has nothing left to say.
    """
    try:
        data = json.loads(
            _ledger_path(repo_root).read_text(encoding="utf-8", errors="replace")
        )
    except (OSError, ValueError):
        return set()
    if not isinstance(data, dict):
        return set()
    return {
        str(k)
        for k, v in data.items()
        if isinstance(v, dict) and v.get("decision") == "declined"
    }


def _record(
    repo_root: Path,
    name: str,
    candidate,
    surface: str,
    *,
    decision: str = "adopted",
) -> None:
    """Append one decision to the ledger, keeping what is already there."""
    path = _ledger_path(repo_root)
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    data[name] = {
        "skill": candidate.name,
        "digest": candidate.digest,
        "surface": surface,
        "decision": decision,
        f"{decision}_at": stamp,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(dict(sorted(data.items())), indent="\t", ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _ensure_pack(root: Path) -> None:
    """Write the manifest once, and never rewrite it.

    `packs.load_pack` raises `PackError` on a malformed manifest and that is
    fatal to every build, so this is the one file here that has to be right:
    `name` matching the directory, a `version`, valid JSON. It is left alone
    once written — the version is a thing a person may bump, and a loop that
    reset it on every run would be arguing with them.
    """
    manifest = root / "pack.json"
    if manifest.is_file():
        return
    root.mkdir(parents=True, exist_ok=True)
    manifest.write_text(
        json.dumps(
            {
                "name": ADOPTED_PACK,
                "version": _PACK_VERSION,
                "description": _PACK_DESCRIPTION,
                "targets": {},
                "maintainer": "hermes-agent (adopted by the learning loop)",
                "source": "local",
            },
            indent="\t",
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    logger.info("created the %s pack", ADOPTED_PACK)


def _render(candidate, portability: str, surface: str) -> str:
    """The adopted SKILL.md: hermes's body, this repository's provenance."""
    state = "pending approval in hermes" if candidate.staged else "active in hermes"
    description = (candidate.description or candidate.name).replace("\n", " ").strip()
    return f"""---
name: {_slug(candidate.name)}
description: {json.dumps(description, ensure_ascii=False)}
metadata:
  workpilot:
    provenance:
      origin: hermes-agent
      skill: {candidate.name}
      category: {candidate.category or "uncategorised"}
      state: {state}
      surface: {surface}
      digest: {candidate.digest}
      adopted: verbatim
---

{candidate.body}

## Portability

{portability}
<!--
  Adopted by the learning loop from a skill hermes-agent wrote from its own
  experience, and adopted *verbatim*: the body above is hermes's, in hermes's
  tool vocabulary. The pack is not listed in .workpilot/skills.toml, so this
  file is emitted to no harness and no agent can load it — listing it is the
  moment to do the rewrite the table above describes.
-->
"""


def adopt(
    repo_root: Path,
    candidate,
    *,
    portability: str,
    surface: str,
    write: bool = True,
) -> Adoption | None:
    """Write one triaged candidate into `skills/hermes-learned/`. Never raises.

    Returns what happened, or ``None`` when nothing could be written.

    Two guards, and they are the same guard seen from either side: a name the
    ledger already carries is never adopted again, and a file already on disk
    is never rewritten. Between them, whatever a person did with an earlier
    adoption — rewrote it, cut it down, deleted it to say no — survives every
    build that follows.
    """
    try:
        name = _slug(candidate.name)
        root = pack_dir(repo_root)
        target = root / name / "SKILL.md"

        if name in ledger_names(repo_root) or target.is_file():
            return Adoption(candidate.name, target, written=False)

        if write:
            _ensure_pack(root)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(
                _render(candidate, portability, surface), encoding="utf-8"
            )
            _record(repo_root, name, candidate, surface)
            logger.info("adopted %s into skills/%s/", candidate.name, ADOPTED_PACK)
        return Adoption(candidate.name, target, written=True)
    except Exception as exc:  # noqa: BLE001 - adoption never fails a build
        logger.warning("could not adopt %s: %s", getattr(candidate, "name", "?"), exc)
        return None


def decline(repo_root: Path, candidate, *, surface: str) -> bool:
    """Record that a person said no to one candidate. Never raises.

    Deleting an adopted file was the only way to say no, and it only worked
    *after* adoption — a candidate still in the queue could only be left there.
    A refusal from the panel writes the same ledger entry deleting would have
    implied, so the name is never adopted and never listed again. Nothing in
    the pack is touched: an earlier adoption a person kept stays theirs.
    """
    try:
        name = _slug(candidate.name)
        _record(repo_root, name, candidate, surface, decision="declined")
        logger.info("declined %s from the hermes review queue", candidate.name)
        return True
    except Exception as exc:  # noqa: BLE001 - a panel click never crashes the API
        logger.warning("could not decline %s: %s", getattr(candidate, "name", "?"), exc)
        return False
