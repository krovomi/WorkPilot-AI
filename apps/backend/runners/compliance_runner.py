"""
Compliance Runner (#357)

The audit evidence of a project, judged against a framework's controls
(`compliance_collector/`), with no model.

    --frameworks                 the frameworks and the project's choice
    --framework soc2 [--period 2026-10] [--save]
                                 one report (the month to date by default)
    --monthly                    the missing reports of the month just ended
    --list | --load NAME         the saved reports
    --config FILE                save the project's choice (a JSON file)

Output protocol (one JSON object per line, prefixed):
    COMPLIANCE_EVENT:{"type": "progress", "data": {"status": "..."}}
    COMPLIANCE_RESULT:{...}
    COMPLIANCE_ERROR:<message>
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from compliance_collector import (  # noqa: E402
    list_reports,
    load_config,
    load_frameworks,
    load_report,
    make_report,
    month_period,
    run_monthly,
    save_config,
    save_report,
)

MAX_CONFIG_BYTES = 16 * 1024


def _emit(prefix: str, payload: Any) -> None:
    print(f"{prefix}:{json.dumps(payload, default=str)}", flush=True)


def _emit_event(event_type: str, data: dict[str, Any]) -> None:
    _emit("COMPLIANCE_EVENT", {"type": event_type, "data": data})


def _frameworks(root: Path) -> dict[str, Any]:
    known, errors = load_frameworks(root)
    return {
        "frameworks": [f.summary() for f in known.values()],
        "config": load_config(root),
        "errors": errors,
    }


def _report(root: Path, framework_id: str, period: str | None, save: bool) -> dict:
    known, errors = load_frameworks(root)
    framework = known.get(framework_id)
    if framework is None:
        raise ValueError(f"unknown framework: {framework_id[:40]}")
    now = datetime.now(UTC).timestamp()
    if period:
        since, until = month_period(period)
        until = min(until, now)
    else:
        period = datetime.fromtimestamp(now, tz=UTC).strftime("%Y-%m")
        since, until = month_period(period)[0], now
    _emit_event("start", {"status": f"Collecting {framework.name} evidence..."})
    report = make_report(
        root, framework, since, until, period=period, now=now, warnings=errors
    )
    _emit_event(
        "complete",
        {"controls": len(report["controls"]), "gaps": len(report["gaps"])},
    )
    if save:
        report["saved"] = save_report(root, report)
    return report


def run(args: argparse.Namespace) -> Any:
    root = Path(args.project_path)
    if args.frameworks:
        return _frameworks(root)
    if args.list:
        return {"reports": list_reports(root)}
    if args.load:
        report = load_report(root, args.load)
        if report is None:
            raise ValueError("no such report")
        return report
    if args.config:
        path = Path(args.config)
        if path.stat().st_size > MAX_CONFIG_BYTES:
            raise ValueError("the configuration is too large")
        return {"config": save_config(root, json.loads(path.read_text("utf-8")))}
    if args.monthly:
        return {
            "made": [
                {
                    "name": m["name"],
                    "framework": m["report"]["framework"],
                    "period": m["report"]["period"]["label"],
                    "coveragePercent": m["report"]["coveragePercent"],
                    "alerts": [g for g in m["report"]["gaps"] if g["alert"]],
                }
                for m in run_monthly(root)
            ]
        }
    return _report(root, args.framework, args.period, args.save)


def main() -> None:
    parser = argparse.ArgumentParser(description="Compliance Runner")
    parser.add_argument("--project-path", required=True, help="Project root path")
    parser.add_argument("--framework", default="soc2")
    parser.add_argument("--period", help="YYYY-MM (default: this month to date)")
    parser.add_argument("--save", action="store_true")
    parser.add_argument("--frameworks", action="store_true")
    parser.add_argument("--monthly", action="store_true")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--load")
    parser.add_argument("--config")
    args = parser.parse_args()

    if not Path(args.project_path).is_dir():
        _emit("COMPLIANCE_ERROR", f"Project path does not exist: {args.project_path}")
        sys.exit(1)
    try:
        _emit("COMPLIANCE_RESULT", run(args))
    except (OSError, ValueError) as exc:
        _emit("COMPLIANCE_ERROR", str(exc)[:500])
        sys.exit(1)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
