"""Measure each variant and rank them, on numbers the card shows.

The criteria, in order, each one deciding only between variants the previous
ones left tied:

1. ``build``  — every subtask of the plan completed;
2. ``tests``  — the QA signed the build off (the QA runs the project's tests);
3. ``goal``   — the task's goal command (goal mode) exits as expected, checked
   again now, in each worktree, with the same gate as the QA loop;
4. ``diff``   — fewer changed lines against the fork point;
5. ``cost``   — less spent, from the usage ledger.

A criterion that cannot be read for every variant ranks nobody: a goal check
that errors, a change set that cannot be read, a cost that is only a floor
(a provider with no known price). Ranking on half the variants would put a
number the card cannot back above one it can, so the criterion is shown with
the reason it was left out. Variants still tied after the last criterion share
their rank, and no variant is recommended unless it ranks first alone.

Nothing here merges, pushes or removes anything: the person picks.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path

from foundation.git_executable import get_git_executable
from goal import evaluate_goal, read_goal
from goal.gate import fork_bases
from goal.spend import task_spend

__all__ = ["CRITERIA", "VariantScore", "measure_variant", "rank_variants"]

CRITERIA = ("build", "tests", "goal", "diff", "cost")
_UNTRACKED_READ_LIMIT = 1_000_000
# The diff value of a variant with no worktree: below any real one, and still
# a number JSON can carry (an infinity is not).
_NOTHING_BUILT = -1e18


@dataclass
class VariantScore:
    spec_id: str
    index: int
    engine: dict
    exit_code: int | None
    worktree: bool
    subtasks_done: int = 0
    subtasks_total: int = 0
    qa_status: str | None = None
    """``approved``, ``rejected``, another QA status, or None when QA never ran."""
    goal_status: str | None = None
    """The gate's verdict (``met``, ``unmet``, ``error``…), None without a goal."""
    goal_reason: str = ""
    diff_lines: int | None = None
    diff_files: int | None = None
    cost_usd: float | None = None
    cost_complete: bool = False
    rank: int | None = None
    values: dict = field(default_factory=dict)
    """Each criterion's value as ranked: higher is better."""

    @property
    def build_complete(self) -> bool:
        return self.subtasks_total > 0 and self.subtasks_done == self.subtasks_total

    def to_dict(self) -> dict:
        data = asdict(self)
        data["build_complete"] = self.build_complete
        return data


