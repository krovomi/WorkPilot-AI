"""
Guardrails Runner
=================

The one implementation of the project's guardrails, for the desktop app and
the command line (``python apps/backend/runners/guardrails_runner.py <command>``):

* ``validate``   the layers read, the rules kept, errors and warnings;
* ``test``       what the rules decide for one tool call (nothing is logged);
* ``check-diff`` a dry run of the rules over the changes since ``--ref``,
  file by file, without blocking anything (``workpilot policy validate``);
* ``activity``   the log of triggered rules and the requests awaiting approval;
* ``answer``     approve or refuse one pending request.

Output: one line ``GUARDRAILS_RESULT:<json>``, or ``GUARDRAILS_ERROR:<json string>``.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


def _emit(prefix: str, payload: Any) -> None:
    print(
        f"{prefix}:{json.dumps(payload, default=str, ensure_ascii=False)}", flush=True
    )


def _decision_dict(decision) -> dict[str, Any]:
    return {
        "action": decision.action.value,
        "triggered": [r.id for r in decision.triggered],
        "message": decision.message,
        "details": decision.details,
    }


def _git(project: Path, *args: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", *args], cwd=str(project), capture_output=True, timeout=60, check=False
    )


def check_diff(project: Path, ref: str) -> dict[str, Any]:
    from security.guardrail_policy import current_branch, load_policy
    from security.guardrails import CallContext, GuardrailAction, evaluate_rules

    if ref.startswith("-"):
        raise RuntimeError(f"Not a git ref: {ref}")
    policy = load_policy(project)
    if policy.errors:
        return {"policy": policy.to_dict(), "files": [], "ref": ref}
    status = _git(project, "diff", "--name-status", "-z", "--no-renames", ref, "--")
    if status.returncode != 0:
        raise RuntimeError(
            status.stderr.decode("utf-8", "replace").strip() or "git diff failed"
        )
    fields = [f for f in status.stdout.decode("utf-8", "replace").split("\0") if f]
    changes = list(zip(fields[::2], fields[1::2], strict=False))
    untracked = _git(project, "ls-files", "--others", "--exclude-standard", "-z")
    changes += [
        ("A", p) for p in untracked.stdout.decode("utf-8", "replace").split("\0") if p
    ]

    branch = current_branch(project)
    results = []
    for kind, path in changes:
        if kind.startswith("D"):
            tool, tool_input = "Bash", {"command": f"rm {path}"}
            context = CallContext(root=project, branch=branch)
        else:
            old = _git(project, "show", f"{ref}:{path}") if kind != "A" else None
            before = (
                old.stdout.decode("utf-8", "replace")
                if old is not None and old.returncode == 0
                else ""
            )
            try:
                after = (project / path).read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            tool, tool_input = "Write", {"file_path": path, "content": after}
            context = CallContext(
                root=project, branch=branch, _cache=(before, after, kind != "A")
            )
        decision = evaluate_rules(policy.rules, tool, tool_input, context)
        if decision.action != GuardrailAction.ALLOW:
            results.append(
                {"path": path, "change": kind[:1], **_decision_dict(decision)}
            )
    return {
        "policy": policy.to_dict(),
        "files": results,
        "ref": ref,
        "checked": len(changes),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="WorkPilot guardrails")
    parser.add_argument(
        "command", choices=["validate", "test", "check-diff", "activity", "answer"]
    )
    parser.add_argument("--project-path", required=True)
    parser.add_argument("--tool", default="Write")
    parser.add_argument("--input", default="{}", help="tool input as JSON (test)")
    parser.add_argument(
        "--ref", default="HEAD", help="compare against this ref (check-diff)"
    )
    parser.add_argument("--request", help="request id (answer)")
    decision = parser.add_mutually_exclusive_group()
    decision.add_argument("--approve", action="store_true")
    decision.add_argument("--refuse", action="store_true")
    args = parser.parse_args()

    project = Path(args.project_path).resolve()
    if not project.is_dir():
        _emit("GUARDRAILS_ERROR", f"Project path does not exist: {project}")
        sys.exit(1)

    from security import guardrail_ledger as ledger
    from security.guardrail_policy import current_branch, load_policy
    from security.guardrails import CallContext, evaluate_rules

    try:
        if args.command == "validate":
            result: Any = load_policy(project).to_dict()
        elif args.command == "test":
            tool_input = json.loads(args.input)
            if not isinstance(tool_input, dict):
                raise RuntimeError("--input must be a JSON object")
            policy = load_policy(project)
            context = CallContext(root=project, branch=current_branch(project))
            result = {
                **_decision_dict(
                    evaluate_rules(policy.rules, args.tool, tool_input, context)
                ),
                "policyErrors": policy.errors,
            }
        elif args.command == "check-diff":
            result = check_diff(project, args.ref)
        elif args.command == "activity":
            result = ledger.activity(project)
        else:
            if not args.request or not (args.approve or args.refuse):
                raise RuntimeError("answer needs --request and --approve or --refuse")
            result = ledger.answer(project, args.request, approved=args.approve)
            if result is None:
                raise RuntimeError(f"No pending request {args.request}")
        _emit("GUARDRAILS_RESULT", result)
    except (RuntimeError, ValueError, OSError) as exc:
        _emit("GUARDRAILS_ERROR", str(exc))
        sys.exit(1)


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
