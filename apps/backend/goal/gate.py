"""The goal gate: what the QA loop and the build ask before calling a task done.

Order of the checks, each one before the next because it removes a false
positive the next one would let through:

1. the goal file reads (``invalid`` otherwise: a person fixes the goal);
2. the protected paths are untouched (``unmet``, and the fixer is told to
   restore them; ``error`` when the change set cannot be read);
3. the command exits with the expected code (``met`` / ``unmet`` / ``error``).

The spending cap is separate (``budget_exceeded``): it is read before a pass
starts, so a pass is never begun once the cap is reached.

Every verdict is written to ``<spec>/goal_result.json``, and a short summary
to ``implementation_plan.json`` (``goal``) for the card, the same way the
verification loop does.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from .check import GoalRun, command_script, run_goal
from .protect import protected_changes
from .spec import GoalConfigError, GoalSpec, load_goal
from .spend import TaskSpend, task_spend

logger = logging.getLogger(__name__)

__all__ = [
    "GOAL_ISSUE_TITLE",
    "GoalVerdict",
    "budget_exceeded",
    "evaluate_goal",
    "fix_request",
    "read_goal",
    "record_verdict",
]

RESULT_FILENAME = "goal_result.json"
GOAL_ISSUE_TITLE = "Goal not met"
# The order `prompts_pkg.prompts._detect_base_branch` creates worktrees from.
_FALLBACK_BASES = ("main", "master", "develop")


@dataclass
class GoalVerdict:
    status: str
    """``met``, ``unmet``, ``error``, ``invalid`` or ``budget``."""
    reason: str
    spec: GoalSpec | None = None
    run: GoalRun | None = None
    protected_changed: list[str] = field(default_factory=list)
    spend: TaskSpend | None = None

    @property
    def met(self) -> bool:
        return self.status == "met"

    @property
    def fixable(self) -> bool:
        """Whether the fixer can act on it: only a definite ``unmet``."""
        return self.status == "unmet"

    def issues(self) -> list[dict]:
        if not self.fixable:
            return []
        return [
            {
                "title": GOAL_ISSUE_TITLE,
                "description": self.reason,
                "type": "goal",
                "severity": "critical",
            }
        ]

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "reason": self.reason,
            "goal": self.spec.to_dict() if self.spec else None,
            "run": self.run.to_dict() if self.run else None,
            "protected_changed": self.protected_changed,
            "spent_usd": self.spend.usd if self.spend else None,
            "spend_complete": self.spend.complete if self.spend else None,
            "at": datetime.now(UTC).isoformat(),
        }


def read_goal(
    spec_dir: Path, source_spec_dir: Path | None = None
) -> tuple[GoalSpec | None, GoalVerdict | None]:
    """The goal, or the ``invalid`` verdict that says why it cannot be read."""
    try:
        return load_goal(source_spec_dir, spec_dir), None
    except GoalConfigError as exc:
        return None, GoalVerdict("invalid", f"the goal cannot be checked: {exc}")


_BRANCH = re.compile(r"^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$")


def _task_branch_settings(spec_dir: Path) -> tuple[str | None, bool]:
    """``baseBranch`` and ``useLocalBranch`` from the task's metadata."""
    try:
        meta = json.loads((spec_dir / "task_metadata.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None, False
    if not isinstance(meta, dict):
        return None, False
    base = meta.get("baseBranch")
    base = base if isinstance(base, str) and _BRANCH.match(base) else None
    return base, meta.get("useLocalBranch") is True


def _bases(spec_dir: Path, source_spec_dir: Path | None) -> list[str]:
    """The refs the task may have forked from, the likeliest first.

    The remote ref comes before the local one: a worktree is created from
    ``origin/<base>``, and a local branch left behind it would put the base's
    own later commits in the task's change set.
    """
    base, local_first = _task_branch_settings(source_spec_dir or spec_dir)
    names = [base] if base else []
    env_base = os.environ.get("DEFAULT_BRANCH", "").strip()
    if env_base and _BRANCH.match(env_base) and env_base not in names:
        names.append(env_base)
    names += [n for n in _FALLBACK_BASES if n not in names]
    refs: list[str] = []
    for name in names:
        refs += [name, f"origin/{name}"] if local_first else [f"origin/{name}", name]
    return refs


def budget_exceeded(
    spec: GoalSpec, spec_dir: Path, source_spec_dir: Path | None = None
) -> GoalVerdict | None:
    """The ``budget`` verdict once the task's spend reaches the goal's cap."""
    if spec.max_cost_usd is None:
        return None
    spend = task_spend(source_spec_dir, spec_dir)
    if spend.usd < spec.max_cost_usd:
        return None
    floor = "" if spend.complete else "at least "
    return GoalVerdict(
        "budget",
        f"the task has spent {floor}${spend.usd:.2f} of its "
        f"${spec.max_cost_usd:.2f} cap",
        spec=spec,
        spend=spend,
    )


def evaluate_goal(
    spec: GoalSpec,
    worktree: Path,
    spec_dir: Path,
    source_spec_dir: Path | None = None,
    *,
    runner=run_goal,
) -> GoalVerdict:
    """Check the goal against the worktree as it stands. Never raises."""
    spend = task_spend(source_spec_dir, spec_dir)
    try:
        patterns = list(spec.protected)
        script = command_script(spec, worktree)
        if script and script not in patterns:
            patterns.append(script)
        if patterns:
            changed = protected_changes(
                worktree, _bases(spec_dir, source_spec_dir), patterns
            )
            if changed is None:
                return GoalVerdict(
                    "error",
                    "the task's change set cannot be read, so the protected "
                    "paths cannot be shown untouched",
                    spec=spec,
                    spend=spend,
                )
            if changed:
                shown = ", ".join(changed[:10]) + (" …" if len(changed) > 10 else "")
                return GoalVerdict(
                    "unmet",
                    "the task changed paths the goal protects: "
                    f"{shown}. Restore them to their state on the base branch; "
                    "the goal is met by changing the code, not its checks.",
                    spec=spec,
                    protected_changed=changed,
                    spend=spend,
                )
        run = runner(spec, worktree)
    except Exception as exc:  # noqa: BLE001 - a gate reports, it does not crash
        logger.warning("goal check failed: %s", exc)
        return GoalVerdict(
            "error", f"the goal check failed: {exc}", spec=spec, spend=spend
        )

    if run.status == "met":
        reason = f"`{spec.command}` exited {run.exit_code} as expected"
    elif run.status == "unmet":
        reason = f"`{spec.command}`: {run.detail}"
    else:
        reason = f"`{spec.command}`: {run.detail}"
    return GoalVerdict(run.status, reason, spec=spec, run=run, spend=spend)


def fix_request(verdict: GoalVerdict, spec_dir: Path) -> str:
    """``QA_FIX_REQUEST.md`` for an unmet goal. The output is quoted (S2)."""
    from security.untrusted import quote_untrusted

    spec = verdict.spec
    lines = [
        "# QA Fix Request — Goal not met",
        "",
        "**Status**: REJECTED (goal gate)",
        "",
        "The task is done when this command exits with the expected code. It did not.",
        "",
        f"- Command: `{spec.command if spec else '?'}`",
        f"- Expected exit code: {spec.expected_exit if spec else '?'}",
        f"- Result: {verdict.reason}",
        "",
    ]
    if spec and spec.protected:
        lines += [
            "These paths define the goal and must stay as they are on the base "
            "branch: " + ", ".join(f"`{p}`" for p in spec.protected),
            "",
        ]
    if verdict.run and verdict.run.output_tail:
        lines += [
            "## End of the command's output",
            "",
            quote_untrusted(
                verdict.run.output_tail,
                kind="tool_output",
                source="goal command output",
                spec_dir=spec_dir,
            ),
            "",
        ]
    lines += [
        "## What to do",
        "",
        "Fix the code so the command passes. Do not skip, delete or weaken a "
        "test, and do not change the command's own script or the CI "
        "configuration: the change set is checked, and such a fix is refused.",
        "",
    ]
    return "\n".join(lines)


def record_verdict(verdict: GoalVerdict, spec_dir: Path) -> None:
    """Write the verdict and the card's summary. Never raises."""
    data = verdict.to_dict()
    try:
        path = Path(spec_dir) / RESULT_FILENAME
        if not path.is_symlink():
            partial = path.with_suffix(".json.partial")
            partial.write_text(
                json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
            )
            os.replace(partial, path)
    except OSError as exc:
        logger.debug("goal: could not write %s: %s", RESULT_FILENAME, exc)

    plan_path = Path(spec_dir) / "implementation_plan.json"
    try:
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(plan, dict):
        return
    plan["goal"] = {
        "status": data["status"],
        "reason": data["reason"][:300],
        "spentUsd": data["spent_usd"],
        "spendComplete": data["spend_complete"],
        "at": data["at"],
    }
    try:
        partial = plan_path.with_suffix(".json.goal-partial")
        partial.write_text(
            json.dumps(plan, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        os.replace(partial, plan_path)
    except OSError as exc:
        logger.debug("goal: could not update the plan summary: %s", exc)
