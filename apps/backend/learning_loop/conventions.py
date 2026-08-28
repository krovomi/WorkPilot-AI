"""Project conventions, learned deterministically and promoted on evidence.

`core/learning_loop.py` had this capability and could not use it. It discovered
naming and structure patterns from finished builds with no API call at all, and
turned them into a durable rule written to `.workpilot/conventions.md` — which
is something the rest of `learning_loop/` does not do: that side extracts
patterns with an LLM and spends them as prompt context.

Two things kept it from being usable, and both are fixed here rather than
carried over.

**Its promotion rule graded its own homework.** It promoted on
``confidence_score >= 0.7 and frequency >= 5``, where `confidence_score` was a
number it computed about itself, and it only ran at all when the caller passed
``success=True`` — an assertion, not an observation. That is precisely what
`ExternalSignal` exists to forbid. Promotion here reuses the thresholds and the
evidence type the skill proposer already enforces: a convention is proposed
once it has been seen ``MIN_OCCURRENCES`` times *and* corroborated on
``MIN_VERIFIED_OUTCOMES`` separate builds that a verifier signed off — tests
green, QA clean, a deterministic detector clean, or a human merging the PR.

**It wrote to the conventions file by itself.** `apply_convention` still
exists, because a learned rule that can never be adopted is a rule nobody
reads. But nothing calls it automatically: the phase writes a proposal, and
adopting it is a person's decision, the same rule the skill proposals follow.

Two of the four original analyzers are deliberately not ported. The
"architecture" one recorded which agent types ran together, which on this
product is always the pipeline and is therefore not a finding. The
"performance" one bucketed tokens-per-second into named tiers and emitted
"Performance pattern: high_efficiency" as a project convention — that is a
metric, not a rule anyone can follow.
"""

from __future__ import annotations

import json
import logging
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .skill_proposer import (
    MIN_OCCURRENCES,
    MIN_VERIFIED_OUTCOMES,
    ExternalSignal,
)

logger = logging.getLogger(__name__)

__all__ = [
    "ConventionCandidate",
    "apply_convention",
    "candidates_from_files",
    "conventions_dir",
    "load_ledger",
    "pending_proposals",
    "promote",
    "record_observation",
    "run_convention_pass",
]

# A directory needs this many changed files before its shape is a pattern
# rather than a coincidence.
MIN_FILES_PER_DIRECTORY = 3

# A naming style needs this many files in one build before it is even a
# candidate. Below it, the "convention" is one developer's afternoon.
MIN_FILES_PER_NAMING_STYLE = 3

_SNAKE = re.compile(r"^[a-z][a-z0-9]*(_[a-z0-9]+)+$")
_KEBAB = re.compile(r"^[a-z][a-z0-9]*(-[a-z0-9]+)+$")
_PASCAL = re.compile(r"^[A-Z][a-z0-9]+([A-Z][a-z0-9]*)*$")
_CAMEL = re.compile(r"^[a-z][a-z0-9]*([A-Z][a-z0-9]*)+$")

# Files whose names are dictated by a tool, not by the project's taste.
_NAMING_EXEMPT = frozenset(
    {
        "__init__",
        "__main__",
        "index",
        "main",
        "setup",
        "conftest",
        "README",
        "LICENSE",
        "Dockerfile",
        "Makefile",
    }
)


@dataclass(frozen=True)
class ConventionCandidate:
    """One rule the codebase appears to follow."""

    convention_id: str
    kind: str
    """``naming`` or ``structure``."""
    statement: str
    """The rule as a sentence, ready to paste into a conventions file."""
    examples: tuple[str, ...]
    target_file: str
    """Which steering file the rule belongs in."""

    def to_dict(self) -> dict[str, Any]:
        return {
            "convention_id": self.convention_id,
            "kind": self.kind,
            "statement": self.statement,
            "examples": list(self.examples),
            "target_file": self.target_file,
        }


# ── discovery ────────────────────────────────────────────────────────────


def _naming_style(stem: str) -> str | None:
    """The naming style of one filename, or None when it does not say.

    A single lowercase word — ``utils``, ``models`` — is valid snake_case,
    camelCase *and* kebab-case simultaneously, so it is evidence for none of
    them. The original classifier counted it as snake_case because that
    branch was tested first, which meant a project of one-word modules
    "learned" a convention from files that never expressed one.
    """
    if stem in _NAMING_EXEMPT or not stem:
        return None
    if _SNAKE.match(stem):
        return "snake_case"
    if _KEBAB.match(stem):
        return "kebab-case"
    if _PASCAL.match(stem):
        return "PascalCase"
    if _CAMEL.match(stem):
        return "camelCase"
    return None


