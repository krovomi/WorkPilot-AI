"""The phase prompts as the agents receive them (`prompts_pkg/prompts.py`).

Real prompt files from `apps/backend/prompts/`, real spec folders. Only the
optional sections from other packages are replaced, where a test is about
what happens when one of them fails or has something to say.
"""

from __future__ import annotations

import importlib
import json
import shutil
import sys
from pathlib import Path

import pytest
from foundation.change_scope import ChangeScope
from prompts_pkg import prompts

MARKER = "<!-- PROJECT-SPECIFIC VALIDATION TOOLS WILL BE INJECTED HERE -->"


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / ".workpilot" / "specs" / "001-x").mkdir(parents=True)
    return tmp_path


@pytest.fixture
def spec_dir(project: Path) -> Path:
    return project / ".workpilot" / "specs" / "001-x"


def _index(project: Path, services: dict) -> None:
    (project / ".workpilot" / "project_index.json").write_text(
        json.dumps({"services": services}), encoding="utf-8"
    )


def _prompts_copy(tmp_path: Path, monkeypatch, edit=None) -> Path:
    """A copy of the prompt folder the module reads, edited by the test."""
    copy = tmp_path / "prompts-copy"
    shutil.copytree(prompts.PROMPTS_DIR, copy)
    if edit:
        edit(copy)
    monkeypatch.setattr(prompts, "PROMPTS_DIR", copy)
    return copy


# --- planners -------------------------------------------------------------------


def test_the_planner_is_told_where_the_spec_and_the_project_are(spec_dir, monkeypatch):
    monkeypatch.setenv("WORKPILOT_QA_MIN_COVERAGE", "85")

    prompt = prompts.get_planner_prompt(spec_dir)

    assert f"`{spec_dir}/spec.md`" in prompt
    assert f"`{spec_dir}/implementation_plan.json`" in prompt
    assert "parent of `.workpilot/`" in prompt
    assert "{{MIN_COVERAGE}}" not in prompt
    assert "auto-claude" not in prompt


def test_the_follow_up_planner_reads_the_request_first(spec_dir):
    prompt = prompts.get_followup_planner_prompt(spec_dir)

    assert f"`{spec_dir}/FOLLOWUP_REQUEST.md` (READ THIS FIRST!)" in prompt
    assert "Parent of `.workpilot/`" in prompt


@pytest.mark.parametrize(
    ("loader", "name"),
    [
        (prompts.get_planner_prompt, "planner.md"),
        (prompts.get_followup_planner_prompt, "followup_planner.md"),
    ],
)
def test_a_missing_planner_prompt_is_named(
    tmp_path, spec_dir, monkeypatch, loader, name
):
    _prompts_copy(tmp_path, monkeypatch, lambda copy: (copy / name).unlink())

    with pytest.raises(FileNotFoundError, match=name):
        loader(spec_dir)


def test_a_missing_prompt_file_is_named(tmp_path, monkeypatch):
    _prompts_copy(tmp_path, monkeypatch, lambda copy: (copy / "qa_fixer.md").unlink())

    with pytest.raises(FileNotFoundError, match="qa_fixer.md"):
        prompts._load_prompt_file("qa_fixer.md")


# --- first run ---------------------------------------------------------------------


def _plan(spec_dir: Path, content) -> None:
    text = content if isinstance(content, str) else json.dumps(content)
    (spec_dir / "implementation_plan.json").write_text(text, encoding="utf-8")


@pytest.mark.parametrize(
    "plan",
    [
        None,
        "{broken",
        [1, 2],
        {},
        {"phases": []},
        {"phases": "one"},
        {"phases": [{"subtasks": []}, "phase", {"subtasks": None}, {"subtasks": "s"}]},
    ],
)
def test_a_plan_without_a_subtask_is_a_first_run(spec_dir, plan):
    if plan is not None:
        _plan(spec_dir, plan)

    assert prompts.is_first_run(spec_dir) is True


