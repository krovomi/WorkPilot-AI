"""The analyses of a server project, run on the server, their reports shared.

The desktop app's analysis views (accessibility, i18n, documentation drift,
flaky tests, technical debt) start a runner of ``runners/`` in the project's
folder and show the report it prints. A server project has no folder on the
computer: the runner runs here, as a job on the project's clone
(``project_jobs``, confined like every job), and its report is saved in the
clone, ``.workpilot/analyses/<analysis>.json``, so every member of the
project reads the last one, with who ran it and when.

An analysis is declared here, once: its runner, the options it takes (a
closed model each) and how its report is told apart in what the runner
prints. Nothing a client sends names a runner, a path or a raw argument: the
request names an analysis of this list, and gives its options.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import partial
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from server.authz.principal import get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import ProjectJob
from server.services.project_jobs import get_project_jobs
from server.services.run_manager import RunManagerError
from shared_board.cards import _require_writer
from shared_features.api import (
    job_public,
    job_with_output,
    read_file,
    write_json_file,
)
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/features/analyses", tags=["features"])

#: Where the reports are saved, relative to the clone.
REPORT_DIR = ".workpilot/analyses"
MAX_REPORT = 8_000_000


class NoOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AccessibilityOptions(NoOptions):
    target_level: Literal["A", "AA", "AAA"] = "AA"


class I18nOptions(NoOptions):
    #: A locale name as the runner compares it (``en``, ``pt-BR``, ``zh_Hans``).
    reference_locale: str = Field(
        default="en", pattern=r"^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$"
    )


class FlakyOptions(NoOptions):
    threshold: float = Field(default=0.05, ge=0.0, le=1.0)
    min_runs: int = Field(default=2, ge=1, le=1000)


def _prefixed(prefix: str) -> Callable[[str], Any]:
    """The report of a runner that prints it as ``<prefix>:<json>``."""
    marker = f"{prefix}:"

    def parse(line: str) -> Any:
        return json.loads(line[len(marker) :]) if line.startswith(marker) else None

    return parse


def _result_object(line: str) -> Any:
    """The report of a runner that prints ``{"result": …}``."""
    if not line.startswith("{"):
        return None
    data = json.loads(line)
    return data.get("result") if isinstance(data, dict) else None


@dataclass(frozen=True)
class Analysis:
    #: The analysis's name in the routes, the job and the report's file.
    key: str
    #: A file of ``runners/``.
    runner: str
    options: type[NoOptions]
    #: The runner's arguments after ``--project-path <clone>``.
    args: Callable[[Any], list[str]]
    #: The report, from one line the runner printed; None for any other line.
    report: Callable[[str], Any]

    @property
    def feature(self) -> str:
        return f"analysis-{self.key}"

    @property
    def report_file(self) -> str:
        return f"{self.key}.json"


ANALYSES: tuple[Analysis, ...] = (
    Analysis(
        key="accessibility",
        runner="accessibility_runner.py",
        options=AccessibilityOptions,
        args=lambda o: ["--target-level", o.target_level],
        report=_prefixed("A11Y_RESULT"),
    ),
    Analysis(
        key="i18n",
        runner="i18n_runner.py",
        options=I18nOptions,
        args=lambda o: ["--reference-locale", o.reference_locale],
        report=_prefixed("I18N_RESULT"),
    ),
    Analysis(
        key="doc-drift",
        runner="doc_drift_runner.py",
        options=NoOptions,
        args=lambda _o: [],
        report=_prefixed("DOC_DRIFT_RESULT"),
    ),
    Analysis(
        key="flaky-tests",
        runner="flaky_tests_runner.py",
        options=FlakyOptions,
        args=lambda o: ["--threshold", str(o.threshold), "--min-runs", str(o.min_runs)],
        report=_prefixed("FLAKY_RESULT"),
    ),
    Analysis(
        key="tech-debt",
        runner="tech_debt_runner.py",
        options=NoOptions,
        args=lambda _o: ["--command", "scan"],
        report=_result_object,
    ),
)


def analysis_named(kind: str) -> Analysis:
    """The declared analysis ``kind``; 404 for any other name."""
    found = next((a for a in ANALYSES if a.key == kind), None)
    if found is None:
        raise HTTPException(status_code=404, detail="No such analysis")
    return found


def _report_dir(clone: Path) -> Path | None:
    """The reports' directory in the clone; None if a link leads it out,
    its own or one of its parents' (``.workpilot`` may not exist yet, or be
    a link the repository holds)."""
    directory = clone / REPORT_DIR
    if not directory.resolve().is_relative_to(clone.resolve()):
        return None
    return directory


def last_report(analysis: Analysis, lines: list[str]) -> Any:
    """The last report among what the runner printed; None if it printed none."""
    for line in reversed(lines):
        try:
            report = analysis.report(line.strip())
        except ValueError:
            continue
        if report is not None:
            return report
    return None


async def _save_report(
    analysis: Analysis, clone: Path, user_id: str, status: str, lines: list[str]
) -> None:
    """Save the report of a job that succeeded, for every member to read."""
    if status != "succeeded":
        return
    report = last_report(analysis, lines)
    directory = _report_dir(clone)
    if report is None or directory is None:
        return
    saved = {
        "analysis": analysis.key,
        "report": report,
        "finished_at": datetime.now(UTC).isoformat(),
        "run_by": user_id,
    }
    try:
        write_json_file(directory, analysis.report_file, json.dumps(saved))
    except (HTTPException, OSError):
        # The job still succeeded; the last saved report stays.
        return


@router.post("/{kind}/jobs", status_code=202)
async def start_analysis(
    kind: str,
    request: Request,
    body: dict[str, Any] = Body(default_factory=dict),
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Run an analysis of the project on its clone, as the caller."""
    principal = get_principal(request)
    _require_writer(scope, principal)
    analysis = analysis_named(kind)
    try:
        options = analysis.options.model_validate(body)
    except ValueError as e:
        raise HTTPException(status_code=422, detail="Invalid options") from e
    try:
        started = await get_project_jobs().start(
            project_id=scope.project_id,
            org_id=scope.org_id,
            server_path=str(scope.path),
            feature=analysis.feature,
            runner=analysis.runner,
            args=analysis.args(options),
            user_id=principal.id,
            project_flag="--project-path",
            on_finish=partial(_save_report, analysis, scope.path, principal.id),
        )
    except RunManagerError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    return job_public(started)