def _naming_candidates(paths: list[Path]) -> list[ConventionCandidate]:
    """Naming conventions, per file extension.

    Keyed by extension because a repo that writes `PascalCase.tsx` next to
    `snake_case.py` is consistent, not contradictory, and a single global
    verdict would report it as a conflict forever.
    """
    by_ext: dict[str, Counter] = defaultdict(Counter)
    examples: dict[tuple[str, str], list[str]] = defaultdict(list)

    for path in paths:
        style = _naming_style(path.stem)
        if style is None:
            continue
        ext = path.suffix or "(no extension)"
        by_ext[ext][style] += 1
        if len(examples[(ext, style)]) < 3:
            examples[(ext, style)].append(path.name)

    out: list[ConventionCandidate] = []
    for ext, counter in sorted(by_ext.items()):
        style, count = counter.most_common(1)[0]
        if count < MIN_FILES_PER_NAMING_STYLE:
            continue
        # A split vote is not a convention. Requiring the leader to hold a
        # clear majority keeps a 4-vs-3 directory from minting a rule.
        if count * 2 <= sum(counter.values()):
            continue
        out.append(
            ConventionCandidate(
                convention_id=f"naming:{ext}:{style}",
                kind="naming",
                statement=f"`{ext}` files are named in {style}.",
                examples=tuple(examples[(ext, style)]),
                target_file="conventions.md",
            )
        )
    return out


def _structure_candidates(paths: list[Path]) -> list[ConventionCandidate]:
    """Directories that consistently hold one kind of file."""
    by_dir: dict[str, Counter] = defaultdict(Counter)
    examples: dict[str, list[str]] = defaultdict(list)

    for path in paths:
        parent = path.parent.as_posix()
        if parent in ("", "."):
            continue
        by_dir[parent][path.suffix or "(no extension)"] += 1
        if len(examples[parent]) < 3:
            examples[parent].append(path.as_posix())

    out: list[ConventionCandidate] = []
    for directory, counter in sorted(by_dir.items()):
        total = sum(counter.values())
        if total < MIN_FILES_PER_DIRECTORY:
            continue
        ext, count = counter.most_common(1)[0]
        if count != total:
            # Mixed directories are the normal case and say nothing.
            continue
        out.append(
            ConventionCandidate(
                convention_id=f"structure:{directory}:{ext}",
                kind="structure",
                statement=f"`{directory}/` holds only `{ext}` files.",
                examples=tuple(examples[directory]),
                target_file="architecture.md",
            )
        )
    return out


def candidates_from_files(files: list[str]) -> list[ConventionCandidate]:
    """Every convention the given set of changed files is evidence for.

    Pure: no filesystem access, no build state, no model. That is what makes
    this half of the loop free to run at every effort level.
    """
    paths = [Path(f) for f in files if f and not f.endswith("/")]
    if not paths:
        return []
    return _naming_candidates(paths) + _structure_candidates(paths)


# ── ledger ───────────────────────────────────────────────────────────────


def conventions_dir(project_dir: Path) -> Path:
    return Path(project_dir) / ".workpilot" / "learning" / "conventions"


def _ledger_path(project_dir: Path) -> Path:
    return conventions_dir(project_dir) / "ledger.json"


def load_ledger(project_dir: Path) -> dict[str, Any]:
    """What has been observed so far. Empty on anything unreadable."""
    path = _ledger_path(project_dir)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError) as exc:
        logger.debug("convention ledger unreadable: %s", exc)
        return {}


def record_observation(
    project_dir: Path,
    candidates: list[ConventionCandidate],
    signals: list[ExternalSignal],
    build_id: str,
) -> int:
    """Add one build's evidence to the ledger. Returns entries touched.

    ``signals`` is what a verifier said about *this* build. A build with none
    still counts towards ``occurrences`` — the code really was written that
    way — but contributes nothing towards corroboration, so it can never on
    its own move a convention closer to being proposed.
    """
    if not candidates:
        return 0
    ledger = load_ledger(project_dir)
    touched = 0

    for candidate in candidates:
        entry = ledger.setdefault(
            candidate.convention_id,
            {**candidate.to_dict(), "occurrences": 0, "builds": [], "corroborated": []},
        )
        # Re-running observe on the same build must not inflate the count.
        if build_id and build_id in entry.get("builds", []):
            continue
        entry["occurrences"] = int(entry.get("occurrences", 0)) + 1
        if build_id:
            entry.setdefault("builds", []).append(build_id)
        if signals and build_id:
            entry.setdefault("corroborated", []).append(
                {"build": build_id, "signals": [s.value for s in signals]}
            )
        # Keep the statement fresh; the examples are the most recent ones.
        entry["statement"] = candidate.statement
        entry["examples"] = list(candidate.examples)
        touched += 1

    _write_ledger(project_dir, ledger)
    return touched


