"""Run a notebook top to bottom in a fresh kernel, and read what each cell did.

Jupyter runs it, so any installed kernel works: Python (ipykernel), R
(IRkernel), Julia (IJulia), C#/F#/PowerShell (.NET Interactive), Scala
(Almond), JavaScript (IJavascript), Go (gonb), Rust (evcxr)…
``jupyter nbconvert --execute --allow-errors`` writes the executed copy to
a temporary folder: the notebook itself is never changed. Quarto (``.qmd``)
and R Markdown (``.Rmd``) run through ``quarto render --to ipynb``, also into
a temporary folder. Polyglot ``.dib`` files have no command-line runner.

The run happens in the notebook's folder (its relative data paths work),
with an environment stripped of credentials (S1), no shell (S4), a timeout
per cell and one for the whole run, and the process group killed on
timeout. A cell tagged ``skip-execution`` is not run and keeps its stored
outputs: the way to leave a ten-minute training cell out.

Missing tools are said plainly, with what to install, never guessed around.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from foundation.platform import find_executable, is_windows
from security.child_env import env_without_credentials

from .outputs import check_outputs, summarize

__all__ = ["Execution", "execute_notebook", "find_jupyter", "kernel_hint"]

CELL_TIMEOUT_S = 300
RUN_TIMEOUT_S = 1800
SKIP_TAG = "skip-execution"

_KERNEL_HINTS = {
    "python": "pip install ipykernel",
    "ir": "install.packages('IRkernel'); IRkernel::installspec()",
    "julia": 'using Pkg; Pkg.add("IJulia")',
    ".net": "dotnet tool install -g Microsoft.dotnet-interactive && dotnet interactive jupyter install",
    "scala": "install Almond (https://almond.sh)",
    "javascript": "npm install -g ijavascript && ijsinstall",
    "typescript": "npm install -g tslab && tslab install",
    "gonb": "go install github.com/janpfeifer/gonb@latest && gonb --install",
    "rust": "cargo install evcxr_jupyter && evcxr_jupyter --install",
    "kotlin": "pip install kotlin-jupyter-kernel",
}


def kernel_hint(kernel: str) -> str:
    name = kernel.lower()
    for key, hint in _KERNEL_HINTS.items():
        if key in name:
            return hint
    return "install the kernel for this notebook's language"


@dataclass
class Execution:
    status: str
    """``done``, ``no_runner``, ``no_kernel``, ``timeout``, ``failed`` or ``unsupported``."""
    detail: str = ""
    hint: str = ""
    runner: str = ""
    cells: list[dict[str, Any]] = field(default_factory=list)
    issues: list[dict[str, Any]] = field(default_factory=list)
    score: int | None = None
    """Cells that ran without error, in percent of the cells run."""
    matching: int | None = None
    """Cells whose new output matches the stored one, in percent of those with both."""
    duration_s: float = 0.0
    output_tail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "detail": self.detail,
            "hint": self.hint,
            "runner": self.runner,
            "cells": self.cells,
            "issues": self.issues,
            "score": self.score,
            "matching": self.matching,
            "durationS": round(self.duration_s, 1),
            "outputTail": self.output_tail,
        }


def find_jupyter(root: Path, notebook: Path) -> str | None:
    """The project's own Jupyter first (a virtual environment), then the PATH."""
    folders = []
    for base in {notebook.parent, root}:
        for venv in (".venv", "venv", "env"):
            folders.append(base / venv / ("Scripts" if is_windows() else "bin"))
    names = ["jupyter.exe", "jupyter"] if is_windows() else ["jupyter"]
    for folder in folders:
        for name in names:
            candidate = folder / name
            if candidate.is_file():
                return str(candidate)
    return find_executable("jupyter")


def _kill_group(process: subprocess.Popen) -> None:
    if is_windows():  # pragma: no cover - Windows leg
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(process.pid)],
            capture_output=True,
            check=False,
        )
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(process.pid, sig)
        except (ProcessLookupError, PermissionError, OSError):
            return
        try:
            process.wait(timeout=5)
            return
        except subprocess.TimeoutExpired:
            continue