async def _own_job(
    db: AsyncSession, scope: ProjectScope, analysis: Analysis, job_id: str
) -> ProjectJob:
    job = await db.get(ProjectJob, job_id)
    if (
        job is None
        or job.project_id != scope.project_id
        or job.feature != analysis.feature
    ):
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.get("/{kind}/jobs/{job_id}")
async def get_analysis_job(
    kind: str,
    job_id: str,
    after: int = Query(default=0, ge=0),
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """An analysis job and the lines of its output after line ``after``."""
    job = await _own_job(db, scope, analysis_named(kind), job_id)
    return await job_with_output(db, scope, job, after)


@router.post("/{kind}/jobs/{job_id}/cancel")
async def cancel_analysis_job(
    kind: str,
    job_id: str,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    _require_writer(scope, get_principal(request))
    job = await _own_job(db, scope, analysis_named(kind), job_id)
    return {"cancelled": await get_project_jobs().cancel(job.id)}


@router.get("/{kind}/report")
async def get_report(
    kind: str,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, str | None]:
    """The last saved report of the analysis, as saved; null if none."""
    analysis = analysis_named(kind)
    directory = _report_dir(scope.path)
    if directory is None:
        raise HTTPException(status_code=409, detail="Reports unavailable")
    return {"report": read_file(directory, analysis.report_file, MAX_REPORT)}
