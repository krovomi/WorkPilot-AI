"""The saved reports of a project and the monthly run (#357).

A report is saved as `.workpilot/compliance/reports/<framework>-<YYYY-MM>.json`
(WorkPilot's own folder, ignored by git: no code of the project is touched).
The monthly run makes, for each framework the project chose in
`.workpilot/compliance/config.json`, the report of the month just ended when it
is not there yet; a report already saved is never rewritten by it, so the
history stays as it was judged.

Nothing is written through a symbolic link or outside the project (S4).
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .evidence import DAY, collect_evidence
from .frameworks import Framework, load_frameworks
from .report import build_report, month_period, period_of

__all__ = [
    "list_reports",
    "load_config",
    "load_report",
    "make_report",
    "run_monthly",
    "save_config",
    "save_report",
]

FOLDER = (".workpilot", "compliance")
CONFIG_FILE = "config.json"
REPORTS = "reports"
MAX_REPORTS = 240
_NAME = re.compile(r"^([a-z0-9][a-z0-9_-]{0,39})-(\d{4}-\d{2})\.json$")
#: How far back the evidence of a report is read (the oldest a control allows).
MAX_LOOKBACK_DAYS = 3650


def _folder(root: Path, *parts: str, create: bool = False) -> Path | None:
    """`root/.workpilot/compliance/<parts>`, None when a part is a link."""
    folder = root
    for part in (*FOLDER, *parts):
        folder = folder / part
        if folder.is_symlink():
            return None
        if create and not folder.exists():
            folder.mkdir()
    resolved = folder.resolve()
    if resolved != root.resolve() and root.resolve() not in resolved.parents:
        return None
    return folder


def _write_json(path: Path, data: Any) -> None:
    if path.is_symlink():
        raise OSError(f"{path.name} is a symbolic link")
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _read(path: Path) -> dict | None:
    if path.is_symlink() or not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


# -- the project's choice -------------------------------------------------------


def load_config(project_root: Path | str) -> dict[str, Any]:
    root = Path(project_root)
    folder = _folder(root)
    data = _read(folder / CONFIG_FILE) if folder else None
    data = data or {}
    frameworks = data.get("frameworks")
    return {
        "frameworks": [f for f in frameworks if isinstance(f, str)][:20]
        if isinstance(frameworks, list)
        else [],
        "monthly": data.get("monthly") is True,
    }


def save_config(project_root: Path | str, raw: Any) -> dict[str, Any]:
    """Keeps the frameworks the app knows; ValueError when there is no such one."""
    root = Path(project_root)
    known, _errors = load_frameworks(root)
    raw = raw if isinstance(raw, dict) else {}
    chosen = raw.get("frameworks")
    chosen = [f for f in chosen if f in known] if isinstance(chosen, list) else []
    config = {
        "frameworks": list(dict.fromkeys(chosen)),
        "monthly": raw.get("monthly") is True,
    }
    if config["monthly"] and not config["frameworks"]:
        raise ValueError("a monthly report needs a framework")
    folder = _folder(root, create=True)
    if folder is None:
        raise OSError("the compliance folder is a symbolic link")
    _write_json(folder / CONFIG_FILE, config)
    return config


# -- reports --------------------------------------------------------------------


def make_report(
    project_root: Path | str,
    framework: Framework,
    since: float,
    until: float,
    *,
    period: str = "",
    now: float | None = None,
    warnings: list[str] | None = None,
    use_git: bool = True,
) -> dict[str, Any]:
    oldest = max(c.max_age_days for c in framework.controls)
    lookback = min(MAX_LOOKBACK_DAYS, max(oldest, int((until - since) // DAY) + 1))
    evidence = collect_evidence(
        project_root, min(since, until - lookback * DAY), until, use_git=use_git
    )
    return build_report(
        framework, evidence, since, until, now=now, period=period, warnings=warnings
    )


def save_report(project_root: Path | str, report: dict[str, Any]) -> str:
    """The report's file name; never through a link, never outside the project."""
    root = Path(project_root)
    name = f"{report['framework']['id']}-{report['period']['label']}.json"
    if not _NAME.match(name):
        raise ValueError(f"not a report name: {name!s:.60}")
    folder = _folder(root, REPORTS, create=True)
    if folder is None:
        raise OSError("the reports folder is a symbolic link")
    _write_json(folder / name, report)
    return name


def list_reports(project_root: Path | str) -> list[dict[str, Any]]:
    folder = _folder(Path(project_root), REPORTS)
    if folder is None or not folder.is_dir():
        return []
    found = []
    for path in folder.iterdir():
        match = _NAME.match(path.name)
        if not match:
            continue
        report = _read(path)
        if not report:
            continue
        summary = (
            report.get("summary") if isinstance(report.get("summary"), dict) else {}
        )
        found.append(
            {
                "name": path.name,
                "framework": match[1],
                "period": match[2],
                "generatedAt": report.get("generatedAt"),
                "coveragePercent": report.get("coveragePercent"),
                "gaps": len(report.get("gaps") or []),
                "alerts": summary.get("alerts", 0),
            }
        )
    found.sort(key=lambda r: (r["period"], r["framework"]), reverse=True)
    return found[:MAX_REPORTS]


def load_report(project_root: Path | str, name: str) -> dict[str, Any] | None:
    if not isinstance(name, str) or not _NAME.match(name):
        return None
    folder = _folder(Path(project_root), REPORTS)
    return _read(folder / name) if folder else None


def _previous_month(now: float) -> str:
    moment = datetime.fromtimestamp(now, tz=UTC)
    first = datetime(moment.year, moment.month, 1, tzinfo=UTC).timestamp()
    return period_of(first - 1)


def run_monthly(
    project_root: Path | str, *, now: float | None = None
) -> list[dict[str, Any]]:
    """The reports of the month just ended that were missing, now made and saved."""
    root = Path(project_root)
    config = load_config(root)
    if not config["monthly"]:
        return []
    now = now if now is not None else datetime.now(UTC).timestamp()
    label = _previous_month(now)
    since, until = month_period(label)
    known, errors = load_frameworks(root)
    saved = {r["name"] for r in list_reports(root)}
    made = []
    for framework_id in config["frameworks"]:
        framework = known.get(framework_id)
        if framework is None or f"{framework_id}-{label}.json" in saved:
            continue
        report = make_report(
            root, framework, since, until, period=label, now=now, warnings=errors
        )
        made.append({"name": save_report(root, report), "report": report})
    return made
