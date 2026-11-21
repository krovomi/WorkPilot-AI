"""How the PR reviewers read a model session: text, tools, sub-agents, structured output.

Every GitHub reviewer hands its session to `process_agent_stream` or
`process_sdk_stream` (runners/github/services/sdk_utils.py). They gather the
model's text, the structured output the reviewer asked for, the sub-agents it
started (Task tool calls) and what went wrong: a stream that breaks, a runaway
session cut by the circuit breaker, the tool-concurrency error worth a retry,
structured output the model could not produce. They also print the progress
lines the desktop app shows ("Reading app.py", "Invoking agent: security").

`process_sdk_stream` reads the Claude SDK's own message classes (the real ones
here); `process_agent_stream` reads the provider-neutral `AgentMessage`s
(`tests/test_process_agent_stream.py` covers its main path).
"""

from __future__ import annotations

import asyncio
import importlib
from types import SimpleNamespace

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from core.agent_client import ContentBlock

from tests.review_llm_fake import (
    StandInModel,
    result,
    structured,
    text,
    thinking,
    tool_result,
    tool_use,
)

sdk_utils = importlib.import_module("runners.github.services.sdk_utils")


def run(stream, *messages, **kwargs):
    model = StandInModel()
    model.answer(*messages)
    client = model.sdk() if stream is sdk_utils.process_sdk_stream else model.agent()
    return asyncio.run(stream(client=client, context_name="Review", **kwargs))


def said(*blocks) -> AssistantMessage:
    return AssistantMessage(content=list(blocks), model="claude-sonnet-4-5")


def finished(subtype="success", **extra) -> ResultMessage:
    return ResultMessage(
        subtype=subtype,
        duration_ms=1,
        duration_api_ms=1,
        is_error=False,
        num_turns=1,
        session_id="s",
        **extra,
    )


@pytest.fixture(params=[False, True], ids=["quiet", "debug"])
def debug(request, monkeypatch):
    """Both log levels: DEBUG=1 adds a line per message, nothing else changes."""
    monkeypatch.setattr(sdk_utils, "DEBUG_MODE", request.param)
    return request.param