def test_a_plan_that_is_not_utf8_is_a_first_run(spec_dir):
    (spec_dir / "implementation_plan.json").write_bytes(b"\xff\xfe{")

    assert prompts.is_first_run(spec_dir) is True


def test_a_plan_with_a_subtask_is_a_resume(spec_dir):
    _plan(spec_dir, {"phases": [{"subtasks": []}, {"subtasks": [{"id": "1"}]}]})

    assert prompts.is_first_run(spec_dir) is False


# --- coverage threshold ---------------------------------------------------------------


def test_the_threshold_follows_the_setting(monkeypatch):
    monkeypatch.setenv("WORKPILOT_QA_MIN_COVERAGE", "70")

    assert prompts._min_coverage() == 70


def test_without_the_qa_package_the_threshold_stays_at_100(monkeypatch):
    monkeypatch.setitem(sys.modules, "qa.coverage_gate", None)

    assert prompts._min_coverage() == 100


# --- optional sections --------------------------------------------------------------


@pytest.mark.parametrize(
    ("module", "attr", "call"),
    [
        (
            "project.spec_kit",
            "format_constitution_for_prompt",
            lambda p, s: prompts.constitution_section(p),
        ),
        ("mobile", "mobile_section", lambda p, s: prompts.mobile_section(p)),
        ("docintel", "docintel_section", lambda p, s: prompts.docintel_section(p, s)),
        ("uiux", "uiux_section", lambda p, s: prompts.uiux_section(s)),
        ("verify.prompt", "verify_section", lambda p, s: prompts.verify_section(s)),
        (
            "workflows.handoff",
            "handoff_section",
            lambda p, s: prompts.workflow_reports_section(s, "qa"),
        ),
    ],
)
def test_a_failing_section_is_left_out_and_the_phase_goes_on(
    project, spec_dir, monkeypatch, module, attr, call
):
    def broken(*_args, **_kwargs):
        raise RuntimeError("section broke")

    monkeypatch.setattr(importlib.import_module(module), attr, broken)

    assert call(project, spec_dir) == ""


def test_the_platform_section_joins_what_applies(project, monkeypatch):
    monkeypatch.setattr(prompts, "mobile_section", lambda _p: "PHONE")
    monkeypatch.setattr(prompts, "windev_section", lambda *_a, **_k: "")

    assert prompts.platform_section(project) == "PHONE"

    monkeypatch.setattr(prompts, "windev_section", lambda *_a, **_k: "WINDEV")

    assert prompts.platform_section(project) == "PHONE\n\nWINDEV"


# --- QA reviewer --------------------------------------------------------------------


def test_a_plain_project_gets_standard_validation(project, spec_dir):
    prompt = prompts.get_qa_reviewer_prompt(spec_dir, project)

    assert "No special project capabilities detected" in prompt
    assert "## PROJECT-SPECIFIC VALIDATION TOOLS" not in prompt
    assert MARKER in prompt
    assert "{{SPEC_DIR}}" not in prompt and "{{BASE_BRANCH}}" not in prompt


def test_the_tool_docs_of_the_project_replace_the_marker_block(project, spec_dir):
    _index(project, {"api": {"framework": "react", "api": {"routes": ["/a"]}}})

    prompt = prompts.get_qa_reviewer_prompt(spec_dir, project)

    assert "- Web Frontend\n" in prompt and "- Api\n" in prompt
    assert "## PROJECT-SPECIFIC VALIDATION TOOLS" in prompt
    assert MARKER not in prompt
    assert "<!-- - API validation (for projects with API endpoints) -->" not in prompt
    # The docs' shell and regex examples keep their backslashes.
    assert r'grep -r "router\.\(get\|post\|put\|delete\)"' in prompt
    assert "querySelector('[data-testid=\\\"feature\\\"]')" in prompt


