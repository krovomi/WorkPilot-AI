"""The rewrite of a branch, end to end: plan, preview, apply, record.

``make_plan`` reads the commits of ``base..HEAD`` (base: where the branch left
its default branch, or the commit the person chose), detects the convention,
builds the plan by rules and, when asked, lets the model word the subjects.
It also says what the rewrite would cost: signed commits whose signature goes,
commits already on a remote (replacing them there would need a force push,
which WorkPilot never does), merge commits (the range must start after them).

``apply`` replays the plan the page sent back (``apply.py``) and records it.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from foundation.git_executable import run_git

from . import history
from .apply import apply_plan
from .commits import (
    SurgeonError,
    current_branch,
    default_base,
    read_range,
    recent_subjects,
    verify,
)
from .conventions import detect_convention, readability
from .messages import reword
from .planner import build_plan, first_rewritten, score


def _remotes_holding(repo: Path, sha: str) -> list[str]:
    result = run_git(
        ["branch", "-r", "--contains", sha, "--format=%(refname:short)"],
        cwd=repo,
        timeout=60,
    )
    if result.returncode != 0:
        return []
    return [r for r in result.stdout.split() if r and not r.endswith("/HEAD")][:5]


def make_plan(
    repo: Path,
    base: str | None = None,
    *,
    ai: bool = False,
    ask: Callable[[str, str | None], str] | None = None,
) -> dict[str, object]:
    base_sha = verify(repo, base) if base else default_base(repo)
    head_sha = verify(repo, "HEAD")
    commits = read_range(repo, base_sha, head_sha)
    convention = detect_convention(repo, recent_subjects(repo))
    warnings: list[dict[str, object]] = []
    merges = [c for c in commits if c.is_merge]
    blocked = "merges" if merges else ""
    steps = [] if blocked else build_plan(commits, convention)
    reworded_by_model = 0
    if steps and ai:
        reworded_by_model = reword(steps, commits, convention, str(repo), ask)
    kept = first_rewritten(commits, steps) if steps else len(commits)
    rewritten = commits[kept:]
    signed = [c for c in rewritten if c.signed]
    if signed:
        warnings.append({"code": "signed", "count": len(signed)})
    if rewritten:
        remotes = _remotes_holding(repo, rewritten[0].sha)
        if remotes:
            warnings.append(
                {"code": "pushed", "count": len(rewritten), "remotes": remotes}
            )
    if merges:
        warnings.append(
            {"code": "merges", "count": len(merges), "after": merges[-1].sha}
        )
    return {
        "base": base_sha,
        "head": head_sha,
        "branch": current_branch(repo),
        "convention": convention.to_dict(),
        "before": readability([c.subject for c in commits], convention),
        "after": score([s.message for s in steps], convention) if steps else None,
        "commits": [c.to_dict() for c in commits],
        "plan": [s.to_dict() for s in steps],
        "keptCommits": kept,
        "warnings": warnings,
        "blocked": blocked,
        "messagesBy": "model" if reworded_by_model else "rules",
        "modelMessages": reworded_by_model,
    }


def apply(
    repo: Path, base: str, head: str, plan: object, branch: str | None = None
) -> dict[str, object]:
    result = apply_plan(repo, base, head, plan, branch=branch)
    commits = read_range(repo, str(result["base"]), str(result["source"]))
    convention = detect_convention(repo, recent_subjects(repo))
    after_subjects = run_git(
        ["log", "--format=%s", f"{result['base']}..{result['head']}"], cwd=repo
    ).stdout.splitlines()
    result["before"] = readability([c.subject for c in commits], convention)
    result["after"] = readability(after_subjects, convention)
    history.record(
        repo,
        {
            "at": history.now_iso(),
            "branch": result["branch"],
            "source": result["source"],
            "head": result["head"],
            "counts": result["counts"],
            "before": result["before"]["percent"],  # type: ignore[index]
            "after": result["after"]["percent"],  # type: ignore[index]
        },
    )
    return result


__all__ = ["SurgeonError", "apply", "make_plan"]
