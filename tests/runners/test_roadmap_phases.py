"""The roadmap's phases, on real files, with stand-in agents.

Each roadmap agent reads a prompt naming its output file and writes it with
its Write tool. The stand-in client here does the same with whatever a test
asks it to write (or writes nothing); the phases, their checks and their
files are the real ones.
"""

from __future__ import annotations

import asyncio
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest
from core.agent_client import AgentMessage, ContentBlock, ContentBlockType, MessageRole
from runners.roadmap import executor as executor_module
from runners.roadmap import graph_integration
from runners.roadmap.competitor_analyzer import CompetitorAnalyzer
from runners.roadmap.executor import AgentExecutor, ScriptExecutor
from runners.roadmap.files import read_object, snapshot, written_since
from runners.roadmap.graph_integration import GraphHintsProvider
from runners.roadmap.phases import DiscoveryPhase, FeaturesPhase, ProjectIndexPhase

DISCOVERY = {
    "project_name": "shop",
    "target_audience": {"primary": "small shops"},
    "product_vision": {"one_liner": "Sell online in a day"},
}


def roadmap(*features: dict, **fields) -> dict:
    return {
        "vision": "Sell online in a day",
        "target_audience": {"primary": "small shops"},
        "phases": [{"id": "phase-1"}],
        "features": list(features)
        or [
            {"id": "f-1", "title": "Card payments"},
            {"id": "f-2", "title": "Gift cards"},
            {"id": "f-3", "title": "Stock alerts"},
        ],
        **fields,
    }


class Agents:
    """Stand-in clients: each run writes the next scripted payload, or nothing.

    A payload is a dict or list (written as JSON), a str (written as is), or
    None (the agent writes nothing). An exception is raised by the client.
    """

    def __init__(self, *payloads, blocks=()):
        self.payloads = list(payloads)
        self.blocks = list(blocks)
        self.prompts: list[str] = []
        self.options: list[dict] = []

    def create(self, project_dir, output_dir, model, **options):
        self.options.append({"model": model, **options})
        return _Client(self)


class _Client:
    def __init__(self, agents: Agents):
        self.agents = agents

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def query(self, prompt: str) -> None:
        self.agents.prompts.append(prompt)
        payload = self.agents.payloads.pop(0) if self.agents.payloads else None
        if isinstance(payload, Exception):
            raise payload
        match = re.search(r"\*\*Output File\*\*: (\S+)", prompt)
        if match and payload is not None:
            body = payload if isinstance(payload, str) else json.dumps(payload)
            Path(match.group(1)).write_text(body, encoding="utf-8")

    async def receive_response(self):
        for block in self.agents.blocks:
            yield AgentMessage(role=MessageRole.ASSISTANT, content=[block])


@pytest.fixture
def out(tmp_path) -> Path:
    folder = tmp_path / "roadmap"
    folder.mkdir()
    return folder


def executor(out: Path, agents: Agents) -> AgentExecutor:
    return AgentExecutor(out.parent, out, "sonnet", agents.create, thinking_budget=None)


def write(path: Path, data) -> None:
    path.write_text(json.dumps(data), encoding="utf-8")


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Discovery


class TestDiscovery:
    def test_a_valid_discovery_is_kept(self, out):
        agents = Agents(DISCOVERY)

        result = run(DiscoveryPhase(out, False, executor(out, agents)).execute())

        assert result.success and result.retries == 0
        assert read_object(out / "roadmap_discovery.json") == DISCOVERY
        assert agents.options[0]["agent_type"] == "roadmap_discovery"
        assert "NON-INTERACTIVELY" in agents.prompts[0]

    def test_an_existing_discovery_is_reused_without_refresh(self, out):
        write(out / "roadmap_discovery.json", DISCOVERY)
        agents = Agents()

        result = run(DiscoveryPhase(out, False, executor(out, agents)).execute())

        assert result.success
        assert agents.prompts == []

    def test_a_refresh_does_not_take_the_old_file_for_the_agents_work(self, out):
        write(out / "roadmap_discovery.json", DISCOVERY)
        agents = Agents(None, None, None)

        result = run(DiscoveryPhase(out, True, executor(out, agents)).execute())

        assert not result.success
        assert len(agents.prompts) == 3
        assert result.errors == [
            f"Attempt {n}: Agent did not create discovery file" for n in (1, 2, 3)
        ]

    def test_a_bad_file_is_retried_until_one_is_valid(self, out):
        agents = Agents("{not json", ["a", "list"], {"project_name": "x"}, DISCOVERY)

        result = run(DiscoveryPhase(out, True, executor(out, agents)).execute())

        assert not result.success
        assert result.errors == [f"Validation failed on attempt {n}" for n in (1, 2, 3)]

    def test_a_valid_file_on_a_later_attempt_counts(self, out):
        agents = Agents(None, DISCOVERY)

        result = run(DiscoveryPhase(out, False, executor(out, agents)).execute())

        assert result.success and result.retries == 1


