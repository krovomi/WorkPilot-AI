"""scripts/diff_coverage.py: every line a change adds is run by a test, in any report it reads."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location(
    "diff_coverage", ROOT / "scripts" / "diff_coverage.py"
)
diff_coverage = importlib.util.module_from_spec(_spec)
# Its dataclasses look their module up by name while the module loads.
sys.modules["diff_coverage"] = diff_coverage
_spec.loader.exec_module(diff_coverage)


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A repository with a base commit on `main` and a change on top of it."""
    _git(tmp_path, "init", "-q", "-b", "main")
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "calc.py").write_text("a = 1\nb = 2\nc = 3\n", encoding="utf-8")
    (tmp_path / "web.ts").write_text("export const a = 1;\n", encoding="utf-8")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-q", "-m", "base")
    _git(tmp_path, "checkout", "-q", "-b", "change")
    (tmp_path / "pkg" / "calc.py").write_text(
        "a = 1\nb = 20\nc = 3\nd = 4\ne = 5\n", encoding="utf-8"
    )
    (tmp_path / "web.ts").write_text(
        "export const a = 1;\nexport const f = (x) => (x ? 1 : 2);\n", encoding="utf-8"
    )
    (tmp_path / "notes.md").write_text("no code\n", encoding="utf-8")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-q", "-m", "change")
    monkeypatch.chdir(tmp_path)
    return tmp_path


def _cobertura(
    repo: Path, lines: dict[int, int], branch: dict[int, str] | None = None
) -> Path:
    rows = []
    for number, hits in lines.items():
        extra = ""
        if branch and number in branch:
            extra = f' branch="true" condition-coverage="{branch[number]}"'
        rows.append(f'<line number="{number}" hits="{hits}"{extra}/>')
    report = repo / "coverage.xml"
    report.write_text(
        f"""<?xml version="1.0" ?>
<coverage><sources><source>{repo / "pkg"}</source></sources>
<packages><package name="pkg"><classes>
<class name="calc.py" filename="calc.py"><lines>{"".join(rows)}</lines></class>
</classes></package></packages></coverage>
""",
        encoding="utf-8",
    )
    return report


def _istanbul(repo: Path, statements: dict[int, int], branch_counts: list[int]) -> Path:
    path = str(repo / "web.ts")
    entry = {
        "path": path,
        "statementMap": {
            str(i): {
                "start": {"line": line, "column": 0},
                "end": {"line": line, "column": 9},
            }
            for i, line in enumerate(statements)
        },
        "s": {str(i): hits for i, hits in enumerate(statements.values())},
        "branchMap": {
            "0": {
                "type": "cond-expr",
                "loc": {
                    "start": {"line": 2, "column": 25},
                    "end": {"line": 2, "column": 40},
                },
                "locations": [
                    {
                        "start": {"line": 2, "column": 30},
                        "end": {"line": 2, "column": 31},
                    },
                    {
                        "start": {"line": 2, "column": 34},
                        "end": {"line": 2, "column": 35},
                    },
                ],
            }
        },
        "b": {"0": branch_counts},
    }
    report = repo / "coverage-final.json"
    report.write_text(json.dumps({path: entry}), encoding="utf-8")
    return report


def test_reads_the_lines_a_change_adds_or_changes():
    diff = (
        "+++ b/pkg/calc.py\n@@ -2 +2 @@\n-b = 2\n+b = 20\n@@ -3,0 +4,2 @@\n+d = 4\n+e = 5\n"
        "+++ /dev/null\n@@ -1,2 +0,0 @@\n-gone\n"
        "+++ b/empty.py\n@@ -1,3 +0,0 @@\n"
    )
    assert diff_coverage.parse_diff(diff) == {"pkg/calc.py": {2, 4, 5}}


def test_passes_when_every_changed_line_ran(repo, capsys):
    report = _cobertura(repo, {1: 1, 2: 3, 3: 1, 4: 1, 5: 2})
    assert diff_coverage.main(["--base", "main", "--cobertura", str(report)]) == 0
    assert "Every changed line is covered (3 measured)." in capsys.readouterr().out


