"""
Git Surgeon Runner

Default: analyses git history for large blobs, sensitive data, and messy
commits. ``--plan`` plans the rewrite of the current branch (``--base`` the
commit to start from, ``--ai`` lets the configured model word the subjects),
``--apply FILE`` replays a plan on a new branch, ``--branches`` lists the
local branches, ``--delete-branches FILE`` deletes merged ones, ``--history``
gives the monthly counts. FILE is a JSON file main wrote.

Output protocol (one JSON object per line, prefixed):
    GIT_SURGEON_EVENT:{"type": "progress", "data": {"status": "..."}}
    GIT_SURGEON_RESULT:{...plan dict...}
    GIT_SURGEON_ERROR:<message>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from git_surgeon import (  # noqa: E402
    SurgeonError,
    apply,
    delete_merged,
    list_branches,
    make_plan,
)
from git_surgeon import history as surgeon_history  # noqa: E402
from git_surgeon.history_analyzer import (  # noqa: E402
    HistoryAnalyzer,
    SurgeryPlan,
)

MAX_INPUT_BYTES = 2 * 1024 * 1024


def _emit(prefix: str, payload: Any) -> None:
    print(f"{prefix}:{json.dumps(payload, default=str)}", flush=True)


def _emit_event(event_type: str, data: dict[str, Any]) -> None:
    _emit("GIT_SURGEON_EVENT", {"type": event_type, "data": data})


def _plan_to_dict(plan: SurgeryPlan) -> dict[str, Any]:
    return {
        "issues": [
            {
                "issueType": issue.issue_type.value,
                "severity": issue.severity,
                "description": issue.description,
                "commitSha": issue.commit_sha,
                "filePath": issue.file_path,
                "sizeBytes": issue.size_bytes,
                "suggestedAction": issue.suggested_action.value,
            }
            for issue in plan.issues
        ],
        "actions": [
            {"action": action.value, "description": description}
            for action, description in plan.actions
        ],
        "estimatedSizeSavingsMb": plan.estimated_size_savings_mb,
        "requiresForcePush": plan.requires_force_push,
        "summary": plan.summary,
    }


def run_scan(project_path: Path, max_commits: int) -> dict[str, Any]:
    if not (project_path / ".git").exists():
        return {
            "issues": [],
            "actions": [],
            "estimatedSizeSavingsMb": 0.0,
            "requiresForcePush": False,
            "summary": "Project is not a git repository",
        }

    _emit_event("start", {"status": "Analyzing git history..."})
    analyzer = HistoryAnalyzer(repo_root=project_path)
    plan = analyzer.analyze(max_commits=max_commits)
    _emit_event(
        "complete",
        {"issues": len(plan.issues), "savingsMb": plan.estimated_size_savings_mb},
    )
    return _plan_to_dict(plan)


def _read_input(path: str) -> Any:
    file = Path(path)
    if file.is_symlink() or not file.is_file() or file.stat().st_size > MAX_INPUT_BYTES:
        raise SurgeonError("the input file is missing or too big")
    return json.loads(file.read_text(encoding="utf-8"))


def run_mode(args: argparse.Namespace, project_path: Path) -> dict[str, Any]:
    if args.plan:
        _emit_event("start", {"status": "plan"})
        return make_plan(project_path, args.base or None, ai=args.ai)
    if args.apply:
        data = _read_input(args.apply)
        if not isinstance(data, dict):
            raise SurgeonError("the plan file holds no plan")
        _emit_event("start", {"status": "apply"})
        return apply(
            project_path,
            str(data.get("base", "")),
            str(data.get("head", "")),
            data.get("plan"),
            data.get("branch") if isinstance(data.get("branch"), str) else None,
        )
    if args.branches:
        return list_branches(project_path)
    if args.delete_branches:
        return delete_merged(project_path, _read_input(args.delete_branches))
    if args.history:
        return {"months": surgeon_history.monthly(project_path)}
    return run_scan(project_path, args.max_commits)


def main() -> None:
    parser = argparse.ArgumentParser(description="Git Surgeon Runner")
    parser.add_argument("--project-path", required=True, help="Project root path")
    parser.add_argument(
        "--max-commits",
        type=int,
        default=500,
        help="Maximum commits to analyse",
    )
    parser.add_argument(
        "--plan", action="store_true", help="Plan the rewrite of the current branch"
    )
    parser.add_argument("--base", default="", help="Commit to start the rewrite from")
    parser.add_argument(
        "--ai", action="store_true", help="Let the configured model word the subjects"
    )
    parser.add_argument(
        "--apply", default="", help="JSON file holding the plan to replay"
    )
    parser.add_argument(
        "--branches", action="store_true", help="List the local branches"
    )
    parser.add_argument(
        "--delete-branches",
        default="",
        help="JSON file listing merged branches to delete",
    )
    parser.add_argument(
        "--history", action="store_true", help="Monthly counts of applied plans"
    )
    args = parser.parse_args()

    project_path = Path(args.project_path)
    if not project_path.exists():
        _emit("GIT_SURGEON_ERROR", f"Project path does not exist: {project_path}")
        sys.exit(1)
    if args.max_commits < 1 or args.max_commits > 5000:
        _emit("GIT_SURGEON_ERROR", "--max-commits must be between 1 and 5000")
        sys.exit(1)

    try:
        _emit("GIT_SURGEON_RESULT", run_mode(args, project_path))
    except (SurgeonError, ValueError, OSError) as exc:
        _emit("GIT_SURGEON_ERROR", str(exc))
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001
        _emit("GIT_SURGEON_ERROR", str(exc))
        sys.exit(1)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
