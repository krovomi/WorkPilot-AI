"""
PR follow-through runner — spawned by the Electron main process for one task.

Reads the task's pull request, and while a check fails or a review thread
waits, runs the QA fixer in the task's worktree and pushes the fix (never
forced). Stops on green, merged, closed, a failure that is red on the base
branch too, the round cap, or anything it cannot judge.

One JSON line per look at the PR on stdout:

  {"event": "round", "round": {...RoundResult.to_dict()...}}

and a last line:

  {"result": {...the last round...}}      or      {"error": "..."}

Usage::

    python pr_followup_runner.py --project-dir <root> --spec-dir <spec> \\
        --spec-name <name> --pr-url <url> [--once] [--interval 60] \\
        [--max-polls 240] [--max-rounds 3] [--no-review-threads]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from pathlib import Path

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from pr_followup.forge import forge_for_url  # noqa: E402
from pr_followup.loop import RoundResult, run_round  # noqa: E402
from pr_followup.policy import DEFAULT_MAX_ROUNDS, FollowupConfig  # noqa: E402

_SPEC_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
MIN_INTERVAL_SECONDS = 15


def _emit(payload: dict) -> None:
    print(json.dumps(payload), flush=True)


def _resolve_inputs(args: argparse.Namespace) -> tuple[Path, Path, Path]:
    """project, spec and worktree directories, resolved and contained."""
    if not _SPEC_NAME.match(args.spec_name or ""):
        raise ValueError("invalid spec name")
    project = Path(args.project_dir).resolve(strict=True)
    worktree = (
        Path(args.worktree_dir).resolve(strict=True)
        if args.worktree_dir
        else (project / ".workpilot" / "worktrees" / "tasks" / args.spec_name).resolve(
            strict=True
        )
    )
    spec = Path(args.spec_dir).resolve(strict=True)
    for path, name in ((worktree, "worktree"), (spec, "spec directory")):
        if path == project or not path.is_relative_to(project):
            raise ValueError(f"the {name} is outside the project")
    return project, spec, worktree


async def _qa_fixer(
    worktree_dir: Path, spec_dir: Path, session: int
) -> tuple[str, str]:
    from core.client import create_agent_client
    from phase_config import (
        get_phase_model,
        get_phase_provider,
        get_phase_thinking_budget,
    )
    from qa.fixer import run_qa_fixer_session
    from security.constants import PROJECT_DIR_ENV_VAR

    os.environ[PROJECT_DIR_ENV_VAR] = str(worktree_dir)
    client = create_agent_client(
        project_dir=worktree_dir,
        spec_dir=spec_dir,
        model=get_phase_model(spec_dir, "qa"),
        agent_type="qa_fixer",
        max_thinking_tokens=get_phase_thinking_budget(spec_dir, "qa"),
        # The task owns its engine: the fix runs on the task's QA provider.
        provider=get_phase_provider(spec_dir, phase="qa"),
    )
    async with client:
        return await run_qa_fixer_session(
            client, spec_dir, session, False, project_dir=worktree_dir
        )


def _pusher(project: Path, spec_name: str):
    def push() -> tuple[bool, str]:
        from core.worktree import WorktreeManager

        result = WorktreeManager(project).push_branch(spec_name, force=False)
        return bool(result.get("success")), str(result.get("error") or "")

    return push


def _learn_from_review(project: Path, pr_url: str, result: RoundResult) -> None:
    """A review thread fixed and pushed becomes a rule candidate (IA1).

    Nothing reaches a prompt from here: a person adopts or dismisses it in the
    Learning Loop.
    """
    if result.action != "fixed" or not result.decision.threads:
        return
    from learning_loop.review_lessons import record_review_threads

    record_review_threads(project, pr_url, result.decision.threads)


async def _run(args: argparse.Namespace) -> int:
    project, spec, worktree = _resolve_inputs(args)
    forge = forge_for_url(args.pr_url, worktree)
    if forge is None:
        _emit(
            {
                "error": "only GitHub pull requests can be followed for now; "
                "this URL is not one"
            }
        )
        return 2
    config = FollowupConfig(
        max_rounds=max(0, args.max_rounds),
        fix_review_threads=not args.no_review_threads,
    )
    interval = max(MIN_INTERVAL_SECONDS, args.interval)
    last: RoundResult | None = None
    for _poll in range(max(1, args.max_polls)):
        last = await run_round(
            spec_dir=spec,
            worktree_dir=worktree,
            forge=forge,
            fixer=_qa_fixer,
            pusher=_pusher(project, args.spec_name),
            config=config,
        )
        _emit({"event": "round", "round": last.to_dict()})
        _learn_from_review(project, args.pr_url, last)
        if args.once or last.finished:
            break
        await asyncio.sleep(interval)
    assert last is not None
    _emit({"result": last.to_dict()})
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Drive a task's PR to merge")
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--spec-dir", required=True)
    parser.add_argument("--spec-name", required=True)
    parser.add_argument("--pr-url", required=True)
    parser.add_argument("--worktree-dir", default=None)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--interval", type=int, default=60)
    parser.add_argument("--max-polls", type=int, default=240)
    parser.add_argument("--max-rounds", type=int, default=DEFAULT_MAX_ROUNDS)
    parser.add_argument("--no-review-threads", action="store_true")
    args = parser.parse_args()
    try:
        sys.exit(asyncio.run(_run(args)))
    except Exception as exc:  # noqa: BLE001
        _emit({"error": str(exc)})
        sys.exit(1)


if __name__ == "__main__":
    from core.log_redaction import install_global_redaction

    install_global_redaction()
    main()
