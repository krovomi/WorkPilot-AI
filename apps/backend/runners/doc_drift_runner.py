"""
Doc Drift Runner

Scans a project for documentation that drifts from the actual code.
Compares references in markdown / RST docs against symbols and files
discovered in the source tree.

Output protocol (one JSON object per line, prefixed):
    DOC_DRIFT_EVENT:{"type": "progress", "data": {"status": "..."}}
    DOC_DRIFT_RESULT:{...full report dict...}
    DOC_DRIFT_ERROR:<message>
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from doc_drift_detector.drift_scanner import DriftScanner  # noqa: E402
from doc_languages import language_for, symbol_names  # noqa: E402

DOC_EXTENSIONS = {".md", ".mdx", ".rst", ".adoc"}
DEFAULT_IGNORES = {
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
}
MAX_SOURCE_BYTES = 600_000
_WORD = re.compile(r"[A-Za-z_]\w*")


def _emit(prefix: str, payload: Any) -> None:
    print(f"{prefix}:{json.dumps(payload, default=str)}", flush=True)


def _emit_event(event_type: str, data: dict[str, Any]) -> None:
    _emit("DOC_DRIFT_EVENT", {"type": event_type, "data": data})


def _walk(root: Path) -> list[Path]:
    """Every file under ``root``, generated and dependency folders pruned."""
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in DEFAULT_IGNORES]
        out.extend(Path(dirpath) / name for name in filenames)
    return out


_NOT_PROJECT_DOC_DIRS = frozenset(
    {
        "changelog.d", "skills", "templates", "template", "examples", "fixtures",
        "__fixtures__", "testdata", "test-data", "references", "prompts", "audit",
    }
)  # fmt: skip


def _is_not_project_doc(path: Path) -> bool:
    """Documents that do not describe this code base as it is now:
    changelogs and release notes cite files as they were, agent skills,
    templates and examples describe the reader's project."""
    name = path.stem.lower()
    return name in {
        "changelog",
        "history",
        "changes",
        "news",
        "releases",
        "release-notes",
        "skill",
    } or any(part.lower() in _NOT_PROJECT_DOC_DIRS for part in path.parts)


def _rel(root: Path, path: Path) -> str:
    return str(path.relative_to(root)).replace("\\", "/")


def _file_resolver(root: Path, all_files: set[str]):
    """How a path cited in a document is found: next to the document, from
    the project root, or as the tail of a project path (docs often cite
    ``src/x.ts`` from a package README inside a monorepo)."""
    suffixes = {f"/{f}" for f in all_files}

    def exists(doc_path: str, ref: str) -> bool:
        ref = ref[2:] if ref.startswith("./") else ref
        if ref in all_files or ref.rstrip("/") in all_files:
            return True
        name = ref.rstrip("/").rsplit("/", 1)[-1]
        if name.startswith(".env") or name.endswith(".local"):
            return True  # local, git-ignored config the reader creates
        doc_dir = (root / doc_path).parent
        if (doc_dir / ref).exists() or (root / ref).exists():
            return True
        tail = "/" + ref.rstrip("/")
        if any(s.endswith(tail) for s in suffixes):
            return True
        # A path whose first folder exists nowhere in this project describes
        # another repository (a guide, an agent skill): not this one's drift.
        first = ref.split("/", 1)[0]
        return not ((doc_dir / first).exists() or (root / first).exists())

    return exists


def _issue_to_dict(issue: Any) -> dict[str, Any]:
    return {
        "driftType": issue.drift_type.value,
        "severity": issue.severity.value,
        "docFile": issue.doc_file,
        "docLine": issue.doc_line,
        "referencedSymbol": issue.referenced_symbol,
        "message": issue.message,
        "suggestion": issue.suggestion,
    }


def run_scan(project_path: Path) -> dict[str, Any]:
    _emit_event("start", {"status": "Discovering documentation files..."})
    files = _walk(project_path)
    doc_paths = [
        p
        for p in files
        if p.suffix.lower() in DOC_EXTENSIONS
        and not _is_not_project_doc(p.relative_to(project_path))
    ]
    source_paths = [p for p in files if language_for(p.name) is not None]
    _emit_event(
        "progress",
        {"status": f"Indexing source code ({len(doc_paths)} docs found)..."},
    )

    symbols: set[str] = set()
    code_words: set[str] = set()
    source_files: set[str] = set()
    languages: dict[str, int] = {}
    for path in source_paths:
        try:
            if path.stat().st_size > MAX_SOURCE_BYTES:
                continue
            content = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        symbols.update(symbol_names(content, path.name))
        code_words.update(_WORD.findall(content))
        source_files.add(_rel(project_path, path))
        lang = language_for(path.name)
        if lang is not None:
            languages[lang.label] = languages.get(lang.label, 0) + 1

    doc_files: dict[str, str] = {}
    for path in doc_paths:
        try:
            doc_files[_rel(project_path, path)] = path.read_text(
                encoding="utf-8", errors="ignore"
            )
        except OSError:
            continue

    _emit_event(
        "progress",
        {
            "status": f"Comparing {len(doc_files)} docs against {len(symbols)} symbols..."
        },
    )

    all_files = {_rel(project_path, p) for p in files}
    scanner = DriftScanner()
    report = scanner.scan(
        doc_files,
        symbols,
        source_files,
        code_words=code_words,
        file_exists=_file_resolver(project_path, all_files),
    )

    result = {
        "docsScanned": report.docs_scanned,
        "codeFilesIndexed": report.source_files_scanned,
        "symbolsIndexed": len(symbols),
        "languages": [
            {"label": label, "files": count}
            for label, count in sorted(languages.items(), key=lambda kv: -kv[1])
        ],
        "docFiles": sorted(doc_files),
        "issues": [_issue_to_dict(i) for i in report.issues],
        "summary": report.summary,
    }
    _emit_event(
        "complete",
        {"issues": len(report.issues), "docsScanned": report.docs_scanned},
    )
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Doc Drift Runner")
    parser.add_argument("--project-path", required=True, help="Project root path")
    args = parser.parse_args()

    project_path = Path(args.project_path)
    if not project_path.exists():
        _emit("DOC_DRIFT_ERROR", f"Project path does not exist: {project_path}")
        sys.exit(1)

    try:
        result = run_scan(project_path)
        _emit("DOC_DRIFT_RESULT", result)
    except Exception as exc:  # noqa: BLE001
        _emit("DOC_DRIFT_ERROR", str(exc))
        sys.exit(1)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
