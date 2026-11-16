"""The one stream the QA reviewer and fixer run, on a scripted client.

Text is shown and logged, each tool call is shown, logged and recorded for
Session History, usage reaches the cost data, and a provider error or a
crash closes the recording as failed.
"""

from __future__ import annotations

import pytest
from qa import session_stream
from qa.session_stream import note_command, stream_session
from task_logger import get_task_logger, load_task_logs


async def _run(client, spec, **kwargs):
    kwargs.setdefault("task_logger", get_task_logger(spec))
    return await stream_session(
        client,
        "Review the login form.",
        agent_type="qa_reviewer",
        agent_name="QA Reviewer",
        tool_label="QA Tool",
        spec_dir=spec,
        project_dir=spec.parents[2],
        **kwargs,
    )


async def test_a_session_is_shown_logged_recorded_and_measured(
    qa_kit, qa_spec, replays, read_replays, capsys
):
    client = qa_kit.Client(
        [
            qa_kit.say("Checking the form."),
            qa_kit.say("   "),
            qa_kit.tool("Read", file_path="src/login.ts"),
            qa_kit.result("export const form = 1"),
            qa_kit.tool("Grep", pattern="TODO"),
            qa_kit.result("no match", error=True),
            qa_kit.tool("Bash", command="npm test"),
            qa_kit.result("3 passed"),
            qa_kit.tool("Edit", file_path="src/login.ts", new_string="fixed"),
            qa_kit.result("edited"),
            qa_kit.tool("Write", file_path="qa_report.md", content="ok"),
            qa_kit.result("written"),
            qa_kit.tool("Glob"),
            qa_kit.result("a.ts"),
        ]
    )
    commands: list[str] = []
    sent: list[bool] = []

    outcome = await _run(
        client, qa_spec, commands_seen=commands, on_query_sent=lambda: sent.append(True)
    )

    assert client.prompts == ["Review the login form."]
    assert sent == [True]
    assert outcome.response_text == "Checking the form.   "
    assert (outcome.message_count, outcome.tool_count) == (14, 6)
    assert outcome.result_error is None
    assert commands == ["npm test"]
    out = capsys.readouterr().out
    assert "Sending QA Reviewer prompt to openai agent" in out
    assert "[Error] no match" in out
    assert "[Done]" in out

    entries = load_task_logs(qa_spec)["phases"]["validation"]["entries"]
    kinds = [(e["type"], e.get("tool_name")) for e in entries]
    assert ("text", None) in kinds
    assert ("tool_start", "Read") in kinds
    ends = [e for e in entries if e["type"] == "tool_end"]
    assert [e["tool_name"] for e in ends] == [
        "Read",
        "Grep",
        "Bash",
        "Edit",
        "Write",
        "Glob",
    ]
    assert ends[0]["detail"] == "export const form = 1"  # kept for the expandable view
    assert ends[1]["content"] == "[Grep] Error: no match"
    assert ends[-1].get("detail") is None  # only Read/Grep/Bash/Edit/Write keep it

    [replay] = read_replays(replays)
    assert replay["status"] == "completed"
    assert (replay["agent_name"], replay["provider"], replay["model"]) == (
        "QA Reviewer",
        "openai",
        "gpt-5",
    )
    step_types = [s["step_type"] for s in replay["steps"]]
    for kind in (
        "agent_response",
        "file_update",
        "file_create",
        "command_run",
        "command_output",
        "tool_call",
        "tool_result",
    ):
        assert kind in step_types, kind

    usage = (qa_spec.parents[2] / ".workpilot").rglob("*.json")
    assert any("qa_reviewer" in p.read_text(encoding="utf-8") for p in usage)


async def test_verbose_shows_inputs_and_results(qa_kit, qa_spec, replays, capsys):
    client = qa_kit.Client(
        [
            qa_kit.tool("Bash", command="x" * 400),
            qa_kit.result("y" * 300),
            qa_kit.tool("Read", file_path="a.py"),
            qa_kit.result("short"),
        ]
    )

    await _run(client, qa_spec, verbose=True)

    out = capsys.readouterr().out
    assert "   Input: {'command': 'xxx" in out and "...\n" in out
    assert "   Input: {'file_path': 'a.py'}\n" in out
    assert "[Done] " + "y" * 200 + "\n" in out


async def test_without_a_task_log_the_tool_is_printed(qa_kit, qa_spec, replays, capsys):
    from core.agent_client import (
        AgentMessage,
        ContentBlock,
        ContentBlockType,
        MessageRole,
    )

    thinking = AgentMessage(
        role=MessageRole.ASSISTANT,
        content=[ContentBlock(type=ContentBlockType.THINKING, text="hmm")],
    )
    client = qa_kit.Client(
        [
            qa_kit.say("Looking."),
            thinking,
            qa_kit.tool("Read", file_path="a.py"),
            qa_kit.result("missing", error=True),
        ]
    )

    outcome = await _run(client, qa_spec, task_logger=None)

    out = capsys.readouterr().out
    assert "[QA Tool: Read]" in out and "[Error] missing" in out
    assert outcome.response_text == "Looking."  # thinking is not the answer
    assert load_task_logs(qa_spec) is None


