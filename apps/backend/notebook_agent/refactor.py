"""Cell → function: the proposals, and the edit made on a review branch.

Two findings, read without a model:

- **Duplicated code** (every language): the same run of at least six
  non-blank lines in two cells or more, after whitespace is normalised.
- **A long Python cell** (more than 50 lines) becomes a function proposal.
  Its parameters are the names the cell reads from earlier cells, its return
  values the names it defines that later cells read (``dataflow``). The
  function goes to ``<notebook>_functions.py`` beside the notebook, with the
  imports its body needs; the cell keeps the imports later cells use and
  becomes one call.

A cell is not proposed when the extraction would change what it does: a
top-level ``return``, ``yield``, ``await``, ``global`` or ``nonlocal``, a
``del`` of a name from another cell, a star import, IPython magics or shell
escapes, or a last expression that the notebook displays. The reason is
given instead.

``apply_refactor`` writes the module and the notebook (Jupyter only), and
can clean the notebook for git (outputs, execution counts, run metadata).
The caller runs it in a review worktree, never in the person's checkout.
"""

from __future__ import annotations

import ast
import json
import keyword
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .dataflow import CellFlow, Dataflow, cell_language
from .model import CellType, NotebookIssue, NotebookIssueType, ParsedNotebook

__all__ = [
    "LONG_CELL_LINES",
    "Proposal",
    "apply_refactor",
    "clean_notebook",
    "duplicates",
    "proposals",
]

LONG_CELL_LINES = 50
DUPLICATE_WINDOW = 6
_KEEP_CELL_METADATA = frozenset({"tags", "name", "slideshow", "language", "vscode"})
_DROP_NOTEBOOK_METADATA = frozenset(
    {"widgets", "toc", "varInspector", "execution", "papermill", "celltoolbar"}
)


@dataclass
class Proposal:
    cell_index: int
    function: str
    params: list[str] = field(default_factory=list)
    returns: list[str] = field(default_factory=list)
    lines: int = 0
    module: str = ""
    preview: str = ""
    reason: str = ""
    """Why the cell cannot be extracted; empty when it can."""

    def to_dict(self) -> dict[str, Any]:
        return {
            "cellIndex": self.cell_index,
            "function": self.function,
            "params": self.params,
            "returns": self.returns,
            "lines": self.lines,
            "module": self.module,
            "preview": self.preview,
            "reason": self.reason,
        }


# ── duplicated code (every language) ───────────────────────────────────────


def _normalised(source: str) -> list[str]:
    return [" ".join(line.split()) for line in source.splitlines() if line.strip()]


def duplicates(nb: ParsedNotebook) -> list[NotebookIssue]:
    """Runs of six identical lines in two code cells or more."""
    seen: dict[tuple[str, ...], list[int]] = {}
    for cell in nb.code_cells:
        lines = _normalised(cell.source)
        windows = {
            tuple(lines[i : i + DUPLICATE_WINDOW])
            for i in range(len(lines) - DUPLICATE_WINDOW + 1)
        }
        for window in windows:
            if sum(len(line) for line in window) < 60:
                continue  # six closing braces are not a duplicate
            cells = seen.setdefault(window, [])
            if cell.index not in cells:
                cells.append(cell.index)
    groups: dict[tuple[int, ...], int] = {}
    for cells in seen.values():
        if len(cells) > 1:
            key = tuple(sorted(cells))
            groups[key] = groups.get(key, 0) + 1
    issues = []
    for cells, windows in sorted(groups.items()):
        issues.append(
            NotebookIssue(
                issue_type=NotebookIssueType.DUPLICATE_CODE,
                cell_index=cells[0],
                message=(
                    f"Cells {', '.join(map(str, cells))} repeat the same block "
                    f"({windows + DUPLICATE_WINDOW - 1} lines or more)"
                ),
                severity="info",
                suggestion="Extract the block into a function and call it from each cell",
            )
        )
    return issues


# ── long Python cells ──────────────────────────────────────────────────────


def _slug(text: str) -> str:
    words = re.findall(r"[A-Za-z0-9]+", text.lower())[:5]
    name = "_".join(words)
    if not name or name[0].isdigit():
        name = f"step_{name}" if name else ""
    return name


def _function_name(nb: ParsedNotebook, index: int, taken: set[str]) -> str:
    heading = ""
    position = next((i for i, c in enumerate(nb.cells) if c.index == index), 0)
    for cell in nb.cells[:position][::-1]:
        if cell.cell_type == CellType.MARKDOWN:
            match = re.search(r"^#+\s*(.+)$", cell.source, re.M)
            if match:
                heading = match.group(1)
            break
        if cell.cell_type == CellType.CODE:
            break
    base = _slug(heading) or f"cell_{index}"
    if keyword.iskeyword(base) or not base.isidentifier():
        base = f"cell_{index}"
    name, n = base, 2
    while name in taken:
        name, n = f"{base}_{n}", n + 1
    taken.add(name)
    return name


