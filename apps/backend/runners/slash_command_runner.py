"""
Quick-Command runner — one command of the Kanban's bar, run on a review card.

The Electron main opens the review card first (``main/quick-command/``), then
starts this runner with the card's worktree as ``--workdir`` and the project
folder the palette listed the command from as ``--project-dir``. Its
environment is the one every page runner gets (``pythonRunnerEnv``): the
provider chosen in the app and its key, and the Claude profile's sign-in when
the provider needs it. Whatever the agent writes stays in the worktree; the
main process commits it on the card's branch afterwards.

Output: one ``__SLASH_COMMAND__:<json>`` line on stdout,
``{"success": true, "result": "..."}`` or ``{"success": false, "error": "..."}``.
Exit code 0 when the command ran, 1 otherwise. Anything else the agent prints
is log, not result.

Usage::

    python slash_command_runner.py --project-dir <checkout> --workdir <worktree> \
        --command bmad-bmm-create-prd [--args "..."]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import tempfile
from pathlib import Path

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

RESULT_PREFIX = "__SLASH_COMMAND__:"

# The bar refuses longer arguments before it starts anything; the runner
# does not trust its caller either.
MAX_ARGS_CHARS = 4000


def _emit(payload: dict) -> None:
    print(f"{RESULT_PREFIX}{json.dumps(payload)}", flush=True)


def _fail(message: str) -> int:
    _emit({"success": False, "error": message})
    return 1


def _directory(raw: str, name: str) -> Path:
    path = Path(raw).resolve()
    if not path.is_dir():
        raise ValueError(f"{name} is not a directory")
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--workdir", required=True)
    parser.add_argument("--command", required=True)
    parser.add_argument("--args", default="")
    args = parser.parse_args(argv)

    from slash_commands.api import _valid_command_name
    from slash_commands.execution import resolve_prompt, run_prompt

    if not _valid_command_name(args.command):
        return _fail(f"invalid command name: {args.command!r}")
    if len(args.args) > MAX_ARGS_CHARS:
        return _fail(f"arguments longer than {MAX_ARGS_CHARS} characters")
    try:
        project_dir = _directory(args.project_dir, "--project-dir")
        workdir = _directory(args.workdir, "--workdir")
    except ValueError as exc:
        return _fail(str(exc))

    prompt = resolve_prompt(project_dir, args.command, args.args)
    if prompt is None:
        return _fail(f"command not found: /{args.command}")

    # The agent's notes about its own run go to a folder of their own, thrown
    # away afterwards: in the worktree they would be committed for review.
    with tempfile.TemporaryDirectory(prefix="workpilot-quick-command-") as notes:
        ok, text = asyncio.run(run_prompt(workdir, prompt, Path(notes)))
    if ok:
        _emit({"success": True, "result": text})
        return 0
    return _fail(text)


if __name__ == "__main__":
    sys.exit(main())