def _git(cwd: Path, *args: str) -> tuple[int, str]:
    try:
        done = subprocess.run(  # noqa: S603 - fixed argv
            [get_git_executable(), *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return 1, ""
    return done.returncode, done.stdout


def _read_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _plan_progress(plan: dict | None) -> tuple[int, int]:
    done = total = 0
    phases = plan.get("phases") if plan else None
    for phase in phases if isinstance(phases, list) else []:
        subtasks = phase.get("subtasks") if isinstance(phase, dict) else None
        for subtask in subtasks if isinstance(subtasks, list) else []:
            if not isinstance(subtask, dict):
                continue
            total += 1
            if subtask.get("status") == "completed":
                done += 1
    return done, total


def diff_size(worktree: Path, bases: list[str]) -> tuple[int, int] | None:
    """Changed lines and files against the fork point; None when unknown.

    Committed, staged and unstaged changes, plus untracked files counted
    line by line. WorkPilot's own files (``.workpilot/``) are left out.
    """
    fork = None
    for base in bases:
        code, out = _git(worktree, "merge-base", "HEAD", base)
        if code == 0 and out.strip():
            fork = out.strip()
            break
    if fork is None:
        return None
    exclude = ":(exclude).workpilot"
    code, numstat = _git(
        worktree, "diff", "--numstat", "--no-renames", fork, "--", ".", exclude
    )
    if code != 0:
        return None
    lines = files = 0
    for row in numstat.splitlines():
        parts = row.split("\t")
        if len(parts) < 3:
            continue
        files += 1
        lines += sum(int(p) for p in parts[:2] if p.isdigit())
    code, untracked = _git(
        worktree, "ls-files", "--others", "--exclude-standard", "-z", "--", ".", exclude
    )
    if code != 0:
        return None
    for name in filter(None, untracked.split("\0")):
        files += 1
        path = worktree / name
        try:
            if path.is_symlink() or not path.is_file():
                continue
            with open(path, "rb") as handle:
                data = handle.read(_UNTRACKED_READ_LIMIT)
        except OSError:
            continue
        if b"\0" not in data:
            lines += data.count(b"\n") + (1 if data and not data.endswith(b"\n") else 0)
    return lines, files


def measure_variant(
    entry: dict,
    variant_dir: Path,
    worktree: Path | None,
    parent_dir: Path,
    *,
    goal_runner=None,
) -> VariantScore:
    """What one variant built, read from its files and its worktree."""
    score = VariantScore(
        spec_id=variant_dir.name,
        index=int(entry.get("index") or 0),
        engine=dict(entry.get("engine") or {}),
        exit_code=entry.get("exitCode"),
        worktree=worktree is not None and worktree.is_dir(),
    )
    local_spec = (
        worktree / ".workpilot" / "specs" / variant_dir.name
        if worktree is not None and score.worktree
        else None
    )
    plan = None
    for candidate in (local_spec, variant_dir):
        if candidate is not None:
            plan = _read_json(candidate / "implementation_plan.json")
            if plan is not None:
                break
    score.subtasks_done, score.subtasks_total = _plan_progress(plan)
    signoff = plan.get("qa_signoff") if plan else None
    if isinstance(signoff, dict) and isinstance(signoff.get("status"), str):
        score.qa_status = signoff["status"]

    spend = task_spend(variant_dir, local_spec)
    score.cost_usd, score.cost_complete = spend.usd, spend.complete

    if not score.worktree:
        return score
    assert worktree is not None and local_spec is not None
    spec_dir = local_spec if local_spec.is_dir() else variant_dir
    measured = diff_size(worktree, fork_bases(spec_dir, variant_dir))
    if measured is not None:
        score.diff_lines, score.diff_files = measured

    # The parent's goal, read where the card writes it: the variants carry a
    # copy, but the person may have changed it since they started.
    goal, invalid = read_goal(spec_dir, parent_dir)
    if invalid is not None:
        score.goal_status, score.goal_reason = invalid.status, invalid.reason
    elif goal is not None:
        kwargs = {"runner": goal_runner} if goal_runner else {}
        verdict = evaluate_goal(goal, worktree, spec_dir, variant_dir, **kwargs)
        score.goal_status, score.goal_reason = verdict.status, verdict.reason
    return score


def _criterion_values(
    name: str, scores: list[VariantScore]
) -> tuple[list[float] | None, str]:
    """Each variant's value for ``name`` (higher is better), or why it is left out."""
    if name == "build":
        return [1.0 if s.build_complete else 0.0 for s in scores], ""
    if name == "tests":
        return [1.0 if s.qa_status == "approved" else 0.0 for s in scores], ""
    if name == "goal":
        statuses = [s.goal_status for s in scores]
        if all(status is None for status in statuses):
            return None, "no_goal"
        built = [s for s in scores if s.worktree]
        if any(s.goal_status not in ("met", "unmet") for s in built):
            return None, "goal_unchecked"
        return [1.0 if s.goal_status == "met" else 0.0 for s in scores], ""
    if name == "diff":
        if any(s.diff_lines is None for s in scores if s.worktree):
            return None, "diff_unknown"
        return [
            -float(s.diff_lines) if s.diff_lines is not None else _NOTHING_BUILT
            for s in scores
        ], ""
    if name == "cost":
        if any(not s.cost_complete for s in scores):
            return None, "cost_partial"
        return [-float(s.cost_usd or 0.0) for s in scores], ""
    raise ValueError(name)


def rank_variants(scores: list[VariantScore]) -> dict:
    """Rank in place and return the table's summary for the card."""
    used: list[str] = []
    skipped: dict[str, str] = {}
    columns: dict[str, list[float]] = {}
    for name in CRITERIA:
        values, reason = _criterion_values(name, scores)
        if values is None:
            skipped[name] = reason
            continue
        used.append(name)
        columns[name] = values
    for position, score in enumerate(scores):
        score.values = {name: columns[name][position] for name in used}

    def key(score: VariantScore) -> tuple:
        return tuple(score.values[name] for name in used)

    ordered = sorted(scores, key=key, reverse=True)
    rank = 0
    previous = None
    for position, score in enumerate(ordered, start=1):
        if key(score) != previous:
            rank, previous = position, key(score)
        score.rank = rank
    scores.sort(key=lambda s: (s.rank or 0, s.index))

    leaders = [s for s in scores if s.rank == 1]
    recommended = (
        leaders[0].spec_id
        if len(leaders) == 1 and leaders[0].worktree and leaders[0].build_complete
        else None
    )
    return {"criteria": used, "skipped": skipped, "recommended": recommended}