# ---------------------------------------------------------------------------
# Features


class TestFeatures:
    def test_without_a_discovery_there_is_nothing_to_build_on(self, out):
        result = run(FeaturesPhase(out, False, executor(out, Agents())).execute())

        assert not result.success
        assert result.errors == ["Discovery file not found"]

    def test_an_existing_roadmap_is_reused_without_refresh(self, out):
        write(out / "roadmap_discovery.json", DISCOVERY)
        write(out / "roadmap.json", roadmap())
        agents = Agents()

        result = run(FeaturesPhase(out, False, executor(out, agents)).execute())

        assert result.success and agents.prompts == []

    def test_a_refresh_keeps_the_features_people_work_on(self, out):
        write(out / "roadmap_discovery.json", DISCOVERY)
        old = [
            {"id": "f-1", "title": "Card payments", "status": "in_progress"},
            {"id": "f-9", "title": "Loyalty", "linked_spec_id": "012-loyalty"},
            {"id": "f-8", "title": "Mine", "source": {"provider": "internal"}},
            {"id": "f-7", "title": "Dropped idea", "status": "idea"},
            "not a feature",
        ]
        write(out / "roadmap.json", roadmap(*old))
        new = roadmap(
            {"id": "f-1", "title": "Card payments v2"},
            {"title": "  LOYALTY  "},
            {"id": "n-1", "title": "Gift cards"},
            {"id": "n-2", "title": None},
            "junk",
        )
        agents = Agents(new)

        result = run(FeaturesPhase(out, True, executor(out, agents)).execute())

        assert result.success
        kept = read_object(out / "roadmap.json")["features"]
        # The three worked-on features first, then the new ones they don't repeat.
        assert [f.get("id") for f in kept] == ["f-1", "f-9", "f-8", "n-1", "n-2"]
        prompt = agents.prompts[0]
        assert "EXISTING FEATURES TO PRESERVE" in prompt
        assert "  - f-9: Loyalty" in prompt
        assert "6. Do NOT generate features with the same IDs" in prompt

    def test_a_refresh_does_not_take_the_old_roadmap_for_a_new_one(self, out):
        write(out / "roadmap_discovery.json", DISCOVERY)
        write(out / "roadmap.json", roadmap())
        agents = Agents(None, None, None)

        result = run(FeaturesPhase(out, True, executor(out, agents)).execute())

        assert not result.success
        assert result.errors[-1] == "Attempt 3: Agent did not create roadmap file"

    @pytest.mark.parametrize(
        "bad",
        [
            "{not json",
            roadmap(features="many"),
            roadmap({"id": "f-1"}, {"id": "f-2"}),
            roadmap(target_audience="everyone"),
            roadmap(target_audience={"secondary": "x"}),
            {"vision": "v"},
        ],
    )
    def test_a_roadmap_that_does_not_hold_up_is_retried(self, out, bad):
        write(out / "roadmap_discovery.json", DISCOVERY)
        agents = Agents(bad, bad, bad)

        result = run(FeaturesPhase(out, False, executor(out, agents)).execute())

        assert not result.success
        assert result.errors[0] == "Validation failed on attempt 1"

    def test_a_roadmap_without_features_to_keep_is_taken_as_written(self, out):
        write(out / "roadmap_discovery.json", DISCOVERY)
        write(out / "roadmap.json", {"features": "none"})
        agents = Agents(roadmap())

        result = run(FeaturesPhase(out, True, executor(out, agents)).execute())

        assert result.success
        assert read_object(out / "roadmap.json") == roadmap()
        assert "EXISTING FEATURES" not in agents.prompts[0]

    def test_merged_features_that_cannot_be_saved_leave_the_agents_roadmap(
        self, out, monkeypatch, capsys
    ):
        write(out / "roadmap_discovery.json", DISCOVERY)
        write(out / "roadmap.json", roadmap({"id": "old", "status": "done"}))
        agents = Agents(roadmap())
        real_write_text = Path.write_text

        def write_text(self, *args, **kwargs):
            if self.name == "roadmap.json" and "old" in str(args):
                raise OSError("disk full")
            return real_write_text(self, *args, **kwargs)

        monkeypatch.setattr(Path, "write_text", write_text)

        result = run(FeaturesPhase(out, True, executor(out, agents)).execute())

        assert result.success
        assert read_object(out / "roadmap.json") == roadmap()
        assert "1 preserved features could not be saved" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# Project index


