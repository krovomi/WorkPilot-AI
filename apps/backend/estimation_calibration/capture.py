"""At merge, the spec's estimate against what it actually used.

A ``core.merge_event`` subscriber. Only a merged spec feeds the dataset: a
spec that is discarded or abandoned never publishes a merge, so it cannot
bias the calibration. The estimate is the one the Smart Estimation dialog
kept on the task (``task_metadata.json``, ``smartEstimate``); the actuals are
read where the build already left them, whatever provider ran it:

- cost and tokens: the project's ``.workpilot/cost_data.json`` (every
  session of every provider is recorded there by ``core.usage_tracker``);
- QA iterations: the spec's ``implementation_plan.json``;
- files changed: the merge's diff, through ``foundation.git_executable``.

No duration is read or kept. Every value read from disk is checked (closed
category list, finite positive numbers); the spec name is a plain name.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from foundation.git_executable import run_git

from .categories import valid_category
from .model import METRICS, positive
from .store import record_sample

_SPEC_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}")


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _spec_dirs(root: Path, spec: str) -> list[Path]:
    """The spec's folder in the project, then in its task worktree."""
    specs = Path(".workpilot") / "specs" / spec
    return [root / specs, root / ".workpilot" / "worktrees" / "tasks" / spec / specs]


def read_estimate(root: Path, spec: str) -> dict[str, Any] | None:
    """The estimate the dialog kept on the task, validated; None without one."""
    meta = _read_json(_spec_dirs(root, spec)[0] / "task_metadata.json") or {}
    estimate = meta.get("smartEstimate")
    inputs = estimate.get("calibrationInputs") if isinstance(estimate, dict) else None
    if not isinstance(inputs, dict):
        return None
    estimated: dict[str, float] = {}
    shown: dict[str, float] = {}
    for metric in METRICS:
        row = inputs.get(metric)
        if not isinstance(row, dict):
            continue
        base = positive(row.get("base"))
        if base is not None:
            estimated[metric] = base
            shown[metric] = positive(row.get("value")) or base
    if not estimated:
        return None
    return {
        "category": valid_category(estimate.get("category")) or "feature",
        "estimated": estimated,
        "shown": shown,
        "adjusted": isinstance(estimate.get("adjustedScore"), int),
    }


def read_usage(root: Path, spec: str) -> dict[str, Any]:
    """Cost, tokens and the provider that spent the most tokens on *spec*."""
    data = _read_json(root / ".workpilot" / "cost_data.json") or {}
    usages = data.get("usages")
    cost = 0.0
    tokens = 0.0
    by_provider: dict[str, float] = {}
    for usage in usages if isinstance(usages, list) else []:
        if not isinstance(usage, dict) or usage.get("spec_id") != spec:
            continue
        cost += positive(usage.get("cost")) or 0.0
        spent = (positive(usage.get("input_tokens")) or 0.0) + (
            positive(usage.get("output_tokens")) or 0.0
        )
        tokens += spent
        provider = usage.get("provider")
        if isinstance(provider, str) and provider:
            by_provider[provider] = by_provider.get(provider, 0.0) + spent
    provider = max(by_provider, key=by_provider.__getitem__) if by_provider else None
    return {"cost_usd": cost, "tokens": tokens, "provider": provider}


def read_qa_iterations(root: Path, spec: str) -> int:
    """The QA iterations the spec went through, from either copy of its plan."""
    best = 0
    for folder in _spec_dirs(root, spec):
        plan = _read_json(folder / "implementation_plan.json") or {}
        signoff = plan.get("qa_signoff")
        stats = plan.get("qa_stats")
        for value in (
            signoff.get("qa_session") if isinstance(signoff, dict) else None,
            stats.get("total_iterations") if isinstance(stats, dict) else None,
        ):
            if positive(value) is not None:
                best = max(best, int(value))
    return best


def read_files_changed(root: Path, spec: str) -> int:
    """Files the merge brought: staged, else the spec's branch against HEAD's first parent."""
    staged = run_git(["diff", "--cached", "--name-only"], cwd=root, timeout=30)
    text = staged.stdout if staged.returncode == 0 else ""
    if not text.strip():
        ranged = run_git(
            ["diff", "--name-only", f"HEAD^1...workpilot/{spec}", "--"],
            cwd=root,
            timeout=30,
        )
        text = ranged.stdout if ranged.returncode == 0 else ""
    return len([line for line in text.splitlines() if line.strip()])


def capture(root: Path, spec: str) -> dict[str, Any] | None:
    """The sample of a merged *spec*, or None when it was never estimated."""
    if not _SPEC_NAME.fullmatch(spec):
        return None
    estimate = read_estimate(root, spec)
    if estimate is None:
        return None
    usage = read_usage(root, spec)
    actual = {
        "cost_usd": usage["cost_usd"],
        "tokens": usage["tokens"],
        "qa_iterations": read_qa_iterations(root, spec),
        "files": read_files_changed(root, spec),
    }
    return {"spec": spec, "provider": usage["provider"], "actual": actual, **estimate}


def on_merge(event) -> None:
    """`core.merge_event` subscriber: keep the merged spec's estimate against its actuals."""
    root = Path(event.project_dir)
    sample = capture(root, event.spec_name)
    if sample is not None:
        record_sample(root, sample)