def _write_ledger(project_dir: Path, ledger: dict[str, Any]) -> None:
    try:
        path = _ledger_path(project_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(ledger, indent="\t", ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    except OSError as exc:  # pragma: no cover - bookkeeping only
        logger.debug("could not write convention ledger: %s", exc)


# ── promotion ────────────────────────────────────────────────────────────


def _proposal_path(project_dir: Path, convention_id: str) -> Path:
    slug = re.sub(r"[^a-z0-9]+", "-", convention_id.lower()).strip("-")
    return conventions_dir(project_dir) / "_proposed" / f"{slug}.md"


def promote(project_dir: Path, *, write: bool = True) -> list[Path]:
    """Write a proposal for every convention that has earned one.

    The gate is the skill proposer's, deliberately: seen ``MIN_OCCURRENCES``
    times, and corroborated on ``MIN_VERIFIED_OUTCOMES`` distinct builds. One
    build that went green is a coincidence; the same rule surviving several
    independently verified builds is the thing worth writing down.
    """
    written: list[Path] = []
    for convention_id, entry in sorted(load_ledger(project_dir).items()):
        if not isinstance(entry, dict):
            continue
        if int(entry.get("occurrences", 0)) < MIN_OCCURRENCES:
            continue
        corroborating = {
            rec.get("build")
            for rec in entry.get("corroborated", [])
            if isinstance(rec, dict) and rec.get("build")
        }
        if len(corroborating) < MIN_VERIFIED_OUTCOMES:
            continue
        path = _proposal_path(project_dir, convention_id)
        if path.exists():
            continue
        if not write:
            written.append(path)
            continue
        if _write_proposal(path, convention_id, entry, corroborating):
            written.append(path)
    return written


def _write_proposal(
    path: Path, convention_id: str, entry: dict[str, Any], builds: set[str]
) -> bool:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        examples = "\n".join(f"- `{e}`" for e in entry.get("examples", [])) or "- —"
        signals = sorted(
            {
                s
                for rec in entry.get("corroborated", [])
                if isinstance(rec, dict)
                for s in rec.get("signals", [])
            }
        )
        path.write_text(
            f"""# Convention proposée — {convention_id}

{entry.get("statement", "")}

**Cible** : `.workpilot/{entry.get("target_file", "conventions.md")}`

## Pourquoi

Observée sur {entry.get("occurrences", 0)} build(s), corroborée sur
{len(builds)} build(s) vérifié(s) : {", ".join(sorted(builds))}.

Signaux externes : {", ".join(signals) or "aucun"}.

## Exemples

{examples}

## Adopter

Rien n'est écrit dans vos fichiers de convention tant qu'une personne ne le
décide pas :

```bash
python -c "from learning_loop.conventions import apply_convention; \\
apply_convention('.', '{convention_id}')"
```
""",
            encoding="utf-8",
        )
        logger.info("proposed convention %s", convention_id)
        return True
    except OSError as exc:  # pragma: no cover
        logger.debug("could not write convention proposal: %s", exc)
        return False


def pending_proposals(project_dir: Path) -> list[Path]:
    """Proposals written but not yet adopted or discarded."""
    directory = conventions_dir(project_dir) / "_proposed"
    return sorted(directory.glob("*.md")) if directory.is_dir() else []


# ── adoption, by a person ────────────────────────────────────────────────


def apply_convention(project_dir: Path | str, convention_id: str) -> bool:
    """Append a promoted convention to its steering file.

    Never called by the observe phase. `core/learning_loop.py` applied its own
    proposals as a side effect of discovering them, which meant a project's
    written conventions could change because a build happened to go green.
    """
    project_dir = Path(project_dir)
    entry = load_ledger(project_dir).get(convention_id)
    if not isinstance(entry, dict):
        logger.warning("no such convention: %s", convention_id)
        return False

    target = (
        project_dir / ".workpilot" / str(entry.get("target_file", "conventions.md"))
    )
    statement = str(entry.get("statement", "")).strip()
    if not statement:
        return False

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        existing = target.read_text(encoding="utf-8") if target.is_file() else ""
        if statement in existing:
            # Already adopted; clearing the proposal is still the right move.
            _discard_proposal(project_dir, convention_id)
            return True
        heading = "## Conventions apprises"
        if heading in existing:
            body = existing.replace(heading, f"{heading}\n\n- {statement}", 1)
        else:
            body = f"{existing.rstrip()}\n\n{heading}\n\n- {statement}\n".lstrip()
        target.write_text(body, encoding="utf-8")
        _discard_proposal(project_dir, convention_id)
        logger.info("adopted convention %s into %s", convention_id, target.name)
        return True
    except OSError as exc:
        logger.warning("could not adopt convention %s: %s", convention_id, exc)
        return False


def _discard_proposal(project_dir: Path, convention_id: str) -> None:
    path = _proposal_path(project_dir, convention_id)
    try:
        path.unlink(missing_ok=True)
    except OSError:  # pragma: no cover
        pass


# ── the phase entry point ────────────────────────────────────────────────


def run_convention_pass(
    project_dir: Path,
    changed_files: list[str],
    signals: list[ExternalSignal],
    build_id: str,
) -> tuple[int, list[Path]]:
    """Observe, then promote. Returns (entries recorded, proposals written).

    Never raises: this runs at the end of a build that already succeeded, and
    losing an observation is cheaper than losing the run.
    """
    try:
        candidates = candidates_from_files(changed_files)
        recorded = record_observation(project_dir, candidates, signals, build_id)
        return recorded, promote(project_dir)
    except Exception as exc:  # noqa: BLE001 - observation must not break a build
        logger.warning("convention pass failed, build unaffected: %s", exc)
        return 0, []