def _refusal(tree: ast.Module, flow: CellFlow, others: set[str]) -> str:
    if flow.star_import:
        return "the cell has a star import"
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            continue
        if isinstance(node, (ast.Global, ast.Nonlocal)):
            return "the cell declares global or nonlocal names"
        if isinstance(node, (ast.Await, ast.AsyncFor, ast.AsyncWith)):
            return "the cell awaits at top level"
    for stmt in tree.body:
        if isinstance(stmt, ast.Return) or any(
            isinstance(n, (ast.Yield, ast.YieldFrom))
            for n in ast.walk(stmt)
            if not isinstance(n, (ast.FunctionDef, ast.Lambda))
        ):
            return "the cell returns or yields at top level"
        if isinstance(stmt, ast.Delete) and any(
            isinstance(t, ast.Name) and t.id in others for t in stmt.targets
        ):
            return "the cell deletes a name of another cell"
    last = tree.body[-1] if tree.body else None
    if isinstance(last, ast.Expr) and not (
        isinstance(last.value, ast.Call)
        and isinstance(last.value.func, (ast.Name, ast.Attribute))
        and (
            getattr(last.value.func, "id", "") in {"print", "display"}
            or getattr(last.value.func, "attr", "") in {"show", "savefig"}
        )
    ):
        return "the cell ends on a value the notebook displays"
    return ""


def _module_name(nb: ParsedNotebook) -> str:
    stem = re.sub(r"\W+", "_", Path(nb.path).stem).strip("_").lower() or "notebook"
    if stem[0].isdigit():
        stem = f"nb_{stem}"
    return f"{stem}_functions"


def _build(
    nb: ParsedNotebook, flow: Dataflow, position: int, name: str
) -> tuple[Proposal, str, str, list[str]]:
    """The proposal, the function's code, the new cell, and the imports the module needs."""
    cell_flow = flow.cells[position]
    cell = next(c for c in nb.cells if c.index == cell_flow.index)
    tree = ast.parse(cell.source)
    earlier = flow.cells[:position]
    later = flow.cells[position + 1 :]
    imported_before = {n: stmt for f in earlier for n, stmt in f.imports.items()}
    reads = [*cell_flow.immediate, *cell_flow.deferred]
    params = [
        n
        for n in dict.fromkeys(reads)
        if n not in imported_before
        and n not in cell_flow.imports
        and any(n in f.defines for f in earlier)
    ]
    later_reads = {n for f in later for n in (*f.immediate, *f.deferred)}
    returns = [
        n for n in cell_flow.defines if n in later_reads and n not in cell_flow.imports
    ]
    module_imports = list(
        dict.fromkeys(
            [imported_before[n] for n in dict.fromkeys(reads) if n in imported_before]
            + list(dict.fromkeys(cell_flow.imports.values()))
        )
    )
    body_stmts = [
        s for s in tree.body if not isinstance(s, (ast.Import, ast.ImportFrom))
    ]
    body = "\n".join(
        ast.get_source_segment(cell.source, s) or ast.unparse(s) for s in body_stmts
    )
    indented = "\n".join(
        ("    " + line) if line.strip() else "" for line in body.splitlines()
    )
    signature = f"def {name}({', '.join(params)}):"
    doc = f'    """Cell {cell.index} of {Path(nb.path).name}, as a function."""'
    ret = ""
    if returns:
        ret = "\n    return " + ", ".join(returns)
    function = f"{signature}\n{doc}\n{indented}{ret}\n"
    module = _module_name(nb)
    kept_imports = [stmt for n, stmt in cell_flow.imports.items() if n in later_reads]
    call = f"{name}({', '.join(params)})"
    if len(returns) == 1:
        call = f"{returns[0]} = {call}"
    elif returns:
        call = f"{', '.join(returns)} = {call}"
    new_cell = "\n".join(
        [*dict.fromkeys(kept_imports), f"from {module} import {name}", call]
    )
    proposal = Proposal(
        cell_index=cell.index,
        function=name,
        params=params,
        returns=returns,
        lines=len(cell.source.splitlines()),
        module=f"{module}.py",
        preview=f"{signature}\n    ...\n"
        + (f"    return {', '.join(returns)}\n" if returns else ""),
    )
    return proposal, function, new_cell, module_imports


