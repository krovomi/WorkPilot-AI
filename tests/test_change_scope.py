"""The change scope that decides how much QA a task gets.

`foundation.change_scope` reads the change set from git and file names only,
so the same task gets the same review whatever the provider or the model.
These tests pin the one property that matters for the board's reliability:
nothing a program reads is ever classified ``light``, and unknown is ``full``.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from foundation.change_scope import (
    LIGHT_MAX_CHANGED_LINES,
    LIGHT_MAX_FILES,
    change_diff,
    change_scope,
    classify,
    is_text_only_path,
)


@pytest.mark.parametrize(
    "path",
    ["toto.txt", "README.md", "docs/guide.rst", "LICENSE", "notes/a.MD", "x.adoc"],
)
def test_text_and_docs_are_text_only(path):
    assert is_text_only_path(path)


@pytest.mark.parametrize(
    "path",
    [
        "app.py",
        "src/index.ts",
        "Program.cs",
        "Api.csproj",
        "package.json",
        "appsettings.json",
        "config.yaml",
        "pyproject.toml",
        ".env",
        "Dockerfile",
        "Makefile",
        "run.sh",
        "requirements.txt.lock",
        "web.config",
    ],
)
def test_anything_a_program_reads_is_not(path):
    assert not is_text_only_path(path)


def test_a_text_only_change_is_light():
    scope = classify(["toto.txt"], 1)
    assert scope.is_light
    assert scope.files == ("toto.txt",)


def test_one_code_file_makes_it_full():
    scope = classify(["toto.txt", "src/app.py"], 3)
    assert not scope.is_light
    assert "src/app.py" in scope.reason


def test_an_unknown_change_set_is_full_and_may_touch_code():
    scope = classify(None, 0)
    assert not scope.is_light
    assert scope.touches_code


def test_an_empty_change_set_is_light_and_touches_no_code():
    # A card whose file was already on the base branch: nothing to test.
    # Sent to the full review it met the coverage gate, and the fixer made
    # up test projects (DummyTest.cs, TESTING.md) instead of tutu.txt.
    for scope in (classify([], 0), classify([".workpilot/specs/001/spec.md"], 4)):
        assert scope.is_light
        assert not scope.touches_code
        assert scope.files == ()


def test_touches_code_is_independent_of_the_review_level(monkeypatch):
    assert classify(["src/app.py"], 3).touches_code
    many = [f"doc{i}.md" for i in range(LIGHT_MAX_FILES + 1)]
    assert not classify(many, 10).touches_code
    assert not classify(["a.md"], LIGHT_MAX_CHANGED_LINES + 1).touches_code
    monkeypatch.setenv("WORKPILOT_QA_LIGHT", "0")
    assert not classify(["toto.txt"], 1).touches_code
    assert not classify([], 0).is_light
    assert classify(["src/app.py"], 1).touches_code


def test_large_text_changes_get_the_full_review():
    many = [f"doc{i}.md" for i in range(LIGHT_MAX_FILES + 1)]
    assert not classify(many, 10).is_light
    assert not classify(["a.md"], LIGHT_MAX_CHANGED_LINES + 1).is_light


def test_the_light_review_can_be_turned_off(monkeypatch):
    monkeypatch.setenv("WORKPILOT_QA_LIGHT", "0")
    assert not classify(["toto.txt"], 1).is_light


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.email=qa@test", "-c", "user.name=qa", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
    )


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    _git(tmp_path, "init", "-q", "-b", "main")
    (tmp_path / "app.py").write_text("print('hi')\n", encoding="utf-8")
    (tmp_path / ".gitignore").write_text(".workpilot/\n", encoding="utf-8")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-q", "-m", "init")
    _git(tmp_path, "checkout", "-q", "-b", "task")
    return tmp_path


def test_a_committed_text_file_is_light_and_its_diff_is_shown(repo):
    (repo / "toto.txt").write_text("OK\n", encoding="utf-8")
    _git(repo, "add", "toto.txt")
    _git(repo, "commit", "-q", "-m", "toto")

    scope = change_scope(repo, "main")

    assert scope.is_light
    assert scope.files == ("toto.txt",)
    assert scope.changed_lines == 1
    assert "+OK" in change_diff(repo, scope, 10_000)


def test_untracked_and_uncommitted_changes_count(repo):
    (repo / "toto.txt").write_text("OK\n", encoding="utf-8")
    assert change_scope(repo, "main").is_light
    assert "+OK" in change_diff(repo, change_scope(repo, "main"), 10_000)

    (repo / "app.py").write_text("print('changed')\n", encoding="utf-8")
    scope = change_scope(repo, "main")
    assert not scope.is_light
    assert "app.py" in scope.files


def test_ignored_spec_files_are_not_the_change(repo):
    spec = repo / ".workpilot" / "specs" / "001"
    spec.mkdir(parents=True)
    (spec / "implementation_plan.json").write_text("{}", encoding="utf-8")
    (repo / "toto.txt").write_text("OK\n", encoding="utf-8")

    assert change_scope(repo, "main").files == ("toto.txt",)


def test_no_git_is_full(tmp_path):
    assert not change_scope(tmp_path, "main").is_light


def test_the_diff_is_capped(repo):
    (repo / "big.md").write_text("line\n" * 300, encoding="utf-8")
    scope = change_scope(repo, "main")
    diff = change_diff(repo, scope, 200)
    assert len(diff) < 300
    assert "truncated" in diff


def test_the_light_prompt_inlines_the_spec_and_the_diff(repo):
    from prompts_pkg import get_qa_reviewer_light_prompt, get_qa_reviewer_prompt

    spec_dir = repo / ".workpilot" / "specs" / "001"
    spec_dir.mkdir(parents=True)
    (spec_dir / "spec.md").write_text(
        "# Create toto.txt\n\n## QA Acceptance Criteria\n- toto.txt contains OK\n",
        encoding="utf-8",
    )
    (spec_dir / "implementation_plan.json").write_text("{}", encoding="utf-8")
    (repo / "toto.txt").write_text("OK\n", encoding="utf-8")
    scope = change_scope(repo, "main")

    prompt = get_qa_reviewer_light_prompt(spec_dir, repo, scope)

    assert "toto.txt contains OK" in prompt
    assert "+OK" in prompt
    # The prompt joins with "/" on every OS, as the full QA prompt does.
    assert f"{spec_dir}/implementation_plan.json" in prompt
    assert "Verdict: APPROVED" in prompt
    assert "{{" not in prompt
    # The point of it: a fraction of the full prompt, and no test run asked.
    assert len(prompt) * 4 < len(get_qa_reviewer_prompt(spec_dir, repo))
    assert "--cov" not in prompt


def test_the_full_prompt_scans_only_the_changed_files():
    from prompts_pkg.prompts import _load_prompt_file

    full = _load_prompt_file("qa_reviewer.md")
    security = full[full.index("### 6.1") : full.index("### 6.2")]
    assert "grep -r " not in security
    assert "--name-only" in security


@pytest.mark.parametrize(
    ("files", "eligible"),
    [
        ({"files_to_create": ["toto.txt"]}, False),
        ({"files_to_modify": ["README.md", "docs/a.md"]}, False),
        ({"files_to_create": ["toto.txt", "src/app.py"]}, True),
        ({"files_to_modify": ["src/app.py"]}, True),
        ({}, True),
    ],
)
def test_tdd_skips_subtasks_that_touch_only_text(files, eligible):
    from prompts_pkg.prompt_generator import subtask_is_tdd_eligible

    subtask = {"verification": {"type": "command", "command": "cat toto.txt"}, **files}
    assert subtask_is_tdd_eligible(subtask, {"type": "implementation"}) is eligible


def test_an_unchanged_worktree_is_light(repo):
    scope = change_scope(repo, "main")
    assert scope.is_light
    assert not scope.touches_code
    assert scope.files == ()


def test_the_light_prompt_for_an_empty_change_checks_the_repository(repo):
    from prompts_pkg import get_qa_reviewer_light_prompt

    spec_dir = repo / ".workpilot" / "specs" / "001"
    spec_dir.mkdir(parents=True)
    (spec_dir / "spec.md").write_text(
        "# Create tutu.txt\n\n- tutu.txt contains OK\n", encoding="utf-8"
    )
    (spec_dir / "implementation_plan.json").write_text("{}", encoding="utf-8")

    prompt = get_qa_reviewer_light_prompt(spec_dir, repo, change_scope(repo, "main"))

    assert "tutu.txt contains OK" in prompt
    assert "no file differs from the base branch" in prompt
    assert "If the change is empty" in prompt
    assert "Never ask for tests" in prompt
    assert "{{" not in prompt


def test_the_coverage_gate_skips_change_sets_without_code(monkeypatch, tmp_path):
    from qa import loop

    called = []
    monkeypatch.setattr(
        "qa.coverage_gate.run_coverage_gate",
        lambda spec_dir: called.append(spec_dir) or {"enabled": False},
    )
    many = [f"doc{i}.md" for i in range(LIGHT_MAX_FILES + 1)]
    for scope in (classify([], 0), classify(many, 10)):
        assert loop._coverage_gate(tmp_path, 1, scope) is None
    assert called == []
    loop._coverage_gate(tmp_path, 1, classify(["src/app.py"], 1))
    assert called == [tmp_path]


def test_fix_requests_forbid_placeholder_tests():
    from prompts_pkg.prompts import _load_prompt_file
    from qa.coverage_gate import evaluate_coverage, render_coverage_fix_request

    assert "placeholder test" in _load_prompt_file("qa_fixer.md")
    assert "this task changed" in _load_prompt_file("qa_reviewer.md")
    request = render_coverage_fix_request(evaluate_coverage({}, 100))
    assert "test factice" in request