class TestTheSdkStream:
    def test_a_review_session_yields_its_text_agents_results_and_output(
        self, debug, capsys
    ):
        seen: dict[str, list] = {"thinking": [], "tools": [], "results": [], "text": []}
        report = {"findings": []}

        out = run(
            sdk_utils.process_sdk_stream,
            ThinkingBlock(thinking="Let me look.", signature="sig"),
            ThinkingBlock(thinking="", signature="sig"),
            said(
                TextBlock(text="Starting the review."),
                TextBlock(text="   "),
                ToolUseBlock(
                    id="t1",
                    name="Task",
                    input={"subagent_type": "security", "prompt": "x" * 400},
                ),
                ToolUseBlock(
                    id="t1b", name="Task", input={"subagent_type": "security"}
                ),
                ToolUseBlock(id="r1", name="Read", input={"file_path": "src/app.py"}),
                ToolUseBlock(id="s1", name="StructuredOutput", input={}),
            ),
            UserMessage(
                content=[
                    ToolResultBlock(tool_use_id="t1", content=[TextBlock(text="ok")]),
                    ToolResultBlock(tool_use_id="r1", content="file body"),
                    TextBlock(text="not a tool result"),
                ]
            ),
            finished(structured_output=report),
            finished(structured_output={"findings": ["a duplicate"]}),
            on_thinking=seen["thinking"].append,
            on_tool_use=lambda *call: seen["tools"].append(call),
            on_tool_result=lambda *res: seen["results"].append(res),
            on_text=seen["text"].append,
            on_structured_output=lambda data: seen.setdefault("out", data),
            model="claude-sonnet-4-5-20250929",
        )

        assert out["error"] is None
        assert out["result_text"] == "Starting the review.   "
        assert out["structured_output"] is report and seen["out"] is report
        assert out["agents_invoked"] == ["security"]
        assert out["subagent_tool_ids"] == {"t1": "security"}
        assert out["msg_count"] == 6
        assert seen["thinking"] == ["Let me look."]
        assert [name for name, *_ in seen["tools"]] == [
            "Task",
            "Task",
            "Read",
            "StructuredOutput",
        ]
        assert seen["results"] == [("t1", None, "ok"), ("r1", None, "file body")]
        assert seen["text"] == ["Starting the review."]
        printed = capsys.readouterr().out
        assert "[Review] Invoking agent: security [sonnet-4.5]" in printed
        assert "[Review] Reading app.py" in printed
        assert "[Agent:security] complete: ok" in printed
        assert ("[DEBUG Review]" in printed) is debug

    def test_blocks_streamed_on_their_own_are_read_too(self, debug, capsys):
        long_result = "r" * 700
        tools: list = []

        out = run(
            sdk_utils.process_sdk_stream,
            ToolUseBlock(
                id="t1",
                name="Task",
                input={"subagent_type": "logic", "prompt": "p" * 301},
            ),
            ToolUseBlock(
                id="t2",
                name="Task",
                input={"subagent_type": "quality", "prompt": "check it"},
            ),
            ToolUseBlock(id="g1", name="Grep", input={"pattern": "TODO"}),
            ToolUseBlock(id="s1", name="StructuredOutput", input={}),
            ToolResultBlock(tool_use_id="t1", content=long_result, is_error=True),
            ToolResultBlock(tool_use_id="g1", content=[TextBlock(text="x" * 150)]),
            ToolResultBlock(tool_use_id="g2", content=""),
            on_tool_use=lambda *call: tools.append(call[0]),
            on_tool_result=lambda *res: tools.append(res[0]),
        )

        assert out["agents_invoked"] == ["logic", "quality"]
        assert tools == ["Task", "Task", "Grep", "StructuredOutput", "t1", "g1", "g2"]
        printed = capsys.readouterr().out
        assert "[Agent:logic] ERROR: " + "r" * 600 + "..." in printed
        assert "[Review] Invoking agent: logic\n" in printed
        assert "[Review] Tool result [done]: " + "x" * 100 + "..." in printed
        assert "Tool result [done]: \n" not in printed

    def test_without_callbacks_the_stream_is_still_read(self):
        out = run(
            sdk_utils.process_sdk_stream,
            ThinkingBlock(thinking="hmm", signature="s"),
            ToolUseBlock(id="t1", name="Task", input={"subagent_type": "logic"}),
            ToolResultBlock(tool_use_id="t1", content="done"),
            said(
                ToolUseBlock(id="t2", name="Task", input={"subagent_type": "quality"}),
                TextBlock(text="All good."),
            ),
            UserMessage(content=[ToolResultBlock(tool_use_id="t2", content="ok")]),
            finished(structured_output={"findings": []}),
        )

        assert out["result_text"] == "All good."
        assert out["structured_output"] == {"findings": []}
        assert out["agents_invoked"] == ["logic", "quality"]

    def test_a_long_session_reports_progress_with_the_agents_still_working(
        self, capsys
    ):
        tasks = [
            ToolUseBlock(id=f"t{n}", name="Task", input={"subagent_type": f"a{n}"})
            for n in range(2)
        ]
        filler = [said(TextBlock(text=".")) for _ in range(8)]
        done = [ToolResultBlock(tool_use_id=f"t{n}", content="ok") for n in range(2)]
        quiet = [said(TextBlock(text=".")) for _ in range(9)]
        more_filler = [said(TextBlock(text=".")) for _ in range(7)]

        run(
            sdk_utils.process_sdk_stream,
            *tasks,
            *filler,
            done[0],
            *quiet,
            done[1],
            *more_filler,
            ThinkingBlock(thinking="x", signature="s"),
            ToolUseBlock(id="t9", name="Task", input={"subagent_type": "late"}),
            *[said(TextBlock(text=".")) for _ in range(10)],
        )

        printed = capsys.readouterr().out
        assert "Processing... (10 messages, 2 agents working)" in printed
        assert "Processing... (20 messages, 1 agent working)" in printed
        assert "Processing... (30 messages)" in printed
        assert "Processing... (40 messages, 1 agent working)" in printed

    def test_a_session_without_sub_agents_reports_plain_progress(self, capsys):
        run(
            sdk_utils.process_sdk_stream,
            *[said(TextBlock(text=".")) for _ in range(10)],
        )

        assert "Processing... (10 messages)" in capsys.readouterr().out

    def test_a_runaway_session_is_cut_by_the_circuit_breaker(self):
        out = run(
            sdk_utils.process_sdk_stream,
            *[said(TextBlock(text="again")) for _ in range(5)],
            max_messages=3,
        )

        assert out["error"].startswith("Circuit breaker triggered")
        assert out["result_text"] == "again" * 3

    def test_structured_output_the_model_could_not_produce_is_an_error(self, debug):
        out = run(
            sdk_utils.process_sdk_stream,
            finished("error_max_structured_output_retries"),
            finished("error_max_structured_output_retries"),
        )

        assert out["error"] == "structured_output_validation_failed"

    def test_a_validation_failure_keeps_an_earlier_stream_error(self):
        out = run(
            sdk_utils.process_sdk_stream,
            *[said(TextBlock(text=".")) for _ in range(2)],
            finished("error_max_structured_output_retries"),
            max_messages=10,
        )
        assert out["error"] == "structured_output_validation_failed"

    def test_a_message_that_names_its_kind_in_a_type_field_is_read(self, debug, capsys):
        tagged = SimpleNamespace(type="tool_result", tool_use_id="t1", content="ok")

        out = run(sdk_utils.process_sdk_stream, tagged)

        assert out["error"] is None
        assert ("(type=tool_result)" in capsys.readouterr().out) is debug

    @pytest.mark.parametrize(
        ("answer", "retry"),
        [
            ("API Error: 400 tool_use ids were found without results", True),
            ("API Error: 400 from the tool server", True),
            ("Status 400 while the tool ran", False),
            ("A tool failed", False),
        ],
    )
    def test_only_the_tool_concurrency_error_asks_for_a_retry(self, answer, retry):
        out = run(sdk_utils.process_sdk_stream, said(TextBlock(text=answer)))

        assert (out["error"] == "tool_use_concurrency_error") is retry

    def test_the_tool_concurrency_error_asks_the_caller_to_retry(self):
        out = run(
            sdk_utils.process_sdk_stream,
            said(
                TextBlock(text="API Error: 400 tool_use ids were found without results")
            ),
        )

        assert out["error"] == "tool_use_concurrency_error"

    def test_a_malformed_message_is_skipped_and_the_rest_is_read(self, debug):
        out = run(
            sdk_utils.process_sdk_stream,
            ToolUseBlock(id="t1", name="Task", input=None),
            said(TextBlock(text="still here")),
        )

        assert out["error"] is None
        assert out["result_text"] == "still here"

    @pytest.mark.parametrize(
        ("failure", "error"),
        [
            (BrokenPipeError(), "Output pipe closed"),
            (RuntimeError("socket closed"), "socket closed"),
        ],
    )
    def test_a_broken_stream_ends_the_session_with_its_error(self, failure, error):
        out = run(
            sdk_utils.process_sdk_stream, said(TextBlock(text="partial")), failure
        )

        assert out["error"] == error
        assert out["result_text"] == "partial"


