"""« Exposition de l'artefact »: what the project's build output reveals, by REA.

`audit` runs REA's ``audit-release-exposure`` on each artifact
`artifacts.find_artifacts` found, and reads the verdict from the checks
themselves: a check ``exposed`` at the threshold (``high`` by default) or above
fails; ``unknown`` and ``not_assessed`` are what static analysis could not
decide and never fail. No artifact, no Node.js, REA missing, a time out, one
artifact REA could not read: the report is ``unchecked``, read by the gates as
unknown, never as a pass.

The record (``artifact_exposure.json`` in the spec directory) holds what REA
said about each check (id, status, severity, the remediation REA wrote, a few
sample paths): data read from a file the task built, quoted as untrusted
before a model reads it (`qa/exposure_gate.py`).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .artifacts import Artifact, find_artifacts
from .locate import ReaLauncher, ReaUnavailable
from .runner import ReaRun, run_rea

__all__ = [
    "FAIL",
    "FAIL_LEVELS",
    "PASS",
    "RECORD",
    "UNCHECKED",
    "ArtifactAudit",
    "ExposureReport",
    "audit",
    "blocking_checks",
    "load_record",
    "write_record",
]

RECORD = "artifact_exposure.json"
PASS = "pass"
FAIL = "fail"
UNCHECKED = "unchecked"
FAIL_LEVELS = ("high", "medium", "low")
_RANK = {"low": 1, "medium": 2, "high": 3}
_MAX_CHECKS = 40
_MAX_TEXT = 400
_MAX_SAMPLES = 3


def _text(value: object, limit: int = _MAX_TEXT) -> str:
    return str(value)[:limit] if isinstance(value, str) else ""


def _checks(result: dict) -> list[dict]:
    """REA's checks, cut to the fields the gates and the card read."""
    kept: list[dict] = []
    for check in result.get("checks") or []:
        if not isinstance(check, dict):
            continue
        observation = check.get("observation")
        samples = observation.get("samples") if isinstance(observation, dict) else None
        kept.append(
            {
                "id": _text(check.get("id"), 80),
                "status": _text(check.get("status"), 20),
                "severity": _text(check.get("severity"), 10) or None,
                "remediation": _text(check.get("remediation")),
                "samples": [
                    _text(s, 200)
                    for s in (samples or [])[:_MAX_SAMPLES]
                    if isinstance(s, str)
                ],
            }
        )
        if len(kept) >= _MAX_CHECKS:
            break
    return kept


def blocking_checks(checks: list[dict], fail_on: str) -> list[dict]:
    """Checks exposed at ``fail_on`` or above, from the checks themselves."""
    floor = _RANK.get(fail_on, _RANK["high"])
    return [
        c
        for c in checks
        if c.get("status") == "exposed"
        and _RANK.get(str(c.get("severity")), 0) >= floor
    ]


@dataclass
class ArtifactAudit:
    path: str
    """Relative to the project."""
    kind: str
    status: str
    """``pass``, ``fail`` or ``unchecked``."""
    checks: list[dict] = field(default_factory=list)
    detail: str = ""

    @property
    def blocking(self) -> list[dict]:
        return [c for c in self.checks if c.get("blocking")]


@dataclass
class ExposureReport:
    fail_on: str = "high"
    mode: str = "warn"
    status: str = UNCHECKED
    artifacts: list[ArtifactAudit] = field(default_factory=list)
    unchecked: str = ""
    """Why nothing was decided, when ``status`` is ``unchecked``."""
    rea: str = ""
    """The REA release that answered, and how it ran (installed or npx)."""

    @property
    def blocking(self) -> list[tuple[ArtifactAudit, dict]]:
        return [(a, c) for a in self.artifacts for c in a.blocking]

    def to_dict(self) -> dict:
        return asdict(self)


def _audit_one(
    artifact: Artifact,
    project_dir: Path,
    fail_on: str,
    launcher: ReaLauncher | ReaUnavailable,
    runner: Callable[..., ReaRun],
) -> ArtifactAudit:
    relative = artifact.relative(project_dir)
    run = runner(
        "audit-release-exposure",
        [artifact.path],
        {"--fail_on": fail_on},
        project_dir=project_dir,
        launcher=launcher,
    )
    if not run.ok or run.result is None:
        return ArtifactAudit(
            path=relative,
            kind=artifact.kind,
            status=UNCHECKED,
            detail=f"{run.error}: {run.detail}"[:_MAX_TEXT],
        )
    checks = _checks(run.result)
    if not checks:
        return ArtifactAudit(
            path=relative,
            kind=artifact.kind,
            status=UNCHECKED,
            detail="REA ran no check",
        )
    blocking = {id(c) for c in blocking_checks(checks, fail_on)}
    for check in checks:
        check["blocking"] = id(check) in blocking
    return ArtifactAudit(
        path=relative,
        kind=artifact.kind,
        status=FAIL if blocking else PASS,
        checks=checks,
    )


def audit(
    project_dir: Path | str,
    *,
    fail_on: str = "high",
    mode: str = "warn",
    launcher: ReaLauncher | ReaUnavailable,
    artifacts: list[Artifact] | None = None,
    runner: Callable[..., ReaRun] = run_rea,
) -> ExposureReport:
    """Audit what ``project_dir`` built. Never raises."""
    root = Path(project_dir).resolve()
    fail_on = fail_on if fail_on in FAIL_LEVELS else "high"
    report = ExposureReport(fail_on=fail_on, mode=mode)
    if isinstance(launcher, ReaUnavailable):
        report.unchecked = f"REA cannot run here ({launcher.reason}): {launcher.detail}"
        return report
    report.rea = f"rea-agents@{launcher.version} ({launcher.source})"
    found = find_artifacts(root) if artifacts is None else artifacts
    if not found:
        report.unchecked = "no build output found: nothing shipped to read"
        return report
    report.artifacts = [
        _audit_one(artifact, root, fail_on, launcher, runner) for artifact in found
    ]
    statuses = [a.status for a in report.artifacts]
    if FAIL in statuses:
        report.status = FAIL
    elif all(status == PASS for status in statuses):
        report.status = PASS
    else:
        # A pass says every artifact was read: one REA could not read is unknown.
        unread = statuses.count(UNCHECKED)
        report.unchecked = f"REA could not read {unread} of {len(statuses)} artifact(s)"
    return report


def write_record(spec_dir: Path | str, report: ExposureReport) -> None:
    spec_dir = Path(spec_dir)
    spec_dir.mkdir(parents=True, exist_ok=True)
    (spec_dir / RECORD).write_text(
        json.dumps(report.to_dict(), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def load_record(spec_dir: Path | str) -> dict | None:
    try:
        data = json.loads((Path(spec_dir) / RECORD).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None
