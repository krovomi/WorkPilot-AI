"""
Accessibility Runner

Scans a project tree for WCAG accessibility violations and emits a
structured report. Designed to be invoked by the Electron frontend
via the accessibility IPC handler.

Output protocol (one JSON object per line, prefixed):
    A11Y_EVENT:{"type": "progress", "data": {"status": "..."}}
    A11Y_RESULT:{...full report dict...}
    A11Y_FIX:{"applied": [...], "missing": [...]}
    A11Y_ERROR:<message>

``--fix FILE`` makes the fixes whose ids FILE lists (a JSON array) in the
files under ``--project-path``. The desktop app only ever points it at the
worktree of a review card, never at the person's checkout (#391).
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

from accessibility_agent.accessibility_scanner import (  # noqa: E402
    A11yReport,
    AccessibilityScanner,
    WcagLevel,
)
from accessibility_agent.contrast import load_tokens  # noqa: E402
from accessibility_agent.fixer import apply_fixes, suggest_alt  # noqa: E402
from accessibility_agent.markup import parse  # noqa: E402
from accessibility_agent.rules import LEVEL_ORDER, RULES  # noqa: E402
from accessibility_agent.score import (  # noqa: E402
    append_history,
    breakdown,
    by_file,
    read_history,
    score,
)
from i18n_agent.catalogs import iter_files  # noqa: E402

# Every markup the scanner's rules read: HTML, JSX/TSX, Vue, Svelte, Astro,
# Angular templates (.html), Blazor/Razor, PHP/Blade, Twig, ERB, Handlebars.
SCAN_EXTENSIONS = frozenset(
    {
        ".html", ".htm", ".jsx", ".tsx", ".vue", ".svelte", ".astro",
        ".razor", ".cshtml", ".php", ".twig", ".erb", ".hbs",
        # Focus visibility and contrast are read from the stylesheets too.
        ".css", ".scss", ".sass", ".less", ".styl",
    }
)  # fmt: skip
MAX_FILE_BYTES = 1024 * 1024
MAX_FILES = 20_000
_LANG = re.compile(r"^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$")


def _emit(prefix: str, payload: Any) -> None:
    print(f"{prefix}:{json.dumps(payload, default=str)}", flush=True)


def _emit_event(event_type: str, data: dict[str, Any]) -> None:
    _emit("A11Y_EVENT", {"type": event_type, "data": data})


def _iter_target_files(root: Path) -> list[Path]:
    # Pruned relative to the project: a project under a ``build/`` folder of
    # its own still gets scanned.
    return iter_files(root, SCAN_EXTENSIONS)


def _read_sources(project_path: Path) -> dict[str, str]:
    contents: dict[str, str] = {}
    for file in _iter_target_files(project_path)[:MAX_FILES]:
        try:
            if file.is_symlink() or file.stat().st_size > MAX_FILE_BYTES:
                continue
            contents[file.relative_to(project_path).as_posix()] = file.read_text(
                encoding="utf-8", errors="ignore"
            )
        except OSError:
            continue
    return contents


def _report_to_dict(report: A11yReport) -> dict[str, Any]:
    violations = [
        {
            "ruleId": v.rule_id,
            "description": v.description,
            "severity": v.severity.value,
            "wcagLevel": v.wcag_level.value,
            "wcagCriteria": v.wcag_criteria,
            "file": v.file,
            "line": v.line,
            "element": v.element,
            "suggestion": v.suggestion,
            "detail": v.detail,
            "conditional": v.conditional,
            "external": v.external,
            "fixId": v.fix_id,
            "fix": v.fix,
        }
        for v in report.violations
    ]
    files = sorted({v["file"] for v in violations})
    found = {v["ruleId"] for v in violations}
    wanted = LEVEL_ORDER[report.target_level.value]
    passed = sorted(
        rule_id
        for rule_id, rule in RULES.items()
        if LEVEL_ORDER[rule.level] <= wanted and rule_id not in found
    )
    return {
        "filesScanned": report.files_scanned,
        "targetLevel": report.target_level.value,
        "violations": violations,
        "passedRules": passed if report.files_scanned else [],
        "summary": report.summary,
        "score": score(violations, report.files_scanned),
        "criteria": breakdown(violations, report.files_scanned),
        "pages": by_file(violations, files),
        # A page whose language is not declared is its own flag (3.1.1).
        "pagesWithoutLang": sorted(
            {v["file"] for v in violations if v["ruleId"] == "page-lang"}
        ),
    }


def run_scan(
    project_path: Path,
    target_level: WcagLevel,
    page_lang: str = "en",
    record: bool = True,
) -> dict[str, Any]:
    _emit_event("start", {"status": "Discovering files..."})
    contents = _read_sources(project_path)
    _emit_event("progress", {"status": f"Scanning {len(contents)} files..."})

    scanner = AccessibilityScanner(
        target_level=target_level, tokens=load_tokens(project_path), page_lang=page_lang
    )
    report = scanner.scan_files(contents)
    result = _report_to_dict(report)
    if record:
        append_history(project_path, result)
    result["history"] = read_history(project_path)
    _emit_event(
        "complete",
        {"violations": len(report.violations), "filesScanned": report.files_scanned},
    )
    return result


def _alt_contexts(project_path: Path, ids: list[str]) -> list[dict[str, str]]:
    """What the source says about each image a fix is asked for: data for the model."""
    contexts = []
    by_file: dict[str, list[str]] = {}
    for fid in ids:
        parts = fid.split(":")
        if parts[0] in ("img-alt", "img-alt-meaningful") and len(parts) >= 4:
            by_file.setdefault(":".join(parts[1:-2]), []).append(fid)
    for relative, wanted in by_file.items():
        path = (project_path / relative).resolve()
        if not path.is_relative_to(project_path.resolve()) or not path.is_file():
            continue
        try:
            markup = parse(relative, path.read_text(encoding="utf-8", errors="ignore"))
        except OSError:
            continue
        lines = {int(f.split(":")[-2]): f for f in wanted if f.split(":")[-2].isdigit()}
        for element in markup.elements:
            fid = lines.get(element.line)
            if fid is None or element.name.lower() not in (
                "img",
                "image",
                "avatar",
                "area",
                "input",
            ):
                continue
            around = element.parent.inner if element.parent is not None else ""
            contexts.append(
                {
                    "id": fid,
                    "file": relative,
                    "src": (element.static("src") or "")[:200],
                    "component": Path(relative).stem,
                    "nearbyText": " ".join(re.sub(r"<[^>]*>", " ", around).split())[
                        :300
                    ],
                }
            )
    return contexts


def run_fix(
    project_path: Path, fixes_file: Path, page_lang: str, ai_alt: bool
) -> dict[str, Any]:
    try:
        raw = json.loads(fixes_file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"Unreadable fix list: {type(exc).__name__}") from exc
    ids = (
        [i for i in raw if isinstance(i, str) and len(i) < 600][:500]
        if isinstance(raw, list)
        else []
    )
    alts: dict[str, str] = {}
    if ai_alt:
        _emit_event("progress", {"status": "Writing alternative texts..."})
        alts = suggest_alt(
            _alt_contexts(project_path, ids), page_lang, str(project_path)
        )
    applied, missing = apply_fixes(project_path, set(ids), lang=page_lang, alts=alts)
    return {
        "applied": [f.to_dict() for f in applied],
        "missing": missing,
        "aiAlt": len([f for f in applied if f.fix_id in alts]),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Accessibility Runner")
    parser.add_argument("--project-path", required=True, help="Project root path")
    parser.add_argument(
        "--target-level",
        default="AA",
        choices=["A", "AA", "AAA"],
        help="WCAG conformance level to enforce",
    )
    parser.add_argument(
        "--page-lang", default="en", help="Language a lang fix declares"
    )
    parser.add_argument("--fix", type=Path, help="JSON array of the fix ids to make")
    parser.add_argument(
        "--ai-alt", action="store_true", help="Ask the active model for alt texts"
    )
    args = parser.parse_args()

    project_path = Path(args.project_path)
    if not project_path.exists():
        _emit("A11Y_ERROR", f"Project path does not exist: {project_path}")
        sys.exit(1)

    page_lang = args.page_lang if _LANG.match(args.page_lang or "") else "en"
    try:
        if args.fix:
            _emit("A11Y_FIX", run_fix(project_path, args.fix, page_lang, args.ai_alt))
            return
        result = run_scan(project_path, WcagLevel(args.target_level), page_lang)
        _emit("A11Y_RESULT", result)
    except Exception as exc:  # noqa: BLE001
        _emit("A11Y_ERROR", str(exc))
        sys.exit(1)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
