"""The coder's subtask prompt and the planner's, section by section (`prompts_pkg.prompt_generator`).

The plan's subtask and phase are what the planner writes; the sections other
packages add (worktree setup, learning loop, automatic tests) are replaced
only where a test is about them.
"""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest
from prompts_pkg import prompt_generator as pg

PHASE = {"id": "p1", "name": "Backend"}


@pytest.fixture(autouse=True)
def _classic_flow(monkeypatch):
    monkeypatch.delenv("TDD_MODE", raising=False)
    monkeypatch.delenv("AUTO_TEST_GENERATION", raising=False)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / ".workpilot" / "specs" / "001-x").mkdir(parents=True)
    return tmp_path


@pytest.fixture
def spec_dir(project: Path) -> Path:
    return project / ".workpilot" / "specs" / "001-x"


def _prompt(spec_dir: Path, project: Path, subtask: dict, **kwargs) -> str:
    return pg.generate_subtask_prompt(spec_dir, project, subtask, PHASE, **kwargs)


# --- paths -------------------------------------------------------------------------


def test_a_spec_outside_the_project_is_named_where_the_worktree_copy_lives(tmp_path):
    spec = tmp_path / "main" / ".workpilot" / "specs" / "004-y"

    assert (
        pg.get_relative_spec_path(spec, tmp_path / "wt") == "./.workpilot/specs/004-y"
    )


def test_a_worktree_at_the_root_of_a_drive_has_the_drive_as_parent():
    root = Path(Path.cwd().anchor)

    is_worktree, parent = pg.detect_worktree_isolation(
        root / ".workpilot" / "worktrees" / "tasks" / "001"
    )

    assert is_worktree is True
    assert parent == root


# --- subtask fields ------------------------------------------------------------------


def test_retries_ask_for_another_approach_with_what_was_learned(spec_dir, project):
    prompt = _prompt(
        spec_dir,
        project,
        {"id": "1", "description": "d"},
        attempt_count=2,
        recovery_hints=["the import path was wrong", "tests need the fixture"],
    )

    assert "## ⚠️ RETRY ATTEMPT (3)" in prompt
    assert "attempted 2 time(s)" in prompt
    assert "- the import path was wrong\n- tests need the fixture" in prompt


def test_a_retry_without_hints_has_no_insight_list(spec_dir, project):
    prompt = _prompt(spec_dir, project, {"id": "1"}, attempt_count=1)

    assert "## ⚠️ RETRY ATTEMPT (2)" in prompt
    assert "Previous attempt insights" not in prompt


def test_the_files_of_the_subtask_are_listed(spec_dir, project):
    prompt = _prompt(
        spec_dir,
        project,
        {
            "id": "1",
            "files_to_modify": ["src/a.py"],
            "files_to_create": ["src/b.py"],
            "patterns_from": ["src/style.py"],
        },
    )

    assert "**Files to Modify:**\n- `src/a.py`" in prompt
    assert "**Files to Create:**\n- `src/b.py`" in prompt
    assert "**Pattern Files (study these first):**\n- `src/style.py`" in prompt


def test_null_or_bare_fields_from_the_planner_do_not_break_the_prompt(
    spec_dir, project
):
    prompt = _prompt(
        spec_dir,
        project,
        {
            "id": "1",
            "files_to_modify": "src/a.py",
            "files_to_create": None,
            "patterns_from": "",
            "verification": None,
        },
    )

    assert "**Files to Modify:**\n- `src/a.py`" in prompt
    assert "Files to Create" not in prompt and "Pattern Files" not in prompt
    assert "Check that the subtask's description is met." in prompt


# --- verification ------------------------------------------------------------------


def test_an_api_check_is_a_curl_with_its_body(spec_dir, project):
    prompt = _prompt(
        spec_dir,
        project,
        {
            "id": "1",
            "verification": {
                "type": "api",
                "method": "POST",
                "url": "http://localhost:8000/carts",
                "body": {"sku": "A1"},
                "expected_status": 201,
            },
        },
    )

    assert (
        'curl -X POST http://localhost:8000/carts -H "Content-Type: application/json" '
        '-d \'{"sku": "A1"}\''
    ) in prompt
    assert "Expected status: 201" in prompt


def test_an_api_check_without_a_body_sends_none(spec_dir, project):
    prompt = _prompt(spec_dir, project, {"id": "1", "verification": {"type": "api"}})

    assert (
        'curl -X GET http://localhost -H "Content-Type: application/json" \n' in prompt
    )
    assert "Expected status: 200" in prompt