@pytest.mark.parametrize(
    ("name", "tool_input", "line"),
    [
        ("Read", {"file_path": "app.py"}, "Reading app.py"),
        ("Read", {}, "Reading file"),
        ("Grep", {"pattern": "p" * 45}, "Searching for '" + "p" * 40 + "...'"),
        ("Grep", {}, "Searching codebase"),
        ("Glob", {"pattern": "**/*.py"}, "Finding files matching '**/*.py'"),
        ("Glob", {}, "Finding files"),
        ("Bash", {"command": "ls"}, "Running: ls"),
        ("Bash", {"command": "c" * 55}, "Running: " + "c" * 50 + "..."),
        ("Bash", {}, "Running command"),
        ("Edit", {"file_path": "src/a.py"}, "Editing a.py"),
        ("Edit", {"file_path": "a.py"}, "Editing a.py"),
        ("Edit", {}, "Editing file"),
        ("Write", {"file_path": "src/b.py"}, "Writing b.py"),
        ("Write", {"file_path": "b.py"}, "Writing b.py"),
        ("Write", {}, "Writing file"),
        ("WebSearch", {}, "Using tool: WebSearch"),
    ],
)
def test_each_tool_call_is_shown_in_words(name, tool_input, line, capsys):
    run(sdk_utils.process_agent_stream, tool_use(name, tool_input, "t1"))

    assert f"[Review] {line}\n" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("model", "shown"),
    [
        ("claude-opus-4-5-20251101", "opus-4.5"),
        ("claude-sonnet-4-5-20250929", "sonnet-4.5"),
        ("claude-haiku-4-5", "haiku-4"),
        ("claude-3-5-sonnet-20241022", "sonnet-3.5"),
        ("claude-3-5-haiku-20241022", "haiku-3.5"),
        ("claude-3-opus-20240229", "opus-3"),
        ("claude-3-sonnet-20240229", "sonnet-3"),
        ("claude-3-haiku-20240307", "haiku-3"),
        ("claude-sonnet-5", "sonnet"),
        ("gpt-5-codex", "gpt-5-codex"),
        ("a-very-long-local-model-name", "a-very-long-local-mo"),
        ("llama3", "llama3"),
        ("", "unknown"),
    ],
)
def test_a_sub_agent_is_announced_with_a_short_model_name(model, shown, capsys):
    run(
        sdk_utils.process_agent_stream,
        tool_use("Task", {"subagent_type": "logic"}, "t1"),
        model=model or None,
    )

    printed = capsys.readouterr().out
    if model:
        assert f"Invoking agent: logic [{shown}]" in printed
    else:
        assert "Invoking agent: logic\n" in printed
    assert sdk_utils._short_model_name(model or None) == shown