async def test_a_result_without_a_tool_call_is_only_shown(
    qa_kit, qa_spec, replays, read_replays
):
    client = qa_kit.Client([qa_kit.result("orphan"), qa_kit.result("bad", error=True)])

    outcome = await _run(client, qa_spec)

    assert outcome.tool_count == 0
    [replay] = read_replays(replays)
    assert "tool_result" not in [s["step_type"] for s in replay["steps"]]


async def test_a_provider_error_is_returned_and_recorded_as_failed(
    qa_kit, qa_spec, replays, read_replays, capsys
):
    client = qa_kit.Client([qa_kit.say("Working")], result_error="Rate limit reached")

    outcome = await _run(client, qa_spec)

    assert outcome.result_error == "Rate limit reached"
    assert "openai session error: Rate limit reached" in capsys.readouterr().out
    assert read_replays(replays)[0]["status"] == "failed"


async def test_a_provider_error_without_a_message_names_its_subtype(
    qa_kit, qa_spec, replays
):
    client = qa_kit.Client([], result_error="")

    outcome = await _run(client, qa_spec)

    assert outcome.result_error == "SDK error (subtype=error)"


async def test_a_client_without_a_result_message_has_no_error(qa_kit, qa_spec, replays):
    client = qa_kit.Client([qa_kit.say("ok")])
    client.last_result_msg = None

    assert (await _run(client, qa_spec)).result_error is None


async def test_a_crash_is_raised_after_the_recording_is_closed(
    qa_kit, qa_spec, replays, read_replays
):
    client = qa_kit.Client([qa_kit.say("Half")], fail=ConnectionError("socket closed"))

    with pytest.raises(ConnectionError, match="socket closed"):
        await _run(client, qa_spec)

    [replay] = read_replays(replays)
    assert replay["status"] == "failed"


async def test_a_broken_replay_store_never_costs_the_session(
    qa_kit, qa_spec, monkeypatch
):
    def unavailable():
        raise OSError("read-only home")

    monkeypatch.setattr(session_stream, "get_replay_recorder", unavailable)
    client = qa_kit.Client([qa_kit.say("Fine"), qa_kit.tool("Bash", command="ls")])

    outcome = await _run(client, qa_spec)

    assert outcome.response_text == "Fine"


async def test_a_recorder_that_fails_mid_session_is_ignored(
    qa_kit, qa_spec, replays, monkeypatch
):
    from replay.recorder import ReplayRecorder

    def broken(self, *args, **kwargs):
        raise RuntimeError("disk full")

    monkeypatch.setattr(ReplayRecorder, "record_response", broken)
    client = qa_kit.Client([qa_kit.say("Still here")])

    assert (await _run(client, qa_spec)).response_text == "Still here"


async def test_a_failing_context_gauge_is_ignored(
    qa_kit, qa_spec, replays, monkeypatch
):
    class Gauge:
        monitor_only = False
        base_chars = 0

        def observe(self, message):
            raise ValueError("bad count")

    gauge = Gauge()
    monkeypatch.setattr(
        "agents.session._make_context_guard", lambda *args, **kwargs: gauge
    )
    client = qa_kit.Client([qa_kit.say("Counted")])

    outcome = await _run(client, qa_spec)

    assert outcome.response_text == "Counted"
    assert gauge.monitor_only is True
    assert gauge.base_chars == len("Review the login form.")


async def test_a_session_without_a_context_gauge_runs(
    qa_kit, qa_spec, replays, monkeypatch
):
    monkeypatch.setattr("agents.session._make_context_guard", lambda *a, **k: None)

    outcome = await _run(qa_kit.Client([qa_kit.say("No gauge")]), qa_spec)

    assert outcome.response_text == "No gauge"


@pytest.mark.parametrize(
    ("tool_input", "shown"),
    [
        ({"file_path": "a/" * 1500}, "..." + ("a/" * 1500)[-1997:]),
        ({"pattern": "TODO"}, "pattern: TODO"),
        ({"command": "c" * 2500}, "c" * 1997 + "..."),
        ({"query": "x"}, None),
    ],
)
def test_a_tool_call_shows_one_line(tool_input, shown):
    assert session_stream._input_display(tool_input) == shown


def test_the_shell_command_is_kept_whatever_the_provider_named_it():
    seen: list[str] = []

    note_command(seen, {"command": "pytest tests/test_calc.py"})
    note_command(seen, {"cmd": ["bash", "-lc", "npx vitest run a.test.ts"]})
    note_command(seen, {"file_path": "x.py"})
    note_command(seen, "not a dict")
    note_command(None, {"command": "ignored"})

    assert seen == ["pytest tests/test_calc.py", "bash -lc npx vitest run a.test.ts"]