class TestProjectIndex:
    def test_an_index_is_built_by_the_analyzer(self, out, tmp_path):
        project = tmp_path / "shop"
        project.mkdir()
        (project / "package.json").write_text('{"name": "shop"}', encoding="utf-8")

        result = run(
            ProjectIndexPhase(out, False, ScriptExecutor(project), project).execute()
        )

        assert result.success
        assert read_object(out / "project_index.json") is not None

    def test_an_analyzer_that_fails_fails_the_phase(self, out, tmp_path):
        class Failing:
            def run_script(self, script, args):
                return False, "analyzer crashed"

        result = run(ProjectIndexPhase(out, True, Failing(), tmp_path).execute())

        assert not result.success
        assert result.errors == ["analyzer crashed"]


# ---------------------------------------------------------------------------
# Competitor analysis


class TestCompetitorAnalysis:
    @pytest.fixture
    def discovered(self, out):
        write(out / "roadmap_discovery.json", DISCOVERY)
        return out

    def test_off_it_writes_a_file_that_says_so(self, out):
        result = run(CompetitorAnalyzer(out, False, executor(out, Agents())).analyze())

        assert result.success
        assert read_object(out / "competitor_analysis.json")["enabled"] is False

    def test_an_analysis_is_validated_and_counted(self, discovered, capsys):
        analysis = {
            "competitors": [
                {"name": "A", "pain_points": ["slow", "pricey"]},
                {"name": "B", "pain_points": "n/a"},
                "C",
            ]
        }
        agents = Agents(analysis)

        result = run(
            CompetitorAnalyzer(discovered, False, executor(discovered, agents)).analyze(
                enabled=True
            )
        )

        assert result.success and result.errors == []
        assert agents.options[0]["agent_type"] == "competitor_analysis"
        assert "Analyzed 3 competitors, found 2 pain points" in capsys.readouterr().out

    def test_an_existing_analysis_is_reused_without_refresh(self, discovered):
        write(discovered / "competitor_analysis.json", {"competitors": []})
        agents = Agents()

        result = run(
            CompetitorAnalyzer(discovered, False, executor(discovered, agents)).analyze(
                enabled=True
            )
        )

        assert result.success and agents.prompts == []

    def test_without_a_discovery_it_is_skipped(self, out):
        result = run(
            CompetitorAnalyzer(out, False, executor(out, Agents())).analyze(
                enabled=True
            )
        )

        assert result.success
        assert result.errors == ["Discovery file not found"]
        assert (
            "Discovery file not found"
            in read_object(out / "competitor_analysis.json")["error"]
        )

    def test_a_failed_analysis_does_not_block_the_roadmap(self, discovered, capsys):
        write(discovered / "competitor_analysis.json", {"competitors": []})
        agents = Agents(None, {"no": "competitors"}, "[1]")

        result = run(
            CompetitorAnalyzer(discovered, True, executor(discovered, agents)).analyze(
                enabled=True
            )
        )

        assert result.success
        assert result.errors == [
            "Attempt 1: Agent did not create competitor analysis file",
            "Attempt 2: Validation failed",
            "Attempt 3: Validation failed",
        ]
        saved = read_object(discovered / "competitor_analysis.json")
        assert saved["error"] == "Analysis failed after retries"
        assert saved["errors"] == result.errors
        assert "continuing without competitor insights" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# Graph hints


