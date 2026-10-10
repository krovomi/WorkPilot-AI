"""An agent type declares the tools its prompts use.

`AGENT_CONFIGS[agent_type]["tools"]` used to decide what an agent was
auto-approved for and nothing else: the settings file `create_client` writes
granted `Write`, `Edit` and `Bash(*)` to every type, so a declaration could be
wrong in either direction without anything noticing. `ideation` wrote its JSON
with shell heredocs while declaring read and web only; the review skill asked a
phase with no shell for `git diff`.

Declarations are now enforced (`undeclared_builtin_tools`, the tool executor's
gate), so a prompt asking for a tool its type does not declare is a feature
that silently stops working. These tests read the prompts each type loads and
hold the declaration to them — the rule `test_spec_agent_configuration` applies
to the spec pipeline, extended to the rest of the product.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "apps" / "backend"
sys.path.insert(0, str(BACKEND))

PROMPTS = BACKEND / "prompts"

# The prompts a type loads, where no table in the code already says so.
# Kept explicit: an agent type that starts loading a new prompt is a line here.
_DECLARED_HERE: dict[str, list[str]] = {
    "architecture_reviewer": ["architecture_reviewer.md"],
    "architecture_visualizer": [
        "architecture_visualizer.md",
        "architecture_map_delta.md",
        "architecture_map_repair.md",
    ],
    "pr_reviewer": [
        "github/pr_security_agent.md",
        "github/pr_quality_agent.md",
        "github/pr_logic_agent.md",
        "github/pr_codebase_fit_agent.md",
        "github/pr_structural.md",
        "github/pr_ai_triage.md",
        "github/pr_reviewer.md",
    ],
    "pr_orchestrator_parallel": ["github/pr_parallel_orchestrator.md"],
    "pr_followup_parallel": [
        "github/pr_followup_orchestrator.md",
        "github/pr_followup_resolution_agent.md",
        "github/pr_followup_newcode_agent.md",
        "github/pr_followup_comment_agent.md",
    ],
    "pr_finding_validator": ["github/pr_finding_validator.md"],
    "pr_template_filler": ["github/pr_template_filler.md"],
    "planner": ["planner.md"],
    "coder": ["coder.md"],
    "qa_reviewer": ["qa_reviewer.md"],
    "qa_fixer": ["qa_fixer.md"],
}

_SHELL = re.compile(
    r"cat >|<< ?'?EOF|sed -i|```(?:bash|sh|shell)\b|`git (?:diff|log|show|status)"
)
_WRITE = re.compile(r"\bWrite` tool|\bWrite tool|the `Write`")


def _prompt_table() -> list[tuple[str, Path]]:
    """(agent_type, file) for every prompt and skill body a type is run with."""
    rows: list[tuple[str, Path]] = []
    for agent_type, files in _DECLARED_HERE.items():
        rows += [(agent_type, PROMPTS / f) for f in files]

    # Tables the code already keeps: read them rather than copy them.
    from ideation.generator import IDEATION_TYPE_PROMPTS
    from runners.roadmap.executor import PROMPT_AGENT_TYPES as ROADMAP

    rows += [("ideation", PROMPTS / f) for f in IDEATION_TYPE_PROMPTS.values()]
    rows += [(t, PROMPTS / f) for f, t in ROADMAP.items()]

    # Workflow skill phases: the SKILL.md each one is handed, under the agent
    # type the runner opens it with.
    from workflows.runner import SKILL_PHASE_AGENTS
    from workflows.spec import load_workflow

    workflow = load_workflow(
        REPO_ROOT / "workflows" / "feature-build" / "workflow.yaml"
    )
    for phase in workflow.phases:
        agent_type = phase.agent or SKILL_PHASE_AGENTS.get(phase.id)
        if not agent_type or "/" not in phase.impl:
            continue
        pack, skill = phase.impl.split("/", 1)
        body = REPO_ROOT / "skills" / pack / skill / "SKILL.md"
        if body.is_file():
            rows.append((agent_type, body))
    return rows


ROWS = _prompt_table()


def _row_id(row: tuple[str, Path]) -> str:
    agent_type, path = row
    return f"{agent_type}:{path.relative_to(REPO_ROOT)}"


def test_the_table_names_real_types_and_files():
    from agents.tools_pkg.models import AGENT_CONFIGS

    assert ROWS, "no prompt found: the guard below would pass on nothing"
    for agent_type, path in ROWS:
        assert agent_type in AGENT_CONFIGS, agent_type
        assert path.is_file(), path


def test_the_skill_phases_are_covered():
    """The read-only phases are the ones a wrong declaration hurts most."""
    covered = {t for t, p in ROWS if p.name == "SKILL.md"}
    assert {"spec_critic", "spec_validation", "pr_reviewer"} <= covered


@pytest.mark.parametrize("row", ROWS, ids=_row_id)
def test_each_prompt_is_run_with_the_tools_it_uses(row):
    from agents.tools_pkg.models import AGENT_CONFIGS

    agent_type, path = row
    config = AGENT_CONFIGS[agent_type]
    tools = set(config["tools"])
    text = path.read_text(encoding="utf-8")

    if match := _SHELL.search(text):
        assert "Bash" in tools, f"{path.name} uses the shell ({match.group(0)!r})"
    if match := _WRITE.search(text):
        assert "Write" in tools, f"{path.name} asks for the Write tool"
    if "mcp__context7__" in text:
        assert "context7" in config["mcp_servers"], f"{path.name} asks Context7"
    if re.search(r"\bWeb(?:Search|Fetch)\b", text):
        assert {"WebSearch", "WebFetch"} <= tools, f"{path.name} searches the web"


def test_ideation_declares_the_writes_it_makes():
    """The executor validates `<type>_ideas.json` on disk; three prompts write
    it with a heredoc. It ran on the settings file's blanket grants."""
    from agents.tools_pkg.models import AGENT_CONFIGS

    assert {"Write", "Bash"} <= set(AGENT_CONFIGS["ideation"]["tools"])
    assert "Edit" not in AGENT_CONFIGS["ideation"]["tools"]


def test_skill_phases_are_told_their_answer_is_the_report():
    """Every skill phase is read-only and `_write_output` saves the answer:
    asking it to write a file asks for a tool it does not have."""
    from workflows.runner import _REPORTING

    assert "write the file" not in _REPORTING
    assert "answer" in _REPORTING


def test_the_tool_hint_promises_no_tool_by_name():
    from core.llm_optimization import _TOOL_USE_HINT

    for name in ("write_file", "run_command"):
        assert name not in _TOOL_USE_HINT
