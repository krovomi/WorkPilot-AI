"""The schema guard over a task's change set, and its record.

`check` reads every migration the task added or changed (inside the project,
no symbolic link, bounded size), runs the rules of its tool on the engine the
manifests name, and notes a migration that existed before the task and was
changed or deleted. The record, `<spec_dir>/schema_guard.json`, is what the
hard gate `migration-safe` and the QA card read.

Status: ``fail`` when a finding is an error (data loss, rename, a NOT NULL
column that the first existing row breaks, an applied migration edited),
``warn`` when only warnings remain (locks, type changes, a missing down),
``pass`` otherwise, including a change set with no migration. ``unchecked``
says why nothing was read; it is never a pass.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path

from foundation.git_executable import run_git

from .discover import UNKNOWN, detect_engine, migration_tool
from .rules import EDITED, ERROR, Finding, analyse

__all__ = [
    "FAIL",
    "PASS",
    "RECORD",
    "UNCHECKED",
    "WARN",
    "SchemaReport",
    "check",
    "load_record",
    "write_record",
]

RECORD = "schema_guard.json"
PASS = "pass"
WARN = "warn"
FAIL = "fail"
UNCHECKED = "unchecked"

MAX_MIGRATIONS = 50
MAX_MIGRATION_BYTES = 512 * 1024

_PLAN = (
    "Expand: add the new structure next to the old one (nullable or with a default), "
    "and have the code write both.",
    "Migrate: backfill the new structure in batches that can resume, outside the "
    "deploy.",
    "Switch: deploy the code that reads the new structure only.",
    "Contract: once no running version uses it, drop the old structure in a later "
    "migration.",
)


@dataclass
class SchemaReport:
    engine: str = UNKNOWN
    migrations: list[dict] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)
    unchecked: str = ""
    mode: str = ""
    base: str = ""
    checked_at: float = field(default_factory=time.time)

    @property
    def status(self) -> str:
        if self.unchecked:
            return UNCHECKED
        if any(f.severity == ERROR for f in self.findings):
            return FAIL
        return WARN if self.findings else PASS

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == ERROR]

    @property
    def plan(self) -> list[str]:
        return list(_PLAN) if self.errors else []

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "engine": self.engine,
            "mode": self.mode,
            "base": self.base,
            "unchecked": self.unchecked,
            "migrations": self.migrations,
            "findings": [f.to_dict() for f in self.findings],
            "plan": self.plan,
            "checked_at": self.checked_at,
        }


def _inside(root: Path, relative: str) -> Path | None:
    candidate = root / relative
    try:
        if candidate.is_symlink():
            return None
        resolved = candidate.resolve()
        resolved.relative_to(root)
    except (OSError, ValueError):
        return None
    return resolved


def _reader(root: Path):
    cache: dict[str, str] = {}

    def read(relative: str) -> str:
        if relative not in cache:
            path = _inside(root, relative)
            text = ""
            try:
                if (
                    path is not None
                    and path.is_file()
                    and path.stat().st_size <= MAX_MIGRATION_BYTES
                ):
                    text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                text = ""
            cache[relative] = text
        return cache[relative]

    return read


def _existed(root: Path, base: str, relative: str) -> bool:
    if not base:
        return False
    try:
        result = run_git(["cat-file", "-e", f"{base}:{relative}"], cwd=root, timeout=15)
    except OSError:
        return False
    return result.returncode == 0


def _base_text(root: Path, base: str, relative: str) -> str:
    """A deleted file's text at the task's base, to know which tool wrote it."""
    if not base:
        return ""
    try:
        result = run_git(["show", f"{base}:{relative}"], cwd=root, timeout=15)
    except OSError:
        return ""
    if result.returncode != 0 or len(result.stdout) > MAX_MIGRATION_BYTES:
        return ""
    return result.stdout


def _edited(path: str, tool: str, deleted: bool) -> Finding:
    return Finding(
        kind=EDITED,
        severity=ERROR,
        path=path,
        line=1,
        statement="",
        message=(
            "deletes a migration that existed before the task"
            if deleted
            else "changes a migration that existed before the task"
        ),
        advice=(
            "This migration may already have run somewhere: restore it and add a "
            "new migration for the change."
        ),
    )


def check(
    project_root: Path,
    files: list[str] | tuple[str, ...],
    base: str = "",
    *,
    mode: str = "",
) -> SchemaReport:
    """The guard's report on the migrations among ``files`` (relative paths)."""
    root = Path(project_root).resolve()
    read = _reader(root)
    report = SchemaReport(mode=mode, base=base)
    migrations: list[tuple[str, str]] = []
    for relative in files:
        relative = str(relative).replace("\\", "/").lstrip("/")
        if not relative or ".." in relative.split("/"):
            continue
        tool = migration_tool(relative, lambda r: read(r) or _base_text(root, base, r))
        if tool is not None:
            migrations.append((relative, tool))
    if not migrations:
        return report
    report.engine = detect_engine(root)
    for relative, tool in migrations[:MAX_MIGRATIONS]:
        text = read(relative)
        existed = _existed(root, base, relative)
        report.migrations.append({"path": relative, "tool": tool, "new": not existed})
        if existed:
            report.findings.append(_edited(relative, tool, deleted=not text))
        if text:
            report.findings.extend(analyse(relative, text, tool, report.engine))
    if len(migrations) > MAX_MIGRATIONS:
        report.migrations.append(
            {
                "path": f"{len(migrations) - MAX_MIGRATIONS} more",
                "tool": "",
                "new": True,
            }
        )
    return report


def write_record(spec_dir: Path, report: SchemaReport) -> None:
    spec_dir = Path(spec_dir)
    spec_dir.mkdir(parents=True, exist_ok=True)
    (spec_dir / RECORD).write_text(
        json.dumps(report.to_dict(), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def load_record(spec_dir: Path) -> dict | None:
    try:
        data = json.loads((Path(spec_dir) / RECORD).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None
