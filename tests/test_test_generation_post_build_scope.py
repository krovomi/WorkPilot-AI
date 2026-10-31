"""Post-build test generation stays inside the project it was given.

`run_post_build_test_generation` filtered files with `startswith`, so
`/work/repo-other/x.py` passed for project `/work/repo`. A path is inside a
root when their common path is the root.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
sys.path.insert(0, str(BACKEND))

from test_generation import api  # noqa: E402


class _Result:
    tests_generated = 0


class _Agent:
    def __init__(self):
        self.seen: list[str] = []

    def _compute_test_file_path(self, path: str) -> str:
        return path + ".missing"

    def generate_unit_tests(self, path, existing):
        self.seen.append(path)
        return _Result()


def _run(monkeypatch, project: Path, files: list[Path]) -> list[str]:
    agent = _Agent()
    module = types.ModuleType("test_generation.generator")
    module.TestGeneratorAgent = lambda: agent
    monkeypatch.setitem(sys.modules, "test_generation.generator", module)
    api.run_post_build_test_generation(str(project), [str(f) for f in files])
    return agent.seen


def test_a_sibling_sharing_the_prefix_is_outside(tmp_path, monkeypatch):
    project = tmp_path / "repo"
    sibling = tmp_path / "repo-other"
    project.mkdir()
    sibling.mkdir()
    inside = project / "module.py"
    outside = sibling / "module.py"
    inside.write_text("x = 1\n", encoding="utf-8")
    outside.write_text("x = 1\n", encoding="utf-8")

    assert _run(monkeypatch, project, [inside, outside]) == [str(inside)]


def test_a_link_out_of_the_project_is_outside(tmp_path, monkeypatch):
    project = tmp_path / "repo"
    elsewhere = tmp_path / "elsewhere"
    project.mkdir()
    elsewhere.mkdir()
    (elsewhere / "module.py").write_text("x = 1\n", encoding="utf-8")
    link = project / "linked.py"
    link.symlink_to(elsewhere / "module.py")

    assert _run(monkeypatch, project, [link]) == []


def test_is_within():
    assert api._is_within("/a/b", "/a/b")
    assert api._is_within("/a/b/c.py", "/a/b")
    assert not api._is_within("/a/bc/c.py", "/a/b")


def test_is_within_with_windows_paths(monkeypatch):
    # commonpath answers with backslashes there: the root must be compared alike
    import ntpath

    monkeypatch.setattr(api.os, "path", ntpath)
    assert api._is_within("/a/b", "/a/b")
    assert api._is_within("C:\\Repo\\src\\m.py", "c:/repo")
    assert not api._is_within("C:\\repo-evil\\m.py", "C:\\repo")
    assert not api._is_within("D:\\repo\\m.py", "C:\\repo")


def test_test_files_are_judged_inside_the_project(tmp_path, monkeypatch):
    project = tmp_path / "test_checkouts" / "repo"
    (project / "tests").mkdir(parents=True)
    source = project / "module.py"
    source.write_text("x = 1\n", encoding="utf-8")
    (project / "test_module.py").write_text("x = 1\n", encoding="utf-8")
    (project / "tests" / "helpers.py").write_text("x = 1\n", encoding="utf-8")

    files = [source, project / "test_module.py", project / "tests" / "helpers.py"]
    assert _run(monkeypatch, project, files) == [str(source)]
