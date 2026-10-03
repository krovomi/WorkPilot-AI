"""`run.py --spec 001 --verify` — the verification loop on a task's code.

The same loop the `verify` phase runs in a build (`verify.loop`), on demand:
the task's worktree when it exists, the provider the task configured for QA,
the `verify` skill specialised for that provider.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

__all__ = ["handle_verify_command"]


def handle_verify_command(
    project_dir: Path,
    spec_dir: Path,
    model: str | None,
    *,
    effort: str = "medium",
    verbose: bool = False,
) -> dict:
    from verify.git import changed_files
    from verify.loop import LoopOptions, run_verify_loop
    from verify.phase import make_agent_runner
    from workflows.runner import find_skill_body, phase_provider

    worktree = project_dir / ".workpilot" / "worktrees" / "tasks" / spec_dir.name
    code_dir = worktree if worktree.is_dir() else project_dir
    local_spec = code_dir / ".workpilot" / "specs" / spec_dir.name
    target_spec = local_spec if local_spec.is_dir() else spec_dir

    explicit, provider = phase_provider(target_spec, "qa")
    repo_root = Path(__file__).resolve().parents[3]
    found = find_skill_body(repo_root, "tooling", "verify", provider)
    runner = make_agent_runner(
        code_dir, target_spec, model=model or "", provider=explicit, verbose=verbose
    )
    print(
        f"\nVerifying {spec_dir.name} in {code_dir} (provider: {provider or 'default'})\n"
    )
    record = asyncio.run(
        run_verify_loop(
            code_dir,
            target_spec,
            runner,
            LoopOptions(
                provider=provider or "",
                model=model or "",
                effort=effort,
                changed_files=changed_files(code_dir),
                skill_body=found[0] if found else "",
                log=lambda message: print(f"  {message}", flush=True),
            ),
        )
    )
    print(
        f"\nVerify: {record.get('status')}"
        + (f" — {record.get('reason')}" if record.get("reason") else "")
        + (f" (score {record['score']}/100)" if record.get("score") is not None else "")
    )
    print(f"Report: {target_spec / 'verify' / 'report.md'}")
    return record
