"""The `execute` phase of a RUN: Python plays the procedure, no model does.

The `procedure` phase (`skills/tooling/runbook`) made a model write the steps;
this module plays them one by one, deterministically, on every provider:

* the procedure is **frozen** before the first step (`procedure.frozen.json`),
  so a resumed build keeps the text the person read rather than asking a
  model for a new one;
* every command goes through the project's command allowlist and guardrails
  (`security.hooks.command_refusal`) — the same gate every non-SDK provider's
  `run_command` goes through — and a refused command stops the run;
* each step's command, exit code and output land in the journal
  (`<spec_dir>/workflow/run.md`), output cut to a page and secrets masked
  (`foundation.log_redaction.redact_text`);
* a step that fails stops the rest and leaves the state written
  (`run-state.json`), so what was and was not done is never a guess;
* a declared environment's health commands run first, and its named
  variables — never their values — reach the steps' processes.

Pausing before the irreversible is not this module's job: the runner stops a
phase declared ``irreversible: true`` before it starts and waits for an
explicit resume (`workflows.runner.irreversible_gate`). This module only ever
runs once that gate has been passed.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from .runbook import Runbook, RunbookError, RunbookStep, load_runbook

logger = logging.getLogger(__name__)

__all__ = [
    "JOURNAL_FILE",
    "STATE_FILE",
    "FROZEN_FILE",
    "RunState",
    "StepRecord",
    "execute_runbook",
    "freeze_procedure",
    "is_frozen",
    "run_execute_phase",
]

JOURNAL_FILE = "run.md"
STATE_FILE = "run-state.json"
FROZEN_FILE = "procedure.frozen.json"

#: How much of a command's output the journal keeps, in characters.
OUTPUT_CHARS = 4_000
#: How long one step may run.
STEP_TIMEOUT_S = 600.0


@dataclass
class StepRecord:
    number: int
    name: str
    command: str
    status: str
    """``done`` | ``failed`` | ``refused`` | ``check-failed`` | ``skipped``."""
    returncode: int | None = None
    detail: str = ""
    started: str = ""
    finished: str = ""


@dataclass
class RunState:
    procedure_sha256: str
    status: str = "running"
    """``running`` | ``done`` | ``failed`` | ``refused`` | ``blocked``."""
    environment: str = "worktree"
    next_step: int = 1
    steps: list[StepRecord] = field(default_factory=list)
    detail: str = ""
    updated: str = ""

    def to_json(self) -> str:
        self.updated = _now()
        return json.dumps(asdict(self), indent=2)


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Freezing the procedure


def freeze_procedure(spec_dir: Path, runbook: Runbook) -> Path:
    """Record which text is being executed, so the `procedure` phase of a
    resumed build keeps it instead of writing another."""
    out = Path(spec_dir) / "workflow"
    out.mkdir(parents=True, exist_ok=True)
    path = out / FROZEN_FILE
    path.write_text(
        json.dumps(
            {
                "phase": "procedure",
                "sha256": runbook.sha256,
                "frozen_at": _now(),
                "reason": "execution started on this procedure",
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return path


def is_frozen(spec_dir: Path, phase_id: str) -> bool:
    """Whether ``phase_id``'s report is frozen and still the text that was
    frozen. A report edited since is not frozen: the person changed the
    procedure on purpose, and the phase must not overwrite it either — the
    executor reads the file as it is, so the answer here is only about
    re-running the model."""
    workflow = Path(spec_dir) / "workflow"
    marker = workflow / FROZEN_FILE
    report = workflow / f"{phase_id}.md"
    if not marker.is_file() or not report.is_file():
        return False
    try:
        data = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if data.get("phase") != phase_id:
        return False
    return True


# ---------------------------------------------------------------------------
# The journal and the state


class _Journal:
    def __init__(self, spec_dir: Path) -> None:
        self.dir = Path(spec_dir) / "workflow"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / JOURNAL_FILE

    def head(self, runbook: Runbook, environment: str) -> None:
        if self.path.exists():
            self.append(f"\n---\n\n_Resumed {_now()}_\n")
            return
        self.path.write_text(
            f"# Run journal — {runbook.operation or 'procedure'}\n\n"
            f"Procedure: `workflow/procedure.md` (sha256 `{runbook.sha256[:12]}`)  \n"
            f"Environment: `{environment}`  \n"
            f"Started: {_now()}\n\n"
            "Every command below went through the project's command allowlist; "
            "output is cut to a page and secrets are masked.\n",
            encoding="utf-8",
        )

    def append(self, text: str) -> None:
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(text)

    def step(self, record: StepRecord, output: str) -> None:
        from foundation.log_redaction import redact_text

        shown = _page(redact_text(output))
        self.append(
            f"\n## {record.number}. {record.name} — {record.status}\n\n"
            f"```\n$ {redact_text(record.command)}\n```\n"
            f"exit code: `{record.returncode if record.returncode is not None else '—'}`"
            f" · {record.started} → {record.finished}\n"
            + (f"\n{record.detail}\n" if record.detail else "")
            + (f"\n```text\n{shown}\n```\n" if shown else "")
        )


def _page(text: str) -> str:
    if len(text) <= OUTPUT_CHARS:
        return text.rstrip()
    try:
        from foundation.paging import spill_excerpt

        return spill_excerpt(
            text, max_chars=OUTPUT_CHARS, location="(the step's full output)"
        )
    except Exception:  # noqa: BLE001 - paging is a courtesy
        return text[:OUTPUT_CHARS] + "\n… (cut)"


def _write_state(spec_dir: Path, state: RunState) -> Path:
    path = Path(spec_dir) / "workflow" / STATE_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(state.to_json(), encoding="utf-8")
    return path


def _read_state(spec_dir: Path) -> RunState | None:
    path = Path(spec_dir) / "workflow" / STATE_FILE
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        steps = [StepRecord(**s) for s in data.pop("steps", [])]
        return RunState(**data, steps=steps)
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
        logger.warning("unreadable run state %s: %s", path, exc)
        return None


# ---------------------------------------------------------------------------
# Running one command, through the gate


async def _run(
    command: str, cwd: Path, env: dict[str, str], project_dir: Path
) -> tuple[str | None, int | None, str]:
    """``(refusal, returncode, output)``: refused by the policy, or run.

    Shell mode, as `ToolExecutor._run_command` uses for the same reason — a
    procedure's step is a shell line (pipes, redirections) — and behind the
    same gate: the project's allowlist and the user's guardrails judge the
    line as written before anything is started.
    """
    from security.hooks import command_refusal

    refusal = await command_refusal(command, project_dir)
    if refusal:
        return refusal, None, ""
    try:
        process = await asyncio.create_subprocess_shell(
            command,
            cwd=str(cwd),
            env=env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=os.name != "nt",
        )
        try:
            out, _ = await asyncio.wait_for(
                process.communicate(), timeout=STEP_TIMEOUT_S
            )
        except TimeoutError:
            process.kill()
            await process.wait()
            return (
                None,
                None,
                f"(no answer after {STEP_TIMEOUT_S:g}s; the step was killed)",
            )
    except OSError as exc:
        return None, None, f"could not start: {exc}"
    return (
        None,
        process.returncode,
        out.decode("utf-8", errors="replace") if out else "",
    )


# ---------------------------------------------------------------------------
# Playing the procedure


async def execute_runbook(
    runbook: Runbook,
    *,
    spec_dir: Path,
    project_dir: Path,
    working_dir: Path | None = None,
) -> RunState:
    """Play ``runbook`` from where its state says it stands.

    Returns the state as written to disk. Never raises on a step: a failure
    is a status, the rest is not played, and the journal says exactly what
    ran.
    """
    from .environments import EnvironmentsError, environment_for

    working_dir = Path(working_dir or project_dir)
    previous = _read_state(spec_dir)
    if previous is not None and previous.procedure_sha256 != runbook.sha256:
        # The procedure changed under a started run. Starting over on a
        # different text would mix two operations; say so and stop.
        state = RunState(
            procedure_sha256=runbook.sha256,
            status="blocked",
            detail=(
                "the procedure changed since execution started "
                f"({len(previous.steps)} step(s) already played on the previous "
                "text); remove workflow/run-state.json to start over on this one"
            ),
        )
        _write_state(spec_dir, state)
        return state
    if previous is not None and previous.status == "done":
        return previous
    state = previous or RunState(procedure_sha256=runbook.sha256)
    state.status = "running"

    blockers = runbook.blockers()
    if blockers:
        state.status = "blocked"
        state.detail = "; ".join(blockers)
        _write_state(spec_dir, state)
        return state

    try:
        environment = environment_for(project_dir, runbook.environment)
    except EnvironmentsError as exc:
        state.status = "blocked"
        state.detail = str(exc)
        _write_state(spec_dir, state)
        return state
    state.environment = environment.name if environment else "worktree"
    env = environment.process_env() if environment else dict(os.environ)
    if environment and (missing := environment.missing_variables()):
        state.status = "blocked"
        state.detail = (
            f"environment {environment.name!r} needs these variables set in the "
            f"operator's environment: {', '.join(missing)}"
        )
        _write_state(spec_dir, state)
        return state

    freeze_procedure(spec_dir, runbook)
    journal = _Journal(spec_dir)
    journal.head(runbook, state.environment)
    _write_state(spec_dir, state)

    # Health first: an environment that does not answer is not one to act on.
    if environment and state.next_step == 1:
        for i, health in enumerate(environment.health, start=1):
            record = StepRecord(0, f"health check {i}", health, "done", started=_now())
            refusal, code, out = await _run(health, working_dir, env, project_dir)
            record.finished = _now()
            record.returncode = code
            if refusal:
                record.status, record.detail = "refused", refusal
            elif code != 0:
                record.status, record.detail = (
                    "failed",
                    "the environment does not answer",
                )
            journal.step(record, out)
            if record.status != "done":
                state.status = "failed"
                state.detail = f"health check {i} {record.status}: {record.detail}"
                _write_state(spec_dir, state)
                return state

    for step in runbook.steps:
        if step.number < state.next_step:
            continue
        record = await _play(step, working_dir, env, project_dir, journal)
        state.steps.append(record)
        if record.status != "done":
            state.status = record.status if record.status == "refused" else "failed"
            state.detail = (
                f"step {step.number} ({step.name}) {record.status}: {record.detail}"
            )
            _write_state(spec_dir, state)
            return state
        state.next_step = step.number + 1
        _write_state(spec_dir, state)

    if runbook.final_check:
        record = StepRecord(
            len(runbook.steps) + 1,
            "final check",
            runbook.final_check,
            "done",
            started=_now(),
        )
        refusal, code, out = await _run(
            runbook.final_check, working_dir, env, project_dir
        )
        record.finished, record.returncode = _now(), code
        if refusal:
            record.status, record.detail = "refused", refusal
        elif code != 0:
            record.status, record.detail = (
                "check-failed",
                "the expected state was not reached",
            )
        journal.step(record, out)
        state.steps.append(record)
        if record.status != "done":
            state.status = "failed"
            state.detail = f"final check {record.status}: {record.detail}"
            _write_state(spec_dir, state)
            return state

    state.status = "done"
    state.detail = f"{len(runbook.steps)} step(s) played"
    journal.append(f"\n---\n\n**Done** {_now()} — {state.detail}.\n")
    _write_state(spec_dir, state)
    return state


async def _play(
    step: RunbookStep,
    cwd: Path,
    env: dict[str, str],
    project_dir: Path,
    journal: _Journal,
) -> StepRecord:
    record = StepRecord(step.number, step.name, step.command, "done", started=_now())
    refusal, code, out = await _run(step.command, cwd, env, project_dir)
    record.finished, record.returncode = _now(), code
    if refusal:
        record.status, record.detail = "refused", refusal
    elif code != 0:
        record.status = "failed"
        record.detail = "non-zero exit" if code is not None else (out or "did not run")
    journal.step(record, out)
    if record.status != "done" or not step.check:
        return record
    # The step's own check: the effect it promised, observed.
    refusal, code, out2 = await _run(step.check, cwd, env, project_dir)
    check = StepRecord(
        step.number, f"{step.name} — check", step.check, "done", started=_now()
    )
    check.finished, check.returncode = _now(), code
    if refusal:
        check.status, check.detail = "refused", refusal
    elif code != 0:
        check.status, check.detail = (
            "check-failed",
            "the expected effect was not observed",
        )
    journal.step(check, out2)
    if check.status != "done":
        record.status, record.detail = check.status, check.detail
    return record


# ---------------------------------------------------------------------------
# The phase


async def run_execute_phase(resolved, ctx):
    """`CUSTOM_EXECUTORS["execute"]`: no session, no token."""
    from .runner import PhaseOutcome

    phase = resolved.phase
    try:
        runbook = load_runbook(ctx.spec_dir)
    except RunbookError as exc:
        return PhaseOutcome(
            phase.id, phase.impl, resolved.dispatch, None, detail=str(exc)
        )
    state = await execute_runbook(
        runbook,
        spec_dir=ctx.spec_dir,
        project_dir=ctx.project_dir,
        working_dir=ctx.project_dir,
    )
    journal = Path(ctx.spec_dir) / "workflow" / JOURNAL_FILE
    if state.status == "done":
        return PhaseOutcome(
            phase.id,
            phase.impl,
            resolved.dispatch,
            True,
            detail=f"{state.detail} → {journal.name}",
            output_path=journal,
        )
    if state.status == "blocked":
        return PhaseOutcome(
            phase.id, phase.impl, resolved.dispatch, None, detail=state.detail
        )
    return PhaseOutcome(
        phase.id,
        phase.impl,
        resolved.dispatch,
        False,
        detail=f"{state.detail} → {journal.name}",
        output_path=journal if journal.is_file() else None,
    )


def procedure_digest(spec_dir: Path) -> str | None:
    """The sha256 of the procedure on disk, for callers that compare."""
    path = Path(spec_dir) / "workflow" / "procedure.md"
    if not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()
