"""
i18n Runner

Scans a project tree for internationalisation issues: hardcoded
user-facing strings, missing translation keys, locale file
inconsistencies, and translation coverage per locale.

Output protocol (one JSON object per line, prefixed):
    I18N_EVENT:{"type": "progress", "data": {"status": "..."}}
    I18N_RESULT:{...full report dict...}
    I18N_TRANSLATE:{written, added, rejected, skipped, answered, notWritable}
    I18N_ERROR:<message>
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

from i18n_agent.audit import audit, translate_catalogs  # noqa: E402


def _emit(prefix: str, payload: Any) -> None:
    print(f"{prefix}:{json.dumps(payload, default=str)}", flush=True)


def _emit_event(event_type: str, data: dict[str, Any]) -> None:
    _emit("I18N_EVENT", {"type": event_type, "data": data})


def run_scan(project_path: Path, reference_locale: str) -> dict[str, Any]:
    _emit_event("start", {"status": "Discovering source files..."})
    result = audit(
        project_path,
        reference_locale,
        emit=lambda status: _emit_event("progress", {"status": status}),
    )
    _emit_event(
        "complete",
        {"issues": len(result["issues"]), "filesScanned": result["filesScanned"]},
    )
    return result


def run_translate(
    project_path: Path, reference_locale: str, locales: list[str]
) -> dict[str, Any]:
    _emit_event("progress", {"status": "Translating the missing keys..."})
    return translate_catalogs(project_path, reference_locale, locales or None)


_LOCALE = re.compile(r"^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$")


def main() -> None:
    parser = argparse.ArgumentParser(description="i18n Runner")
    parser.add_argument("--project-path", required=True, help="Project root path")
    parser.add_argument(
        "--reference-locale",
        default="en",
        help="Reference locale to compare other locales against",
    )
    parser.add_argument(
        "--translate",
        action="store_true",
        help="Add each locale's missing keys, translated by the active model "
        "(run it in a review worktree: it writes the catalogs)",
    )
    parser.add_argument(
        "--locales",
        default="",
        help="Comma-separated locales to translate (all by default)",
    )
    args = parser.parse_args()
    locales = [x for x in args.locales.split(",") if x]
    if not _LOCALE.match(args.reference_locale) or not all(
        _LOCALE.match(x) for x in locales
    ):
        _emit("I18N_ERROR", "Invalid locale")
        sys.exit(1)

    project_path = Path(args.project_path)
    if not project_path.exists():
        _emit("I18N_ERROR", f"Project path does not exist: {project_path}")
        sys.exit(1)

    try:
        if args.translate:
            _emit(
                "I18N_TRANSLATE",
                run_translate(project_path, args.reference_locale, locales),
            )
            return
        result = run_scan(project_path, args.reference_locale)
        _emit("I18N_RESULT", result)
    except Exception as exc:  # noqa: BLE001
        _emit("I18N_ERROR", str(exc))
        sys.exit(1)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
