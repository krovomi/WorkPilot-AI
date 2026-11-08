"""runners/documentation_runner.py: the Documentation tab's backend."""

from __future__ import annotations

from pathlib import Path

import pytest
from runners import documentation_runner as runner


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "Orders.cs").write_text(
        "/// <summary>Orders.</summary>\npublic class Orders\n{\n"
        "    public void Cancel(int id) { }\n}\n",
        encoding="utf-8",
    )
    (tmp_path / "src" / "tax.py").write_text(
        'def vat(country: str) -> float:\n    """VAT.\n\n    Args:\n        country: code.\n    """\n'
        "    return 0.2\n",
        encoding="utf-8",
    )
    (tmp_path / "node_modules" / "lib").mkdir(parents=True)
    (tmp_path / "node_modules" / "lib" / "x.js").write_text(
        "export function hidden() {}\n", encoding="utf-8"
    )
    return tmp_path


def test_project_overview_counts_every_language_and_skips_dependencies(project):
    overview = runner.project_overview(project)
    by_lang = {lang["id"]: lang for lang in overview["languages"]}
    assert set(by_lang) == {"csharp", "python"}
    assert by_lang["python"]["coverage_pct"] == 100.0
    assert by_lang["csharp"]["missing"] == 1
    assert [f["path"] for f in overview["files"]] == ["src/Orders.cs"]


def test_file_coverage_and_drafts_are_project_relative(project):
    coverage = runner.file_coverage(project, "src/Orders.cs")
    assert coverage["path"] == "src/Orders.cs"
    assert {s["file_path"] for s in coverage["symbols"]} == {"src/Orders.cs"}
    drafts = runner.file_docstrings(project, "src/Orders.cs")
    assert [d["name"] for d in drafts["generated_docs"]] == ["Orders.Cancel"]
    assert '<param name="id">' in drafts["generated_docs"][0]["generated_doc"]


def test_readme_names_the_folder_by_its_project_path(project):
    readme = runner.folder_readme(project, "src")
    assert str(project) not in readme["readme_content"]
    assert "Orders.cs" in readme["readme_content"]


@pytest.mark.parametrize("path", ["../outside.cs", "/etc/passwd"])
def test_paths_outside_the_project_are_refused(project, path):
    with pytest.raises(ValueError, match="outside the project"):
        runner.file_coverage(project, path)


def test_unsupported_files_are_refused(project):
    (project / "notes.md").write_text("# hi\n", encoding="utf-8")
    with pytest.raises(ValueError, match="Unsupported"):
        runner.file_coverage(project, "notes.md")
