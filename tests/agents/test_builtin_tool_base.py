"""The built-in Claude Code tools a session is offered (`agents.tools_pkg.builtin_base`).

A trivial card on 2026-11-28 re-read ~20 k tokens of unused tool schemas
(Agent, Workflow, Monitor, Cron, worktree tools…) on each of its 27 API turns.
"""

from __future__ import annotations

import pytest
from agents.tools_pkg.builtin_base import (
    ENV,
    builtin_tool_base,
    restrict_builtin_tools,
)

#: CLI built-ins no WorkPilot agent declares; none of them may reach a session.
UNDECLARED = {
    "DesignSync",
    "Monitor",
    "SendMessage",
    "Workflow",
    "CronCreate",
    "RemoteTrigger",
    "ScheduleWakeup",
    "EnterWorktree",
    "ExitWorktree",
    "ReportFindings",
    "ListAgents",
    "PushNotification",
}


@pytest.fixture(autouse=True)
def _switch_on(monkeypatch):
    monkeypatch.delenv(ENV, raising=False)


def test_a_summarizer_gets_no_builtin_tool():
    assert builtin_tool_base("spec_compaction") == []


def test_a_reader_gets_only_what_it_declares_plus_tool_search():
    base = builtin_tool_base("spec_validation")
    assert set(base) == {"Read", "Glob", "Grep", "ToolSearch"}
    assert not UNDECLARED & set(base)


def test_the_coder_keeps_its_tools_agent_and_skills():
    base = builtin_tool_base("coder", subagents=True, skills=True)
    assert {"Read", "Write", "Edit", "Bash", "WebFetch", "Agent", "Skill"} <= set(base)
    assert not UNDECLARED & set(base)


def test_disallowed_always_wins():
    base = builtin_tool_base("coder", disallowed=["Bash", "WebFetch"])
    assert "Bash" not in base and "WebFetch" not in base


def test_unknown_type_and_switch_off_leave_the_cli_default(monkeypatch):
    assert builtin_tool_base("not_a_registered_type") is None
    monkeypatch.setenv(ENV, "0")
    assert builtin_tool_base("coder") is None


def test_restrict_reads_what_the_factory_decided():
    options = {
        "agents": {"explorer": object()},
        "setting_sources": ["project", "user"],
        "disallowed_tools": ["WebSearch"],
    }
    restrict_builtin_tools(options, "coder", extra=("REPL",))
    tools = options["tools"]
    assert {"Agent", "Skill", "REPL"} <= set(tools)
    assert "WebSearch" not in tools


def test_restrict_without_subagents_or_user_sources():
    options = {"setting_sources": ["project"]}
    restrict_builtin_tools(options, "qa_reviewer")
    assert "Agent" not in options["tools"]
    assert "Skill" not in options["tools"]


def test_restrict_leaves_an_unknown_type_alone():
    options: dict = {}
    restrict_builtin_tools(options, "not_a_registered_type")
    assert "tools" not in options


class TestTheFactories:
    """Both factories hand the base to the CLI (`--tools`)."""

    def test_simple_client_summarizer_gets_an_empty_base(self, monkeypatch, tmp_path):
        from tests.core.test_setting_sources import _simple_client

        options = _simple_client(monkeypatch, tmp_path, "spec_compaction")
        assert options["tools"] == []

    def test_create_client_reviewer_gets_its_declaration(self, monkeypatch, tmp_path):
        from tests.core.test_setting_sources import _create_client

        options = _create_client(monkeypatch, tmp_path, "qa_reviewer")
        assert {"Read", "Bash", "Edit", "ToolSearch"} <= set(options["tools"])
        assert not UNDECLARED & set(options["tools"])

    def test_create_client_switch_off_keeps_the_cli_default(
        self, monkeypatch, tmp_path
    ):
        from tests.core.test_setting_sources import _create_client

        monkeypatch.setenv(ENV, "off")
        options = _create_client(monkeypatch, tmp_path, "qa_reviewer")
        assert "tools" not in options
