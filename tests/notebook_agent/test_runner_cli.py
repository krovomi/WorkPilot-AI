"""The Notebook Agent runner, end to end, the way the desktop app starts it.

Scan, apply (extract a long cell, clean outputs), run, and the monthly
figures, on a project with a `.workpilot/` folder so the history is kept.
`test_cells.py` covers the notebook model; this file covers the command.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "notebook_agent_runner.py"

LONG_CELL = "\n".join(
    ["data = [1, 2, 3]"]
    + [f"v{i} = data[0] + {i}" for i in range(55)]
    + ["total = v0 + v1"]
)


def _notebook(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    cells = [
        {"cell_type": "markdown", "source": "# Sales\n\nintro", "metadata": {}},
        {
            "cell_type": "code",
            "source": "import math\n",
            "metadata": {},
            "execution_count": 1,
            "outputs": [],
        },
        {
            "cell_type": "code",
            "source": LONG_CELL,
            "metadata": {},
            "execution_count": 2,
            "outputs": [{"output_type": "stream", "name": "stdout", "text": "x"}],
        },
        {
            "cell_type": "code",
            "source": "print(total)",
            "metadata": {},
            "execution_count": 3,
            "outputs": [],
        },
    ]
    data = {
        "cells": cells,
        "metadata": {"kernelspec": {"name": "python3", "language": "python"}},
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "lab"
    (root / ".workpilot").mkdir(parents=True)
    _notebook(root / "analysis" / "sales.ipynb")
    return root


def _run(project: Path, *args: str) -> tuple[int, dict[str, list]]:
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project-path", str(project), *args],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    lines: dict[str, list] = {}
    for line in done.stdout.splitlines():
        prefix, sep, payload = line.partition(":")
        if sep and prefix.startswith("NOTEBOOK_"):
            lines.setdefault(prefix, []).append(json.loads(payload))
    return done.returncode, lines


def _history(project: Path) -> list[dict]:
    path = project / ".workpilot" / "notebooks" / "history.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_a_scan_describes_each_notebook_and_skips_a_broken_one(project: Path) -> None:
    (project / "broken.ipynb").write_text("{not json", encoding="utf-8")
    code, lines = _run(project)
    assert code == 0
    statuses = [e["data"].get("status", "") for e in lines["NOTEBOOK_EVENT"]]
    assert statuses[1] == "Found 2 notebook(s), analyzing..."
    assert statuses[2].startswith("Failed to parse broken.ipynb:")
    [nb] = lines["NOTEBOOK_RESULT"][0]["notebooks"]
    assert nb["path"] == "analysis/sales.ipynb"
    assert (nb["totalCells"], nb["codeCells"], nb["markdownCells"]) == (4, 3, 1)
    assert nb["cells"][0]["firstLine"] == "# Sales"
    assert nb["cells"][2]["lines"] == 57
    assert [i["issueType"] for i in nb["issues"]] == ["long_cell"]
    assert nb["dependencies"]["edges"] == [{"from": 2, "to": 3, "names": ["total"]}]
    assert [p["cellIndex"] for p in nb["proposals"]] == [2]
    assert nb["runnable"] and nb["editable"]
    assert _history(project) == [
        {
            "at": _history(project)[0]["at"],
            "kind": "scan",
            "notebooks": 1,
            "findings": 0,
        }
    ]


def test_a_project_without_notebooks_scans_to_an_empty_list(tmp_path: Path) -> None:
    code, lines = _run(tmp_path)
    assert code == 0
    assert lines["NOTEBOOK_RESULT"] == [{"notebooks": []}]
    assert lines["NOTEBOOK_EVENT"][-1]["data"] == {"status": "No notebooks found"}


def test_apply_extracts_the_long_cell_and_cleans_the_outputs(project: Path) -> None:
    code, lines = _run(
        project,
        "--action",
        "apply",
        "--notebook",
        "analysis/sales.ipynb",
        "--extract",
        "2,2, ",
        "--clean",
    )
    assert code == 0, lines
    [applied] = lines["NOTEBOOK_APPLY"]
    assert [e["function"] for e in applied["extracted"]] == ["cell_2"]
    assert applied["cleaned"] is True
    assert sorted(applied["changed"]) == [
        "analysis/sales.ipynb",
        "analysis/sales_functions.py",
    ]
    module = (project / "analysis" / "sales_functions.py").read_text(encoding="utf-8")
    assert "def cell_2():" in module and "return total" in module
    stored = json.loads(
        (project / "analysis" / "sales.ipynb").read_text(encoding="utf-8")
    )
    assert all(not c.get("outputs") for c in stored["cells"])
    assert _history(project)[-1]["kind"] == "refactor"
    assert _history(project)[-1]["extracted"] == 1

    code, lines = _run(project, "--action", "metrics")
    assert code == 0
    [month] = lines["NOTEBOOK_METRICS"][0]["months"]
    assert month["month"] == _history(project)[-1]["at"][:7]


def test_a_notebook_at_the_project_root_is_named_without_a_folder(
    project: Path,
) -> None:
    _notebook(project / "top.ipynb")
    code, lines = _run(
        project, "--action", "apply", "--notebook", "top.ipynb", "--extract", "2"
    )
    assert code == 0, lines
    assert lines["NOTEBOOK_APPLY"][0]["changed"] == ["top_functions.py", "top.ipynb"]


@pytest.mark.parametrize(
    ("extract", "message"),
    [
        ("a", "invalid literal for int() with base 10: 'a'"),
        ("-1", "invalid cell list"),
        (",".join(str(i) for i in range(51)), "invalid cell list"),
    ],
)
def test_apply_refuses_a_bad_cell_list(project: Path, extract: str, message: str):
    code, lines = _run(
        project,
        "--action",
        "apply",
        "--notebook",
        "analysis/sales.ipynb",
        "--extract",
        extract,
    )
    assert code == 1
    assert lines["NOTEBOOK_ERROR"] == [message]


def test_run_says_when_the_project_has_no_jupyter(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PATH", str(project / "no-bin"))
    code, lines = _run(
        project, "--action", "execute", "--notebook", "analysis/sales.ipynb"
    )
    assert code == 0, lines
    [run] = lines["NOTEBOOK_EXECUTION"]
    assert run["path"] == "analysis/sales.ipynb"
    assert run["status"] == "no_runner"
    assert lines["NOTEBOOK_EVENT"][0]["data"] == {"status": "Running sales.ipynb..."}


def test_notebooks_under_workpilot_are_not_the_projects(project: Path) -> None:
    _notebook(project / ".workpilot" / "cache.ipynb")
    code, lines = _run(
        project, "--action", "execute", "--notebook", ".workpilot/cache.ipynb"
    )
    assert code == 1
    assert lines["NOTEBOOK_ERROR"] == ["not a notebook of this project"]


def test_a_symlink_inside_the_project_is_refused(project: Path) -> None:
    link = project / "alias.ipynb"
    try:
        link.symlink_to(project / "analysis" / "sales.ipynb")
    except OSError:
        pytest.skip("this account cannot create symbolic links")
    code, lines = _run(project, "--action", "apply", "--notebook", "alias.ipynb")
    assert code == 1
    assert lines["NOTEBOOK_ERROR"] == ["the notebook is a symbolic link"]


def test_a_missing_project_is_refused(tmp_path: Path) -> None:
    code, lines = _run(tmp_path / "gone")
    assert code == 1
    assert lines["NOTEBOOK_ERROR"][0].startswith("Project path does not exist:")


# --- in-process: what a subprocess cannot reach cheaply -------------------------


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("notebook_runner_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_a_notebook_over_20_mb_is_refused(
    runner, project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(runner, "MAX_NOTEBOOK_BYTES", 10)
    with pytest.raises(ValueError, match="larger than 20 MB"):
        runner.resolve_notebook(project, "analysis/sales.ipynb")


def test_a_finished_run_is_recorded_with_its_score(
    runner, project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class Done:
        status = "done"
        score = 75

        def to_dict(self):
            return {"status": "done", "score": 75}

    seen = {}

    def execute(root, target, *, cell_timeout_s, code_indices):
        seen.update(root=root, timeout=cell_timeout_s, cells=code_indices)
        return Done()

    monkeypatch.setattr(runner, "execute_notebook", execute)
    result = runner.run_execute(project, "analysis/sales.ipynb", 30)
    assert result == {"path": "analysis/sales.ipynb", "status": "done", "score": 75}
    assert seen == {"root": project, "timeout": 30, "cells": [1, 2, 3]}
    assert _history(project)[-1]["kind"] == "execute"
    assert _history(project)[-1]["score"] == 75


def test_a_review_worktree_records_in_its_own_project(runner, tmp_path: Path) -> None:
    main = tmp_path / "lab"
    worktree = main / ".workpilot" / "worktrees" / "007"
    assert runner._main_project(worktree) == main.resolve()
    assert runner._main_project(main) == main


def test_a_notebook_outside_the_root_keeps_its_own_path(
    runner, project: Path, tmp_path: Path
) -> None:
    from notebook_agent.notebook_handler import NotebookHandler

    elsewhere = _notebook(tmp_path / "elsewhere" / "nb.ipynb")
    nb = NotebookHandler().parse(elsewhere)
    assert runner._notebook_to_dict(nb, project)["path"] == nb.path


@pytest.mark.parametrize(
    ("action", "argv", "message"),
    [
        ("scan", [], "unexpected"),
        ("metrics", ["--action", "metrics"], "unexpected"),
    ],
)
def test_an_unexpected_failure_still_ends_with_an_error_line(
    runner,
    project: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys,
    action: str,
    argv: list[str],
    message: str,
) -> None:
    def boom(*_a, **_k):
        raise RuntimeError(message)

    monkeypatch.setattr(runner, "run_scan" if action == "scan" else "metrics", boom)
    monkeypatch.setattr(sys, "argv", ["runner", "--project-path", str(project), *argv])
    with pytest.raises(SystemExit) as stop:
        runner.main()
    assert stop.value.code == 1
    assert capsys.readouterr().out.splitlines()[-1] == f'NOTEBOOK_ERROR:"{message}"'
