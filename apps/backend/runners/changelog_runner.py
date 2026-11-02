#!/usr/bin/env python3
"""
Changelog Runner

Builds a project's changelog from its done cards or its git history, with
the prompts of the desktop generator, and one model call through the active
provider (``core.oneshot``, routed like ``core.client``; text only, no tool).
The server runs it as a job on a server project's clone
(``shared_features.analyses``), which saves the result as the project's
shared report.

Usage:
    changelog_runner.py --project-path <clone> --options=<json>

``--options`` is a ``changelog_generator.options.ChangelogOptions``, checked
again here.

Output protocol (one line each, prefixed):
    CHANGELOG_EVENT:{"stage": "...", "progress": 0-100, "message": "..."}
    CHANGELOG_RESULT:{"changelog": "...", "version": "...", ...}
    CHANGELOG_ERROR:<message>
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent.parent))

from changelog_generator import cards, git_history  # noqa: E402
from changelog_generator.options import ChangelogOptions  # noqa: E402
from changelog_generator.prompts import (  # noqa: E402
    build_git_prompt,
    build_tasks_prompt,
    extract_changelog,
)


def _emit(prefix: str, payload: Any) -> None:
    text = payload if isinstance(payload, str) else json.dumps(payload)
    print(f"{prefix}:{text}", flush=True)


def _progress(stage: str, progress: int, message: str) -> None:
    _emit("CHANGELOG_EVENT", {"stage": stage, "progress": progress, "message": message})


class ChangelogError(Exception):
    """A reason the changelog could not be built, said to the person."""


def build_prompt(root: Path, options: ChangelogOptions) -> tuple[str, int]:
    """The prompt and how many cards or commits it covers."""
    if options.source_mode == "tasks":
        _progress("loading_specs", 10, "Preparing changelog generation...")
        found = cards.done_cards(root, options.task_ids)
        if not found:
            raise ChangelogError("None of the chosen cards is done on the board")
        return build_tasks_prompt(options, found), len(found)
    _progress("loading_commits", 10, "Loading commits...")
    if options.source_mode == "branch-diff" and options.branch_diff:
        commits = git_history.branch_diff_commits(root, options.branch_diff)
        if not commits:
            raise ChangelogError("No commits found between the specified branches")
    elif options.git_history:
        commits = git_history.history_commits(root, options.git_history)
        if not commits:
            raise ChangelogError("No commits found for the specified range")
    else:
        raise ChangelogError("Say which commits")
    return build_git_prompt(options, commits), len(commits)


def _complete(prompt: str, root: Path) -> str:
    """One text completion by the active provider; the reason it gave if it failed."""
    from core.oneshot import oneshot_completion

    reasons: list[str] = []

    def failed(detail: dict) -> None:
        # Already redacted (``foundation.error_details``).
        if isinstance(detail.get("message"), str):
            reasons.append(detail["message"])

    answer = asyncio.run(
        oneshot_completion(prompt, project_dir=str(root), on_error=failed)
    )
    if not answer and reasons:
        raise ChangelogError(reasons[-1])
    return answer


def run(root: Path, options: ChangelogOptions, complete=None) -> dict[str, Any]:
    """Build the changelog; ``complete`` stands in for the model in tests."""
    prompt, count = build_prompt(root, options)
    _progress("generating", 30, "Generating changelog...")
    answer = (complete or (lambda p: _complete(p, root)))(prompt)
    changelog = extract_changelog(answer or "")
    if not changelog:
        raise ChangelogError("The model returned no changelog")
    _progress("formatting", 90, "Formatting changelog...")
    return {
        "changelog": changelog,
        "version": options.version,
        "date": options.date,
        "sourceMode": options.source_mode,
        "format": options.format,
        "audience": options.audience,
        "itemsIncluded": count,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build a project's changelog")
    parser.add_argument("--project-path", required=True)
    parser.add_argument("--options", required=True)
    args = parser.parse_args(argv)
    root = Path(args.project_path).resolve()
    try:
        options = ChangelogOptions.model_validate_json(args.options)
    except ValueError:
        _emit("CHANGELOG_ERROR", "Invalid options")
        return 1
    try:
        result = run(root, options)
    except ChangelogError as e:
        _emit("CHANGELOG_ERROR", str(e))
        return 1
    _progress("complete", 100, "Changelog generation complete")
    _emit("CHANGELOG_RESULT", result)
    return 0


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    sys.exit(main())