class TestTheAgentStream:
    def test_a_client_that_is_not_an_agent_client_is_read_as_the_sdk_s(self):
        model = StandInModel()
        model.answer(said(TextBlock(text="raw")))

        out = asyncio.run(sdk_utils.process_agent_stream(client=model.sdk()))

        assert out["result_text"] == "raw"

    def test_quiet_blocks_and_missing_callbacks_are_skipped(self):
        out = run(
            sdk_utils.process_agent_stream,
            thinking(""),
            thinking("considering"),
            text(""),
            text("   "),
            text("Answer."),
            structured({}),
            structured({"first": 1}),
            structured({"second": 2}),
            result("success"),
            result("success", {"third": 3}),
            tool_use("Task", {"subagent_type": "logic"}, "t1"),
            tool_result("t1", [ContentBlock(type="text", text="ok")]),
            tool_result("t2", None),
            tool_use("StructuredOutput", {}, "s1"),
            text(None),
        )

        assert out["result_text"] == "   Answer."
        assert out["structured_output"] == {"first": 1}

    def test_a_result_block_carries_the_output_when_nothing_came_before(self):
        got: list = []

        out = run(
            sdk_utils.process_agent_stream,
            result("success", {"verdict": "ok"}),
            result("success", {"verdict": "later"}),
            on_structured_output=got.append,
        )

        assert out["structured_output"] == {"verdict": "ok"} and got == [
            {"verdict": "ok"}
        ]

    def test_a_result_block_without_a_callback_still_gives_the_output(self):
        out = run(sdk_utils.process_agent_stream, result("success", {"v": 1}))

        assert out["structured_output"] == {"v": 1}

    def test_structured_output_without_a_callback_is_kept(self):
        out = run(sdk_utils.process_agent_stream, structured({"v": 2}))

        assert out["structured_output"] == {"v": 2}

    def test_structured_output_the_model_could_not_produce_is_an_error(self):
        out = run(
            sdk_utils.process_agent_stream,
            result("error_max_structured_output_retries"),
            result("error_max_structured_output_retries"),
        )

        assert out["error"] == "structured_output_validation_failed"

    def test_an_unknown_block_kind_is_left_aside(self):
        message = text("kept")
        message.content.append(ContentBlock(type="annotation", text="aside"))

        out = run(sdk_utils.process_agent_stream, message)

        assert out["result_text"] == "kept"

    def test_a_long_session_reports_the_agents_still_working(self, capsys):
        run(
            sdk_utils.process_agent_stream,
            tool_use("Task", {"subagent_type": "a"}, "t1"),
            tool_use("Task", {"subagent_type": "b"}, "t2"),
            *[text(".") for _ in range(8)],
            tool_result("t1", "done"),
            *[text(".") for _ in range(9)],
            tool_result("t2", "done"),
            *[text(".") for _ in range(9)],
        )

        printed = capsys.readouterr().out
        assert "(10 messages, 2 agents working)" in printed
        assert "(20 messages, 1 agent working)" in printed
        assert "Processing... (30 messages)\n" in printed

    def test_a_malformed_message_is_skipped(self):
        broken = text("x")
        broken.content = None

        out = run(sdk_utils.process_agent_stream, broken, text("after"))

        assert out["result_text"] == "after"

    @pytest.mark.parametrize(
        ("failure", "error"),
        [
            (BrokenPipeError(), "Output pipe closed"),
            (RuntimeError("socket closed"), "socket closed"),
        ],
    )
    def test_a_broken_stream_ends_with_its_error(self, failure, error):
        out = run(sdk_utils.process_agent_stream, text("partial"), failure)

        assert out["error"] == error
        assert out["result_text"] == "partial"
