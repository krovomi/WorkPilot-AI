"""
Notebook Agent Runner

Discovers notebooks in a project (Jupyter with any kernel, .NET Polyglot
``.dib``, Quarto ``.qmd``, R Markdown ``.Rmd``), parses them, and reports common issues
(stale outputs, out-of-order execution, empty cells, long cells, missing
documentation), the dependencies between cells, and cell → function proposals.

Actions:
    --action scan (default)           every notebook of the project
    --action execute --notebook <rel> run one notebook in a fresh kernel
    --action apply --notebook <rel> [--extract 3,7] [--clean]
                                      edit it (run by main in a review worktree)
    --action metrics                  the monthly figures

Output protocol (one JSON object per line, prefixed):
    NOTEBOOK_EVENT:{"type": "progress", "data": {"status": "..."}}
    NOTEBOOK_RESULT:{"notebooks": [...]}       (scan)
    NOTEBOOK_EXECUTION:{...}                   (execute)
    NOTEBOOK_APPLY:{...}                       (apply)
    NOTEBOOK_METRICS:{"months": [...]}         (metrics)
    NOTEBOOK_ERROR:<message>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from notebook_agent.dataflow import Dataflow, analyze_dataflow  # noqa: E402
from notebook_agent.executor import execute_notebook  # noqa: E402
from notebook_agent.formats import NOTEBOOK_SUFFIXES, discover  # noqa: E402
from notebook_agent.history import flow_issue_count, metrics, record  # noqa: E402
from notebook_agent.notebook_handler import (  # noqa: E402
    NotebookHandler,
    ParsedNotebook,
)
from notebook_agent.refactor import apply_refactor, duplicates, proposals  # noqa: E402

MAX_NOTEBOOK_BYTES = 20 * 1024 * 1024
MAX_EXTRACT = 50


def _emit(prefix: str, payload: Any) -> None:
    print(f"{prefix}:{json.dumps(payload, default=str)}", flush=True)


def _emit_event(event_type: str, data: dict[str, Any]) -> None:
    _emit("NOTEBOOK_EVENT", {"type": event_type, "data": data})


def _discover_notebooks(project_path: Path) -> list[Path]:
    """Jupyter, Polyglot (.dib), Quarto and R Markdown notebooks."""
    return discover(project_path)


def _cells(nb: ParsedNotebook) -> list[dict[str, Any]]:
    return [
        {
            "index": cell.index,
            "cellType": cell.cell_type.value,
            "lines": len(cell.source.splitlines()),
            "firstLine": next(
                (ln.strip() for ln in cell.source.splitlines() if ln.strip()), ""
            )[:100],
            "executionCount": cell.execution_count,
        }
        for cell in nb.cells
    ]


def _notebook_to_dict(
    nb: ParsedNotebook, project_root: Path, flow: Dataflow | None = None
) -> dict[str, Any]:
    try:
        rel_path = Path(nb.path).relative_to(project_root).as_posix()
    except ValueError:
        rel_path = nb.path
    flow = flow or analyze_dataflow(nb)
    return {
        "path": rel_path,
        "kernel": nb.kernel,
        "language": nb.language,
        "totalCells": len(nb.cells),
        "codeCells": len(nb.code_cells),
        "markdownCells": len(nb.markdown_cells),
        "issues": [
            {
                "issueType": issue.issue_type.value,
                "cellIndex": issue.cell_index,
                "message": issue.message,
                "severity": issue.severity,
                "suggestion": issue.suggestion,
            }
            for issue in nb.issues
        ],
        "cells": _cells(nb),
        "dependencies": flow.to_dict(),
        "proposals": [p.to_dict() for p in proposals(nb, flow)],
        "runnable": Path(nb.path).suffix.lower() != ".dib",
        "editable": Path(nb.path).suffix.lower() == ".ipynb",
    }


def _analyse(handler: NotebookHandler, path: Path) -> tuple[ParsedNotebook, Dataflow]:
    nb = handler.parse(path)
    handler.analyze(nb)
    flow = analyze_dataflow(nb)
    nb.issues.extend(flow.issues)
    nb.issues.extend(duplicates(nb))
    nb.issues.sort(key=lambda i: (i.cell_index, i.severity != "error"))
    return nb, flow


def resolve_notebook(project: Path, relative: str) -> Path:
    """The notebook ``relative`` names, inside ``project`` (S4); raises otherwise."""
    if not relative or "\0" in relative or Path(relative).is_absolute():
        raise ValueError("the notebook must be a path relative to the project")
    root = project.resolve()
    target = (root / relative).resolve()
    if not target.is_relative_to(root) or target == root:
        raise ValueError("the notebook is outside the project")
    if (root / relative).is_symlink():
        raise ValueError("the notebook is a symbolic link")
    if target.suffix.lower() not in NOTEBOOK_SUFFIXES or not target.is_file():
        raise ValueError("not a notebook of this project")
    if ".workpilot" in target.relative_to(root).parts:
        raise ValueError("not a notebook of this project")
    if target.stat().st_size > MAX_NOTEBOOK_BYTES:
        raise ValueError("the notebook is larger than 20 MB")
    return target


def run_scan(project_path: Path) -> dict[str, Any]:
    _emit_event("start", {"status": "Discovering notebooks..."})
    notebook_paths = _discover_notebooks(project_path)

    if not notebook_paths:
        _emit_event("complete", {"status": "No notebooks found"})
        return {"notebooks": []}

    _emit_event(
        "progress",
        {"status": f"Found {len(notebook_paths)} notebook(s), analyzing..."},
    )

    handler = NotebookHandler()
    notebooks: list[dict[str, Any]] = []
    for path in notebook_paths:
        try:
            nb, flow = _analyse(handler, path)
            notebooks.append(_notebook_to_dict(nb, project_path, flow))
        except (OSError, ValueError, RecursionError) as exc:
            _emit_event("progress", {"status": f"Failed to parse {path.name}: {exc}"})

    total_issues = sum(len(nb["issues"]) for nb in notebooks)
    _emit_event(
        "complete",
        {"notebooks": len(notebooks), "issues": total_issues},
    )
    record(
        project_path,
        "scan",
        notebooks=len(notebooks),
        findings=flow_issue_count(notebooks),
    )
    return {"notebooks": notebooks}


def run_execute(project_path: Path, relative: str, cell_timeout: int) -> dict[str, Any]:
    target = resolve_notebook(project_path, relative)
    _emit_event("progress", {"status": f"Running {target.name}..."})
    handler = NotebookHandler()
    nb = handler.parse(target)
    run = execute_notebook(
        project_path,
        target,
        cell_timeout_s=cell_timeout,
        code_indices=[c.index for c in nb.code_cells],
    )
    if run.status == "done":
        record(project_path, "execute", score=run.score)
    return {"path": relative, **run.to_dict()}


def run_apply(
    project_path: Path, relative: str, extract: list[int], clean: bool
) -> dict[str, Any]:
    target = resolve_notebook(project_path, relative)
    nb, flow = _analyse(NotebookHandler(), target)
    result = apply_refactor(target, nb, flow, extract, clean)
    if result["extracted"]:
        record(
            _main_project(project_path), "refactor", extracted=len(result["extracted"])
        )
    folder = target.parent.relative_to(project_path.resolve()).as_posix()
    result["changed"] = [
        f"{folder}/{name}" if folder != "." else name for name in result["changed"]
    ]
    return {"path": relative, **result}


def _main_project(root: Path) -> Path:
    """A review worktree's own project (``<project>/.workpilot/worktrees/…``), else ``root``."""
    parts = root.resolve().parts
    for index, part in enumerate(parts):
        if part == ".workpilot" and index:
            return Path(*parts[:index])
    return root