def test_a_marker_without_its_closing_line_is_still_replaced(
    tmp_path, project, spec_dir, monkeypatch
):
    def cut_the_block(copy: Path) -> None:
        reviewer = copy / "qa_reviewer.md"
        text = reviewer.read_text(encoding="utf-8")
        reviewer.write_text(
            text.replace(
                "<!-- - API validation (for projects with API endpoints) -->", ""
            ),
            encoding="utf-8",
        )

    _prompts_copy(tmp_path, monkeypatch, cut_the_block)
    _index(project, {"db": {"database": "postgres"}})

    prompt = prompts.get_qa_reviewer_prompt(spec_dir, project)

    assert MARKER not in prompt
    assert prompt.count("## PROJECT-SPECIFIC VALIDATION TOOLS") == 1
    assert prompt.index("## PROJECT-SPECIFIC VALIDATION TOOLS") < prompt.rindex(
        "## DATABASE"
    )


def test_without_a_marker_the_tool_docs_are_appended(
    tmp_path, project, spec_dir, monkeypatch
):
    def drop_the_marker(copy: Path) -> None:
        reviewer = copy / "qa_reviewer.md"
        reviewer.write_text(
            reviewer.read_text(encoding="utf-8").replace(MARKER, ""), encoding="utf-8"
        )

    _prompts_copy(tmp_path, monkeypatch, drop_the_marker)
    _index(project, {"db": {"dependencies": ["prisma"]}})

    prompt = prompts.get_qa_reviewer_prompt(spec_dir, project)

    tail = prompt[prompt.rindex("## PROJECT-SPECIFIC VALIDATION TOOLS") :]
    assert "DATABASE" in tail.upper()


def test_a_missing_tool_doc_is_skipped(tmp_path, project, spec_dir, monkeypatch):
    _prompts_copy(
        tmp_path,
        monkeypatch,
        lambda copy: (copy / "mcp_tools" / "database_validation.md").unlink(),
    )
    _index(project, {"db": {"database": "postgres"}})

    prompt = prompts.get_qa_reviewer_prompt(spec_dir, project)

    assert "Has Database" not in prompt  # capability names lose their prefix
    assert "- Database\n" in prompt
    assert "## PROJECT-SPECIFIC VALIDATION TOOLS" not in prompt


def test_every_section_with_something_to_say_reaches_the_reviewer(
    project, spec_dir, monkeypatch
):
    for name in (
        "constitution_section",
        "platform_section",
        "dotnet_section",
        "docintel_section",
        "uiux_section",
        "workflow_reports_section",
        "verify_section",
    ):
        monkeypatch.setattr(prompts, name, lambda *_a, _n=name, **_k: f"<<{_n}>>")

    prompt = prompts.get_qa_reviewer_prompt(spec_dir, project)

    found = [
        prompt.index(f"<<{n}>>")
        for n in (
            "constitution_section",
            "platform_section",
            "dotnet_section",
            "docintel_section",
            "uiux_section",
            "workflow_reports_section",
            "verify_section",
        )
    ]
    assert found == sorted(found)
    assert found[0] > prompt.index("## PROJECT CAPABILITIES DETECTED")


# --- light review -------------------------------------------------------------------


def test_the_light_review_inlines_a_long_spec_and_says_where_the_rest_is(
    project, spec_dir
):
    (spec_dir / "spec.md").write_text(
        "S" * (prompts.LIGHT_QA_SPEC_MAX_CHARS + 50), encoding="utf-8"
    )
    (spec_dir / "requirements.json").write_text(
        json.dumps({"task_description": 42}), encoding="utf-8"
    )

    prompt = prompts.get_qa_reviewer_light_prompt(
        spec_dir, project, ChangeScope("light", "docs only")
    )

    assert "S" * prompts.LIGHT_QA_SPEC_MAX_CHARS in prompt
    assert "S" * (prompts.LIGHT_QA_SPEC_MAX_CHARS + 1) not in prompt
    assert f"[... truncated: read `{spec_dir}/spec.md` for the rest ...]" in prompt
    assert "(not recorded)" in prompt
    assert "### If the change is empty" in prompt


