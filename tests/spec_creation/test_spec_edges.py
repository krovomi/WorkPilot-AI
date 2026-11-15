"""The last branches of spec creation: a locked plan file, a plan that is not
JSON, an editor that removes its own file, a packaged build without its
analyzer, a heuristic chosen up front."""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

import pytest
import ui
from spec import api, complexity, discovery, requirements
from spec.phases import PhaseExecutor
from spec.pipeline import SpecOrchestrator
from spec.validate_pkg import SpecValidator
from spec.validate_pkg.auto_fix import auto_fix_plan
from task_logger import TaskLogger


@pytest.fixture
def spec_dir(tmp_path: Path) -> Path:
    path = tmp_path / "app" / ".workpilot" / "specs" / "001-export"
    path.mkdir(parents=True)
    return path


def _executor(spec_dir: Path) -> PhaseExecutor:
    async def never(*args, **kwargs):
        raise AssertionError("no agent session expected")

    return PhaseExecutor(
        project_dir=spec_dir.parents[2],
        spec_dir=spec_dir,
        task_description="Export invoices as CSV",
        spec_validator=SpecValidator(spec_dir),
        run_agent_fn=never,
        task_logger=TaskLogger(spec_dir, emit_markers=False),
        ui_module=ui,
    )


class TestPlanFile:
    def test_a_locked_plan_is_retried_then_left_with_a_warning(
        self, spec_dir, monkeypatch, caplog
    ):
        plan = spec_dir / "implementation_plan.json"
        plan.write_text("{}", encoding="utf-8")
        attempts = []

        def locked(self, missing_ok=False):
            attempts.append(self)
            raise PermissionError("held by the file watcher")

        monkeypatch.setattr(Path, "unlink", locked)
        monkeypatch.setattr("time.sleep", lambda seconds: None)
        with caplog.at_level(logging.WARNING):
            _executor(spec_dir)._ensure_plan_deleted(plan)

        assert len(attempts) == 5
        assert "Could not delete plan file after retries" in caplog.text

    def test_a_lock_released_on_the_second_try_deletes_the_plan(
        self, spec_dir, monkeypatch
    ):
        plan = spec_dir / "implementation_plan.json"
        plan.write_text("{}", encoding="utf-8")
        real_unlink = Path.unlink
        attempts = []

        def locked_once(self, missing_ok=False):
            attempts.append(self)
            if len(attempts) == 1:
                raise PermissionError("held by the file watcher")
            real_unlink(self, missing_ok=missing_ok)

        monkeypatch.setattr(Path, "unlink", locked_once)
        monkeypatch.setattr("time.sleep", lambda seconds: None)
        _executor(spec_dir)._ensure_plan_deleted(plan)

        assert not plan.exists()
        assert len(attempts) == 2

    def test_a_plan_that_is_not_json_is_quoted_in_the_log(self, spec_dir, caplog):
        plan = spec_dir / "implementation_plan.json"
        plan.write_text("Here is the plan: phase one, then two", encoding="utf-8")
        with caplog.at_level(logging.INFO):
            _executor(spec_dir)._log_plan_content(plan, "after planning")
        assert "invalid JSON: Here is the plan" in caplog.text

    def test_a_missing_plan_is_said_to_be_missing(self, spec_dir, caplog):
        with caplog.at_level(logging.INFO):
            _executor(spec_dir)._log_plan_content(
                spec_dir / "implementation_plan.json", "after planning"
            )
        assert "file does not exist" in caplog.text

    def test_legacy_chunks_become_the_subtasks(self, spec_dir):
        (spec_dir / "implementation_plan.json").write_text(
            json.dumps(
                {
                    "feature": "Export invoices",
                    "workflow_type": "feature",
                    "phases": [
                        {"id": "1", "chunks": [{"id": "1.1", "description": "CSV"}]}
                    ],
                }
            ),
            encoding="utf-8",
        )
        assert auto_fix_plan(spec_dir) is True
        plan = json.loads(
            (spec_dir / "implementation_plan.json").read_text(encoding="utf-8")
        )
        assert plan["phases"][0]["subtasks"][0]["description"] == "CSV"
        assert plan["phases"][0]["name"] == "Phase 1"


def test_an_editor_that_removes_its_file_returns_nothing(tmp_path, monkeypatch):
    script = tmp_path / "remove.py"
    script.write_text("import os, sys\nos.remove(sys.argv[-1])\n", encoding="utf-8")
    monkeypatch.setenv(
        "EDITOR", f'"{Path(sys.executable).as_posix()}" "{script.as_posix()}"'
    )
    assert requirements.open_editor_for_input("task_description") == ""


def test_a_build_without_its_analyzer_says_so(tmp_path, monkeypatch):
    packaged = tmp_path / "backend" / "spec" / "discovery.py"
    monkeypatch.setattr(discovery, "__file__", str(packaged))
    project = tmp_path / "app"
    spec = project / ".workpilot" / "specs" / "001-x"
    spec.mkdir(parents=True)

    ok, message = discovery.run_discovery_script(project, spec)

    assert not ok
    assert message.startswith("Script not found:")


async def test_the_assessor_is_pointed_at_the_project_index(spec_dir):
    (spec_dir.parent.parent / "project_index.json").write_text("{}", encoding="utf-8")
    seen = {}

    async def agent(prompt_file, additional_context=""):
        seen["context"] = additional_context
        return False, "no answer"

    assert await complexity.run_ai_complexity_assessment(spec_dir, "x", agent) is None
    assert "**Project Index**: Available at" in seen["context"]


async def test_with_the_assessor_off_the_heuristic_decides(tmp_path, monkeypatch):
    monkeypatch.setenv("BRAIN_ENABLED", "false")
    project = tmp_path / "app"
    project.mkdir()
    orch = SpecOrchestrator(
        project_dir=project,
        task_description="Fix the typo in the footer",
        spec_name="001-typo",
        use_ai_assessment=False,
    )

    await orch._phase_complexity_assessment_with_requirements()

    assert orch.assessment.assessed_by == "heuristic"


def test_links_inside_a_project_list_earlier_requirements(tmp_path, monkeypatch):
    project = tmp_path / "app"
    spec = project / ".workpilot" / "specs" / "002-export"
    spec.mkdir(parents=True)
    links = {"requirements": [{"id": "FR-001", "files": ["b.go", "a.go"]}]}
    monkeypatch.setattr(api, "load_links", lambda path: links)
    calls = []

    def earlier(project_dir, files, exclude):
        calls.append((Path(project_dir), files, exclude))
        return [{"spec": "001-old", "id": "FR-009"}]

    monkeypatch.setattr(api, "earlier_requirements", earlier)

    answer = api._links(spec)

    assert answer["earlier"] == [{"spec": "001-old", "id": "FR-009"}]
    assert calls == [(project, ["a.go", "b.go"], "002-export")]
