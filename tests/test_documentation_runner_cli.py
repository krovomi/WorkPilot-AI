"""The documentation runner as the Documentation tab starts it: one action per run.

Real source files in a project folder and the real documentation agent; the
process is the one the app spawns.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from runners import documentation_runner as runner

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "documentation_runner.py"
RESULT = "DOCUMENTATION_RESULT:"
ERROR = "DOCUMENTATION_ERROR:"


def _process(project: Path, action: str, path: str | None = None):
    args = ["--project-path", str(project), "--action", action]
    if path is not None:
        args += ["--path", path]
    return subprocess.run(
        [sys.executable, str(RUNNER), *args],
        cwd=BACKEND,
        # As the app starts it (pythonRunnerEnv): UTF-8 whatever the code page.
        env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )


def _result(done: subprocess.CompletedProcess[str]) -> dict:
    assert done.returncode == 0, done.stdout + done.stderr
    [line] = [x for x in done.stdout.splitlines() if x.startswith(RESULT)]
    return json.loads(line[len(RESULT) :])


def _error(done: subprocess.CompletedProcess[str]) -> str:
    assert done.returncode == 1
    [line] = [x for x in done.stdout.splitlines() if x.startswith(ERROR)]
    return line[len(ERROR) :]


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    (root / "src").mkdir(parents=True)
    (root / "src" / "cart.ts").write_text(
        "/** A cart. */\nexport class Cart {}\nexport function total(items: number[]) {}\n",
        encoding="utf-8",
    )
    (root / "src" / "tax.py").write_text(
        'def vat(country):\n    """VAT."""\n    return 0.2\n', encoding="utf-8"
    )
    (root / "src" / "empty.go").write_text("package shop\n", encoding="utf-8")
    (root / "README.md").write_text("# Shop\n", encoding="utf-8")
    (root / ".cache").mkdir()
    (root / ".cache" / "hidden.py").write_text("def x(): pass\n", encoding="utf-8")
    return root


def test_a_missing_project_is_refused(tmp_path: Path) -> None:
    assert _error(_process(tmp_path / "gone", "project")).startswith(
        "Project path does not exist"
    )


def test_the_project_overview_reads_every_source_file(project: Path) -> None:
    try:
        os.symlink(project / "src" / "gone.py", project / "src" / "dangling.py")
    except OSError:
        pass  # without the right to link, the rest still holds
    (project / "src" / "generated.py").write_text("x = 1\n" * 80_000, encoding="utf-8")

    overview = _result(_process(project, "project"))

    # cart.ts, tax.py and empty.go; not the README, not the hidden folder,
    # not the link that points nowhere, not the file over the size bound.
    assert overview["files_scanned"] == 3
    assert overview["files_with_symbols"] == 2
    assert overview["truncated"] is False
    assert {lang["id"] for lang in overview["languages"]} == {"typescript", "python"}
    # total() has no doc comment, vat() a summary without its argument.
    assert [f["path"] for f in overview["files"]] == ["src/cart.ts", "src/tax.py"]


def test_a_large_project_reports_its_progress(tmp_path: Path) -> None:
    for index in range(200):
        (tmp_path / f"m{index:03}.py").write_text(
            f"def f{index}():\n    pass\n", encoding="utf-8"
        )

    done = _process(tmp_path, "project")

    assert '"status": "Reading 200/200 files..."' in done.stdout
    assert _result(done)["missing"] == 200


def test_coverage_drafts_and_readme_as_the_tab_asks_for_them(project: Path) -> None:
    coverage = _result(_process(project, "coverage", "src/cart.ts"))
    assert coverage["path"] == "src/cart.ts" and coverage["language"] == "typescript"

    drafts = _result(_process(project, "docstrings", "src/cart.ts"))
    assert [d["name"] for d in drafts["generated_docs"]] == ["total"]
    assert drafts["source_path"] == "src/cart.ts"

    readme = _result(_process(project, "readme"))
    assert readme["source_path"] == "."
    assert str(project) not in readme["readme_content"]


@pytest.mark.parametrize(
    ("action", "path", "message"),
    [
        ("coverage", "src/nothing.ts", "File not found: src/nothing.ts"),
        ("docstrings", "src/nothing.ts", "File not found: src/nothing.ts"),
        ("docstrings", "README.md", "Unsupported file type: .md"),
        ("readme", "docs", "Folder not found: docs"),
        ("readme", "../..", "Path is outside the project: ../.."),
    ],
)
def test_a_path_the_tab_cannot_use_is_an_error_line(
    project: Path, action: str, path: str, message: str
) -> None:
    assert _error(_process(project, action, path)) == message


def test_a_file_that_vanishes_while_reading_is_left_out(
    project: Path, monkeypatch
) -> None:
    from agents.documenter import DocAnalyzer

    real = DocAnalyzer.analyze_file

    def analyze(self, file_path: str):
        if file_path.endswith("tax.py"):
            raise FileNotFoundError(file_path)
        return real(self, file_path)

    monkeypatch.setattr(DocAnalyzer, "analyze_file", analyze)

    overview = runner.project_overview(project)

    assert {lang["id"] for lang in overview["languages"]} == {"typescript"}


def test_a_listing_stops_at_its_bound(project: Path, monkeypatch) -> None:
    monkeypatch.setattr(runner, "MAX_FILES", 2)

    overview = runner.project_overview(project)

    assert overview["files_scanned"] == 2
    assert overview["truncated"] is True