class TestGraphHints:
    def test_memory_off_writes_a_file_that_says_so(self, out, monkeypatch):
        monkeypatch.setattr(graph_integration, "is_memory_enabled", lambda: False)

        result = run(GraphHintsProvider(out, out.parent).retrieve_hints())

        assert result.success
        assert read_object(out / "graph_hints.json")["enabled"] is False

    @pytest.mark.parametrize("hints", [[{"text": "Payments matter"}], []])
    def test_what_the_brain_knows_is_saved(self, out, monkeypatch, hints, capsys):
        asked = {}

        async def get_graph_hints(**kwargs):
            asked.update(kwargs)
            return hints

        monkeypatch.setattr(graph_integration, "is_memory_enabled", lambda: True)
        monkeypatch.setattr(graph_integration, "get_graph_hints", get_graph_hints)

        result = run(GraphHintsProvider(out, out.parent).retrieve_hints())

        saved = read_object(out / "graph_hints.json")
        assert result.success
        assert (saved["hints"], saved["hint_count"]) == (hints, len(hints))
        assert asked["project_id"] == str(out.parent)
        said = capsys.readouterr().out
        assert ("Retrieved 1 graph hints" in said) == bool(hints)

    def test_a_brain_that_fails_is_noted_and_the_roadmap_goes_on(
        self, out, monkeypatch
    ):
        async def get_graph_hints(**_kwargs):
            raise RuntimeError("vault locked")

        monkeypatch.setattr(graph_integration, "is_memory_enabled", lambda: True)
        monkeypatch.setattr(graph_integration, "get_graph_hints", get_graph_hints)

        result = run(GraphHintsProvider(out, out.parent).retrieve_hints())

        assert result.success and result.errors == ["vault locked"]
        assert read_object(out / "graph_hints.json")["error"] == "vault locked"

    def test_existing_hints_are_reused_without_refresh(self, out, monkeypatch):
        write(out / "graph_hints.json", {"hints": []})
        monkeypatch.setattr(
            graph_integration, "is_memory_enabled", lambda: pytest.fail("asked")
        )

        assert run(GraphHintsProvider(out, out.parent).retrieve_hints()).success


# ---------------------------------------------------------------------------
# The executors


class TestAgentExecutor:
    def test_the_agents_text_and_tools_are_streamed(self, out, capsys):
        agents = Agents(
            blocks=[
                ContentBlock(type=ContentBlockType.TEXT, text="Reading the README."),
                ContentBlock(type=ContentBlockType.TOOL_USE, tool_name="Read"),
                ContentBlock(type=ContentBlockType.TOOL_USE),
                ContentBlock(type=ContentBlockType.TEXT),
            ]
        )

        ok, text = run(
            executor(out, agents).run_agent("roadmap_features.md", "Extra context")
        )

        assert ok and text == "Reading the README."
        said = capsys.readouterr().out
        assert "Reading the README." in said
        assert "[Tool: Read]" in said
        assert agents.prompts[0].endswith("\nExtra context\n")
        assert f"**Output Directory**: {out}" in agents.prompts[0]

    def test_an_unknown_prompt_runs_under_the_roadmap_type(self, out, tmp_path):
        agents = Agents()
        ex = executor(out, agents)
        ex.prompts_dir = tmp_path
        (tmp_path / "other.md").write_text("Do it.", encoding="utf-8")

        ok, _ = run(ex.run_agent("other.md"))

        assert ok
        assert agents.options[0]["agent_type"] == "roadmap_discovery"

    def test_a_missing_prompt_is_an_error(self, out):
        ok, text = run(executor(out, Agents()).run_agent("gone.md"))

        assert not ok and text.startswith("Prompt not found: ")

    def test_an_agent_that_fails_says_why(self, out):
        ok, text = run(
            executor(out, Agents(RuntimeError("quota"))).run_agent(
                "roadmap_discovery.md"
            )
        )

        assert (ok, text) == (False, "quota")