def proposals(nb: ParsedNotebook, flow: Dataflow) -> list[Proposal]:
    """One proposal per long Python cell, extractable or with its reason."""
    found: list[Proposal] = []
    taken = {n for f in flow.cells for n in f.defines}
    by_index = {c.index: c for c in nb.code_cells}
    for position, cell_flow in enumerate(flow.cells):
        cell = by_index.get(cell_flow.index)
        if cell is None or len(cell.source.splitlines()) <= LONG_CELL_LINES:
            continue
        if cell_language(nb, cell.source, cell.metadata) != "python":
            continue
        name = _function_name(nb, cell.index, taken)
        others = {n for f in flow.cells if f is not cell_flow for n in f.defines}
        if re.search(r"^\s*[%!]", cell.source, re.M):
            reason = "the cell uses IPython magics or shell commands"
        else:
            try:
                tree = ast.parse(cell.source)
            except SyntaxError:
                reason = "the cell does not parse as Python"
            else:
                reason = _refusal(tree, cell_flow, others)
        if reason:
            found.append(
                Proposal(
                    cell_index=cell.index,
                    function=name,
                    lines=len(cell.source.splitlines()),
                    reason=reason,
                )
            )
            continue
        found.append(_build(nb, flow, position, name)[0])
    return found


# ── the edit ───────────────────────────────────────────────────────────────


def clean_notebook(data: dict[str, Any]) -> bool:
    """Outputs, execution counts and run metadata removed; True when anything changed."""
    before = json.dumps(data, sort_keys=True)
    for cell in data.get("cells", []):
        if cell.get("cell_type") == "code":
            cell["outputs"] = []
            cell["execution_count"] = None
        meta = cell.get("metadata")
        if isinstance(meta, dict):
            cell["metadata"] = {
                k: v for k, v in meta.items() if k in _KEEP_CELL_METADATA
            }
    meta = data.get("metadata")
    if isinstance(meta, dict):
        data["metadata"] = {
            k: v for k, v in meta.items() if k not in _DROP_NOTEBOOK_METADATA
        }
    return json.dumps(data, sort_keys=True) != before


def _lines(text: str) -> list[str]:
    parts = text.split("\n")
    return [p + "\n" for p in parts[:-1]] + ([parts[-1]] if parts[-1] else [])


def apply_refactor(
    notebook: Path,
    nb: ParsedNotebook,
    flow: Dataflow,
    extract: list[int],
    clean: bool,
) -> dict[str, Any]:
    """Extract the chosen cells and clean the notebook; what changed, and what was refused."""
    if notebook.suffix.lower() != ".ipynb":
        raise ValueError("only Jupyter notebooks (.ipynb) are edited")
    data = json.loads(notebook.read_text(encoding="utf-8"))
    cells = data.get("cells")
    if not isinstance(cells, list):
        raise ValueError("the notebook has no cells")
    wanted = set(extract)
    available = {p.cell_index: p for p in proposals(nb, flow)}
    taken = {n for f in flow.cells for n in f.defines}
    extracted: list[dict[str, Any]] = []
    refused: list[dict[str, Any]] = []
    functions: list[str] = []
    imports: list[str] = []
    for position, cell_flow in enumerate(flow.cells):
        if cell_flow.index not in wanted:
            continue
        proposal = available.get(cell_flow.index)
        if proposal is None or proposal.reason:
            refused.append(
                {
                    "cellIndex": cell_flow.index,
                    "reason": proposal.reason if proposal else "not a long Python cell",
                }
            )
            continue
        taken.discard(proposal.function)
        _, function, new_cell, needed = _build(nb, flow, position, proposal.function)
        cells[cell_flow.index]["source"] = _lines(new_cell)
        functions.append(function)
        imports.extend(needed)
        extracted.append(proposal.to_dict())
    for index in sorted(
        wanted - {p["cellIndex"] for p in extracted} - {r["cellIndex"] for r in refused}
    ):
        refused.append({"cellIndex": index, "reason": "not a long Python cell"})
    changed: list[str] = []
    if functions:
        module = notebook.parent / f"{_module_name(nb)}.py"
        if module.is_symlink():
            raise ValueError("the functions module is a symbolic link")
        header = f'"""Functions extracted from {notebook.name} by WorkPilot."""\n\n'
        existing = module.read_text(encoding="utf-8") if module.is_file() else header
        imports_text = "\n".join(i for i in dict.fromkeys(imports) if i not in existing)
        text = existing.rstrip("\n") + "\n\n"
        if imports_text:
            text = (
                existing.replace(header, header + imports_text + "\n", 1)
                if existing.startswith(header)
                else imports_text + "\n\n" + existing
            ).rstrip("\n") + "\n\n"
        text += "\n\n".join(functions)
        module.write_text(text, encoding="utf-8")
        changed.append(module.name)
    cleaned = clean and clean_notebook(data)
    if functions or cleaned:
        notebook.write_text(
            json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        changed.append(notebook.name)
    return {
        "extracted": extracted,
        "refused": refused,
        "cleaned": cleaned,
        "changed": changed,
    }
