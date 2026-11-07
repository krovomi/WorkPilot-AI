"""
Documentation Runner

The "Documentation" tab's backend: documentation coverage of the whole
project or of one file, draft doc comments for one file, README for one
folder. Every language of ``doc_languages`` is read (Python through its AST,
the others through their declaration patterns), and each draft follows the
language's own convention (XML doc, KDoc, rustdoc, godoc, Swift markup...).

Paths given by the app are relative to the project; a path that resolves
outside it is refused.

Output protocol (one line each, prefixed):
    DOCUMENTATION_EVENT:{"type": "progress", "data": {"status": "..."}}
    DOCUMENTATION_RESULT:{...}
    DOCUMENTATION_ERROR:<message>
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from agents.documenter import DocStatus, DocumentationAgent  # noqa: E402
from doc_languages import language_for  # noqa: E402

IGNORED_DIRS = {
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "__pycache__",
    ".venv",
    "venv",
    ".workpilot",
    "out",
    "coverage",
    "bin",
    "obj",
    "target",
    "vendor",
    "Pods",
    ".dart_tool",
    ".gradle",
    ".idea",
    ".vs",
}
MAX_FILES = 4000
MAX_FILE_BYTES = 400_000
TOP_FILES = 40


def _emit(prefix: str, payload: Any) -> None:
    print(f"{prefix}:{json.dumps(payload, default=str)}", flush=True)


def _error(message: str) -> None:
    print(f"DOCUMENTATION_ERROR:{' '.join(message.split())}", flush=True)


def _progress(status: str) -> None:
    _emit("DOCUMENTATION_EVENT", {"type": "progress", "data": {"status": status}})


def _inside(project: Path, relative: str) -> Path:
    """``relative`` resolved under ``project``; refuses anything outside it."""
    target = (project / relative).resolve()
    root = project.resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"Path is outside the project: {relative}")
    return target


def _rel(project: Path, path: Path) -> str:
    return str(path.resolve().relative_to(project.resolve())).replace("\\", "/")


def _source_files(project: Path) -> list[Path]:
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(project):
        dirnames[:] = [
            d for d in dirnames if d not in IGNORED_DIRS and not d.startswith(".")
        ]
        for name in filenames:
            if language_for(name) is None:
                continue
            path = Path(dirpath) / name
            try:
                if path.stat().st_size > MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            out.append(path)
            if len(out) >= MAX_FILES:
                return out
    return out


def _counts(symbols: list[Any]) -> dict[str, int]:
    return {
        "total": len(symbols),
        "documented": sum(1 for s in symbols if s.status == DocStatus.DOCUMENTED),
        "partial": sum(1 for s in symbols if s.status == DocStatus.PARTIAL),
        "missing": sum(1 for s in symbols if s.status == DocStatus.MISSING),
    }


def _pct(counts: dict[str, int]) -> float:
    return (
        round(counts["documented"] / counts["total"] * 100, 1)
        if counts["total"]
        else 0.0
    )


def project_overview(project: Path) -> dict[str, Any]:
    """Coverage of every source file, per language and per file."""
    agent = DocumentationAgent()
    _progress("Listing source files...")
    files = _source_files(project)
    per_language: dict[str, dict[str, Any]] = {}
    per_file: list[dict[str, Any]] = []
    for index, path in enumerate(files, 1):
        if index % 200 == 0:
            _progress(f"Reading {index}/{len(files)} files...")
        try:
            symbols = agent.analyzer.analyze_file(str(path))
        except (OSError, ValueError):
            continue
        if not symbols:
            continue
        lang = language_for(path.name)
        if lang is None:
            continue
        counts = _counts(symbols)
        bucket = per_language.setdefault(
            lang.id,
            {
                "id": lang.id,
                "label": lang.label,
                "files": 0,
                "total": 0,
                "documented": 0,
                "partial": 0,
                "missing": 0,
            },
        )
        bucket["files"] += 1
        for key in ("total", "documented", "partial", "missing"):
            bucket[key] += counts[key]
        per_file.append(
            {
                "path": _rel(project, path),
                "language": lang.id,
                **counts,
                "coverage_pct": _pct(counts),
            }
        )

    totals = {
        key: sum(b[key] for b in per_language.values())
        for key in ("total", "documented", "partial", "missing")
    }
    languages = sorted(per_language.values(), key=lambda b: -b["total"])
    for bucket in languages:
        bucket["coverage_pct"] = _pct(bucket)
    worst = sorted(per_file, key=lambda f: (-(f["missing"] + f["partial"]), f["path"]))
    return {
        "files_scanned": len(files),
        "files_with_symbols": len(per_file),
        "truncated": len(files) >= MAX_FILES,
        **totals,
        "coverage_pct": _pct(totals),
        "languages": languages,
        "files": [f for f in worst if f["missing"] + f["partial"] > 0][:TOP_FILES],
    }


def file_coverage(project: Path, relative: str) -> dict[str, Any]:
    path = _inside(project, relative)
    if not path.is_file():
        raise ValueError(f"File not found: {relative}")
    if language_for(path.name) is None:
        raise ValueError(f"Unsupported file type: {path.suffix or path.name}")
    coverage = DocumentationAgent().check_documentation_coverage(file_path=str(path))
    for sym in coverage.get("symbols", []):
        sym["file_path"] = relative
    coverage["path"] = relative
    lang = language_for(path.name)
    coverage["language"] = lang.id if lang else None
    return coverage


def file_docstrings(project: Path, relative: str) -> dict[str, Any]:
    path = _inside(project, relative)
    if not path.is_file():
        raise ValueError(f"File not found: {relative}")
    if language_for(path.name) is None:
        raise ValueError(f"Unsupported file type: {path.suffix or path.name}")
    result = DocumentationAgent().generate_docstrings(file_path=str(path)).to_dict()
    result["source_path"] = relative
    # Only what still needs a doc comment: the documented symbols are noise here.
    result["generated_docs"] = [
        {**d, "file_path": relative}
        for d in result["generated_docs"]
        if d.get("generated_doc")
    ]
    return result


def folder_readme(project: Path, relative: str) -> dict[str, Any]:
    path = _inside(project, relative or ".")
    if not path.is_dir():
        raise ValueError(f"Folder not found: {relative}")
    result = DocumentationAgent().generate_module_readme(str(path)).to_dict()
    result["source_path"] = relative or "."
    # The README names the folder by its project path, not the machine's.
    shown = relative or "."
    result["readme_content"] = result["readme_content"].replace(str(path), shown)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Documentation Runner")
    parser.add_argument("--project-path", required=True)
    parser.add_argument(
        "--action",
        required=True,
        choices=["project", "coverage", "docstrings", "readme"],
    )
    parser.add_argument("--path", default="")
    args = parser.parse_args()

    project = Path(args.project_path)
    if not project.is_dir():
        _error(f"Project path does not exist: {project}")
        sys.exit(1)
    try:
        if args.action == "project":
            result = project_overview(project)
        elif args.action == "coverage":
            result = file_coverage(project, args.path)
        elif args.action == "docstrings":
            result = file_docstrings(project, args.path)
        else:
            result = folder_readme(project, args.path)
        _emit("DOCUMENTATION_RESULT", result)
    except Exception as exc:  # noqa: BLE001 - reported to the UI as the error line
        _error(str(exc))
        sys.exit(1)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
