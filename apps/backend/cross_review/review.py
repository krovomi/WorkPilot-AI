"""A second engine reads the finished task before its pull request (plan of 29 October, IA2).

The build was planned, coded, reviewed and corrected by one provider. Its
blind spots are shared by every phase: a model that misread the spec reads its
own code the same way. Here a *different* provider × model reads the diff
against the spec and the goal, and answers with a verdict a program can read.

Three verdicts, and only one of them is a green light:

- ``agree``: the reviewer found no blocking problem;
- ``disagree``: it names at least one blocking problem, with a file;
- ``inconclusive``: anything else — no answer, an answer that is not the
  JSON asked for, a disagreement that names nothing, an agreement that lists
  a blocker. Never read as ``agree``.

A ``disagree`` blocks the pull request (`blocking_verdict`, read by
`WorktreeManager.push_and_create_pr`) until the person overrides it or the
code changes. "The code" is the content of the worktree, hashed as a git tree
(`tree_fingerprint`): a commit made at push time does not unblock it, an edit
does, and then the verdict is stale and says so.

Off until a second engine is named: in the project settings (the desktop
passes ``WORKPILOT_CROSS_REVIEW_PROVIDER`` / ``_MODEL`` / ``_EFFORT``) or in
the task's ``task_metadata.json`` (``crossReview``). An engine equal to the
build's is refused: the same model reading its own work twice is not a
second look. Choosing the engine and running its session is the workflow
phase's job (`workflows/cross_review_phase.py`); this package reads and keeps
the verdict, and imports nothing above `foundation`, so the pull request step
in `core` can read it without joining the agent runtime's import cycle.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

VERDICT_FILE = "cross_review.json"
VERDICTS = ("agree", "disagree", "inconclusive")
SEVERITIES = ("blocker", "major", "minor")

MAX_FINDINGS = 20
MAX_TEXT = 500

# What the fingerprint leaves out: WorkPilot's own files in the worktree root
# (`.workpilot-discard-list` and the like) change between the review and the
# push without changing the code anyone reviewed.
_FINGERPRINT_EXCLUDES = (":(exclude,glob).workpilot*", ":(exclude,glob).workpilot*/**")


@dataclass(frozen=True)
class Reviewer:
    provider: str
    model: str
    effort: str | None = None

    def label(self) -> str:
        return f"{self.provider} / {self.model}"


@dataclass
class Verdict:
    verdict: str
    summary: str = ""
    findings: list[dict[str, Any]] = field(default_factory=list)
    note: str = ""
    """Why the answer was read as it was, when it was not taken at its word."""

    def blocking(self) -> list[dict[str, Any]]:
        return [f for f in self.findings if f.get("severity") == "blocker"]


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _clip(value: Any, limit: int = MAX_TEXT) -> str:
    return " ".join(str(value or "").split())[:limit]


# ── Reading the answer ──────────────────────────────────────────────────


def _candidates(text: str) -> list[dict[str, Any]]:
    """Every JSON object in `text` that carries a ``verdict`` key."""
    decoder = json.JSONDecoder()
    found: list[dict[str, Any]] = []
    index = text.find("{")
    while index != -1:
        try:
            value, end = decoder.raw_decode(text, index)
        except ValueError:
            index = text.find("{", index + 1)
            continue
        if isinstance(value, dict) and "verdict" in value:
            found.append(value)
        index = text.find("{", end)
    return found


def _finding(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    issue = _clip(raw.get("issue") or raw.get("description"))
    if not issue:
        return None
    severity = str(raw.get("severity", "")).strip().lower()
    line = raw.get("line")
    return {
        "severity": severity if severity in SEVERITIES else "minor",
        "file": _clip(raw.get("file"), 300),
        "line": line if isinstance(line, int) and line > 0 else None,
        "issue": issue,
    }


def parse_verdict(text: str | None) -> Verdict:
    """The reviewer's answer as a verdict. Anything unclear is ``inconclusive``.

    The last JSON object with a ``verdict`` key is the answer: a model that
    drafts, then corrects itself, ends with the version it means.
    """
    candidates = _candidates(text or "")
    if not candidates:
        return Verdict("inconclusive", note="the reviewer gave no JSON verdict")
    raw = candidates[-1]
    said = str(raw.get("verdict", "")).strip().lower()
    findings = [
        f
        for f in (_finding(item) for item in (raw.get("findings") or [])[:MAX_FINDINGS])
        if f is not None
    ]
    verdict = Verdict("inconclusive", _clip(raw.get("summary")), findings)
    blockers = verdict.blocking()
    if said == "agree" and not blockers:
        verdict.verdict = "agree"
    elif said == "disagree" and blockers:
        verdict.verdict = "disagree"
    elif said == "agree":
        verdict.note = "the reviewer agreed and listed a blocking problem"
    elif said == "disagree":
        verdict.note = "the reviewer disagreed without naming a blocking problem"
    else:
        verdict.note = f"unknown verdict {said!r}"
    return verdict


# ── What was reviewed ───────────────────────────────────────────────────


def _git(cwd: Path, *args: str, env: dict[str, str] | None = None) -> tuple[int, str]:
    from foundation.git_executable import get_git_executable

    try:
        done = subprocess.run(  # noqa: S603 - fixed argv, no shell
            [get_git_executable(), *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            check=False,
            env=env,
        )
    except (OSError, subprocess.SubprocessError):
        return 1, ""
    return done.returncode, done.stdout


def tree_fingerprint(worktree: Path) -> str | None:
    """The git tree of the worktree's content, committed or not; None if unknown.

    Built in a throwaway index, so the worktree's own index is never touched.
    Ignored files are left out, as they are from a commit.
    """
    with tempfile.TemporaryDirectory(prefix="workpilot-xr-") as tmp:
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(tmp) / "index")}
        code, _ = _git(worktree, "read-tree", "HEAD", env=env)
        if code != 0:
            return None
        code, _ = _git(
            worktree, "add", "-A", "--", ".", *_FINGERPRINT_EXCLUDES, env=env
        )
        if code != 0:
            return None
        code, out = _git(worktree, "write-tree", env=env)
    tree = out.strip()
    return tree if code == 0 and tree else None


# ── The record ──────────────────────────────────────────────────────────


def write_verdict(
    spec_dir: Path,
    verdict: Verdict,
    reviewer: Reviewer,
    fingerprint: str | None,
    build_provider: str | None,
) -> dict[str, Any] | None:
    record = {
        "version": 1,
        "verdict": verdict.verdict,
        "summary": verdict.summary,
        "findings": verdict.findings,
        "note": verdict.note,
        "provider": reviewer.provider,
        "model": reviewer.model,
        "build_provider": build_provider or "",
        "tree": fingerprint or "",
        "at": _now(),
    }
    path = spec_dir / VERDICT_FILE
    try:
        partial = path.with_suffix(".json.partial")
        partial.write_text(
            json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        os.replace(partial, path)
    except OSError as exc:
        logger.warning("could not write the cross review: %s", exc)
        return None
    _persist_plan_summary(spec_dir, record)
    return record


def _persist_plan_summary(spec_dir: Path, record: dict[str, Any]) -> None:
    """``crossReview`` in `implementation_plan.json`, for the card's badge.

    The Kanban reads the plan, not the record (as `verify` and `goal` do).
    Merged into whatever the plan holds; a plan that cannot be read is left
    alone, and the record stays the source the pull request step reads.
    """
    path = spec_dir / "implementation_plan.json"
    try:
        plan = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(plan, dict):
        return
    plan["crossReview"] = {
        "verdict": record["verdict"],
        "provider": record["provider"],
        "model": record["model"],
        "blockers": sum(
            1 for f in record["findings"] if f.get("severity") == "blocker"
        ),
        "summary": (record["summary"] or record["note"])[:300],
        "at": record["at"],
    }
    partial = path.with_suffix(".json.xr-partial")
    try:
        partial.write_text(
            json.dumps(plan, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        os.replace(partial, path)
    except OSError as exc:
        logger.debug("cross review: could not update the plan summary: %s", exc)


def read_verdict(spec_dir: Path) -> dict[str, Any] | None:
    try:
        record = json.loads((spec_dir / VERDICT_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(record, dict) or record.get("verdict") not in VERDICTS:
        return None
    return record


def blocking_verdict(spec_dirs: list[Path], worktree: Path) -> dict[str, Any] | None:
    """The ``disagree`` that still applies to this worktree, or None.

    The newest record among `spec_dirs` decides. A disagreement about a tree
    that is no longer the worktree's is stale and blocks nothing; so is one
    whose tree could not be computed, then or now.
    """
    records = [r for r in (read_verdict(d) for d in spec_dirs) if r is not None]
    if not records:
        return None
    newest = max(records, key=lambda r: str(r.get("at", "")))
    if newest["verdict"] != "disagree" or not newest.get("tree"):
        return None
    current = tree_fingerprint(worktree)
    if current is None or current != newest["tree"]:
        return None
    return newest


def refusal_message(record: dict[str, Any]) -> str:
    """What the person reads when the pull request is held back."""
    blockers = [f for f in record.get("findings", []) if f.get("severity") == "blocker"]
    lines = [
        f"Cross review by {record.get('provider')} / {record.get('model')} "
        f"disagrees with this change ({len(blockers)} blocking problem(s)):"
    ]
    for finding in blockers[:5]:
        where = finding.get("file") or "?"
        if finding.get("line"):
            where += f":{finding['line']}"
        lines.append(f"- {where}: {finding.get('issue', '')}")
    lines.append(
        "Fix the code and run the build again, or create the pull request anyway."
    )
    return "\n".join(lines)
