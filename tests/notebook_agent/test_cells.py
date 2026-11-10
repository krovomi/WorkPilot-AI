"""Notebook cells: dependencies, cell → function, a run in a fresh kernel (#371)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from notebook_agent.dataflow import analyze_dataflow
from notebook_agent.executor import execute_notebook, read_executed
from notebook_agent.history import metrics, record
from notebook_agent.model import CellType, NotebookCell, ParsedNotebook
from notebook_agent.notebook_handler import NotebookHandler
from notebook_agent.outputs import check_outputs
from notebook_agent.refactor import apply_refactor, duplicates, proposals

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "apps" / "backend" / "runners" / "notebook_agent_runner.py"


def _nb(
    language: str, sources: list[str], counts: list[int | None] | None = None
) -> ParsedNotebook:
    nb = ParsedNotebook(path="analysis.ipynb", language=language)
    for i, source in enumerate(sources):
        nb.cells.append(
            NotebookCell(
                index=i,
                cell_type=CellType.CODE,
                source=source,
                execution_count=(counts or [None] * len(sources))[i],
            )
        )
    return nb


def _kinds(flow) -> dict[str, list[int]]:
    found: dict[str, list[int]] = {}
    for issue in flow.issues:
        found.setdefault(issue.issue_type.value, []).append(issue.cell_index)
    return found


def _ipynb(
    path: Path, sources: list[str], outputs: list[list[dict]] | None = None
) -> Path:
    cells = [
        {
            "cell_type": "code",
            "source": source,
            "metadata": {},
            "execution_count": i + 1,
            "outputs": (outputs or [[] for _ in sources])[i],
        }
        for i, source in enumerate(sources)
    ]
    data = {
        "cells": cells,
        "metadata": {
            "kernelspec": {"name": "python3", "language": "python"},
            "widgets": {},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


# ── dependencies ───────────────────────────────────────────────────────────


def test_python_dependencies_and_order():
    flow = analyze_dataflow(
        _nb(
            "python",
            [
                "import pandas as pd\ndf = pd.read_csv('a.csv')",
                "summary = describe(df)",
                "def describe(frame):\n    return frame.describe()",
            ],
        )
    )
    assert {"from": 0, "to": 1, "names": ["df"]} in flow.edges
    assert {"from": 2, "to": 1, "names": ["describe"]} in flow.edges
    assert _kinds(flow)["used_before_defined"] == [1]
    assert flow.order == [0, 2, 1] and not flow.in_order
    assert flow.precise


def test_names_read_in_a_function_body_are_not_used_before_defined():
    # The function runs later: `model` only has to exist when it is called.
    flow = analyze_dataflow(
        _nb(
            "python",
            ["def score():\n    return model.predict()", "model = 1", "score()"],
        )
    )
    assert "used_before_defined" not in _kinds(flow)
    assert "implicit_global" in _kinds(flow)


def test_undefined_name_is_exact_and_stays_quiet_when_names_can_hide():
    assert _kinds(analyze_dataflow(_nb("python", ["print(ghost)", "x = len([1])"])))[
        "undefined_name"
    ] == [0]
    # Builtins, IPython names, comprehension variables and magics are not findings.
    quiet = _nb(
        "python",
        ["%matplotlib inline\nvalues = [v * 2 for v in range(3)]\ndisplay(values)"],
    )
    assert _kinds(analyze_dataflow(quiet)) == {}
    # A star import or %run may define anything: no undefined-name finding.
    assert "undefined_name" not in _kinds(
        analyze_dataflow(_nb("python", ["from math import *", "print(pi)"]))
    )
    assert "undefined_name" not in _kinds(
        analyze_dataflow(_nb("python", ["%run setup.py", "print(config)"]))
    )


def test_hidden_state_from_execution_counts():
    flow = analyze_dataflow(_nb("python", ["x = 1", "y = x + 1"], counts=[5, 2]))
    assert _kinds(flow)["hidden_state"] == [1]


def test_shared_mutation():
    flow = analyze_dataflow(
        _nb(
            "python",
            ["df = load()", "df.dropna(inplace=True)", "print(df)", "print(df.shape)"],
        )
    )
    assert _kinds(flow).get("shared_mutation") == [1]


@pytest.mark.parametrize(
    ("language", "cells"),
    [
        (
            "r",
            ["df <- read.csv('a.csv')", "m <- mean(df$y)\nprint(later)", "later <- 2"],
        ),
        ("julia", ["df = load()", "m = mean(df)\nprintln(later)", "later = 2"]),
        (
            "csharp",
            [
                "var df = Load();",
                "var m = df.Count;\nConsole.WriteLine(later);",
                "int later = 2;",
            ],
        ),
        (
            "fsharp",
            [
                "let df = load ()",
                'let m = Seq.length df\nprintfn "%d" later',
                "let later = 2",
            ],
        ),
        (
            "powershell",
            ["$df = Get-Data", "$m = $df.Count\nWrite-Output $later", "$later = 2"],
        ),
        (
            "scala",
            ["val df = load()", "val m = df.size\nprintln(later)", "val later = 2"],
        ),
        (
            "kotlin",
            ["val df = load()", "val m = df.size\nprintln(later)", "val later = 2"],
        ),
        (
            "javascript",
            [
                "const df = load();",
                "const m = df.length;\nconsole.log(later);",
                "let later = 2;",
            ],
        ),
        ("go", ["df := load()", "m := len(df)\nfmt.Println(later)", "later := 2"]),
        (
            "rust",
            [
                "let df = load();",
                'let m = df.len();\nprintln!("{}", later);',
                "let later = 2;",
            ],
        ),
    ],
)
def test_every_stack_gets_dependencies(language: str, cells: list[str]):
    flow = analyze_dataflow(_nb(language, cells))
    assert {"from": 0, "to": 1, "names": ["df"]} in flow.edges
    assert _kinds(flow)["used_before_defined"] == [1]
    assert not flow.precise
    assert "approximate" in flow.issues[0].message


def test_other_languages_skip_function_bodies_and_comments():
    flow = analyze_dataflow(
        _nb(
            "r",
            [
                "f <- function(a) { a + later }  # later comes later",
                "later <- 2\nresult <- f(1)",
            ],
        )
    )
    assert "used_before_defined" not in _kinds(flow)
    flow = analyze_dataflow(
        _nb(
            "javascript",
            ["function f() { return later; }\n// later", "const later = 1;"],
        )
    )
    assert "used_before_defined" not in _kinds(flow)


def test_cells_of_a_polyglot_notebook_use_their_own_language(tmp_path: Path):
    path = tmp_path / "poly.dib"
    path.write_text(
        "#!csharp\nvar total = 1;\n\n#!markdown\n# Title\n\n#!sql\nSELECT total FROM t\n",
        encoding="utf-8",
    )
    nb = NotebookHandler().parse(path)
    flow = analyze_dataflow(nb)
    languages = [c.language for c in flow.cells]
    assert languages == ["csharp", "sql"]
    assert flow.edges == []  # SQL has no variables of the C# cell


# ── cell → function ───────────────────────────────────────────────────────


def _long_cell() -> str:
    body = "\n".join(f"step_{i} = frame['x'].sum() * factor + {i}" for i in range(52))
    return f"import numpy as np\n{body}\ntotal = np.sum([step_0, step_51])"


def test_long_python_cell_becomes_a_function_proposal():
    nb = _nb(
        "python",
        [
            "import pandas as pd\nframe = pd.DataFrame()\nfactor = 2",
            _long_cell(),
            "print(total, np.pi)",
        ],
    )
    nb.cells.insert(
        1,
        NotebookCell(
            index=99, cell_type=CellType.MARKDOWN, source="## Compute the totals"
        ),
    )
    flow = analyze_dataflow(nb)
    [proposal] = proposals(nb, flow)
    assert proposal.function == "compute_the_totals"
    assert proposal.params == ["frame", "factor"]
    assert proposal.returns == ["total"]
    assert proposal.reason == ""


def test_a_cell_that_would_change_meaning_is_refused_with_its_reason():
    displayed = _long_cell() + "\ntotal"
    flow = analyze_dataflow(nb := _nb("python", ["frame = 1\nfactor = 2", displayed]))
    [proposal] = proposals(nb, flow)
    assert "displays" in proposal.reason
    magic = "%time\n" + _long_cell()
    flow = analyze_dataflow(nb := _nb("python", ["frame = 1\nfactor = 2", magic]))
    assert "magics" in proposals(nb, flow)[0].reason


def test_duplicated_blocks_in_any_language():
    block = "\n".join(
        f"result_{i} <- transform(data, column_{i}, scale = TRUE)" for i in range(6)
    )
    found = duplicates(_nb("r", [block, "x <- 1\n" + block]))
    assert [i.cell_index for i in found] == [0]
    assert "Cells 0, 1" in found[0].message


def test_apply_extracts_into_a_module_and_cleans(tmp_path: Path):
    path = _ipynb(
        tmp_path / "My Analysis.ipynb",
        [
            "import pandas as pd\nframe = pd.DataFrame()\nfactor = 2",
            _long_cell(),
            "print(total, np.pi)",
        ],
        outputs=[[{"output_type": "stream", "name": "stdout", "text": "x"}], [], []],
    )
    nb = NotebookHandler().parse(path)
    flow = analyze_dataflow(nb)
    result = apply_refactor(path, nb, flow, [1, 2], clean=True)
    assert [e["cellIndex"] for e in result["extracted"]] == [1]
    assert result["refused"] == [{"cellIndex": 2, "reason": "not a long Python cell"}]
    assert result["cleaned"] and sorted(result["changed"]) == [
        "My Analysis.ipynb",
        "my_analysis_functions.py",
    ]
    module = (tmp_path / "my_analysis_functions.py").read_text(encoding="utf-8")
    assert "import numpy as np" in module and "def cell_1(frame, factor):" in module
    compile(module, "module", "exec")
    data = json.loads(path.read_text(encoding="utf-8"))
    cell = "".join(data["cells"][1]["source"])
    assert (
        cell
        == "import numpy as np\nfrom my_analysis_functions import cell_1\ntotal = cell_1(frame, factor)"
    )
    assert all(
        c["outputs"] == [] and c["execution_count"] is None for c in data["cells"]
    )
    assert "widgets" not in data["metadata"]


def test_apply_refuses_a_text_notebook(tmp_path: Path):
    path = tmp_path / "doc.qmd"
    path.write_text("```{python}\nx = 1\n```\n", encoding="utf-8")
    nb = NotebookHandler().parse(path)
    with pytest.raises(ValueError, match="only Jupyter"):
        apply_refactor(path, nb, analyze_dataflow(nb), [0], clean=True)


# ── outputs and a run ─────────────────────────────────────────────────────


def _table(rows: int) -> dict:
    return {
        "output_type": "execute_result",
        "data": {"text/plain": f"...\n[{rows} rows x 3 columns]"},
    }


def test_output_checks():
    issues, matches = check_outputs(2, [_table(10)], [_table(8)])
    assert [i["issueType"] for i in issues] == ["shape_changed"] and matches is False
    issues, _ = check_outputs(
        1,
        [],
        [
            {
                "output_type": "error",
                "ename": "ModuleNotFoundError",
                "evalue": "No module named 'sklearn'",
            }
        ],
    )
    assert (
        issues[0]["issueType"] == "missing_dependency"
        and "sklearn" in issues[0]["message"]
    )
    issues, _ = check_outputs(
        1,
        [],
        [{"output_type": "error", "ename": "AssertionError", "evalue": "rows lost"}],
    )
    assert issues[0]["issueType"] == "assertion_failed"
    issues, _ = check_outputs(
        1,
        [],
        [
            {
                "output_type": "display_data",
                "data": {"text/plain": "<Figure size 640x480 with 0 Axes>"},
            }
        ],
    )
    assert issues[0]["issueType"] == "empty_plot"
    # Memory addresses and timings are not a change.
    same = {
        "output_type": "stream",
        "name": "stdout",
        "text": "<obj at 0x7f00aa11bb22> in 12 ms",
    }
    other = {
        "output_type": "stream",
        "name": "stdout",
        "text": "<obj at 0x7f00cc33dd44> in 30 ms",
    }
    assert check_outputs(0, [same], [other]) == ([], True)


def test_reading_an_executed_notebook():
    stored = {
        "cells": [
            {"cell_type": "code", "outputs": [_table(10)]},
            {"cell_type": "markdown"},
            {"cell_type": "code", "outputs": []},
            {"cell_type": "code", "outputs": []},
        ]
    }
    executed = {
        "cells": [
            {
                "cell_type": "code",
                "execution_count": 1,
                "source": "df",
                "outputs": [_table(10)],
                "metadata": {
                    "execution": {
                        "iopub.execute_input": "2026-11-10T10:00:00Z",
                        "shell.execute_reply": "2026-11-10T10:00:02.5Z",
                    }
                },
            },
            {"cell_type": "markdown"},
            {
                "cell_type": "code",
                "execution_count": 2,
                "source": "boom()",
                "outputs": [
                    {"output_type": "error", "ename": "NameError", "evalue": "boom"}
                ],
                "metadata": {},
            },
            {
                "cell_type": "code",
                "execution_count": None,
                "source": "train()",
                "outputs": [],
                "metadata": {"tags": ["skip-execution"]},
            },
        ]
    }
    run = read_executed(stored, executed)
    assert [c["status"] for c in run.cells] == ["ok", "error", "skipped"]
    assert [c["cellIndex"] for c in run.cells] == [0, 2, 3]
    assert run.cells[0]["seconds"] == 2.5
    assert run.score == 50 and run.matching == 100
    assert "first failing cell" in run.issues[0]["message"]


class _FakeJupyter:
    """Stands for `jupyter`: lists a kernel, or writes the executed copy."""

    def __init__(self, kernels: list[str], executed: dict | None):
        self.kernels = kernels
        self.executed = executed
        self.calls: list[tuple[list[str], dict]] = []

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        fake = self

        class Process:
            pid = 1
            returncode = 0

            def communicate(self, timeout=None):
                if argv[1] == "kernelspec":
                    return json.dumps(
                        {"kernelspecs": {k: {} for k in fake.kernels}}
                    ).encode(), b""
                out = Path(argv[argv.index("--output-dir") + 1]) / "executed.ipynb"
                out.write_text(json.dumps(fake.executed), encoding="utf-8")
                return b"done", b""

        return Process()


def _jupyter_on_path(monkeypatch, tmp_path: Path):
    bin_dir = tmp_path / ".venv" / "bin"
    bin_dir.mkdir(parents=True)
    (bin_dir / "jupyter").write_text("", encoding="utf-8")
    monkeypatch.setattr("notebook_agent.executor.is_windows", lambda: False)


def test_execute_runs_in_a_temp_copy_without_credentials(tmp_path: Path, monkeypatch):
    _jupyter_on_path(monkeypatch, tmp_path)
    monkeypatch.setenv("OPENAI_API_KEY", "not-for-the-notebook")
    path = _ipynb(tmp_path / "nb.ipynb", ["x = 1"])
    before = path.read_text(encoding="utf-8")
    fake = _FakeJupyter(
        ["python3"],
        {
            "cells": [
                {
                    "cell_type": "code",
                    "execution_count": 1,
                    "source": "x = 1",
                    "outputs": [],
                    "metadata": {},
                }
            ]
        },
    )
    run = execute_notebook(tmp_path, path, popen=fake)
    assert run.status == "done" and run.score == 100
    argv, kwargs = fake.calls[-1]
    assert argv[1:6] == ["nbconvert", "--to", "notebook", "--execute", "--allow-errors"]
    assert "OPENAI_API_KEY" not in kwargs["env"] and kwargs["cwd"] == str(tmp_path)
    assert "shell" not in kwargs
    assert path.read_text(encoding="utf-8") == before  # the notebook is never changed


def test_execute_names_what_is_missing(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("notebook_agent.executor.find_executable", lambda name: None)
    path = _ipynb(tmp_path / "nb.ipynb", ["x = 1"])
    assert execute_notebook(tmp_path, path).status == "no_runner"
    _jupyter_on_path(monkeypatch, tmp_path)
    data = json.loads(path.read_text(encoding="utf-8"))
    data["metadata"]["kernelspec"]["name"] = "ir"
    path.write_text(json.dumps(data), encoding="utf-8")
    run = execute_notebook(tmp_path, path, popen=_FakeJupyter(["python3"], None))
    assert run.status == "no_kernel" and "IRkernel" in run.hint
    dib = tmp_path / "poly.dib"
    dib.write_text("#!csharp\nvar x = 1;\n", encoding="utf-8")
    assert execute_notebook(tmp_path, dib).status == "unsupported"


# ── history and the runner ─────────────────────────────────────────────────


def test_history_per_month(tmp_path: Path):
    (tmp_path / ".workpilot").mkdir()
    record(tmp_path, "scan", notebooks=3, findings=2)
    record(tmp_path, "execute", score=80)
    record(tmp_path, "execute", score=60)
    record(tmp_path, "refactor", extracted=2)
    [month] = metrics(tmp_path)
    assert month["notebooks"] == 3 and month["findings"] == 2
    assert month["runs"] == 2 and month["meanScore"] == 70 and month["extracted"] == 2


def _run(*args: str) -> tuple[int, str]:
    done = subprocess.run(  # noqa: S603 - fixed argv
        [sys.executable, str(RUNNER), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    return done.returncode, done.stdout


def test_runner_scan_reports_dependencies(tmp_path: Path):
    _ipynb(tmp_path / "nb.ipynb", ["y = x + 1", "x = 1"])
    code, out = _run("--project-path", str(tmp_path))
    assert code == 0
    line = next(ln for ln in out.splitlines() if ln.startswith("NOTEBOOK_RESULT:"))
    [nb] = json.loads(line.split(":", 1)[1])["notebooks"]
    assert nb["dependencies"]["order"] == [1, 0]
    assert any(i["issueType"] == "used_before_defined" for i in nb["issues"])
    assert nb["editable"] and nb["runnable"] and len(nb["cells"]) == 2


@pytest.mark.parametrize(
    "notebook", ["../outside.ipynb", "/etc/passwd", "missing.ipynb", "notes.txt"]
)
def test_runner_keeps_the_notebook_inside_the_project(tmp_path: Path, notebook: str):
    (tmp_path / "project").mkdir()
    (tmp_path / "outside.ipynb").write_text("{}", encoding="utf-8")
    (tmp_path / "project" / "notes.txt").write_text("x", encoding="utf-8")
    code, out = _run(
        "--project-path",
        str(tmp_path / "project"),
        "--action",
        "apply",
        "--notebook",
        notebook,
    )
    assert code == 1 and "NOTEBOOK_ERROR:" in out


def test_runner_refuses_a_symlinked_notebook(tmp_path: Path):
    (tmp_path / "project").mkdir()
    real = _ipynb(tmp_path / "real.ipynb", ["x = 1"])
    try:
        (tmp_path / "project" / "link.ipynb").symlink_to(real)
    except OSError:
        pytest.skip("symlinks are not available here")
    code, out = _run(
        "--project-path",
        str(tmp_path / "project"),
        "--action",
        "execute",
        "--notebook",
        "link.ipynb",
    )
    assert code == 1 and "symbolic link" in out or "outside" in out