def test_the_light_review_says_when_the_spec_cannot_be_read(project, spec_dir):
    (spec_dir / "spec.md").mkdir()  # reading a folder fails
    (spec_dir / "requirements.json").write_text("[1]", encoding="utf-8")

    prompt = prompts.get_qa_reviewer_light_prompt(
        spec_dir, project, ChangeScope("light", "docs only")
    )

    assert f"(spec.md not readable — read `{spec_dir}/spec.md`)" in prompt
    assert "(not recorded)" in prompt


def test_the_light_review_keeps_the_request_from_closing_its_fence(project, spec_dir):
    (spec_dir / "spec.md").write_text("Spec {{FILES}}", encoding="utf-8")
    (spec_dir / "requirements.json").write_text(
        json.dumps({"task_description": "  fix ``` and {{DIFF}}  "}), encoding="utf-8"
    )

    prompt = prompts.get_qa_reviewer_light_prompt(
        spec_dir, project, ChangeScope("light", "docs only")
    )

    assert "fix ``​` and { {DIFF}}" in prompt
    assert "Spec { {FILES}}" in prompt


# --- QA fixer -----------------------------------------------------------------------


def test_the_fixer_reads_the_fix_request_first(project, spec_dir, monkeypatch):
    monkeypatch.setenv("WORKPILOT_QA_MIN_COVERAGE", "90")

    prompt = prompts.get_qa_fixer_prompt(spec_dir, project)

    assert f"`{spec_dir}/QA_FIX_REQUEST.md` (READ THIS FIRST!)" in prompt
    assert "{{SPEC_DIR}}" not in prompt and "{{MIN_COVERAGE}}" not in prompt


def test_the_fixer_gets_the_verification_and_the_windev_rules(
    project, spec_dir, monkeypatch
):
    monkeypatch.setattr(prompts, "verify_section", lambda _s: "<<verify>>")
    monkeypatch.setattr(prompts, "windev_section", lambda *_a, **_k: "<<windev>>")

    prompt = prompts.get_qa_fixer_prompt(spec_dir, project)

    assert prompt.index("<<verify>>") < prompt.index("<<windev>>")


# --- targeted review ----------------------------------------------------------------


def test_the_targeted_review_shows_how_to_run_each_ecosystem_tests(project, spec_dir):
    scope = ChangeScope(
        "targeted",
        "two files",
        files=("src/cart.ts", "Shop/Cart.cs"),
        tests=("src/cart.test.ts", "Shop.Tests/CartTests.cs"),
        test_map=(
            ("src/cart.ts", ("src/cart.test.ts",)),
            ("Shop/Cart.cs", ("Shop.Tests/CartTests.cs",)),
        ),
    )

    prompt = prompts.get_qa_reviewer_targeted_prompt(spec_dir, project, scope)

    assert "npx vitest run src/cart.test.ts --coverage" in prompt
    assert "FullyQualifiedName~CartTests" in prompt
    assert "- `src/cart.ts` → `src/cart.test.ts`" in prompt
    assert "(diff unavailable — read the changed files)" in prompt


def test_the_targeted_review_without_a_known_runner_says_so(project, spec_dir):
    scope = ChangeScope("targeted", "one file", files=("a.cob",), tests=("a_test.cob",))

    prompt = prompts.get_qa_reviewer_targeted_prompt(spec_dir, project, scope)

    assert "<the project's runner> <tests>" in prompt


def test_the_full_review_runs_the_touched_tests_before_any_long_suite(
    project, spec_dir
):
    prompt = prompts.get_qa_reviewer_prompt(spec_dir, project)

    touched = prompt.index("### 3.0: Touched Tests First (fail fast)")
    assert touched < prompt.index("### 3.1: Unit Tests") < prompt.index("### 7.1:")
    # Every stack gets its own selection, not one tool's.
    for selection in (
        "vitest related",
        "--findRelatedTests",
        "pytest",
        "go test",
        "cargo test",
        "dotnet test",
        "mvn",
    ):
        assert selection in prompt[touched:], selection
    assert "skip 3.1 to 3.4 and Phase 7.1" in prompt
