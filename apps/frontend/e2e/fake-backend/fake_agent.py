"""A stand-in for the agents of a local build: everything but the model.

The Electron E2E (`e2e/kanban-flow.e2e.ts`, `e2e/journeys/`) points the app's backend folder
(`autoBuildPath`) here, so starting a card runs these scripts with the same
arguments, environment and stdout protocol as the real ones. What they do
around the model is the real backend's own code, imported from
`apps/backend`: the task and phase events (`core.task_event`,
`foundation.phase_event`), the worktree (`core.worktree.WorktreeManager`).
The forge is played too, so no pull request leaves the machine. Every
other command (`--merge`, `--merge-preview`, `--discard`...) is handed to the
real `run.py`.

The spec phase (`runners/spec_runner.py`):
  the `.workpilot/` set-up the real pipeline does first, PLANNING_STARTED, writes spec.md and a one-subtask implementation plan,
  PLANNING_COMPLETE, then the build when `--auto-approve` says so.

The build (`run.py --spec`):
  creates the task worktree, CODING_STARTED, waits until the test drops
  `e2e-release` in the spec folder (so the card can be seen running), writes
  the file the task asks for and commits it on the task branch, marks the
  subtask done, ALL_SUBTASKS_DONE, QA_STARTED, signs QA off, QA_PASSED.

The review's pull request (`run.py --analyze-impact`, then `--create-pr`):
  the impact analysis answers a fixed body and rating instead of asking a
  model; the PR is "opened" on a forge that cannot exist (`forge.e2e.invalid`,
  a reserved name): what the app asked for (branch, target, title, body) is
  written to `e2e-pull-request.json` in the spec folder for the test to read,
  and the answer is the one line of JSON the real command prints.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
REAL_BACKEND = (HERE / ".." / ".." / ".." / "backend").resolve()
sys.path.insert(0, str(REAL_BACKEND))

from core.task_event import TaskEventEmitter  # noqa: E402
from core.worktree import WorktreeManager  # noqa: E402
from foundation.file_utils import write_json_atomic  # noqa: E402
from foundation.phase_event import ExecutionPhase, emit_phase  # noqa: E402
from init import init_workpilot_dir  # noqa: E402

RELEASE_FILE = "e2e-release"
RELEASE_TIMEOUT_S = 120.0
#: The file the fake agent writes in the task worktree.
OUTPUT_FILE = "CONTRIBUTING.md"
#: Where the fake forge says what pull request the app asked for.
PULL_REQUEST_FILE = "e2e-pull-request.json"
#: The forge of the fake pull requests: `.invalid` never resolves (RFC 2606).
FORGE = "https://forge.e2e.invalid/e2e-team"
#: What the impact analysis answers, in place of the model.
IMPACT = {"rating": "2", "features": "Contributor guide"}


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _write_json(path: Path, data: dict) -> None:
    # Atomic, as the agents write the plan: the app reads it while it changes.
    write_json_atomic(path, data)


def _plan(spec_dir: Path, description: str, status: str) -> dict:
    plan = _read_json(spec_dir / "implementation_plan.json")
    plan.update(
        {
            "feature": plan.get("feature") or description[:80],
            "workflow_type": "feature",
            "updated_at": _now(),
            "phases": [
                {
                    "id": "phase-1",
                    "name": "Write the file",
                    "subtasks": [
                        {
                            "id": "subtask-1",
                            "description": f"Write {OUTPUT_FILE}",
                            "status": status,
                            "files_to_create": [OUTPUT_FILE],
                        }
                    ],
                }
            ],
        }
    )
    return plan


def spec_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", default="")
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--spec-dir", required=True)
    parser.add_argument("--auto-approve", action="store_true")
    parser.add_argument("--base-branch")
    parser.add_argument("--direct", action="store_true")
    args, _ = parser.parse_known_args(argv)

    spec_dir = Path(args.spec_dir)
    # As the spec pipeline does first (spec/pipeline/models.py): the
    # project's .gitignore entries, committed before any task branch exists.
    init_workpilot_dir(Path(args.project_dir))
    events = TaskEventEmitter.from_spec_dir(spec_dir)
    emit_phase(ExecutionPhase.PLANNING, "Writing the spec")
    events.emit("PLANNING_STARTED")
    (spec_dir / "spec.md").write_text(
        f"# Spec\n\n{args.task}\n\nWrite `{OUTPUT_FILE}`.\n", encoding="utf-8"
    )
    _write_json(
        spec_dir / "implementation_plan.json", _plan(spec_dir, args.task, "pending")
    )
    events.emit(
        "PLANNING_COMPLETE",
        {"hasSubtasks": True, "subtaskCount": 1, "requireReviewBeforeCoding": False},
    )
    if not args.auto_approve:
        return 0
    build = ["--spec", spec_dir.name, "--project-dir", args.project_dir]
    if args.base_branch:
        build += ["--base-branch", args.base_branch]
    return build_main(build)


def _wait_for_release(spec_dir: Path) -> bool:
    deadline = time.monotonic() + RELEASE_TIMEOUT_S
    while time.monotonic() < deadline:
        if (spec_dir / RELEASE_FILE).exists():
            return True
        time.sleep(0.2)
    return False


def build_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True)
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--base-branch")
    args, _ = parser.parse_known_args(argv)

    project = Path(args.project_dir)
    spec_dir = project / ".workpilot" / "specs" / args.spec
    events = TaskEventEmitter.from_spec_dir(spec_dir)
    worktree = WorktreeManager(project, base_branch=args.base_branch).create_worktree(
        args.spec
    )

    emit_phase(ExecutionPhase.CODING, "Writing the file", subtask="subtask-1")
    events.emit("CODING_STARTED", {"subtaskId": "subtask-1"})
    _write_json(
        spec_dir / "implementation_plan.json",
        _plan(spec_dir, args.spec, "in_progress"),
    )
    if not _wait_for_release(spec_dir):
        emit_phase(ExecutionPhase.FAILED, "The test never released the fake agent")
        events.emit("CODING_FAILED", {"error": "not released", "recoverable": True})
        return 1

    (worktree.path / OUTPUT_FILE).write_text(
        "# Contributing\n\nRun the tests with `pytest`.\n", encoding="utf-8"
    )
    git = ["git", "-c", "user.name=E2E agent", "-c", "user.email=agent@e2e.invalid"]
    subprocess.run([*git, "add", OUTPUT_FILE], cwd=worktree.path, check=True)
    subprocess.run(
        [*git, "commit", "-q", "-m", f"Add {OUTPUT_FILE}"],
        cwd=worktree.path,
        check=True,
    )
    _write_json(
        spec_dir / "implementation_plan.json", _plan(spec_dir, args.spec, "completed")
    )
    events.emit("ALL_SUBTASKS_DONE", {"totalCount": 1})

    emit_phase(ExecutionPhase.QA_REVIEW, "Checking the result")
    events.emit("QA_STARTED", {"iteration": 1, "maxIterations": 1})
    (spec_dir / "qa_report.md").write_text(
        f"# QA\n\nStatus: APPROVED\n\n`{OUTPUT_FILE}` exists.\n", encoding="utf-8"
    )
    plan = _read_json(spec_dir / "implementation_plan.json")
    plan["qa_signoff"] = {"status": "approved", "timestamp": _now(), "qa_session": 1}
    _write_json(spec_dir / "implementation_plan.json", plan)
    emit_phase(ExecutionPhase.COMPLETE, "QA validation passed")
    events.emit("QA_PASSED", {"iteration": 1, "testsRun": {}})
    return 0


#: The flags the app passes when it starts a build (`agent-manager.ts`).
BUILD_FLAGS = {
    "--spec",
    "--project-dir",
    "--auto-continue",
    "--force",
    "--direct",
    "--base-branch",
    "--enable-streaming",
    "--streaming-session-id",
}


def _pr_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True)
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--pr-target")
    parser.add_argument("--pr-title")
    parser.add_argument("--pr-draft", action="store_true")
    parser.add_argument("--pr-body-file")
    parser.add_argument("--base-branch")
    args, _ = parser.parse_known_args(argv)
    return args


def _answer(result: dict) -> int:
    # The app reads the last line of stdout that is a JSON object.
    print(json.dumps(result), flush=True)
    return 0 if result.get("success") else 1


def analyze_impact_main(argv: list[str]) -> int:
    """`run.py --analyze-impact`: the PR body the review dialog starts from."""
    args = _pr_args(argv)
    project = Path(args.project_dir)
    if WorktreeManager(project).get_worktree_info(args.spec) is None:
        return _answer({"success": False, "error": "No build worktree found"})
    body = f"## Summary\n\nAdds `{OUTPUT_FILE}`.\n"
    return _answer({"success": True, "body": body, **IMPACT})


def create_pr_main(argv: list[str]) -> int:
    """`run.py --create-pr`: the task branch, opened as a pull request."""
    args = _pr_args(argv)
    project = Path(args.project_dir)
    info = WorktreeManager(project, base_branch=args.base_branch).get_worktree_info(
        args.spec
    )
    if info is None:
        return _answer({"success": False, "error": "No build worktree found"})
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=info.path,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    body = ""
    if args.pr_body_file:
        body = Path(args.pr_body_file).read_text(encoding="utf-8")
    url = f"{FORGE}/{project.name}/pull/1"
    spec_dir = project / ".workpilot" / "specs" / args.spec
    _write_json(
        spec_dir / PULL_REQUEST_FILE,
        {
            "url": url,
            "branch": info.branch,
            "head": head,
            "target": args.pr_target or info.base_branch,
            "title": args.pr_title or "",
            "draft": args.pr_draft,
            "body": body,
        },
    )
    return _answer({"success": True, "pr_url": url, "already_exists": False})


def run_main(argv: list[str]) -> int:
    """`run.py`: a build and the forge are played here, the rest by the real backend."""
    flags = {arg for arg in argv if arg.startswith("--")}
    if "--spec" in flags and flags <= BUILD_FLAGS:
        return build_main(argv)
    if "--analyze-impact" in flags:
        return analyze_impact_main(argv)
    if "--create-pr" in flags:
        return create_pr_main(argv)
    real = REAL_BACKEND / "run.py"
    return subprocess.call([sys.executable, str(real), *argv], env=os.environ.copy())
