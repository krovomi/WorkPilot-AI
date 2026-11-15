"""AgentRunner: one spec session, on the Claude SDK stream or on any other
provider's AgentClient, and what a failed session answers the orchestrator."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from core.agent_client import (
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    LocalModelRuntimeError,
    MessageRole,
    OpenAIAgentClient,
)
from spec.pipeline.agent_runner import AgentRunner, agent_type_for
from task_logger import TaskLogger


# The Claude SDK stream is told apart by class name, as the SDK's are.
class TextBlock:
    def __init__(self, text):
        self.text = text


class ToolUseBlock:
    def __init__(self, name, input):
        self.name = name
        self.input = input


class ToolResultBlock:
    def __init__(self, content, is_error=False):
        self.content = content
        self.is_error = is_error


class AssistantMessage:
    def __init__(self, *content):
        self.content = list(content)


class UserMessage:
    def __init__(self, *content):
        self.content = list(content)


class SystemMessage:
    def __init__(self, subtype):
        self.subtype = subtype


class SdkClient:
    def __init__(self, messages=(), error=None):
        self.messages = list(messages)
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
        for message in self.messages:
            yield message


class ProviderClient(SdkClient):
    model = "qwen3"

    def provider_name(self):
        return "ollama"


class OpenAIClient(OpenAIAgentClient):
    """The real class, for its isinstance check, without its HTTP setup."""

    def __init__(self, project_dir, messages):
        self._project_dir = str(project_dir)
        self.model = "gpt-test"
        self.messages = messages
        self.prompts = []

    def provider_name(self):
        return "openai"

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt):
        self.prompts.append(prompt)

    async def receive_response(self):
        for message in self.messages:
            yield message


def _assistant(*blocks):
    return AgentMessage(role=MessageRole.ASSISTANT, content=list(blocks))


@pytest.fixture
def dirs(tmp_path: Path) -> tuple[Path, Path]:
    project = tmp_path / "app"
    spec = project / ".workpilot" / "specs" / "001-x"
    spec.mkdir(parents=True)
    for name in ("project_index.json", "requirements.json"):
        (spec / name).write_text("{}", encoding="utf-8")
    return project, spec


def _runner(dirs, logger=True) -> AgentRunner:
    project, spec = dirs
    return AgentRunner(
        project,
        spec,
        "sonnet",
        TaskLogger(spec, emit_markers=False) if logger else None,
    )


def _use_provider(monkeypatch, provider, client):
    created = {}

    def factory(**kwargs):
        created.update(kwargs)
        return client

    # By name: a test elsewhere may have put another core.client module in
    # sys.modules, which is the one the runner imports from.
    monkeypatch.setattr("core.client.peek_active_provider", lambda spec_dir: provider)
    name = "create_client" if provider == "claude" else "create_agent_client"
    monkeypatch.setattr(f"core.client.{name}", factory)
    return created


def test_research_and_critique_run_under_their_own_agent_types() -> None:
    assert agent_type_for("spec_researcher.md") == "spec_researcher"
    assert agent_type_for("spec_critic.md") == "spec_self_critique"
    assert agent_type_for("planner.md") == "spec_writer"


async def test_a_missing_prompt_fails_before_any_client(dirs) -> None:
    ok, message = await _runner(dirs).run_agent("no_such_prompt.md")

    assert not ok and message.startswith("Prompt not found")


async def test_a_claude_session_streams_text_and_tools_into_the_task_log(
    dirs, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = SdkClient(
        [
            AssistantMessage(
                TextBlock("Reading the requirements before writing the spec."),
                ToolUseBlock("Read", {"file_path": "requirements.json"}),
            ),
            UserMessage(ToolResultBlock('{"task": "export"}')),
            AssistantMessage(ToolUseBlock("Bash", {"command": "ls"})),
            UserMessage(ToolResultBlock("permission denied", is_error=True)),
            SystemMessage("rate_limit_event"),
            SystemMessage("init"),
        ]
    )
    created = _use_provider(monkeypatch, "claude", client)
    runner = _runner(dirs)

    ok, text = await runner.run_agent(
        "spec_writer.md",
        additional_context="Write the spec now.",
        thinking_budget=2048,
        prior_phase_summaries="## Context from Previous Phases",
    )

    assert ok and text == "Reading the requirements before writing the spec."
    assert created["agent_type"] == "spec_writer"
    assert created["max_thinking_tokens"] == 2048
    prompt = client.prompts[0]
    assert "Write the spec now." in prompt
    assert "## Context from Previous Phases" in prompt
    assert "{{MIN_COVERAGE}}" not in prompt
    entries = json.dumps(runner.task_logger.get_logs())
    assert "requirements.json" in entries and "permission denied" in entries


async def test_an_empty_claude_session_is_a_failure(dirs, monkeypatch) -> None:
    _use_provider(monkeypatch, "claude", SdkClient([AssistantMessage(TextBlock("ok"))]))

    ok, message = await _runner(dirs).run_agent("planner.md")

    assert not ok and message.startswith("Agent session empty (0 tools, 2b output)")


@pytest.mark.parametrize(
    ("error", "sentinel"),
    [
        (RuntimeError("Prompt is too long: 250000 tokens"), "PROMPT_TOO_LONG_HALT::"),
        (
            RuntimeError("Unknown message type: rate_limit_event"),
            "RATE_LIMIT_RETRY_REQUIRED::",
        ),
        (RuntimeError("connection reset"), ""),
    ],
)
async def test_a_failed_claude_session_says_why(
    dirs, monkeypatch, error, sentinel
) -> None:
    _use_provider(monkeypatch, "claude", SdkClient(error=error))

    ok, message = await _runner(dirs).run_agent("planner.md")

    assert not ok
    assert message.startswith(sentinel)
    assert message.endswith(str(error))


async def test_another_provider_streams_through_its_agent_client(
    dirs, monkeypatch
) -> None:
    client = ProviderClient(
        [
            _assistant(
                ContentBlock(type=ContentBlockType.TEXT, text="Planning the export.")
            ),
            _assistant(
                ContentBlock(
                    type=ContentBlockType.TOOL_USE,
                    tool_name="Write",
                    tool_input={"file_path": "implementation_plan.json"},
                ),
                ContentBlock(
                    type=ContentBlockType.TOOL_RESULT, result_content="written"
                ),
                ContentBlock(
                    type=ContentBlockType.TOOL_USE,
                    tool_name="Grep",
                    tool_input={"pattern": "csv"},
                ),
                ContentBlock(
                    type=ContentBlockType.TOOL_RESULT,
                    result_content="no match",
                    is_error=True,
                ),
            ),
        ]
    )
    created = _use_provider(monkeypatch, "ollama", client)
    runner = _runner(dirs)

    ok, text = await runner.run_agent("spec_critic.md", thinking_budget=None)

    assert ok and text == "Planning the export."
    assert created["provider"] == "ollama"
    assert created["agent_type"] == "spec_self_critique"
    entries = json.dumps(runner.task_logger.get_logs())
    assert "implementation_plan.json" in entries and "no match" in entries


async def test_a_task_that_owns_its_engine_uses_the_spec_phase_provider(
    dirs, monkeypatch
) -> None:
    monkeypatch.setattr("phase_config.is_engine_locked", lambda spec_dir: True)
    monkeypatch.setattr(
        "phase_config.get_phase_provider", lambda spec_dir, phase: "Ollama"
    )
    client = ProviderClient(
        [
            _assistant(
                ContentBlock(
                    type=ContentBlockType.TOOL_USE, tool_name="Write", tool_input={}
                )
            )
        ]
    )
    created = _use_provider(monkeypatch, "claude", None)
    monkeypatch.setattr(
        "core.client.create_agent_client", lambda **kw: created.update(kw) or client
    )

    ok, _ = await _runner(dirs, logger=False).run_agent("planner.md")

    assert ok and created["provider"] == "ollama"


async def test_an_empty_session_on_another_provider_is_a_failure(
    dirs, monkeypatch
) -> None:
    _use_provider(monkeypatch, "ollama", ProviderClient([]))

    ok, message = await _runner(dirs).run_agent("planner.md")

    assert not ok and "provider=ollama" in message


@pytest.mark.parametrize(
    ("error", "sentinel"),
    [
        (
            RuntimeError("request exceeds the available context size (4096 tokens)"),
            "PROMPT_TOO_LONG_HALT::",
        ),
        (
            RuntimeError("Rate limit reached for gpt-test"),
            "RATE_LIMIT_RETRY_REQUIRED::",
        ),
        (RuntimeError("bad gateway"), ""),
    ],
)
async def test_a_failed_session_on_another_provider_gets_the_same_sentinels(
    dirs, monkeypatch, error, sentinel
) -> None:
    # Before, only the Claude stream recognised these: an overflowing Ollama
    # prompt or an OpenAI rate limit failed the spec instead of halting or
    # pausing it.
    _use_provider(monkeypatch, "ollama", ProviderClient(error=error))

    ok, message = await _runner(dirs).run_agent("planner.md")

    assert not ok and message.startswith(sentinel)
    if sentinel.startswith("RATE"):
        assert "hit your limit — ollama error" in message


async def test_a_local_runtime_error_is_raised_to_the_caller(dirs, monkeypatch) -> None:
    _use_provider(
        monkeypatch,
        "ollama",
        ProviderClient(error=LocalModelRuntimeError("ollama is not running")),
    )

    with pytest.raises(LocalModelRuntimeError):
        await _runner(dirs).run_agent("planner.md")


async def test_the_validation_fixer_on_openai_works_in_the_spec_directory(
    dirs, monkeypatch
) -> None:
    project, spec = dirs
    client = OpenAIClient(
        project,
        [
            _assistant(
                ContentBlock(
                    type=ContentBlockType.TOOL_USE,
                    tool_name="Edit",
                    tool_input={"path": "spec.md"},
                )
            )
        ],
    )
    _use_provider(monkeypatch, "openai", client)

    ok, _ = await _runner(dirs, logger=False).run_agent("validation_fixer.md")

    assert ok
    assert f"Tool working directory: {spec.resolve()}" in client.prompts[0]
    assert Path(client._tool_working_directory) == spec.resolve()


def test_tool_inputs_shown_in_the_activity_feed() -> None:
    show = AgentRunner._extract_tool_input_display

    assert show("not a dict") is None
    assert show({"pattern": "TODO"}) == "pattern: TODO"
    assert show({"file_path": "a" * 2500}).startswith("...")
    assert show({"command": "x" * 2500}).endswith("...")
    assert show({"path": "src"}) == "src"
    assert show({"other": 1}) is None


def test_tool_details_kept_for_reading_tools_only() -> None:
    detail = AgentRunner._get_tool_detail_content

    assert detail("WebFetch", "page") is None
    assert detail("Read", "content") == "content"
    assert detail("Read", "x" * 60000) is None


async def test_the_coverage_threshold_defaults_when_the_gate_cannot_say(
    dirs, monkeypatch, capsys
) -> None:
    def broken():
        raise ValueError("WORKPILOT_QA_MIN_COVERAGE=abc")

    monkeypatch.setattr("qa.coverage_gate.get_min_coverage", broken)
    client = SdkClient(
        [AssistantMessage(ToolUseBlock("Write", {"file_path": "p.json"}))]
    )
    _use_provider(monkeypatch, "claude", client)

    ok, _ = await _runner(dirs, logger=False).run_agent("planner.md")

    assert ok
    assert "{{MIN_COVERAGE}}" not in client.prompts[0]
    assert "100" in client.prompts[0]
    # Without a task log, a tool call is still shown on the console.
    assert "[Tool: Write]" in capsys.readouterr().out


class Gauge:
    monitor_only = False

    def __init__(self):
        self.started = None

    def report_start(self, prompt):
        self.started = prompt

    def observe(self, message):
        raise RuntimeError("gauge broken")


@pytest.mark.parametrize("guard", ["raises", "breaks"])
async def test_a_broken_context_gauge_never_stops_the_session(
    dirs, monkeypatch, guard
) -> None:
    gauge = Gauge()

    def make_guard(*args):
        if guard == "raises":
            raise RuntimeError("no gauge")
        return gauge

    monkeypatch.setattr("agents.session._make_context_guard", make_guard)
    client = SdkClient(
        [AssistantMessage(ToolUseBlock("Write", {"file_path": "p.json"}))]
    )
    _use_provider(monkeypatch, "claude", client)

    ok, _ = await _runner(dirs).run_agent("planner.md")

    assert ok
    if guard == "breaks":
        assert gauge.monitor_only is True and gauge.started == client.prompts[0]
