"""Author an architecture model, then repair it until archify accepts it.

The loop is bounded by *progress*, not by a round count, because that is what
the diagnostics support: each refusal names what is wrong, so a round that does
not reduce the error count is a round that learned nothing and the next one will
learn nothing either. `archify`'s own contract says it plainly — continue while
the objective error count reaches a new minimum, and when two consecutive rounds
fail to improve on the best, stop and report the diagnostics truthfully rather
than presenting the last candidate as finished.

`MAX_ROUNDS` is a ceiling on top of that, not the mechanism. It exists so a
model that oscillates between two equally-broken candidates cannot spend a
build's budget.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import cli
from . import evidence as evidence_module
from . import ir as ir_module
from .runtime import archify_root, check

logger = logging.getLogger(__name__)

MAX_ROUNDS = 4

#: Two rounds without a new best means the diagnostics have stopped informing
#: the edit. One is too jumpy: a repair often trades one diagnostic for another
#: before the count drops.
STALL_LIMIT = 2

#: A base model past this size stops being context and starts being the whole
#: budget. Models this large mean the previous pass ignored the component cap.
MAX_BASELINE_CHARS = 60_000

ProgressFn = Callable[[str], None]

#: `(prompt) -> response`. Injected so the loop can be tested without a model,
#: and so the caller owns client construction, which is where the provider,
#: the phase model and the thinking budget are resolved.
SessionFn = Callable[[str], Awaitable[str]]


@dataclass
class AuthoringResult:
    """What came out, and honestly how far it got."""

    ok: bool
    spec_path: Path | None = None
    artifact_path: Path | None = None
    rounds: int = 0
    receipt: dict = field(default_factory=dict)
    diagnostics: list[dict] = field(default_factory=list)
    error: str = ""

    def to_dict(self) -> dict[str, object]:
        return {
            "ok": self.ok,
            "specPath": str(self.spec_path) if self.spec_path else None,
            "artifactPath": str(self.artifact_path) if self.artifact_path else None,
            "rounds": self.rounds,
            "receipt": self.receipt,
            "diagnostics": self.diagnostics[:20],
            "error": self.error,
        }


def build_prompt(
    project_dir: Path,
    output_path: Path,
    baseline: dict[str, Any] | None = None,
    task_summary: str = "",
    changed_files: list[str] | None = None,
) -> str:
    """The authoring prompt: measured evidence, plus the base model when there is one."""
    from prompts_pkg.prompts import (
        get_architecture_delta_section,
        get_architecture_map_prompt,
    )

    root = archify_root()
    if root is None:
        raise cli.ArchifyUnavailable(check())

    section = evidence_module.render_section(evidence_module.collect(project_dir))

    baseline_section = ""
    if baseline is not None:
        import json

        rendered = json.dumps(baseline, indent="\t")
        if len(rendered) > MAX_BASELINE_CHARS:
            # Compact rather than truncate: half a JSON object is not a model,
            # and the id list is the part that must survive intact.
            rendered = json.dumps(baseline, separators=(",", ":"))
        baseline_section = get_architecture_delta_section(
            baseline_json=rendered,
            task_summary=task_summary,
            changed_files=changed_files or [],
        )

    return get_architecture_map_prompt(
        archify_root=root,
        output_path=output_path,
        evidence_section=section,
        baseline_section=baseline_section,
    )


async def author(
    session: SessionFn,
    project_dir: Path,
    spec_path: Path,
    artifact_path: Path,
    baseline: dict[str, Any] | None = None,
    task_summary: str = "",
    changed_files: list[str] | None = None,
    revision: str | None = None,
    progress: ProgressFn | None = None,
) -> AuthoringResult:
    """Write a model, validate it, repair while repairing helps, then deliver."""
    from prompts_pkg.prompts import get_architecture_repair_prompt

    def say(message: str) -> None:
        logger.info("architecture-map: %s", message)
        if progress:
            progress(message)

    spec_path.parent.mkdir(parents=True, exist_ok=True)

    say("collecting repository evidence")
    prompt = build_prompt(
        project_dir=project_dir,
        output_path=spec_path,
        baseline=baseline,
        task_summary=task_summary,
        changed_files=changed_files,
    )

    best = float("inf")
    stalls = 0
    rounds_run = 0
    last: cli.Receipt | None = None

    for round_index in range(1, MAX_ROUNDS + 1):
        rounds_run = round_index
        say(f"authoring the model (round {round_index})")
        await session(prompt)

        if not spec_path.is_file():
            return AuthoringResult(
                ok=False,
                rounds=round_index,
                error=f"the session wrote no model at {spec_path.name}",
            )

        try:
            model = ir_module.load(spec_path)
        except ir_module.IRError as exc:
            # Malformed output is a diagnosable failure like any other, so it
            # goes back through the repair loop rather than ending the run.
            last = cli.Receipt(
                ok=False,
                command="parse",
                payload={"diagnostics": [{"code": "ir/unreadable", "message": str(exc)}]},
            )
        else:
            ir_module.pin_repository(model, project_dir, revision)
            ir_module.save(spec_path, model)

            say(f"validating (round {round_index})")
            last = cli.validate(spec_path, repo_root=project_dir)

        if last.ok:
            say("delivering the artifact")
            delivered = cli.deliver(spec_path, artifact_path, repo_root=project_dir)
            if delivered.ok:
                return AuthoringResult(
                    ok=True,
                    spec_path=spec_path,
                    artifact_path=artifact_path,
                    rounds=round_index,
                    receipt=delivered.payload,
                )
            # Delivery re-renders the frozen bytes and can refuse what validate
            # accepted. Its diagnostics feed the same loop.
            last = delivered

        count = last.error_count
        if count < best:
            best, stalls = count, 0
        else:
            stalls += 1
            if stalls >= STALL_LIMIT:
                say(f"stopping: {count} unresolved diagnostic(s), no longer improving")
                break

        if round_index == MAX_ROUNDS:
            break

        prompt = get_architecture_repair_prompt(spec_path, last.diagnostics)

    diagnostics = last.diagnostics if last else []
    return AuthoringResult(
        ok=False,
        spec_path=spec_path if spec_path.is_file() else None,
        rounds=rounds_run,
        receipt=last.payload if last else {},
        diagnostics=diagnostics,
        error=last.summary() if last else "authoring produced nothing",
    )
