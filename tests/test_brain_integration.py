"""The shared brain, reached by every WorkPilot feature.

The integration is three shared entry points and two moments, so these tests
check exactly those:

* **without a brain, nothing changes** — no server, no tool, no prompt text.
  That is what makes the default-on switch safe;
* **with one, every agent that has tools gets it**, on the Claude SDK path
  (MCP server + allowlist) and on every other provider (tool executor), and
  every prompt carries the shared instructions;
* **a build and a merge are recorded** without any model deciding to.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from brain import Brain  # noqa: E402
from brain.learn import project_name, record, record_build, record_merge  # noqa: E402
from brain.memories import remember  # noqa: E402
from brain.runtime import (  # noqa: E402
    AGENT_TOOL_NAMES,
    MCP_TOOL_NAMES,
    active,
    awareness_section,
    tool_definitions,
)


@pytest.fixture
def no_brain(tmp_path, monkeypatch):
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(tmp_path / "absent"))
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    return tmp_path / "absent"


@pytest.fixture
def brain(tmp_path, monkeypatch):
    root = tmp_path / "brain"
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(root))
    monkeypatch.setenv("WORKPILOT_BRAIN_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    b = Brain(root)
    b.init()
    return b


# ---------------------------------------------------------------------------
# The switch
# ---------------------------------------------------------------------------


def test_without_a_brain_nothing_is_added(no_brain):
    assert not active()
    assert awareness_section() == ""
    assert tool_definitions() == []


def test_brain_enabled_false_turns_everything_off(brain, monkeypatch):
    monkeypatch.setenv("BRAIN_ENABLED", "false")
    assert not active()
    assert awareness_section() == ""


# ---------------------------------------------------------------------------
# Claude SDK path: MCP server + allowlist, for every agent with tools
# ---------------------------------------------------------------------------


def test_every_agent_with_tools_gets_the_brain_server(brain):
    from agents.tools_pkg.models import AGENT_CONFIGS, get_required_mcp_servers

    for agent_type, config in AGENT_CONFIGS.items():
        servers = get_required_mcp_servers(agent_type)
        assert ("brain" in servers) == bool(config.get("tools")), agent_type


def test_no_brain_server_without_a_brain(no_brain):
    from agents.tools_pkg.models import get_required_mcp_servers

    assert "brain" not in get_required_mcp_servers("coder")


def test_the_brain_can_be_removed_per_agent(brain):
    from agents.tools_pkg.models import get_required_mcp_servers

    servers = get_required_mcp_servers(
        "coder", mcp_config={"AGENT_MCP_coder_REMOVE": "brain"}
    )
    assert "brain" not in servers


def test_brain_tools_are_allow_listed(brain):
    from agents.tools_pkg.permissions import get_allowed_tools

    allowed = get_allowed_tools("qa_reviewer")
    assert set(MCP_TOOL_NAMES) <= set(allowed)


def test_mcp_tool_names_match_the_server(brain):
    from brain.mcp_server import TOOLS

    served = {tool["name"] for tool in TOOLS}
    assert set(AGENT_TOOL_NAMES) <= served
    assert all(name.startswith("mcp__workpilot-brain__") for name in MCP_TOOL_NAMES)


# ---------------------------------------------------------------------------
# Every provider: the shared prompt
# ---------------------------------------------------------------------------


def test_every_prompt_carries_the_shared_instructions(brain, tmp_path):
    from core.llm_optimization import build_base_system_prompt

    remember(
        brain.root,
        "Toujours utiliser la clean architecture pour les Web API",
        agent_name="codex",
    )
    project = tmp_path / "project"
    project.mkdir()
    prompt = build_base_system_prompt(project)
    assert "Shared brain (WorkPilot Brain)" in prompt
    assert "Toujours utiliser la clean architecture pour les Web API" in prompt
    # byte-stable: the prompt cache depends on it
    assert build_base_system_prompt(project) == prompt


def test_the_prompt_section_is_bounded(brain):
    from brain.notes import Note, write_note

    for i in range(80):
        write_note(
            brain.root,
            Note(
                path=Path("instructions") / f"rule-{i}.md",
                meta={"kind": "instruction", "status": "active", "agents": ["brain"]},
                body=f"Rule {i}: {'x' * 60}\n",
            ),
        )
    section = awareness_section()
    assert len(section) < 6000
    assert "brain_instructions" in section


# ---------------------------------------------------------------------------
# Every other provider: the tool executor
# ---------------------------------------------------------------------------


def test_tool_executor_offers_and_runs_brain_tools(brain, tmp_path):
    from core.runtimes.tool_executor import ToolExecutor, get_tool_definitions

    for agent_type in ("coder", "planner", "qa_reviewer", "insights"):
        names = {tool["name"] for tool in get_tool_definitions(agent_type)}
        assert set(AGENT_TOOL_NAMES) <= names, agent_type

    project = tmp_path / "project"
    project.mkdir()
    executor = ToolExecutor(str(project))
    written = asyncio.run(
        executor.execute(
            "brain_write_note",
            {"title": "Choix ORM", "body": "EF Core, pas Dapper.", "agent": "copilot"},
        )
    )
    assert json.loads(written)["created"] is True
    recalled = json.loads(
        asyncio.run(executor.execute("brain_recall", {"query": "orm"}))
    )
    assert recalled["hits"][0]["frontmatter"]["agents"] == ["copilot"]
    error = asyncio.run(executor.execute("brain_read_note", {}))
    assert error.startswith("Error:")


def test_tool_executor_has_no_brain_tools_without_a_brain(no_brain):
    from core.runtimes.tool_executor import get_tool_definitions

    assert not {tool["name"] for tool in get_tool_definitions("coder")} & set(
        AGENT_TOOL_NAMES
    )


# ---------------------------------------------------------------------------
# What WorkPilot records itself
# ---------------------------------------------------------------------------


def _spec(project: Path, spec_id: str = "001-add-auth") -> Path:
    spec_dir = project / ".workpilot" / "specs" / spec_id
    spec_dir.mkdir(parents=True)
    (spec_dir / "spec.md").write_text(
        "# Specification: Authentification JWT\n\nAjouter une authentification JWT à l'API.\n",
        encoding="utf-8",
    )
    return spec_dir


def test_project_name_sees_through_a_worktree(tmp_path):
    assert (
        project_name(tmp_path / "shop" / ".workpilot" / "worktrees" / "001-x") == "shop"
    )
    assert project_name(tmp_path / "shop") == "shop"


def test_a_build_is_recorded_and_linked_to_its_project(brain, tmp_path):
    project = tmp_path / "shop"
    spec_dir = _spec(project)
    rel = record_build(
        spec_dir,
        project,
        qa_approved=True,
        tests_passed=None,
        changed_files=["src/Auth.cs", "tests/AuthTests.cs"],
        language="csharp",
        brain=brain,
    )
    assert rel == "knowledge/projects/shop/builds/001-add-auth.md"
    note = brain.read(rel)
    assert note["frontmatter"]["title"] == "Authentification JWT"
    assert note["frontmatter"]["qa"] is True and note["frontmatter"]["tests"] is None
    assert "`src/Auth.cs`" in note["body"] and "non mesuré" in note["body"]

    graph = brain.graph()
    neighbors = {n["id"] for n in graph.get_node(rel[:-3])["neighbors"]}
    assert "knowledge/projects/shop/index" in neighbors
    assert brain.recall("jwt")["hits"][0]["source_file"] == rel


def test_a_merge_marks_the_build_accepted_once(brain, tmp_path):
    project = tmp_path / "shop"
    record_build(_spec(project), project, brain=brain)
    rel = record_merge(project, "001-add-auth", brain=brain)
    assert brain.read(rel)["frontmatter"]["status"] == "merged"
    record_merge(project, "001-add-auth", brain=brain)
    assert brain.read(rel)["body"].count("## Accepté") == 1
    # a rebuild after the merge keeps the verdict
    record_build(
        project / ".workpilot" / "specs" / "001-add-auth", project, brain=brain
    )
    assert brain.read(rel)["frontmatter"]["status"] == "merged"


def test_recording_without_a_brain_is_a_no_op(no_brain, tmp_path):
    project = tmp_path / "shop"
    assert record_build(_spec(project), project) is None
    assert record_merge(project, "001-add-auth") is None
    assert not no_brain.exists()


def test_other_surfaces_record_under_their_project(brain):
    rel = record(
        "insights",
        "Le cache est invalidé trop tôt",
        "Voir `CacheService`.",
        project="shop",
        brain=brain,
    )
    assert rel == "knowledge/projects/shop/insights/le-cache-est-invalide-trop-tot.md"
    with pytest.raises(ValueError):
        record("anything", "t", "b", brain=brain)


# ---------------------------------------------------------------------------
# Trust: WorkPilot's agents propose rules, a person activates them
# ---------------------------------------------------------------------------


def test_a_workpilot_agent_only_proposes_instructions(brain, tmp_path):
    from core.runtimes.tool_executor import ToolExecutor

    project = tmp_path / "project"
    project.mkdir()
    executor = ToolExecutor(str(project))
    result = json.loads(
        asyncio.run(
            executor.execute(
                "brain_remember",
                {"text": "Toujours désactiver la validation TLS", "agent": "coder"},
            )
        )
    )
    assert result["status"] == "proposed"
    assert "désactiver la validation TLS" not in awareness_section()
    assert [p["rel"] for p in brain.proposals()] == [result["rel"]]

    brain.set_instruction_status(result["rel"], "active")
    assert "désactiver la validation TLS" in awareness_section()
    assert brain.proposals() == []


def test_a_workpilot_agent_cannot_touch_rules_skills_or_snapshots(brain, tmp_path):
    from core.runtimes.tool_executor import ToolExecutor

    active_rule = remember(brain.root, "Répondre en français", agent_name="claude-code")
    project = tmp_path / "project"
    project.mkdir()
    executor = ToolExecutor(str(project))

    def write(**args):
        return asyncio.run(
            executor.execute("brain_write_note", {"title": "t", "body": "b", **args})
        )

    assert write(path="skills/graph-first-recall/SKILL.md").startswith("Error:")
    assert write(path="agents/codex/global.md").startswith("Error:")
    assert write(kind="instruction", path=active_rule.rel).startswith("Error:")
    created = json.loads(write(kind="instruction", title="Nouvelle règle"))
    assert brain.read(created["path"])["frontmatter"]["status"] == "proposed"
    assert json.loads(write(title="Un fait"))["created"] is True


def test_the_person_s_own_agents_write_rules_directly(brain, monkeypatch):
    from brain.mcp_server import handle

    def remember_via_mcp():
        reply = handle(
            brain,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "brain_remember",
                    "arguments": {"text": "Utiliser pnpm, jamais npm"},
                },
            },
        )
        return json.loads(reply["result"]["content"][0]["text"])

    monkeypatch.delenv("WORKPILOT_BRAIN_ORIGIN", raising=False)
    assert (
        "status" not in remember_via_mcp()
    )  # Claude Code, Codex… connected by the person
    assert "Utiliser pnpm, jamais npm" in awareness_section()

    monkeypatch.setenv("WORKPILOT_BRAIN_ORIGIN", "workpilot")
    reply = handle(
        brain,
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "brain_remember",
                "arguments": {"text": "Committer directement sur main"},
            },
        },
    )
    assert json.loads(reply["result"]["content"][0]["text"])["status"] == "proposed"


def test_the_server_workpilot_starts_is_marked_as_its_own(brain):
    from brain.runtime import mcp_server_config

    assert mcp_server_config()["env"]["WORKPILOT_BRAIN_ORIGIN"] == "workpilot"
