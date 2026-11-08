"""Notebook formats besides Jupyter, so the checks reach every stack.

Jupyter (``.ipynb``) already covers any kernel: Python, R, Julia, C#/F# via
.NET Interactive, Kotlin, Scala, Go (gonb), Rust (evcxr). Three text formats
are common too and carry no outputs, so only the structural checks apply
(empty cells, long cells, no prose):

- ``.dib``: Polyglot Notebooks (.NET Interactive), cells introduced by a
  ``#!<kernel>`` line (``#!csharp``, ``#!fsharp``, ``#!pwsh``, ``#!sql``,
  ``#!markdown``…);
- ``.qmd``: Quarto, Markdown with ```` ```{lang} ```` code chunks;
- ``.Rmd``: R Markdown, same chunks.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from .model import CellType, NotebookCell, ParsedNotebook

NOTEBOOK_SUFFIXES = frozenset({".ipynb", ".dib", ".qmd", ".rmd"})

_SKIPPED_DIRS = frozenset(
    {
        ".git",
        "node_modules",
        ".venv",
        "venv",
        "__pycache__",
        ".ipynb_checkpoints",
        "bin",
        "obj",
        "target",
        "build",
        "dist",
        "vendor",
        ".quarto",
        "_freeze",
        "renv",
    }
)

_DIB_MAGIC = re.compile(r"^#!([A-Za-z][\w-]*)\s*$")
_CHUNK_OPEN = re.compile(r"^```+\s*\{\s*([A-Za-z][\w-]*)[^}]*\}\s*$")
_CHUNK_CLOSE = re.compile(r"^```+\s*$")
_PROSE_KERNELS = frozenset({"markdown", "md"})


def discover(root: Path) -> list[Path]:
    """Every notebook under ``root``, generated and dependency folders pruned."""
    found: list[Path] = []
    for current, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in _SKIPPED_DIRS]
        for name in files:
            if Path(name).suffix.lower() in NOTEBOOK_SUFFIXES:
                found.append(Path(current) / name)
    return sorted(found)


def parse_text_notebook(path: Path) -> ParsedNotebook:
    """Parse a ``.dib``, ``.qmd`` or ``.Rmd`` file into cells."""
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".dib":
        cells, languages = _parse_dib(text)
        kernel = ".net-interactive"
    else:
        cells, languages = _parse_chunks(text)
        kernel = "quarto" if path.suffix.lower() == ".qmd" else "rmarkdown"
    nb = ParsedNotebook(
        path=str(path), kernel=kernel, language=", ".join(sorted(languages))
    )
    nb.cells = [
        NotebookCell(index=i, cell_type=kind, source=source)
        for i, (kind, source) in enumerate(cells)
    ]
    return nb


def _parse_dib(text: str) -> tuple[list[tuple[CellType, str]], set[str]]:
    cells: list[tuple[CellType, str]] = []
    languages: set[str] = set()
    kind: CellType | None = None
    lines: list[str] = []
    for line in text.splitlines():
        magic = _DIB_MAGIC.match(line)
        if magic and magic.group(1) != "meta":
            if kind is not None:
                cells.append((kind, "\n".join(lines).strip()))
            name = magic.group(1).lower()
            kind = CellType.MARKDOWN if name in _PROSE_KERNELS else CellType.CODE
            if kind is CellType.CODE:
                languages.add(name)
            lines = []
        elif kind is not None:
            lines.append(line)
    if kind is not None:
        cells.append((kind, "\n".join(lines).strip()))
    return cells, languages


def _parse_chunks(text: str) -> tuple[list[tuple[CellType, str]], set[str]]:
    cells: list[tuple[CellType, str]] = []
    languages: set[str] = set()
    prose: list[str] = []
    code: list[str] | None = None
    for line in text.splitlines():
        if code is None:
            opening = _CHUNK_OPEN.match(line)
            if opening:
                if "".join(prose).strip():
                    cells.append((CellType.MARKDOWN, "\n".join(prose).strip()))
                prose = []
                code = []
                languages.add(opening.group(1).lower())
            else:
                prose.append(line)
        elif _CHUNK_CLOSE.match(line):
            cells.append((CellType.CODE, "\n".join(code).strip()))
            code = None
        else:
            code.append(line)
    if code is not None:
        cells.append((CellType.CODE, "\n".join(code).strip()))
    elif "".join(prose).strip():
        cells.append((CellType.MARKDOWN, "\n".join(prose).strip()))
    return cells, languages