def _extract_list(raw: str) -> list[int]:
    if not raw:
        return []
    values = [int(part) for part in raw.split(",") if part.strip()]
    if len(values) > MAX_EXTRACT or any(v < 0 or v > 100_000 for v in values):
        raise ValueError("invalid cell list")
    return sorted(set(values))


def main() -> None:
    parser = argparse.ArgumentParser(description="Notebook Agent Runner")
    parser.add_argument("--project-path", required=True, help="Project root path")
    parser.add_argument(
        "--action", choices=["scan", "execute", "apply", "metrics"], default="scan"
    )
    parser.add_argument("--notebook", default="")
    parser.add_argument("--extract", default="")
    parser.add_argument("--clean", action="store_true")
    parser.add_argument("--cell-timeout", type=int, default=300)
    args = parser.parse_args()

    project_path = Path(args.project_path).resolve()
    if not project_path.is_dir():
        _emit("NOTEBOOK_ERROR", f"Project path does not exist: {project_path}")
        sys.exit(1)

    try:
        if args.action == "execute":
            timeout = min(max(args.cell_timeout, 10), 3600)
            _emit(
                "NOTEBOOK_EXECUTION", run_execute(project_path, args.notebook, timeout)
            )
        elif args.action == "apply":
            _emit(
                "NOTEBOOK_APPLY",
                run_apply(
                    project_path, args.notebook, _extract_list(args.extract), args.clean
                ),
            )
        elif args.action == "metrics":
            _emit("NOTEBOOK_METRICS", {"months": metrics(project_path)})
        else:
            _emit("NOTEBOOK_RESULT", run_scan(project_path))
    except (ValueError, OSError) as exc:
        _emit("NOTEBOOK_ERROR", str(exc))
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001
        _emit("NOTEBOOK_ERROR", str(exc))
        sys.exit(1)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
