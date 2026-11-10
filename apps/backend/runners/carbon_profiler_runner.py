"""Carbon profiler runner: the report, the budget, the settings and the export.

Reads ``.workpilot/carbon-ledger.json`` (written by ``core.usage_tracker``)
and ``.workpilot/carbon.json`` (the project's settings). Modes:

    --project-path P [--month YYYY-MM] [--backfill]  the report and the budget
    --project-path P --save-config FILE              keep checked settings
    --project-path P --budget-check                  thresholds newly crossed
    --project-path P --export YYYY-MM --format F     the ESG document (json, csv, md)

Output protocol, one line each:
    CARBON_EVENT:{"type": "...", "data": {...}}
    CARBON_RESULT:{...}
    CARBON_ERROR:<message>
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from carbon_profiler import budget, config, export, ledger, report  # noqa: E402

MONTH = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
MAX_CONFIG_BYTES = 16 * 1024


def _emit(prefix: str, payload: Any) -> None:
    print(f"{prefix}:{json.dumps(payload, default=str)}", flush=True)


def _fail(message: str) -> None:
    print(f"CARBON_ERROR:{' '.join(message.split())[:500]}", flush=True)
    sys.exit(1)


def _rows(root: Path, cfg: config.CarbonConfig) -> tuple[list[ledger.Row], bool]:
    entries = ledger.raw_entries(root)
    return ledger.rows(entries or [], cfg), entries is not None


def scan(root: Path, month: str) -> dict[str, Any]:
    cfg = config.load(root)
    _emit(
        "CARBON_EVENT",
        {"type": "start", "data": {"status": "Loading the carbon ledger"}},
    )
    all_rows, has_ledger = _rows(root, cfg)
    result = report.build(all_rows, month=month)
    result.update(
        {
            "hasLedger": has_ledger,
            "budget": budget.status(all_rows, cfg),
            "config": cfg.to_dict(),
        }
    )
    _emit(
        "CARBON_EVENT", {"type": "complete", "data": {"records": result["recordCount"]}}
    )
    return result


def save_config(root: Path, file: Path) -> dict[str, Any]:
    if (
        file.is_symlink()
        or not file.is_file()
        or file.stat().st_size > MAX_CONFIG_BYTES
    ):
        raise ValueError("not a settings file")
    return config.save(root, json.loads(file.read_text(encoding="utf-8"))).to_dict()


def budget_check(root: Path) -> dict[str, Any]:
    cfg = config.load(root)
    if cfg.monthly_budget_kg <= 0:
        return {"alerts": [], "budget": None}
    all_rows, _ = _rows(root, cfg)
    current = budget.status(all_rows, cfg)
    return {"alerts": budget.due_alerts(root, current), "budget": current}


def export_month(root: Path, month: str, fmt: str) -> dict[str, Any]:
    cfg = config.load(root)
    all_rows, _ = _rows(root, cfg)
    doc = export.document(all_rows, month, cfg, root.name)
    return {"month": month, "format": fmt, "content": export.render(doc, fmt)}


def main() -> None:
    parser = argparse.ArgumentParser(description="Carbon profiler runner")
    parser.add_argument("--project-path", required=True)
    parser.add_argument("--month", default="")
    parser.add_argument(
        "--backfill",
        action="store_true",
        help="Rebuild the ledger from cost_data.json first.",
    )
    parser.add_argument("--save-config")
    parser.add_argument("--budget-check", action="store_true")
    parser.add_argument("--export")
    parser.add_argument("--format", default="json", choices=export.FORMATS)
    args = parser.parse_args()

    root = Path(args.project_path).resolve()
    if not root.is_dir():
        _fail("The project folder does not exist")
    for month in (args.month, args.export or ""):
        if month and not MONTH.match(month):
            _fail("Not a month (YYYY-MM)")

    try:
        if args.save_config:
            result = save_config(root, Path(args.save_config))
        elif args.budget_check:
            result = budget_check(root)
        elif args.export:
            result = export_month(root, args.export, args.format)
        else:
            if args.backfill:
                from core.usage_tracker import backfill_carbon_ledger_from_cost_data

                count = backfill_carbon_ledger_from_cost_data(root)
                _emit("CARBON_EVENT", {"type": "backfill", "data": {"records": count}})
            result = scan(root, args.month)
    except (OSError, ValueError) as exc:
        _fail(str(exc))
    _emit("CARBON_RESULT", result)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
