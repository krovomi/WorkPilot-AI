"""The targeted QA tier, between the light review and the full one.

A small code change (at most `TARGETED_MAX_CODE_FILES` code files and
`TARGETED_MAX_CHANGED_LINES` changed lines in them) whose every touched file
has a test the conventions point to runs only those tests, with coverage of
the touched files and no subagent roster. These tests pin the boundaries, the
fallbacks to the full review (any doubt), the test mapping, and the gate that
never lets the tier approve a task whose tests did not run.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from foundation.change_scope import (
    TARGETED_MAX_CHANGED_LINES,
    TARGETED_MAX_CODE_FILES,
    ChangeScope,
    change_scope,
    classify,
    is_text_only_path,
    targeted_blocker,
)
from foundation.touched_tests import is_test_file, map_tests, tests_for

REPO = [
    "src/calc.py",
    "src/util.py",
    "src/core/engine.py",
    "tests/test_calc.py",
    "tests/unit/core/test_engine.py",
    "src/util_test.py",
    "web/src/a.ts",
    "web/src/b.tsx",
    "web/src/c.ts",
    "web/src/d.ts",
    "web/src/a.test.ts",
    "web/src/b.spec.tsx",
    "web/src/__tests__/c.ts",
    "web/__tests__/d.test.ts",
    "other/tests/test_lonely.py",
    "src/lonely.py",
    "src/nothing.py",
    "README.md",
]


def _classify(files, lines=10, code_lines=None, repo=REPO, doubtful=None):
    return classify(
        files,
        lines,
        code_lines=code_lines,
        repo_files=list(repo) if repo is not None else None,
        doubtful=doubtful,
    )


# --- tier selection boundaries ---------------------------------------------


def test_thresholds_are_named_constants():
    assert TARGETED_MAX_CODE_FILES == 3
    assert TARGETED_MAX_CHANGED_LINES == 150


def test_three_code_files_are_targeted_four_are_full():
    three = ["src/calc.py", "src/core/engine.py", "web/src/a.ts"]
    scope = _classify(three, 30)
    assert scope.is_targeted
    assert scope.touches_code
    assert scope.tests == (
        "tests/test_calc.py",
        "tests/unit/core/test_engine.py",
        "web/src/a.test.ts",
    )
    four = [*three, "web/src/b.tsx"]
    scope = _classify(four, 30)
    assert scope.is_full
    assert "4 code files > 3" in scope.reason


def test_150_changed_code_lines_are_targeted_151_are_full():
    assert _classify(["src/calc.py"], TARGETED_MAX_CHANGED_LINES).is_targeted
    scope = _classify(["src/calc.py"], TARGETED_MAX_CHANGED_LINES + 1)
    assert scope.is_full
    assert "151 changed code lines > 150" in scope.reason


def test_text_files_alongside_do_not_count():
    docs = [f"docs/page{i}.md" for i in range(8)]
    scope = _classify(
        ["src/calc.py", *docs], 900, code_lines=TARGETED_MAX_CHANGED_LINES
    )
    assert scope.is_targeted
    assert scope.code_files == ("src/calc.py",)
    assert scope.tests == ("tests/test_calc.py",)


def test_text_only_changes_stay_light():
    assert _classify(["README.md"], 3).is_light


# --- fallbacks to the full review --------------------------------------------


def test_a_code_file_without_a_test_falls_back_to_full():
    scope = _classify(["src/calc.py", "src/nothing.py"])
    assert scope.is_full
    assert "no test found for src/nothing.py" in scope.reason
    assert scope.tests == ()


def test_a_test_in_an_unrelated_directory_does_not_count():
    # other/tests/ is not at the level of src/lonely.py nor above it.
    assert _classify(["src/lonely.py"]).is_full


@pytest.mark.parametrize(
    "path",
    [
        "src/Program.cs",
        "config.yaml",
        "package.json",
        "pnpm-lock.yaml",
        "pyproject.toml",
        "poetry.lock",
        "requirements.txt",
        "requirements-dev.txt",
        "apps/backend/security/hooks.py",
        "apps/backend/server/auth/jwt.py",
        "apps/backend/server/authz/policy.py",
        ".github/scripts/check.js",
        "dist/bundle.js",
        "web/src/types.d.ts",
        "web/vendor/lib.js",
        "proto/api_pb2.py",
        "web/src/api.generated.ts",
        "tests/conftest.py",
        "setup.py",
        "web/vite.config.ts",
        "web/.eslintrc.js",
    ],
)
def test_doubtful_files_fall_back_to_full(path):
    repo = [*REPO, path, "tests/test_hooks.py", "tests/test_jwt.py"]
    scope = _classify([path], 5, repo=repo)
    assert scope.is_full
    assert scope.touches_code


def test_blocker_reasons_name_the_file():
    assert "security-sensitive" in targeted_blocker("apps/backend/security/x.py")
    assert "security-sensitive" in targeted_blocker("server/auth_tokens/x.ts")
    assert "CI" in targeted_blocker(".github/actions/run.js")
    assert "generated" in targeted_blocker("web/dist/a.js")
    assert "configuration" in targeted_blocker("tests/conftest.py")
    assert "file type" in targeted_blocker("pom.xml")
    assert "configuration" in targeted_blocker("src/Program.cs")
    assert targeted_blocker("src/calc.py") is None
    assert targeted_blocker("main.go") is None  # Go has a known test convention


def test_requirements_files_are_not_text_only():
    assert not is_text_only_path("requirements.txt")
    assert not is_text_only_path("constraints-dev.txt")
    assert is_text_only_path("notes.txt")


def test_deleted_or_generated_files_reported_by_the_disk_fall_back():
    for why in ("src/calc.py: deleted or renamed", "src/calc.py: generated file"):
        scope = _classify(["src/calc.py"], doubtful={"src/calc.py": why})
        assert scope.is_full
        assert why in scope.reason


@pytest.mark.parametrize(
    "path", ["src/a b.py", "src/x;curl evil.py", "src/$(id).py", "src/it's.py"]
)
def test_paths_a_shell_would_interpret_fall_back_to_full(path):
    stem = Path(path).stem
    scope = _classify([path], repo=[*REPO, path, f"tests/test_{stem}.py"])
    assert scope.is_full
    assert "characters a command line would interpret" in scope.reason


def test_a_mapped_test_with_shell_characters_falls_back_to_full():
    scope = _classify(["src/calc.py"], repo=["src/calc.py", "tests/x y/test_calc.py"])
    assert scope.is_full


def test_unknown_repository_file_list_is_full():
    assert _classify(["src/calc.py"], repo=None).is_full
    assert classify(None, 0).is_full


def test_the_kill_switches(monkeypatch):
    monkeypatch.setenv("WORKPILOT_QA_TARGETED", "0")
    scope = _classify(["src/calc.py"])
    assert scope.is_full
    assert "WORKPILOT_QA_TARGETED=0" in scope.reason
    monkeypatch.delenv("WORKPILOT_QA_TARGETED")
    monkeypatch.setenv("WORKPILOT_QA_LIGHT", "0")
    assert _classify(["src/calc.py"]).is_full


# --- test mapping --------------------------------------------------------------


@pytest.mark.parametrize(
    ("source", "tests"),
    [
        ("src/calc.py", ("tests/test_calc.py",)),
        ("src/util.py", ("src/util_test.py",)),
        ("src/core/engine.py", ("tests/unit/core/test_engine.py",)),
        ("web/src/a.ts", ("web/src/a.test.ts",)),
        ("web/src/b.tsx", ("web/src/b.spec.tsx",)),
        ("web/src/c.ts", ("web/src/__tests__/c.ts",)),
        ("web/src/d.ts", ("web/__tests__/d.test.ts",)),
        ("tests/test_calc.py", ("tests/test_calc.py",)),
        ("web/src/a.test.ts", ("web/src/a.test.ts",)),
        ("src/nothing.py", ()),
        ("README.md", ()),
    ],
)
def test_sources_map_to_their_tests_by_convention(source, tests):
    assert tests_for(source, REPO) == tests


def test_conftest_is_not_a_test_and_tests_are_recognised():
    assert not is_test_file("tests/conftest.py")
    assert is_test_file("tests/test_x.py")
    assert is_test_file("pkg/x_test.py")
    assert is_test_file("web/x.spec.ts")
    assert is_test_file("web/__tests__/x.tsx")
    assert not is_test_file("web/x.ts")


def test_map_tests_reports_the_unmapped_files():
    mapping, unmapped = map_tests(["src/calc.py", "src/nothing.py"], REPO)
    assert mapping == {"src/calc.py": ("tests/test_calc.py",)}
    assert unmapped == ["src/nothing.py"]


def test_windows_separators_are_normalised():
    assert tests_for("src\\calc.py", ["tests\\test_calc.py"]) == ("tests/test_calc.py",)


# --- from git ------------------------------------------------------------------


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
    (tmp_path / "src").mkdir()
    (tmp_path / "tests").mkdir()
    (tmp_path / "src" / "calc.py").write_text(
        "def add(a, b):\n    return a + b\n", encoding="utf-8"
    )
    (tmp_path / "tests" / "test_calc.py").write_text(
        "from src.calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n",
        encoding="utf-8",
    )
    (tmp_path / ".gitignore").write_text(".workpilot/\n", encoding="utf-8")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-q", "-m", "init")
    _git(tmp_path, "checkout", "-q", "-b", "task")
    return tmp_path


def test_a_small_committed_code_change_is_targeted(repo):
    (repo / "src" / "calc.py").write_text(
        "def add(a, b):\n    return b + a\n", encoding="utf-8"
    )
    (repo / "NOTES.md").write_text("why\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "change")

    scope = change_scope(repo, "main")

    assert scope.is_targeted, scope.reason
    assert scope.tests == ("tests/test_calc.py",)
    assert scope.test_map == (("src/calc.py", ("tests/test_calc.py",)),)
    assert scope.changed_lines == 3


def test_a_new_untracked_test_maps_to_itself(repo):
    (repo / "tests" / "test_more.py").write_text(
        "def test_x():\n    assert 1\n", encoding="utf-8"
    )
    scope = change_scope(repo, "main")
    assert scope.is_targeted
    assert scope.tests == ("tests/test_more.py",)


def test_a_deleted_test_falls_back_to_full(repo):
    (repo / "tests" / "test_calc.py").unlink()
    scope = change_scope(repo, "main")
    assert scope.is_full
    assert "deleted" in scope.reason


def test_a_generated_header_falls_back_to_full(repo):
    (repo / "src" / "calc.py").write_text(
        "# @generated by protoc. DO NOT EDIT.\ndef add(a, b):\n    return a + b\n",
        encoding="utf-8",
    )
    scope = change_scope(repo, "main")
    assert scope.is_full
    assert "generated" in scope.reason


def test_a_large_change_measured_by_git_is_full(repo):
    body = "".join(f"X{i} = {i}\n" for i in range(TARGETED_MAX_CHANGED_LINES + 1))
    (repo / "src" / "calc.py").write_text(body, encoding="utf-8")
    assert change_scope(repo, "main").is_full


# --- prompt and agent configuration ------------------------------------------


def _spec(repo: Path) -> Path:
    spec_dir = repo / ".workpilot" / "specs" / "001"
    spec_dir.mkdir(parents=True)
    (spec_dir / "spec.md").write_text(
        "# Swap add\n\n## QA Acceptance Criteria\n- add stays correct\n",
        encoding="utf-8",
    )
    (spec_dir / "implementation_plan.json").write_text("{}", encoding="utf-8")
    return spec_dir


def test_the_targeted_prompt_names_the_tests_and_has_no_subagents(repo):
    from prompts_pkg import get_qa_reviewer_prompt, get_qa_reviewer_targeted_prompt

    (repo / "src" / "calc.py").write_text(
        "def add(a, b):\n    return b + a\n", encoding="utf-8"
    )
    spec_dir = _spec(repo)
    scope = change_scope(repo, "main")

    prompt = get_qa_reviewer_targeted_prompt(spec_dir, repo, scope)

    assert "TARGETED QA" in prompt
    assert "`src/calc.py` → `tests/test_calc.py`" in prompt
    assert "pytest tests/test_calc.py --cov" in prompt
    assert "add stays correct" in prompt
    assert "+    return b + a" in prompt
    assert '"review_scope": "targeted"' in prompt
    assert "targeted_tests" in prompt
    assert "no subagents in this pass" in prompt
    assert "Verdict: APPROVED" in prompt
    assert "{{" not in prompt
    assert len(prompt) * 2 < len(get_qa_reviewer_prompt(spec_dir, repo))


def test_the_targeted_reviewer_gets_no_subagent_roster(monkeypatch, tmp_path):
    from qa import loop

    targeted = _classify(["src/calc.py"])
    assert targeted.is_targeted
    seen: dict = {}

    def fake_client(**kwargs):
        seen.update(kwargs)
        raise RuntimeError("stop here")

    monkeypatch.setattr(loop, "_review_scope", lambda scope: targeted)
    monkeypatch.setattr(loop, "get_phase_thinking_budget", lambda *a, **k: None)
    monkeypatch.setattr(loop, "get_phase_provider", lambda *a, **k: "openai")
    monkeypatch.setattr(loop, "create_agent_client", fake_client)
    scope = SimpleNamespace(
        spec_dir=tmp_path, project_dir=tmp_path, emitter=SimpleNamespace(emit=print)
    )
    state = loop._QaState(qa_iteration=1)

    result = asyncio.run(loop._run_reviewer(scope, state, "any-model", ""))

    assert result is loop._Next.FAILED
    assert seen["agent_type"] == "qa_reviewer"
    assert seen["use_subagents"] is False
    assert seen["provider"] == "openai"

    monkeypatch.setattr(loop, "_review_scope", lambda scope: classify(None, 0))
    asyncio.run(loop._run_reviewer(scope, state, "any-model", ""))
    assert seen["use_subagents"] is True


def test_commands_are_noted_whatever_the_tool_input_shape():
    from qa.reviewer import _note_command

    seen: list[str] = []
    _note_command(seen, {"command": "pytest tests/test_calc.py"})
    _note_command(seen, {"cmd": ["bash", "-lc", "npx vitest run a.test.ts"]})
    _note_command(seen, {"file_path": "x.py"})
    _note_command(None, {"command": "ignored"})
    assert seen == ["pytest tests/test_calc.py", "bash -lc npx vitest run a.test.ts"]


# --- the targeted gate ---------------------------------------------------------


def _signoff(**overrides):
    signoff = {
        "status": "approved",
        "review_scope": "targeted",
        "targeted_tests": [
            {"file": "tests/test_calc.py", "command": "pytest", "passed": True}
        ],
        "coverage": {"measured": True, "touched_files": 100},
    }
    signoff.update(overrides)
    return signoff


CALC = ["pytest tests/test_calc.py --cov=src"]


def test_the_gate_accepts_run_passed_and_covered_tests():
    from qa.targeted_gate import evaluate_targeted

    scope = _classify(["src/calc.py"])
    assert evaluate_targeted(_signoff(), scope, CALC, 100) == []


@pytest.mark.parametrize(
    ("signoff", "commands", "expected"),
    [
        (_signoff(targeted_tests=[]), CALC, "absent"),
        (
            _signoff(targeted_tests=[{"file": "tests/test_calc.py", "passed": False}]),
            CALC,
            "non passé",
        ),
        (_signoff(), [], "aucune commande"),
        (_signoff(), ["pytest tests/test_other.py"], "aucune commande"),
        (_signoff(coverage={"measured": True, "touched_files": 80}), CALC, "80.0%"),
        (_signoff(coverage={"measured": False}), CALC, "non mesurée"),
        (_signoff(coverage={}), CALC, "absente"),
        (
            _signoff(
                coverage={
                    "touched_files": 100,
                    "per_file": {"src/calc.py": 50},
                }
            ),
            CALC,
            "`src/calc.py` 50.0%",
        ),
    ],
)
def test_the_gate_rejects_what_it_did_not_see(signoff, commands, expected):
    from qa.targeted_gate import evaluate_targeted

    failures = evaluate_targeted(signoff, _classify(["src/calc.py"]), commands, 100)
    assert any(expected in f for f in failures), failures


def test_a_disabled_coverage_threshold_still_requires_the_tests():
    from qa.targeted_gate import evaluate_targeted

    scope = _classify(["src/calc.py"])
    assert evaluate_targeted(_signoff(coverage={}), scope, CALC, 0) == []
    assert evaluate_targeted(_signoff(targeted_tests=[]), scope, CALC, 0)


def test_a_targeted_scope_without_tests_never_passes():
    from qa.targeted_gate import evaluate_targeted

    assert evaluate_targeted(_signoff(), ChangeScope("targeted", "x"), CALC, 0)


def test_the_loop_routes_a_targeted_pass_to_its_gate(monkeypatch, tmp_path):
    from qa import loop

    called = []
    monkeypatch.setattr(
        "qa.coverage_gate.run_coverage_gate",
        lambda spec_dir: called.append(spec_dir) or {"enabled": False},
    )
    (tmp_path / "implementation_plan.json").write_text(
        json.dumps({"qa_signoff": _signoff(targeted_tests=[])}), encoding="utf-8"
    )
    scope = _classify(["src/calc.py"])

    gate = loop._coverage_gate(tmp_path, 2, scope, CALC)

    assert called == []  # the whole-suite coverage gate is not asked
    assert gate is not None
    issues, verdict = gate
    assert "targeted QA gate" in verdict
    assert all(i["type"] == "targeted_qa_gap" for i in issues)
    plan = json.loads((tmp_path / "implementation_plan.json").read_text("utf-8"))
    assert plan["qa_signoff"]["status"] == "rejected"
    request = (tmp_path / "QA_FIX_REQUEST.md").read_text(encoding="utf-8")
    assert "QA ciblée" in request
    assert "tests/test_calc.py" in request

    (tmp_path / "implementation_plan.json").write_text(
        json.dumps({"qa_signoff": _signoff()}), encoding="utf-8"
    )
    assert loop._coverage_gate(tmp_path, 3, scope, CALC) is None


def test_the_report_says_which_tier_ran(tmp_path):
    from qa.report import render_qa_report

    assert render_qa_report(tmp_path, _signoff())
    report = (tmp_path / "qa_report.md").read_text(encoding="utf-8")
    assert "Scope: targeted QA — QA ciblée" in report
    assert "Targeted tests: tests/test_calc.py pass" in report
