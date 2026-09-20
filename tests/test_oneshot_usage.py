"""What a one-shot caller is told about cost, and when it is told nothing.

The Arena ranks models on these numbers, so the distinction this pins is the
one that matters: a usage record the provider produced, versus no record at
all. Turning the second into ``{"input_tokens": 0, "cost_usd": 0.0}`` would
make an unmeasured model indistinguishable from a free one, in a table people
read as measurements.
"""

import asyncio
import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "oneshot_completion_runner.py"

sys.path.insert(0, str(BACKEND))


def load_runner():
    spec = importlib.util.spec_from_file_location("oneshot_usage_undertest", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def runner():
    return load_runner()


class FakeClient:
    """The smallest thing `oneshot_completion` drives: a client with a usage."""

    def __init__(self, usage=None, raises=False):
        self.last_usage = usage
        self._raises = raises

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt):
        if self._raises:
            raise RuntimeError("provider said no")

    async def receive_response(self):
        return
        yield  # pragma: no cover — makes this an async generator


def run_completion(monkeypatch, client, **kwargs):
    from core import oneshot

    monkeypatch.setattr(oneshot, "_build_client", lambda *a, **k: client)
    monkeypatch.setattr(
        oneshot, "_get_active_provider", lambda *_: "openai", raising=False
    )
    monkeypatch.setattr(
        "core.client._get_active_provider", lambda *_: "openai", raising=False
    )
    return asyncio.run(
        oneshot.oneshot_completion("hello", provider="openai", model="gpt-5", **kwargs)
    )


def test_a_reported_usage_reaches_the_caller(monkeypatch):
    seen = []
    usage = {"input_tokens": 12, "output_tokens": 30, "cost_usd": 0.004}

    run_completion(monkeypatch, FakeClient(usage), on_usage=seen.append)

    assert seen == [usage]


def test_nothing_is_reported_when_the_provider_reported_nothing(monkeypatch):
    seen = []

    run_completion(monkeypatch, FakeClient(None), on_usage=seen.append)

    assert seen == []


def test_usage_survives_a_failed_completion(monkeypatch):
    # A run that died halfway still spent tokens, and the caller is the one
    # who has to account for them.
    seen = []
    usage = {"input_tokens": 9, "output_tokens": 0, "cost_usd": 0.001}

    result = run_completion(
        monkeypatch, FakeClient(usage, raises=True), on_usage=seen.append
    )

    assert result == ""
    assert seen == [usage]


def test_a_raising_callback_never_breaks_the_completion(monkeypatch):
    def explode(_usage):
        raise ValueError("consumer bug")

    assert (
        run_completion(monkeypatch, FakeClient({"cost_usd": 1}), on_usage=explode) == ""
    )


def _run_runner(runner, monkeypatch, tmp_path, capsys, usage=None, detail=None):
    async def fake_completion(prompt, **kwargs):
        if usage is not None and kwargs.get("on_usage"):
            kwargs["on_usage"](usage)
        if detail is not None and kwargs.get("on_error"):
            kwargs["on_error"](detail)
        return "" if detail is not None else "an answer"

    fake_module = types.ModuleType("core.oneshot")
    fake_module.oneshot_completion = fake_completion
    monkeypatch.setitem(sys.modules, "core.oneshot", fake_module)

    input_file = tmp_path / "input.json"
    input_file.write_text(json.dumps({"prompt": "x"}), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["runner", "--input", str(input_file)])

    code = runner.main()
    return code, capsys.readouterr().out


def marker_payload(stdout, marker):
    for line in stdout.splitlines():
        if marker in line:
            return json.loads(line.split(marker, 1)[1])
    return None


def test_the_runner_prints_the_usage_it_was_given(
    runner, monkeypatch, tmp_path, capsys
):
    usage = {"input_tokens": 5, "output_tokens": 7, "cost_usd": 0.002}
    code, out = _run_runner(runner, monkeypatch, tmp_path, capsys, usage=usage)

    assert code == 0
    assert marker_payload(out, runner.USAGE_MARKER) == usage
    # The line every existing caller reads is untouched.
    assert runner.RESULT_MARKER + "an answer" in out


def test_the_runner_prints_no_usage_line_when_there_is_none(
    runner, monkeypatch, tmp_path, capsys
):
    _, out = _run_runner(runner, monkeypatch, tmp_path, capsys)

    assert runner.USAGE_MARKER not in out


def test_a_failure_carries_a_reason_a_ui_can_show(
    runner, monkeypatch, tmp_path, capsys
):
    detail = {"message": "model not found", "code": "invalid_model"}
    code, out = _run_runner(runner, monkeypatch, tmp_path, capsys, detail=detail)

    assert code == 1
    assert marker_payload(out, runner.ERROR_MARKER) == detail


def test_an_unserialisable_payload_does_not_fail_the_run(
    runner, monkeypatch, tmp_path, capsys
):
    # `default=str` is what keeps a stray object out of the caller's way; the
    # run is graded on its result line, not on its diagnostics.
    runner._emit_marker(runner.USAGE_MARKER, {"cost_usd": object()})

    assert runner.USAGE_MARKER in capsys.readouterr().out


def test_a_provider_with_no_adapter_is_refused_when_the_caller_asked(monkeypatch):
    # The Arena votes on which model answered best. A provider served by the
    # Claude SDK would have its win recorded under its own name.
    from core import oneshot

    built = []
    monkeypatch.setattr(
        oneshot, "_build_client", lambda *a, **k: built.append(a) or FakeClient(None)
    )
    reported = []

    result = asyncio.run(
        oneshot.oneshot_completion(
            "hello",
            provider="mistral",
            model="mistral-large",
            require_provider=True,
            on_error=reported.append,
        )
    )

    assert result == ""
    assert built == []  # nothing ran
    assert "mistral" in reported[0]["message"]


def test_the_same_provider_still_runs_when_the_caller_did_not_ask(monkeypatch):
    # Every existing caller wants the task to run, degradation included.
    from core import oneshot

    monkeypatch.setattr(oneshot, "_build_client", lambda *a, **k: FakeClient(None))

    asyncio.run(
        oneshot.oneshot_completion("hello", provider="mistral", model="mistral-large")
    )


def test_every_provider_that_drives_itself_passes_the_gate():
    from core import oneshot

    for provider in ("claude", "anthropic", "openai", "copilot", "google", "ollama"):
        assert oneshot.drives_itself(provider)
    for provider in ("mistral", "deepseek", "grok", "meta", "aws", "cursor", ""):
        assert not oneshot.drives_itself(provider)