def _run(
    argv: list[str], cwd: Path, timeout_s: int, popen: Callable[..., subprocess.Popen]
) -> tuple[int | None, str, bool]:
    kwargs: dict[str, Any] = {
        "cwd": str(cwd),
        "env": env_without_credentials(
            extra={"NO_COLOR": "1", "PYTHONUNBUFFERED": "1"}
        ),
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "stdin": subprocess.DEVNULL,
    }
    if is_windows():  # pragma: no cover - Windows leg
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
    else:
        kwargs["start_new_session"] = True
    process = popen(argv, **kwargs)  # noqa: S603 - argv list, no shell
    try:
        output, _ = process.communicate(timeout=timeout_s)
        timed_out = False
    except subprocess.TimeoutExpired:
        _kill_group(process)
        try:
            output, _ = process.communicate(timeout=10)
        except (subprocess.TimeoutExpired, OSError, ValueError):
            output = b""
        timed_out = True
    text = (
        output.decode("utf-8", errors="replace")
        if isinstance(output, bytes)
        else (output or "")
    )
    return process.returncode, text[-4000:], timed_out


def _installed_kernels(
    jupyter: str, cwd: Path, popen: Callable[..., subprocess.Popen]
) -> set[str] | None:
    try:
        code, out, _ = _run([jupyter, "kernelspec", "list", "--json"], cwd, 60, popen)
    except (OSError, ValueError):
        return None
    if code != 0:
        return None
    try:
        start = out.index("{")
        data = json.loads(out[start:])
    except ValueError:
        return None
    specs = data.get("kernelspecs") if isinstance(data, dict) else None
    return set(specs) if isinstance(specs, dict) else None


def _seconds(meta: dict[str, Any]) -> float | None:
    execution = meta.get("execution") if isinstance(meta, dict) else None
    if not isinstance(execution, dict):
        return None
    try:
        start = datetime.fromisoformat(
            str(execution["iopub.execute_input"]).replace("Z", "+00:00")
        )
        end = datetime.fromisoformat(
            str(execution["shell.execute_reply"]).replace("Z", "+00:00")
        )
    except (KeyError, ValueError):
        return None
    return round((end - start).total_seconds(), 2)


def read_executed(
    stored: dict[str, Any],
    executed: dict[str, Any],
    code_indices: list[int] | None = None,
) -> Execution:
    """Per code cell: ran, failed or skipped, its time, and the output checks.

    ``code_indices`` numbers the code cells as the scan does, for a text
    notebook whose executed copy has its own cell layout.
    """
    run = Execution(status="done")
    before = [c for c in stored.get("cells", []) if c.get("cell_type") == "code"]
    after = [c for c in executed.get("cells", []) if c.get("cell_type") == "code"]
    stored_indices = code_indices or [
        i for i, c in enumerate(stored.get("cells", [])) if c.get("cell_type") == "code"
    ]
    ran = ok = same = compared = 0
    for position, cell in enumerate(after):
        index = stored_indices[position] if position < len(stored_indices) else position
        previous = before[position] if position < len(before) else {}
        tags = (cell.get("metadata") or {}).get("tags") or []
        skipped = SKIP_TAG in tags
        outputs = cell.get("outputs") or []
        error = next((o for o in outputs if o.get("output_type") == "error"), None)
        if skipped:
            state = "skipped"
        elif error is not None:
            state = "error"
        elif (
            cell.get("execution_count") is None
            and not "".join(cell.get("source") or "").strip()
        ):
            state = "empty"
        else:
            state = "ok"
        if state in ("ok", "error"):
            ran += 1
            ok += state == "ok"
        found, matches = check_outputs(index, previous.get("outputs") or [], outputs)
        if matches is not None and not skipped:
            compared += 1
            same += matches
        run.issues.extend(found)
        run.cells.append(
            {
                "cellIndex": index,
                "status": state,
                "seconds": _seconds(cell.get("metadata") or {}),
                "error": (
                    {
                        "name": str(error.get("ename", ""))[:120],
                        "value": str(error.get("evalue", ""))[:500],
                    }
                    if error
                    else None
                ),
                "output": summarize(outputs),
            }
        )
    first_error = next((c for c in run.cells if c["status"] == "error"), None)
    if first_error is not None:
        for issue in run.issues:
            if (
                issue["cellIndex"] == first_error["cellIndex"]
                and issue["issueType"] == "execution_error"
            ):
                issue["message"] += (
                    " (first failing cell: later errors may follow from it)"
                )
                break
    run.score = round(100 * ok / ran) if ran else None
    run.matching = round(100 * same / compared) if compared else None
    return run


