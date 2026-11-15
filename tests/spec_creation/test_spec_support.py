"""The helpers around the phases: phase summaries, the minimal context, the
project index stats, the requirements editor, the plan writer, the spec
source record and the traceability endpoint's edges."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest
from core.agent_client import AgentMessage, ContentBlock, ContentBlockType, MessageRole
from spec import compaction, context, discovery, requirements, source, writer


class SummaryClient:
    def __init__(self, chunks, error=None):
        self.chunks = chunks
        self.error = error
        self.prompts = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt):
        self.prompts.append(prompt)
        if self.error:
            raise self.error

    async def receive_response(self):
        yield AgentMessage(
            role=MessageRole.ASSISTANT,
            content=[
                ContentBlock(type=ContentBlockType.TEXT, text=c) for c in self.chunks
            ]
            + [ContentBlock(type=ContentBlockType.TOOL_USE, tool_name="Read")],
        )


async def test_a_phase_is_summarized_on_the_tasks_provider(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # No Claude token anywhere: the summary no longer asks for one.
    client = SummaryClient(["- five ", "services "])
    created = {}

    def factory(**kwargs):
        created.update(kwargs)
        return client

    monkeypatch.setattr("core.client.create_agent_client", factory)

    summary = await compaction.summarize_phase_output(
        "discovery", "x" * 20000, project_dir=tmp_path, spec_dir=tmp_path, model="qwen3"
    )

    assert summary == "- five services"
    assert created["agent_type"] == "spec_compaction"
    assert created["model"] == "qwen3"
    assert "[... output truncated for summarization ...]" in client.prompts[0]


async def test_a_failed_summary_hands_back_the_raw_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "core.client.create_agent_client",
        lambda **kw: SummaryClient([], error=RuntimeError("provider down")),
    )

    summary = await compaction.summarize_phase_output(
        "planning", "y" * 3000, project_dir=tmp_path, spec_dir=tmp_path
    )

    assert summary.startswith("[Summarization failed: provider down]")
    assert summary.endswith("[... truncated ...]")


def test_phase_outputs_are_the_files_each_phase_writes(tmp_path: Path) -> None:
    (tmp_path / "project_index.json").write_text('{"services": {}}', encoding="utf-8")
    (tmp_path / "spec.md").write_text("s" * 12000, encoding="utf-8")
    (tmp_path / "critique_report.json").write_bytes(b"\xff\xfe not utf-8")

    assert "project_index.json" in compaction.gather_phase_outputs(
        tmp_path, "discovery"
    )
    critique = compaction.gather_phase_outputs(tmp_path, "self_critique")
    assert "[... file truncated ...]" in critique
    assert "critique_report.json" not in critique
    assert compaction.gather_phase_outputs(tmp_path, "validation") == ""
    assert compaction.gather_phase_outputs(tmp_path, "unknown") == ""


def test_summaries_are_formatted_under_one_heading() -> None:
    assert compaction.format_phase_summaries({}) == ""
    text = compaction.format_phase_summaries({"spec_writing": "- done"})
    assert text.startswith("## Context from Previous Phases")
    assert "### Spec Writing\n- done" in text


def test_the_minimal_context_holds_only_what_the_task_names(tmp_path: Path) -> None:
    context.create_minimal_context(
        tmp_path,
        "Secure the API endpoint in `src/Api/AuthController.cs`, then "
        "update lib/auth.ex and lib/auth.ex (again).",
        ["api"],
    )

    saved = json.loads((tmp_path / "context.json").read_text("utf-8"))
    assert saved["files_to_modify"] == ["src/Api/AuthController.cs", "lib/auth.ex"]
    assert saved["patterns"] == {} and saved["scoped_services"] == ["api"]
    # No invented Python files for the words "API", "endpoint", "secure".
    assert not any(f.endswith(".py") for f in saved["files_to_modify"])


def test_a_minimal_context_without_a_task(tmp_path: Path) -> None:
    context.create_minimal_context(tmp_path, "", [])

    saved = json.loads((tmp_path / "context.json").read_text("utf-8"))
    assert saved["task_description"] == "unknown task"
    assert saved["files_to_modify"] == []


def test_project_index_stats_name_the_services(tmp_path: Path) -> None:
    index = tmp_path / "project_index.json"
    assert discovery.get_project_index_stats(tmp_path) == {}
    index.write_text("[1, 2]", encoding="utf-8")
    assert discovery.get_project_index_stats(tmp_path) == {}
    index.write_text(
        json.dumps({"project_type": "monorepo", "services": {"web": {}, "api": {}}}),
        encoding="utf-8",
    )
    assert discovery.get_project_index_stats(tmp_path) == {
        "services": ["api", "web"],
        "project_type": "monorepo",
    }


def test_discovery_runs_the_analyzer_when_there_is_no_index(tmp_path: Path) -> None:
    project = tmp_path / "shop"
    (project / "src").mkdir(parents=True)
    (project / "go.mod").write_text("module shop\n\ngo 1.22\n", encoding="utf-8")
    (project / "src" / "main.go").write_text("package main\n", encoding="utf-8")
    spec_dir = tmp_path / "spec"
    spec_dir.mkdir()

    ok, message = discovery.run_discovery_script(project, spec_dir)

    assert ok, message
    assert json.loads((spec_dir / "project_index.json").read_text("utf-8"))
    assert discovery.run_discovery_script(project, spec_dir) == (
        True,
        "project_index.json already exists",
    )


def test_a_failed_analyzer_reports_its_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import subprocess

    def fail(cmd, **kwargs):
        assert kwargs["env"]["PYTHONUTF8"] == "1"
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="Traceback: boom")

    monkeypatch.setattr(discovery.subprocess, "run", fail)
    assert discovery.run_discovery_script(tmp_path, tmp_path) == (
        False,
        "Traceback: boom",
    )

    def hang(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, 300)

    monkeypatch.setattr(discovery.subprocess, "run", hang)
    assert discovery.run_discovery_script(tmp_path, tmp_path) == (
        False,
        "Script timed out",
    )

    def missing(cmd, **kwargs):
        raise OSError("no interpreter")

    monkeypatch.setattr(discovery.subprocess, "run", missing)
    assert discovery.run_discovery_script(tmp_path, tmp_path) == (
        False,
        "no interpreter",
    )


def _editor_script(tmp_path: Path, body: str) -> str:
    script = tmp_path / "editor.py"
    script.write_text(
        "import sys\n"
        "path = sys.argv[-1]\n"
        f"with open(path, 'a', encoding='utf-8') as f:\n    f.write({body!r})\n",
        encoding="utf-8",
    )
    return script.as_posix()


def test_the_editor_returns_what_was_typed_without_comments(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    script = _editor_script(tmp_path, "Add dark mode\n# not this\nwith AA contrast\n")
    monkeypatch.setenv("EDITOR", f'"{Path(sys.executable).as_posix()}" "{script}"')

    assert requirements.open_editor_for_input("task_description") == (
        "Add dark mode\nwith AA contrast"
    )


def test_an_editor_that_fails_or_is_missing_returns_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(
        "EDITOR", f'"{Path(sys.executable).as_posix()}" -c "raise SystemExit(3)"'
    )
    assert requirements.open_editor_for_input("task") == ""

    monkeypatch.setenv("EDITOR", (tmp_path / "no-such-editor").as_posix())
    assert requirements.open_editor_for_input("task") == ""


def test_without_editor_variables_the_first_installed_editor_is_used(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("EDITOR", raising=False)
    monkeypatch.delenv("VISUAL", raising=False)
    monkeypatch.setattr(requirements, "find_executable", lambda name: None)

    # Nothing installed: no editor is started, nothing is returned.
    assert requirements.open_editor_for_input("task") == ""


def test_the_task_can_be_typed_in_the_editor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    import ui

    monkeypatch.setattr(
        requirements, "open_editor_for_input", lambda field: "From the editor"
    )
    answers = iter(["edit", "", ""])
    monkeypatch.setattr("builtins.input", lambda prompt="": next(answers))

    req = requirements.gather_requirements_interactively(ui)

    assert req["task_description"] == "From the editor"
    assert req["workflow_type"] == "feature"
    assert req["additional_context"] is None
    assert "Got 15 chars from editor" in capsys.readouterr().out


def test_an_empty_answer_still_names_the_task(monkeypatch: pytest.MonkeyPatch) -> None:
    import ui

    def eof(prompt=""):
        raise EOFError

    calls = iter([eof, lambda p="": "9", eof])
    monkeypatch.setattr("builtins.input", lambda prompt="": next(calls)(prompt))

    req = requirements.gather_requirements_interactively(ui)

    assert req["task_description"] == "No task description provided"
    assert req["workflow_type"] == "feature"


def test_requirements_round_trip(tmp_path: Path) -> None:
    assert requirements.load_requirements(tmp_path) is None
    requirements.save_requirements(tmp_path, {"task_description": "x"})
    assert requirements.load_requirements(tmp_path) == {"task_description": "x"}


def test_plan_stats(tmp_path: Path) -> None:
    assert writer.get_plan_stats(tmp_path) == {}
    (tmp_path / "implementation_plan.json").write_text("{bad", encoding="utf-8")
    assert writer.get_plan_stats(tmp_path) == {}
    writer.create_minimal_plan(tmp_path, "")
    assert writer.get_plan_stats(tmp_path) == {"total_subtasks": 1, "total_phases": 1}
    plan = json.loads((tmp_path / "implementation_plan.json").read_text("utf-8"))
    assert plan["feature"] == "Unnamed Feature"
    assert plan["phases"][0]["subtasks"][0]["description"] == "Implement the change"


def test_an_unwritable_spec_source_records_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "requirements.json").write_text(
        '{"task_description": "Export"}', encoding="utf-8"
    )

    def refuse(self, *args, **kwargs):
        raise OSError("read-only")

    monkeypatch.setattr(Path, "write_text", refuse)

    assert source.record_spec_source(tmp_path) is False


def test_the_spec_package_exposes_the_orchestrator_lazily() -> None:
    import spec

    assert spec.SpecOrchestrator.__name__ == "SpecOrchestrator"
    assert callable(spec.get_specs_dir)
    with pytest.raises(AttributeError):
        spec.no_such_name  # noqa: B018


def test_traceability_failures_answer_without_detail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from spec import api

    spec_dir = tmp_path / "loose-spec"
    spec_dir.mkdir()
    app = FastAPI()
    app.include_router(api.router)
    client = TestClient(app)

    def broken(path):
        raise RuntimeError(f"cannot read {path}")

    monkeypatch.setattr(api, "collect", broken)
    answer = client.get(
        "/api/spec-traceability/", params={"spec_dir": str(spec_dir)}
    ).json()
    assert answer == {"success": False, "error": "An internal error has occurred."}

    # Links of a spec outside .workpilot/specs have no project to look in.
    monkeypatch.setattr(api, "load_links", lambda path: {"requirements": []})
    assert api._links(spec_dir) == {"requirements": [], "earlier": []}
