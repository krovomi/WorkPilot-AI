"""The impact analyzer run: the model's rating of a PR, or nothing.

``core/worktree_pr.py`` calls ``run_impact_analyzer_sync`` while it builds a
PR body, from plain code and from inside a running event loop. The model is a
stand-in at ``core.client.create_agent_client``; the prompt, the session loop
and the parsing of the answer are real.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from agents import impact_analyzer as impact
from replay import recorder as replay_recorder


class TextBlock:
    def __init__(self, text: str) -> None:
        self.text = text


class AssistantMessage:
    def __init__(self, text: str) -> None:
        self.content = [TextBlock(text)]


class ResultMessage:
    session_id = "sess-impact"
    subtype = "success"
    usage = {"input_tokens": 10, "output_tokens": 5}
    total_cost_usd = 0.0


class _Options:
    model = "claude-sonnet-test"


class _Client:
    def __init__(
        self,
        answer: str | None,
        fail: Exception | None = None,
        delay: float = 0.0,
    ) -> None:
        self.options = _Options()
        self._answer = answer
        self._fail = fail
        self._delay = delay
        self.prompts: list[str] = []

    async def __aenter__(self) -> _Client:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def query(self, prompt: str) -> None:
        self.prompts.append(prompt)
        if self._fail is not None:
            raise self._fail

    async def receive_response(self):
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._answer is not None:
            yield AssistantMessage(self._answer)
        yield ResultMessage()


@pytest.fixture
def spec(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    spec_dir = tmp_path / "shop" / ".workpilot" / "specs" / "001-login"
    spec_dir.mkdir(parents=True)
    monkeypatch.setattr(
        replay_recorder,
        "_replay_recorder",
        replay_recorder.ReplayRecorder(storage_dir=tmp_path / "replays"),
    )
    monkeypatch.setenv(
        "WORKPILOT_AGENT_DEBUGGER_STATE", str(tmp_path / "debugger" / "state.json")
    )
    import core.usage_tracker as usage_tracker

    monkeypatch.setattr(usage_tracker, "_get_analytics_db_session", lambda: None)
    return spec_dir


def _model(monkeypatch: pytest.MonkeyPatch, client: _Client) -> list[dict]:
    import core.client

    calls: list[dict] = []

    def create_agent_client(**kwargs: Any) -> _Client:
        calls.append(kwargs)
        return client

    monkeypatch.setattr(core.client, "create_agent_client", create_agent_client)
    return calls


DIFF = "diff --git a/src/cart.py b/src/cart.py\n+def total(): ..."
ANSWER = json.dumps({"rating": 3, "features": "Panier,\n  calcul du total"})


def test_the_model_rates_the_change(
    spec: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (spec / "spec.md").write_text("# Cart total\n", encoding="utf-8")
    client = _Client(ANSWER)
    calls = _model(monkeypatch, client)

    analysis = asyncio.run(
        impact.run_impact_analyzer(
            spec.parents[2],
            spec,
            "claude-sonnet-test",
            thinking_budget=1024,
            diff_summary=DIFF,
            commit_log="feat: cart total",
        )
    )

    assert analysis == impact.ImpactAnalysis(
        rating="3", features="Panier, calcul du total"
    )
    assert [c["agent_type"] for c in calls] == ["impact_analyzer"]
    assert calls[0]["max_thinking_tokens"] == 1024
    [prompt] = client.prompts
    assert "# Cart total" in prompt and "feat: cart total" in prompt
    assert DIFF in prompt


def test_an_empty_diff_is_not_sent_to_the_model(
    spec: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _model(monkeypatch, _Client(ANSWER))

    assert (
        asyncio.run(impact.run_impact_analyzer(spec, spec, "m", diff_summary=" "))
        is None
    )
    assert calls == []


@pytest.mark.parametrize(
    "client",
    [
        pytest.param(_Client(None), id="no answer"),
        pytest.param(_Client("rated it a 9"), id="unparseable answer"),
        pytest.param(_Client(None, fail=RuntimeError("reset")), id="session error"),
    ],
)
def test_no_usable_rating_is_none(
    spec: Path, monkeypatch: pytest.MonkeyPatch, client: _Client
) -> None:
    _model(monkeypatch, client)

    assert (
        asyncio.run(impact.run_impact_analyzer(spec, spec, "m", diff_summary=DIFF))
        is None
    )


def test_a_client_that_cannot_open_is_logged_and_none(
    spec: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _Unreachable(_Client):
        async def __aenter__(self) -> _Client:
            raise OSError("no route to the model")

    _model(monkeypatch, _Unreachable(ANSWER))

    assert (
        asyncio.run(impact.run_impact_analyzer(spec, spec, "m", diff_summary=DIFF))
        is None
    )
    log = (spec / "task_logs.json").read_text(encoding="utf-8")
    assert "Impact analyzer error: no route to the model" in log


# -- the synchronous wrapper -----------------------------------------------------


def test_the_sync_wrapper_runs_from_plain_code(
    spec: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _model(monkeypatch, _Client(ANSWER))

    analysis = impact.run_impact_analyzer_sync(spec, spec, "m", diff_summary=DIFF)

    assert analysis is not None and analysis.rating == "3"


def test_the_sync_wrapper_runs_inside_a_running_loop(
    spec: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _model(monkeypatch, _Client(ANSWER))

    async def caller() -> impact.ImpactAnalysis | None:
        return impact.run_impact_analyzer_sync(spec, spec, "m", diff_summary=DIFF)

    analysis = asyncio.run(caller())

    assert analysis is not None and analysis.features == "Panier, calcul du total"


def test_the_sync_wrapper_gives_up_at_its_timeout(
    spec: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _model(monkeypatch, _Client(ANSWER, delay=5))

    analysis = impact.run_impact_analyzer_sync(
        spec, spec, "m", diff_summary=DIFF, timeout_s=0.2
    )

    assert analysis is None


def test_the_sync_wrapper_never_raises(
    spec: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import core.client

    def broken(**_kwargs: Any) -> _Client:
        raise ValueError("no provider configured")

    monkeypatch.setattr(core.client, "create_agent_client", broken)

    assert impact.run_impact_analyzer_sync(spec, spec, "m", diff_summary=DIFF) is None


# -- what the prompt is given ----------------------------------------------------


def test_a_large_diff_keeps_only_its_file_level_lines() -> None:
    diff = "diff --git a/x b/x\n+" + "x" * impact.MAX_DIFF_CHARS + "\n 1 file changed"

    assert impact._truncate_diff(diff).splitlines() == [
        "(Diff truncated to file-level summaries due to size)",
        "",
        "diff --git a/x b/x",
        " 1 file changed",
    ]
    assert impact._truncate_diff("y" * (impact.MAX_DIFF_CHARS + 1)) == (
        "y" * impact.MAX_DIFF_CHARS + "\n\n(... diff truncated due to size)"
    )


def test_the_spec_is_given_cut_or_said_to_be_missing(spec: Path) -> None:
    assert impact._load_spec_overview(spec) == "(No spec overview available)"
    (spec / "spec.md").write_text("s" * 9000, encoding="utf-8")
    assert impact._load_spec_overview(spec).endswith("(... spec truncated for brevity)")
    (spec / "spec.md").write_bytes(b"\xff\xfe broken")
    assert impact._load_spec_overview(spec) == "(No spec overview available)"


@pytest.mark.parametrize(
    "answer",
    ["", "[1, 2]", '{"rating": "high", "features": "x"}', "{not json}"],
)
def test_answers_without_a_rating_are_refused(answer: str) -> None:
    assert impact._parse_response(answer) is None


def test_a_long_feature_list_is_cut() -> None:
    analysis = impact._parse_response(json.dumps({"rating": 2, "features": "f" * 600}))

    assert analysis is not None
    assert analysis.features == "f" * 497 + "..."