class TestScriptExecutor:
    @pytest.fixture
    def scripts(self, tmp_path):
        folder = tmp_path / "scripts"
        folder.mkdir()
        (folder / "ok.py").write_text(
            "import sys; print('done', sys.argv[1:])", encoding="utf-8"
        )
        (folder / "bad.py").write_text(
            "import sys; sys.stderr.write('broke é'); sys.exit(3)", encoding="utf-8"
        )
        (folder / "quiet.py").write_text(
            "import sys; print('only stdout'); sys.exit(1)", encoding="utf-8"
        )
        return folder

    def make(self, cwd: Path, scripts: Path) -> ScriptExecutor:
        ex = ScriptExecutor(cwd)
        ex.scripts_base_dir = scripts
        return ex

    def test_a_script_s_output_is_returned(self, tmp_path, scripts):
        ok, output = self.make(tmp_path, scripts).run_script("ok.py", ["--x"])

        assert ok and output.strip() == "done ['--x']"

    def test_a_failing_script_returns_what_it_printed(self, tmp_path, scripts):
        ex = self.make(tmp_path, scripts)

        assert ex.run_script("bad.py", []) == (False, "broke é")
        assert ex.run_script("quiet.py", []) == (False, "only stdout\n")

    def test_a_missing_script_is_an_error(self, tmp_path, scripts):
        ok, output = self.make(tmp_path, scripts).run_script("gone.py", [])

        assert not ok and output.startswith("Script not found: ")

    def test_a_folder_that_is_gone_is_an_error(self, tmp_path, scripts):
        ok, output = self.make(tmp_path / "gone", scripts).run_script("ok.py", [])

        assert not ok and output

    def test_a_script_that_hangs_is_stopped(self, tmp_path, scripts, monkeypatch):
        def hang(*_a, **_kw):
            raise subprocess.TimeoutExpired("python", 300)

        monkeypatch.setattr(executor_module.subprocess, "run", hang)

        assert self.make(tmp_path, scripts).run_script("ok.py", []) == (
            False,
            "Script timed out",
        )


class TestFiles:
    def test_a_file_rewritten_with_other_content_is_new(self, tmp_path):
        path = tmp_path / "a.json"
        assert snapshot(path) is None
        assert not written_since(path, None)

        path.write_text("1", encoding="utf-8")
        before = snapshot(path)
        assert not written_since(path, before)
        path.write_text("2", encoding="utf-8")
        assert written_since(path, before)
        assert written_since(path, None)

    def test_only_a_json_object_is_read(self, tmp_path):
        path = tmp_path / "a.json"
        assert read_object(path) is None
        path.write_bytes(b"\xff\xfe")
        assert read_object(path) is None
        path.write_text("[1]", encoding="utf-8")
        assert read_object(path) is None
        path.write_text('{"a": 1}', encoding="utf-8")
        assert read_object(path) == {"a": 1}


def test_the_analyzer_runs_with_this_interpreter():
    # The script executor starts the backend's scripts with the interpreter
    # running the roadmap, not whatever "python" is first on PATH.
    assert executor_module.sys.executable == sys.executable


# ---------------------------------------------------------------------------
# The orchestrator


class TestTheOrchestrator:
    @pytest.fixture
    def make(self, tmp_path, monkeypatch):
        import runners.roadmap.orchestrator as orchestrator

        monkeypatch.setattr(graph_integration, "is_memory_enabled", lambda: False)

        def make(agents: Agents, out: Path | None = None):
            monkeypatch.setattr(orchestrator, "create_agent_client", agents.create)
            project = tmp_path / "shop"
            project.mkdir(exist_ok=True)
            return orchestrator.RoadmapOrchestrator(project, output_dir=out)

        return make

    def test_without_a_project_index_nothing_else_runs(self, make, out, capsys):
        agents = Agents()
        run_ = make(agents, out)

        class NoIndex:
            def run_script(self, script, args):
                return False, "no analyzer"

        run_.project_index_phase.script_executor = NoIndex()

        assert run(run_.run()) is False
        assert agents.prompts == []
        assert "Project analysis failed" in capsys.readouterr().out

    def test_features_that_never_hold_up_fail_the_run(self, make, out, capsys):
        write(out / "project_index.json", {})
        agents = Agents(DISCOVERY, None, None, None)

        assert run(make(agents, out).run()) is False
        said = capsys.readouterr().out
        assert "Feature generation failed" in said
        assert "Agent did not create roadmap file" in said

    def test_the_default_output_is_the_projects_workpilot_folder(self, make):
        orchestrator = make(Agents())

        assert orchestrator.output_dir == orchestrator.project_dir / ".workpilot" / (
            "roadmap"
        )
        assert orchestrator.output_dir.is_dir()

    def test_no_summary_without_a_roadmap(self, make, out, capsys):
        make(Agents(), out)._print_summary()

        assert "ROADMAP GENERATED" not in capsys.readouterr().out
