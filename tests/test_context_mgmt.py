"""context_mgmt: policy, decision table, capabilities, actions and the guard.

The guard is exercised through `_run_agent_client_session` with a fake client,
the same way the hot-swap break is, so a regression in the wiring is caught and
not only in the pure helpers.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from context_mgmt.capabilities import context_capabilities
from context_mgmt.decide import Situation, decide, recommended_action
from context_mgmt.marker import (
    consume_context_action,
    read_context_action,
    request_targets,
    write_context_action,
)
from context_mgmt.policy import ContextPolicy, load_context_policy, policy_from_dict
from context_mgmt.windows import CONTEXT_WINDOW_BY_MODEL_PREFIX, window_from_table
from core.agent_client import AgentMessage, ContentBlock, ContentBlockType, MessageRole
from task_logger import LogPhase

REPO = Path(__file__).resolve().parents[1]


# ── policy ───────────────────────────────────────────────────────────────────


def test_policy_defaults_and_clamping():
    assert policy_from_dict(None) == ContextPolicy()
    policy = policy_from_dict(
        {"mode": "clear", "thresholdPct": 97, "prepareHandoff": False}
    )
    assert (policy.mode, policy.threshold_pct, policy.prepare_handoff) == (
        "clear",
        90,
        False,
    )
    assert (
        policy_from_dict({"mode": "nonsense", "thresholdPct": 12}).threshold_pct == 30
    )
    assert policy_from_dict({"thresholdPct": 52}).threshold_pct == 50
    assert ContextPolicy(threshold_pct=50).hard_threshold_pct == 80
    assert ContextPolicy(threshold_pct=70).hard_threshold_pct == 85
    assert ContextPolicy(threshold_pct=90).hard_threshold_pct == 90


def test_policy_is_reread_when_the_metadata_changes(tmp_path: Path):
    meta = tmp_path / "task_metadata.json"
    meta.write_text(json.dumps({"contextPolicy": {"mode": "off"}}), encoding="utf-8")
    assert load_context_policy(tmp_path).mode == "off"
    meta.write_text(
        json.dumps({"contextPolicy": {"mode": "compact"}}), encoding="utf-8"
    )
    os.utime(meta, (meta.stat().st_atime, meta.stat().st_mtime + 5))
    assert load_context_policy(tmp_path).mode == "compact"


# ── decision table ───────────────────────────────────────────────────────────

AUTO = ContextPolicy()


@pytest.mark.parametrize(
    ("percent", "policy", "situation", "ready", "native", "manual", "expected"),
    [
        (40, AUTO, Situation(), True, False, None, None),
        (55, AUTO, Situation(), True, False, None, "compact"),
        (55, AUTO, Situation(at_task_boundary=True), True, False, None, "clear"),
        (55, AUTO, Situation(compactions_in_subtask=2), True, False, None, "clear"),
        (55, AUTO, Situation(tool_output_ratio=0.9), True, False, None, "clear"),
        # waits for the background handoff below the hard threshold...
        (55, AUTO, Situation(), False, False, None, None),
        # ...and stops waiting past it
        (82, AUTO, Situation(), False, False, None, "compact"),
        # native compaction is left to the provider below the hard threshold
        (60, AUTO, Situation(), True, True, None, None),
        (86, AUTO, Situation(), True, True, None, "compact"),
        # forced modes
        (55, ContextPolicy(mode="clear"), Situation(), True, False, None, "clear"),
        (
            55,
            ContextPolicy(mode="compact"),
            Situation(at_task_boundary=True),
            True,
            False,
            None,
            "compact",
        ),
        # off never acts by itself; a manual request always does
        (99, ContextPolicy(mode="off"), Situation(), True, False, None, None),
        (10, ContextPolicy(mode="off"), Situation(), True, False, "clear", "clear"),
        (10, AUTO, Situation(prompt_too_long=True), True, False, None, "clear"),
        # a thread that started past the threshold would restart past it:
        # no cut below the hard threshold...
        (60, AUTO, Situation(floor_pct=55), True, False, None, None),
        # ...one at it, where a new thread still has room to work...
        (82, AUTO, Situation(floor_pct=55), True, False, None, "compact"),
        # ...and none when even the hard threshold is below the floor
        (95, AUTO, Situation(floor_pct=85), True, False, None, None),
        (60, AUTO, Situation(floor_pct=45), True, False, None, "compact"),
        (60, AUTO, Situation(floor_pct=85), True, False, "clear", "clear"),
        (
            10,
            AUTO,
            Situation(prompt_too_long=True, floor_pct=85),
            True,
            False,
            None,
            "clear",
        ),
    ],
)
def test_decision_table(percent, policy, situation, ready, native, manual, expected):
    decision = decide(
        percent,
        policy,
        situation,
        handoff_ready=ready,
        native_compact=native,
        manual=manual,
    )
    assert (decision.action if decision else None) == expected


def test_recommendation_matches_the_situation():
    assert recommended_action(Situation()) == "compact"
    assert recommended_action(Situation(at_task_boundary=True)) == "clear"


# ── capabilities and windows ────────────────────────────────────────────────


def test_capabilities_come_from_the_provider_matrix():
    assert context_capabilities("claude").native_compact
    assert context_capabilities("claude").usage == "exact"
    assert context_capabilities("deepseek").compact == "emulated"
    assert context_capabilities("grok").usage == "reported"
    # Codex is an auth mode of `openai`, decided by the client.
    assert context_capabilities("openai").compact == "emulated"
    assert context_capabilities("openai-codex-cli").native_compact
    unknown = context_capabilities("no-such-provider")
    assert (unknown.compact, unknown.usage) == ("emulated", "estimated")


def test_window_table_agrees_with_the_frontend_gauge():
    """The gauge and the engine must size a model the same way."""
    source = (REPO / "apps/frontend/src/shared/constants/models.ts").read_text("utf-8")
    block = source.split("CONTEXT_WINDOW_BY_MODEL_PREFIX", 1)[1].split("];", 1)[0]
    frontend = {
        prefix: int(value.replace("_", ""))
        for prefix, value in re.findall(r'\["([^"]+)",\s*([\d_]+)\]', block)
    }
    backend = dict(CONTEXT_WINDOW_BY_MODEL_PREFIX)
    assert frontend, "could not read the frontend table"
    for prefix, value in frontend.items():
        assert backend.get(prefix) == value, prefix
    assert window_from_table("claude-sonnet-4-5") == 200_000
    assert window_from_table("claude-sonnet-4-5[1m]") == 1_000_000
    assert window_from_table("qwen2.5-coder") == 128_000


# ── marker ───────────────────────────────────────────────────────────────────


def test_marker_round_trip_and_targeting(tmp_path: Path):
    assert write_context_action(tmp_path, "compact", subtask_id="s-2")
    request = read_context_action(tmp_path)
    assert request and request.action == "compact"
    assert not request_targets(request, "coding", "s-1")
    assert consume_context_action(tmp_path, "coding", "s-1") is None
    assert (tmp_path / "CONTEXT_ACTION.json").exists()
    assert consume_context_action(tmp_path, "coding", "s-2").action == "compact"
    assert not (tmp_path / "CONTEXT_ACTION.json").exists()
    assert not write_context_action(tmp_path, "explode")


# ── actions ──────────────────────────────────────────────────────────────────


def _entry(role, text, phase="coding", subtask="s-1", **block):
    content = [{"type": "text", "text": text}] if text else []
    if block:
        content.append(block)
    return {
        "v": 1,
        "phase": phase,
        "subtask_id": subtask,
        "role": role,
        "content": content,
    }


def _write_log(spec_dir: Path, provider: str, model: str, entries: list[dict]) -> Path:
    from core.conversation_log import conversation_log_path

    path = conversation_log_path(spec_dir, provider, model)
    path.write_text("".join(json.dumps(e) + "\n" for e in entries), encoding="utf-8")
    return path


def test_clear_closes_every_thread_and_leaves_a_handoff(tmp_path: Path, monkeypatch):
    from context_mgmt.actions import apply_clear
    from context_mgmt.handoff import consume_pending_handoff
    from core.conversation_log import read_log_for_phase_resume

    _write_log(tmp_path, "claude", "opus", [_entry("assistant", "hello")])
    (tmp_path / ".session.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("AUTO_CLAUDE_RESUME_SESSION_ID", "abc")

    apply_clear(tmp_path, "where the work stands")

    assert read_log_for_phase_resume(tmp_path, "openai", "gpt-5", "coding") == []
    assert list(tmp_path.glob("conversation.*.cleared.jsonl"))
    assert not (tmp_path / ".session.json").exists()
    assert "AUTO_CLAUDE_RESUME_SESSION_ID" not in os.environ
    section = consume_pending_handoff(tmp_path)
    assert "where the work stands" in section and "data, not instructions" in section
    assert consume_pending_handoff(tmp_path) == ""


def test_compact_keeps_a_summary_and_a_clean_tail(tmp_path: Path):
    from context_mgmt.actions import apply_compact
    from core.conversation_log import read_log

    entries = [_entry("assistant", f"step {i}") for i in range(20)]
    entries.insert(15, _entry("system", "", type="tool_result", tool_use_id="t"))
    _write_log(tmp_path, "deepseek", "deepseek-chat", entries)

    assert apply_compact(
        tmp_path,
        provider="deepseek",
        model="deepseek-chat",
        phase="coding",
        summary="SUM",
    )

    log = read_log(tmp_path, "deepseek", "deepseek-chat")
    assert "SUM" in log[0]["content"][0]["text"]
    assert log[1]["role"] == "assistant"
    assert len(log) <= 9
    assert list(tmp_path.glob("*.compacted.jsonl"))


# ── the guard inside a real session loop ─────────────────────────────────────


class _FakeClient:
    def __init__(self, provider: str, model: str, messages: list[AgentMessage]):
        self._provider = provider
        self.model = model
        self._messages = messages
        self.resumed: list | None = None
        self.last_usage: dict | None = None
        self.last_context_tokens: int | None = None
        self.context_window_tokens = 1_000

    def provider_name(self) -> str:
        return self._provider

    def resumes_native_session(self) -> bool:
        return False

    async def resume(self, history) -> None:
        self.resumed = history

    async def query(self, prompt: str) -> None:  # noqa: ARG002
        return None

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        for message in self._messages:
            yield message


def _text(text: str) -> AgentMessage:
    return AgentMessage(
        role=MessageRole.ASSISTANT,
        content=[ContentBlock(type=ContentBlockType.TEXT, text=text)],
    )


def _spec(tmp_path: Path, policy: dict | None = None) -> Path:
    spec = tmp_path / "proj" / ".workpilot" / "specs" / "001-x"
    spec.mkdir(parents=True)
    meta = {"taskId": "t1", "contextPolicy": policy or {}}
    (spec / "task_metadata.json").write_text(json.dumps(meta), encoding="utf-8")
    return spec


@pytest.mark.asyncio
async def test_manual_request_ends_the_session_at_a_safe_point(tmp_path: Path):
    from agents.session import _run_agent_client_session

    spec = _spec(tmp_path, {"mode": "off"})
    write_context_action(spec, "clear")
    tool_use = AgentMessage(
        role=MessageRole.ASSISTANT,
        content=[
            ContentBlock(
                type=ContentBlockType.TOOL_USE,
                tool_id="t1",
                tool_name="Read",
                tool_input={},
            )
        ],
    )
    tool_result = AgentMessage(
        role=MessageRole.USER,
        content=[ContentBlock(type=ContentBlockType.TOOL_RESULT, tool_use_id="t1")],
    )
    client = _FakeClient(
        "deepseek", "deepseek-chat", [tool_use, tool_result, _text("x")]
    )

    status, _response, info = await _run_agent_client_session(
        client, "code it", spec, phase=LogPhase.CODING, context_managed=True
    )

    assert status == "context_reset"
    assert info["action"] == "clear"
    assert not (spec / "CONTEXT_ACTION.json").exists()
    assert (spec / "context" / "handoff_pending.md").exists()


@pytest.mark.asyncio
async def test_unmanaged_sessions_ignore_the_guard(tmp_path: Path):
    from agents.session import _run_agent_client_session

    spec = _spec(tmp_path)
    write_context_action(spec, "clear")
    client = _FakeClient("deepseek", "deepseek-chat", [_text("x")])

    status, _response, _info = await _run_agent_client_session(
        client, "summarise this", spec, phase=LogPhase.CODING
    )

    assert status != "context_reset"
    assert (spec / "CONTEXT_ACTION.json").exists()


@pytest.mark.asyncio
async def test_oversized_replay_of_a_finished_subtask_is_cleared_before_sending(
    tmp_path: Path, capsys
):
    """The cheapest moment: nothing has been sent yet."""
    from agents.session import _run_agent_client_session

    spec = _spec(tmp_path)  # auto, 50 %
    _write_log(
        spec,
        "deepseek",
        "deepseek-chat",
        [_entry("assistant", "x" * 3_000, subtask="s-0") for _ in range(3)],
    )
    client = _FakeClient("deepseek", "deepseek-chat", [_text("done")])

    await _run_agent_client_session(
        client, "next subtask", spec, phase=LogPhase.CODING, context_managed=True
    )

    assert client.resumed is None  # nothing replayed
    out = capsys.readouterr().out
    events = [
        json.loads(line.split(":", 1)[1])
        for line in out.splitlines()
        if line.startswith("__TASK_EVENT__:")
    ]
    applied = [e for e in events if e["type"] == "CONTEXT_ACTION_APPLIED"]
    assert applied and applied[0]["action"] == "clear"
    usage = [e for e in events if e["type"] == "CONTEXT_USAGE"]
    assert usage and usage[-1]["windowTokens"] == 1_000
    assert usage[-1]["compactSupport"] == "emulated"


@pytest.mark.asyncio
async def test_prompt_too_long_is_recovered_once_per_subtask(tmp_path: Path):
    from context_mgmt.recovery import recover_from_prompt_too_long

    spec = _spec(tmp_path)
    project = spec.parents[2]
    assert recover_from_prompt_too_long(spec, project, "coding", "s-1")
    assert not recover_from_prompt_too_long(spec, project, "coding", "s-1")
    assert recover_from_prompt_too_long(spec, project, "coding", "s-2")
    (spec / "task_metadata.json").write_text(
        json.dumps({"contextPolicy": {"mode": "off"}}), encoding="utf-8"
    )
    os.utime(spec / "task_metadata.json", None)
    assert not recover_from_prompt_too_long(spec, project, "coding", "s-3")


def test_native_compaction_settings_follow_the_policy(tmp_path: Path):
    from context_mgmt import codex_auto_compact_limit, native_auto_compact_env
    from core.codex_cli_client import build_codex_exec_args

    spec = _spec(tmp_path, {"mode": "auto", "thresholdPct": 60})
    assert native_auto_compact_env(spec) == {"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "60"}
    assert codex_auto_compact_limit(spec, 200_000) == 120_000
    args = build_codex_exec_args(
        executable="codex",
        project_dir=tmp_path,
        model=None,
        reasoning_effort=None,
        prompt="",
        thread_id=None,
        auto_compact_token_limit=120_000,
    )
    assert "model_auto_compact_token_limit=120000" in args

    clear_only = _spec(tmp_path / "b", {"mode": "clear"})
    assert native_auto_compact_env(clear_only) == {}
    assert codex_auto_compact_limit(clear_only, 200_000) is None


class _SlowClient(_FakeClient):
    """Yields to the event loop between messages, like a real stream does.

    The reported fill (tokens of the 1 000-token window, one per message) grows
    from 30 % to 60 % unless ``fills`` says otherwise.
    """

    def __init__(self, provider, model, messages, fills: list[int] | None = None):
        super().__init__(provider, model, messages)
        self._fills = fills or [300] + [600] * (len(messages) - 1)

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        import asyncio

        for message, fill in zip(self._messages, self._fills, strict=True):
            await asyncio.sleep(0)
            self.last_context_tokens = fill
            yield message
            await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_handoff_is_prepared_in_parallel_then_used(tmp_path: Path, monkeypatch):
    from agents.session import _run_agent_client_session
    from core.conversation_log import read_log

    calls: list[int] = []

    async def fake_summary(entries, **_kwargs):
        calls.append(len(entries))
        return "SUMMARY FROM THE BACKGROUND"

    monkeypatch.setattr("context_mgmt.guard.summarize_conversation", fake_summary)
    spec = _spec(tmp_path)  # auto, 50 %
    client = _SlowClient("grok", "grok-4", [_text(f"step {i}") for i in range(6)])

    status, _response, info = await _run_agent_client_session(
        client, "code it", spec, phase=LogPhase.CODING, context_managed=True
    )

    assert status == "context_reset"
    assert info["action"] == "compact"  # same subtask: keep the working memory
    assert len(calls) == 1  # prepared once, in the background, then reused
    log = read_log(spec, "grok", "grok-4")
    assert "SUMMARY FROM THE BACKGROUND" in log[0]["content"][0]["text"]


# ── a thread a reset cannot help ─────────────────────────────────────────────


def _task_events(out: str) -> list[dict]:
    return [
        json.loads(line.split(":", 1)[1])
        for line in out.splitlines()
        if line.startswith("__TASK_EVENT__:")
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("fills", "expected"),
    [
        # 60 % from the first turn: a new thread would start there again
        ([600] * 6, "continue"),
        # the hard threshold (80 %) still cuts, the next thread has room
        ([600, 600, 850, 850], "context_reset"),
    ],
)
async def test_a_fresh_thread_that_starts_past_the_threshold_is_not_cut_there(
    tmp_path: Path, monkeypatch, fills, expected
):
    from agents.session import _run_agent_client_session

    async def fake_summary(_entries, **_kwargs):
        return "SUMMARY"

    monkeypatch.setattr("context_mgmt.guard.summarize_conversation", fake_summary)
    spec = _spec(tmp_path)  # auto, 50 %, nothing to replay
    messages = [_text(f"step {i}") for i in range(len(fills))]
    client = _SlowClient("deepseek", "deepseek-chat", messages, fills=fills)

    status, _response, _info = await _run_agent_client_session(
        client, "code it", spec, phase=LogPhase.CODING, context_managed=True
    )

    assert status == expected


@pytest.mark.asyncio
async def test_a_replayed_thread_has_no_floor(tmp_path: Path, monkeypatch):
    """A reset can shrink what a thread replays: only a fresh one has a floor."""
    from agents.session import _run_agent_client_session

    async def fake_summary(_entries, **_kwargs):
        return "SUMMARY"

    monkeypatch.setattr("context_mgmt.guard.summarize_conversation", fake_summary)
    spec = _spec(tmp_path)
    _write_log(spec, "deepseek", "deepseek-chat", [_entry("assistant", "earlier")])
    messages = [_text(f"step {i}") for i in range(6)]
    client = _SlowClient("deepseek", "deepseek-chat", messages, fills=[600] * 6)

    status, _response, _info = await _run_agent_client_session(
        client, "code it", spec, phase=LogPhase.CODING, context_managed=True
    )

    assert client.resumed
    assert status == "context_reset"


@pytest.mark.asyncio
async def test_a_monitor_only_guard_measures_and_never_acts(tmp_path: Path, capsys):
    from agents.session import _run_agent_client_session

    spec = _spec(tmp_path)
    _write_log(
        spec,
        "deepseek",
        "deepseek-chat",
        [_entry("assistant", "x" * 3_000, subtask="s-0") for _ in range(3)],
    )
    write_context_action(spec, "clear")
    client = _SlowClient(
        "deepseek", "deepseek-chat", [_text("a"), _text("b")], fills=[900, 950]
    )

    status, _response, _info = await _run_agent_client_session(
        client,
        "next subtask",
        spec,
        phase=LogPhase.CODING,
        context_managed=True,
        context_monitor_only=True,
    )

    assert status != "context_reset"  # past the hard threshold, still not cut
    assert client.resumed  # the oversized replay is not cleared before sending
    assert (spec / "CONTEXT_ACTION.json").exists()  # left for a managed session
    events = _task_events(capsys.readouterr().out)
    assert not [e for e in events if e["type"] == "CONTEXT_ACTION_APPLIED"]
    usage = [e for e in events if e["type"] == "CONTEXT_USAGE"]
    assert usage and usage[-1]["percent"] == 95.0  # the gauge keeps measuring


def test_reset_limit_counts_the_resets_of_one_unit_in_a_row():
    from context_mgmt.reset_limit import ResetLimit

    limit = ResetLimit(cap=3)
    unit = ("coding", "1.1", "qwen2.5-coder")
    assert not limit.record(unit, "context_reset")
    assert not limit.record(unit, "context_reset")
    assert not limit.record(unit, "continue")  # ended on its own: not a loop
    assert not limit.monitor_only(unit)
    assert [limit.record(unit, "context_reset") for _ in range(3)] == [
        False,
        False,
        True,
    ]
    assert limit.monitor_only(unit)
    assert not limit.record(unit, "context_reset")  # reported once
    assert not limit.record(unit, "continue")
    assert limit.monitor_only(unit)  # for the rest of the subtask
    assert not limit.monitor_only(("coding", "1.1", "qwen2.5-coder:32k"))
    assert not limit.monitor_only(("coding", "1.2", "qwen2.5-coder"))