def test_a_browser_check_lists_what_to_look_at(spec_dir, project):
    prompt = _prompt(
        spec_dir,
        project,
        {
            "id": "1",
            "verification": {
                "type": "browser",
                "url": "http://localhost:5173/cart",
                "checks": ["the total shows", "the button is enabled"],
            },
        },
    )

    assert "Open in browser: http://localhost:5173/cart" in prompt
    assert "- [ ] the total shows\n- [ ] the button is enabled" in prompt


def test_an_end_to_end_check_numbers_its_steps(spec_dir, project):
    prompt = _prompt(
        spec_dir,
        project,
        {"id": "1", "verification": {"type": "e2e", "steps": ["add an item", "pay"]}},
    )

    assert "End-to-end verification steps:\n1. add an item\n2. pay" in prompt


# --- sections from other packages ----------------------------------------------------


def test_the_worktree_setup_reaches_the_coder(spec_dir, project, monkeypatch):
    recipe = importlib.import_module("core.workspace.recipe_run")
    monkeypatch.setattr(
        recipe, "setup_prompt_section", lambda _wt: "## Setup\nports 4100"
    )

    assert "## Setup\nports 4100" in _prompt(spec_dir, project, {"id": "1"})


def test_the_automatic_tests_of_the_touched_files_reach_the_coder(
    spec_dir, project, monkeypatch
):
    seen = []

    def plan(project_dir, files):
        seen.append((project_dir, files))
        return "## Automatic tests\nadd an API contract test"

    monkeypatch.setattr(pg, "build_auto_test_instructions", plan)

    prompt = _prompt(
        spec_dir,
        project,
        {"id": "1", "files_to_modify": ["a.cs"], "files_to_create": ["b.cs"]},
    )

    assert "## Automatic tests\nadd an API contract test" in prompt
    assert seen == [(project, ["a.cs", "b.cs"])]


def test_automatic_tests_can_be_turned_off(spec_dir, project, monkeypatch):
    monkeypatch.setenv("AUTO_TEST_GENERATION", "False")
    monkeypatch.setattr(pg, "build_auto_test_instructions", lambda *_a: "AUTO")

    assert "AUTO" not in _prompt(spec_dir, project, {"id": "1"})


def test_a_failing_test_planner_is_left_out(spec_dir, project, monkeypatch):
    def broken(*_args):
        raise RuntimeError("no stack")

    monkeypatch.setattr(pg, "build_auto_test_instructions", broken)

    assert "## Verification" in _prompt(spec_dir, project, {"id": "1"})


@pytest.mark.parametrize("phase", ["coding", "planning"])
def test_what_earlier_builds_taught_reaches_both_prompts(
    spec_dir, project, monkeypatch, phase
):
    injection = importlib.import_module("learning_loop.prompt_injection")
    calls = []

    def lesson(project_dir, which, spec_dir=None):
        calls.append(which)
        return f"## Lessons for {which}"

    monkeypatch.setattr(injection, "get_learning_context", lesson)

    if phase == "coding":
        prompt = _prompt(spec_dir, project, {"id": "1"})
    else:
        prompt = pg.generate_planner_prompt(spec_dir, project)

    assert f"## Lessons for {phase}" in prompt
    assert calls == [phase]


@pytest.mark.parametrize("phase", ["coding", "planning"])
def test_a_failing_learning_loop_is_left_out(spec_dir, project, monkeypatch, phase):
    injection = importlib.import_module("learning_loop.prompt_injection")

    def broken(*_args, **_kwargs):
        raise RuntimeError("vault offline")

    monkeypatch.setattr(injection, "get_learning_context", broken)

    if phase == "coding":
        assert "## Instructions" in _prompt(spec_dir, project, {"id": "1"})
    else:
        assert "## SPEC LOCATION" in pg.generate_planner_prompt(spec_dir, project)


def test_a_failing_dotnet_probe_leaves_the_environment_section(
    spec_dir, project, monkeypatch
):
    def broken(_dir):
        raise OSError("no dotnet")

    monkeypatch.setattr(pg, "generate_dotnet_env_section", broken)

    assert "## YOUR ENVIRONMENT" in pg.generate_environment_context(project, spec_dir)


# --- planner -----------------------------------------------------------------------


def test_the_planner_infers_the_project_from_the_spec_folder(spec_dir, project):
    prompt = pg.generate_planner_prompt(spec_dir)

    assert f"**Working Directory:** `{project}`" in prompt
    assert "`./.workpilot/specs/001-x/spec.md`" in prompt


def test_without_its_prompt_file_the_planner_still_gets_its_task(
    spec_dir, project, monkeypatch, tmp_path
):
    monkeypatch.setattr(pg, "PLANNER_PROMPT_FILE", tmp_path / "gone.md")

    prompt = pg.generate_planner_prompt(spec_dir, project)

    assert prompt.endswith(
        "Read spec.md and create implementation_plan.json with phases and subtasks."
    )
