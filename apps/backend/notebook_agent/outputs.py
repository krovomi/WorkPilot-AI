"""What a fresh run of a cell printed, checked against what the notebook kept.

Read from the outputs Jupyter writes (nbformat 4), the same for every kernel:

- ``execution_error``: the cell raised; the exception name and message;
- ``assertion_failed``: an ``assert`` (or a test framework's assertion) failed;
- ``missing_dependency``: a module or package is not installed
  (``ModuleNotFoundError``, R's ``there is no package``, .NET's
  ``could not be found``), or the cell needs a GPU (CUDA);
- ``empty_plot``: a figure with no axes, or a Plotly figure with no data;
- ``shape_changed``: a table's rows × columns (pandas, polars, R tibble)
  differ from the stored output;
- ``output_changed``: the text output differs from the stored one, memory
  addresses and timings set aside.

Pure: no kernel, no file.
"""

from __future__ import annotations

import re
from typing import Any

__all__ = ["check_outputs", "summarize"]

_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_ADDRESS = re.compile(r"0x[0-9a-fA-F]{6,}")
_TIMING = re.compile(r"\b\d+(\.\d+)?\s*(ms|µs|us|ns|s|sec|seconds)\b")
_SHAPES = (
    re.compile(r"\[(\d[\d,]*) rows x (\d[\d,]*) columns\]"),
    re.compile(r"(\d[\d,]*) rows × (\d[\d,]*) columns"),
    re.compile(r"shape: \((\d[\d_,]*), (\d[\d_,]*)\)"),  # polars
    re.compile(r"A tibble: (\d[\d,]*) [×x] (\d[\d,]*)"),  # R
)
_EMPTY_FIGURE = re.compile(r"<Figure size [\d.]+x[\d.]+ with 0 Axes>")
_MISSING = (
    re.compile(r"No module named '([\w.]+)'"),
    re.compile(r"there is no package called ['‘]([\w.]+)['’]"),
    re.compile(r"Package ([\w.]+) not found"),
    re.compile(r"The type or namespace name '(\w+)' could not be found"),
    re.compile(r"Cannot find module '([\w@/.-]+)'"),
)


def _text(output: dict[str, Any]) -> str:
    if output.get("output_type") == "stream":
        raw = output.get("text", "")
    else:
        data = output.get("data") or {}
        raw = data.get("text/plain", "")
        if not raw:
            raw = data.get("text/html", "")
    return _ANSI.sub("", raw if isinstance(raw, str) else "".join(raw))


def _shape(outputs: list[dict[str, Any]]) -> tuple[str, str] | None:
    for output in outputs:
        data = output.get("data") or {}
        for key in ("text/plain", "text/html"):
            raw = data.get(key, "")
            text = raw if isinstance(raw, str) else "".join(raw)
            for pattern in _SHAPES:
                match = pattern.search(text)
                if match:
                    clean = (re.sub(r"[_,]", "", g) for g in match.groups())
                    rows, cols = clean
                    return rows, cols
    return None


def _comparable(outputs: list[dict[str, Any]]) -> str:
    parts = []
    for output in outputs:
        if output.get("output_type") in ("stream", "execute_result", "display_data"):
            if output.get("output_type") == "stream" and output.get("name") == "stderr":
                continue
            text = _TIMING.sub("<t>", _ADDRESS.sub("<addr>", _text(output)))
            parts.append(" ".join(text.split()))
    return "\n".join(p for p in parts if p)


def _issue(
    kind: str, cell: int, message: str, severity: str, suggestion: str
) -> dict[str, Any]:
    return {
        "issueType": kind,
        "cellIndex": cell,
        "message": message,
        "severity": severity,
        "suggestion": suggestion,
    }


def check_outputs(
    index: int, stored: list[dict[str, Any]], fresh: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], bool | None]:
    """The findings for one cell, and whether its output matches the stored one."""
    issues: list[dict[str, Any]] = []
    for output in fresh:
        if output.get("output_type") != "error":
            continue
        name = str(output.get("ename", ""))
        value = _ANSI.sub("", str(output.get("evalue", "")))[:300]
        missing = next((m.group(1) for p in _MISSING if (m := p.search(value))), None)
        if missing:
            issues.append(
                _issue(
                    "missing_dependency",
                    index,
                    f"Cell {index} needs '{missing}', which is not installed",
                    "error",
                    "Add it to the project's dependencies and install it",
                )
            )
        elif re.search(r"\bCUDA\b|\bcudnn\b|NVIDIA driver", value, re.I):
            issues.append(
                _issue(
                    "missing_dependency",
                    index,
                    f"Cell {index} needs a GPU (CUDA): {value[:160]}",
                    "warning",
                    "Run it on a machine with a GPU, or fall back to the CPU",
                )
            )
        elif "Assert" in name:
            issues.append(
                _issue(
                    "assertion_failed",
                    index,
                    f"Cell {index}: an assertion failed{': ' + value if value else ''}",
                    "error",
                    "The notebook's own check no longer holds: look at the data or the code",
                )
            )
        else:
            issues.append(
                _issue(
                    "execution_error",
                    index,
                    f"Cell {index} raised {name}: {value}"
                    if value
                    else f"Cell {index} raised {name}",
                    "error",
                    "Fix the cell, then run the notebook again",
                )
            )
    for output in fresh:
        data = output.get("data") or {}
        plotly = data.get("application/vnd.plotly.v1+json")
        if _EMPTY_FIGURE.search(_text(output)) or (
            isinstance(plotly, dict) and not plotly.get("data")
        ):
            issues.append(
                _issue(
                    "empty_plot",
                    index,
                    f"Cell {index} draws an empty figure",
                    "warning",
                    "Check that the plotted data is not empty",
                )
            )
            break
    before, after = _shape(stored), _shape(fresh)
    if before and after and before != after:
        issues.append(
            _issue(
                "shape_changed",
                index,
                f"Cell {index}: the table was {before[0]} × {before[1]}, it is now {after[0]} × {after[1]}",
                "warning",
                "The data or the code changed what this cell produces",
            )
        )
    old, new = _comparable(stored), _comparable(fresh)
    if not old or any(o.get("output_type") == "error" for o in fresh):
        return issues, None if not old else False
    matches = old == new
    if not matches and not (before and after and before != after):
        issues.append(
            _issue(
                "output_changed",
                index,
                f"Cell {index} prints something else than the stored output",
                "info",
                "Rerun and save the notebook, or look at why the result moved",
            )
        )
    return issues, matches


def summarize(outputs: list[dict[str, Any]]) -> dict[str, Any]:
    """What a cell showed, small enough for the page."""
    kinds: list[str] = []
    text = ""
    for output in outputs:
        data = output.get("data") or {}
        if any(k.startswith("image/") for k in data):
            kinds.append("image")
        elif "text/html" in data:
            kinds.append("html")
        elif output.get("output_type") == "error":
            kinds.append("error")
        else:
            kinds.append("text")
        if not text and output.get("output_type") != "error":
            text = _text(output).strip()
    shape = _shape(outputs)
    return {
        "kinds": sorted(set(kinds)),
        "text": text[:400] + ("…" if len(text) > 400 else ""),
        "shape": list(shape) if shape else None,
    }