def test_names_each_changed_line_no_test_ran_and_ignores_old_ones(repo, capsys):
    # Line 1 and 3 did not change: missing them is the floor's business, not this gate's.
    report = _cobertura(repo, {1: 0, 2: 1, 3: 0, 4: 0, 5: 1})
    assert diff_coverage.main(["--base", "main", "--cobertura", str(report)]) == 1
    out = capsys.readouterr().out
    assert (
        "::error file=pkg/calc.py,line=4,title=diff coverage::pkg/calc.py:4 never run by a test"
        in out
    )
    assert "line=1," not in out
    assert "line=3," not in out
    assert "1 changed line(s) not covered, out of 3 measured" in out


def test_a_branch_half_taken_on_a_changed_line_fails(repo, capsys):
    report = _cobertura(
        repo, {2: 1, 4: 1, 5: 1}, branch={5: "50% (1/2)", 4: "100% (2/2)"}
    )
    assert diff_coverage.main(["--base", "main", "--cobertura", str(report)]) == 1
    out = capsys.readouterr().out
    assert "pkg/calc.py:5 1 branch path never taken" in out
    assert "calc.py:4" not in out


def test_reads_istanbul_statements_and_branches(repo, capsys):
    report = _istanbul(repo, {1: 1, 2: 1}, branch_counts=[3, 0])
    assert diff_coverage.main(["--base", "main", "--istanbul", str(report)]) == 1
    assert "web.ts:2 1 branch path never taken" in capsys.readouterr().out

    report = _istanbul(repo, {1: 1, 2: 0}, branch_counts=[0, 0])
    assert diff_coverage.main(["--base", "main", "--istanbul", str(report)]) == 1
    out = capsys.readouterr().out
    # A line no test ran is said once, not again for its branches.
    assert "web.ts:2 never run by a test" in out
    assert "branch path" not in out

    report = _istanbul(repo, {1: 1, 2: 4}, branch_counts=[1, 3])
    assert diff_coverage.main(["--base", "main", "--istanbul", str(report)]) == 0


def test_lines_and_files_no_report_measures_are_not_counted(repo, capsys):
    # Lines 4 and 5 are not in the report (a `pragma: no cover`, say): only line 2 counts.
    report = _cobertura(repo, {1: 1, 2: 1, 3: 1})
    assert diff_coverage.main(["--base", "main", "--cobertura", str(report)]) == 0
    assert "(1 measured)" in capsys.readouterr().out


def test_skips_report_entries_outside_the_repository(repo, tmp_path_factory):
    elsewhere = tmp_path_factory.mktemp("elsewhere") / "x.ts"
    report = repo / "outside.json"
    report.write_text(
        json.dumps(
            {str(elsewhere): {"path": str(elsewhere), "statementMap": {}, "s": {}}}
        ),
        encoding="utf-8",
    )
    assert diff_coverage.read_istanbul(report, repo.resolve()) == {}


def test_asks_for_a_report(repo):
    with pytest.raises(SystemExit):
        diff_coverage.main(["--base", "main"])


@pytest.mark.parametrize(
    ("workflow", "gate"),
    [
        (
            "ci.yml",
            "scripts/diff_coverage.py --base HEAD^1 --cobertura apps/backend/coverage.xml",
        ),
        (
            "ci.yml",
            "scripts/diff_coverage.py --base HEAD^1 --istanbul apps/frontend/coverage/coverage-final.json",
        ),
        (
            "mobile.yml",
            "../../scripts/diff_coverage.py --base HEAD^1 --istanbul coverage/coverage-final.json",
        ),
    ],
)
def test_every_pull_request_runs_the_gate_on_its_report(workflow, gate):
    text = (ROOT / ".github" / "workflows" / workflow).read_text(encoding="utf-8")
    assert gate in text
    # HEAD^1 is only there with the merge commit's parents.
    assert "fetch-depth: 2" in text
