"""The personal style profile of the coach (#376), for the Coach page.

Actions (``--action``):

- ``get``: the stored profile, the person's preferences and what the agents
  are given (``COACH_PROFILE``);
- ``build``: read the project's history and lint config again, store the
  profile (``COACH_PROFILE``);
- ``set``: the preferences on stdin, ``{"enabled": bool, "overrides": {…}}``,
  closed lists only (``COACH_PROFILE``);
- ``export``: the effective preferences, no email, path or code (``COACH_EXPORT``);
- ``import``: an export on stdin, taken as the person's preferences
  (``COACH_PROFILE``);
- ``check``: a task's diff (``--spec``) against the profile (``COACH_CHECK``).

Errors: ``COACH_ERROR:<message>``. No model is called.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from agent_coach.profile_builder import build_profile  # noqa: E402
from agent_coach.profile_injector import deviations, profile_block  # noqa: E402
from agent_coach.profile_store import (  # noqa: E402
    effective,
    export_profile,
    import_profile,
    load_preferences,
    load_profile,
    save_preferences,
    save_profile,
)
from foundation.base_branch import detect_base_branch  # noqa: E402
from foundation.git_executable import run_git  # noqa: E402

MAX_STDIN = 256 * 1024
_SPEC = re.compile(r"^[A-Za-z0-9][\w.-]{0,119}$")
MAX_FILES = 200


def _emit(prefix: str, payload: Any) -> None:
    print(f"{prefix}:{json.dumps(payload, default=str)}", flush=True)


def _state(root: Path) -> dict[str, Any]:
    profile = load_profile(root)
    preferences = load_preferences(root)
    return {
        "profile": profile,
        "preferences": preferences,
        "effective": effective(profile, preferences),
        "injected": bool(profile_block(root)),
    }


def _stdin_json() -> Any:
    raw = sys.stdin.read(MAX_STDIN + 1)
    if len(raw) > MAX_STDIN:
        raise ValueError("input too large")
    return json.loads(raw or "null")


def _task_diff(root: Path, spec: str) -> dict[str, list[str]]:
    worktree = (root / ".workpilot" / "worktrees" / "tasks" / spec).resolve()
    tasks = (root / ".workpilot" / "worktrees" / "tasks").resolve()
    if worktree.parent != tasks or not worktree.is_dir():
        raise ValueError("this task has no worktree")
    base = detect_base_branch(root / ".workpilot" / "specs" / spec, root)
    merge_base = run_git(["merge-base", "HEAD", base], cwd=worktree, timeout=20)
    if merge_base.returncode != 0:
        raise ValueError("the task's base branch was not found")
    diff = run_git(
        [
            "diff",
            "--unified=0",
            "--no-color",
            "--no-renames",
            merge_base.stdout.strip(),
        ],
        cwd=worktree,
        timeout=60,
    )
    files: dict[str, list[str]] = {}
    current: list[str] | None = None
    for line in diff.stdout.splitlines():
        if line.startswith("+++ "):
            path = line[4:].removeprefix("b/")
            current = (
                None
                if path == "/dev/null" or len(files) >= MAX_FILES
                else files.setdefault(path, [])
            )
        elif current is not None and line.startswith("+"):
            current.append(line[1:])
    return files


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Personal style profile of the agent coach"
    )
    parser.add_argument("--project-path", required=True)
    parser.add_argument(
        "--action",
        choices=["get", "build", "set", "export", "import", "check"],
        default="get",
    )
    parser.add_argument("--spec", default="")
    args = parser.parse_args()
    root = Path(args.project_path).resolve()
    if not root.is_dir():
        print("COACH_ERROR:Project path does not exist", flush=True)
        return 1
    try:
        if args.action == "build":
            if not save_profile(root, build_profile(root)):
                raise ValueError("the project has no .workpilot folder")
            _emit("COACH_PROFILE", _state(root))
        elif args.action == "set":
            data = _stdin_json()
            if not isinstance(data, dict):
                raise ValueError("preferences must be an object")
            save_preferences(
                root, data.get("enabled") is not False, data.get("overrides")
            )
            _emit("COACH_PROFILE", _state(root))
        elif args.action == "export":
            _emit("COACH_EXPORT", export_profile(root))
        elif args.action == "import":
            import_profile(root, _stdin_json())
            _emit("COACH_PROFILE", _state(root))
        elif args.action == "check":
            if not _SPEC.match(args.spec):
                raise ValueError("invalid task name")
            styles = effective(load_profile(root), load_preferences(root))
            _emit(
                "COACH_CHECK",
                {
                    "spec": args.spec,
                    "deviations": deviations(styles, _task_diff(root, args.spec)),
                },
            )
        else:
            _emit("COACH_PROFILE", _state(root))
    except (OSError, ValueError) as exc:
        print(f"COACH_ERROR:{' '.join(str(exc).split())[:300]}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    sys.exit(main())