def execute_notebook(
    root: Path,
    notebook: Path,
    *,
    cell_timeout_s: int = CELL_TIMEOUT_S,
    run_timeout_s: int = RUN_TIMEOUT_S,
    code_indices: list[int] | None = None,
    popen: Callable[..., subprocess.Popen] = subprocess.Popen,
) -> Execution:
    """Run ``notebook`` (inside ``root``) once. Never raises for the notebook's own errors."""
    suffix = notebook.suffix.lower()
    if suffix == ".dib":
        return Execution(
            status="unsupported",
            detail="Polyglot notebooks (.dib) have no command-line runner",
            hint="Run it in VS Code, or save it as .ipynb to run it here",
        )
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="wp-notebook-") as tmp:
        out_dir = Path(tmp)
        if suffix == ".ipynb":
            jupyter = find_jupyter(root, notebook)
            if not jupyter:
                return Execution(
                    status="no_runner",
                    detail="Jupyter is not installed for this project",
                    hint="pip install jupyter (nbconvert) in the project's environment",
                )
            stored = json.loads(notebook.read_text(encoding="utf-8"))
            kernel = str(
                ((stored.get("metadata") or {}).get("kernelspec") or {}).get("name")
                or ""
            )
            kernels = _installed_kernels(jupyter, notebook.parent, popen)
            if kernel and kernels is not None and kernel not in kernels:
                return Execution(
                    status="no_kernel",
                    detail=f"The kernel '{kernel}' is not installed",
                    hint=kernel_hint(kernel),
                    runner=jupyter,
                )
            argv = [
                jupyter,
                "nbconvert",
                "--to",
                "notebook",
                "--execute",
                "--allow-errors",
                f"--ExecutePreprocessor.timeout={int(cell_timeout_s)}",
                "--output-dir",
                str(out_dir),
                "--output",
                "executed",
                str(notebook),
            ]
            executed_path = out_dir / "executed.ipynb"
        else:
            quarto = find_executable("quarto")
            if not quarto:
                return Execution(
                    status="no_runner",
                    detail="Quarto is not installed",
                    hint="Install Quarto (https://quarto.org) to run .qmd and .Rmd files",
                )
            stored = {"cells": []}
            argv = [
                quarto,
                "render",
                str(notebook),
                "--to",
                "ipynb",
                "--execute",
                "--output-dir",
                str(out_dir),
            ]
            executed_path = out_dir / f"{notebook.stem}.ipynb"
        try:
            code, tail, timed_out = _run(argv, notebook.parent, run_timeout_s, popen)
        except (OSError, ValueError) as exc:
            return Execution(
                status="failed", detail=f"the runner could not start: {exc}"
            )
        duration = time.monotonic() - started
        if timed_out:
            return Execution(
                status="timeout",
                detail=f"the run took more than {run_timeout_s} s",
                hint=f"tag long cells with '{SKIP_TAG}' to leave them out",
                duration_s=duration,
                output_tail=tail,
            )
        if not executed_path.is_file():
            found = sorted(out_dir.glob("*.ipynb"))
            executed_path = found[0] if found else executed_path
        if not executed_path.is_file():
            return Execution(
                status="failed",
                detail=f"the runner exited with code {code} and wrote no notebook",
                duration_s=duration,
                output_tail=tail,
            )
        executed = json.loads(executed_path.read_text(encoding="utf-8"))
        if suffix != ".ipynb":
            stored = {"cells": [dict(c, outputs=[]) for c in executed.get("cells", [])]}
        run = read_executed(
            stored, executed, None if suffix == ".ipynb" else code_indices
        )
        run.runner = Path(argv[0]).name
        run.duration_s = duration
        run.output_tail = tail if code else ""
        return run
