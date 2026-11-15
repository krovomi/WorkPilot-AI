"""JEV paths the feature tests leave out: every bypass reason an adapter can
record, the evidence filters, the answer validator's refusals, and the local
observation reader's refusals. The TypeSafe endpoint is `httpx.MockTransport`
(the client's own transport seam); git runs for real in `tmp_path`.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path

import httpx
import pytest
from foundation.build_signals import BuildPaused
from integrations.jev import (
    adapters,
    context,
    observations,
    reviews,
    rubrics,
    runtime,
    service,
    settings,
)
from integrations.jev.client import JevClient
from integrations.jev.models import (
    JevAnswer,
    JevContext,
    JevOutcome,
    JevQuestion,
    JevSettings,
)

ENV = {"WORKPILOT_JEV_ENABLED": "1", "TYPESAFE_API_KEY": "tsk-test-0000"}


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
    )


def _review_answer(score: float = 1.0) -> dict:
    probabilities = {"0": 0.0, "1": 1.0, "2": 0.0}
    return {
        "type": "score",
        "score": score,
        "confidence": 0.95,
        "probabilities": probabilities,
        "legend": {"0": "a", "1": "b", "2": "c"},
    }


def _client(handler) -> JevClient:
    return JevClient(httpx.MockTransport(handler))


def _run(
    project: Path, spec: Path | None = None, workflow="feature-build", client=None
) -> runtime.JevRun:
    run = runtime.JevRun.from_env(JevContext(workflow, project, spec), env=dict(ENV))
    if client is not None:
        run.client = client
    return run


@pytest.fixture
def repo(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    _git(project, "init", "-q")
    (project / "app.py").write_text("print(1)\n", encoding="utf-8")
    _git(project, "add", "app.py")
    _git(project, "commit", "-qm", "base")
    spec = tmp_path / "spec"
    spec.mkdir()
    (spec / "spec.md").write_text("Make it print 2.", encoding="utf-8")
    return project, spec


# --------------------------------------------------------------------------
# Build and planning adapters
# --------------------------------------------------------------------------


async def test_review_of_a_real_change_is_evaluated(repo):
    project, spec = repo
    sent: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "model": "jev-test",
                "answers": {"coverage": _review_answer(), "risk": _review_answer()},
            },
        )

    run = _run(project, spec, client=_client(handler))
    adapters.capture_base(run)
    (project / "app.py").write_text("print(2)\n", encoding="utf-8")

    outcome = await adapters.assess_build(run, "review", pass_id="qa")

    assert outcome.status == "evaluated"
    assert sent[0]["state"]["files"] == ["app.py"]
    assert "+print(2)" in sent[0]["state"]["diff"]
    assert run.observation["evaluations"][-1]["passId"] == "qa"


async def test_review_without_a_captured_base_is_bypassed(repo):
    project, spec = repo
    run = _run(project, spec)
    outcome = await adapters.assess_build(run, "review", pass_id="qa")
    assert (outcome.status, outcome.reason) == ("bypassed", "missing_context")


async def test_review_with_no_change_is_bypassed(repo):
    project, spec = repo
    run = _run(project, spec)
    adapters.capture_base(run)
    assert (
        await adapters.assess_build(run, "review", pass_id="qa")
    ).reason == "missing_context"


async def test_build_without_a_spec_directory_is_bypassed(repo):
    project, _spec = repo
    run = _run(project, None)
    assert (
        await adapters.assess_build(run, "classification", pass_id="p")
    ).reason == "missing_context"


async def test_oversized_spec_is_too_large(repo):
    project, spec = repo
    (spec / "spec.md").write_text("x" * 70_000, encoding="utf-8")
    run = _run(project, spec)
    assert (
        await adapters.assess_build(run, "classification", pass_id="p")
    ).reason == "context_too_large"


def test_oversized_git_output_is_too_large(repo):
    project, _spec = repo
    (project / "big.txt").write_text("y" * 70_000, encoding="utf-8")
    _git(project, "add", "big.txt")
    with pytest.raises(context.JevContextError) as caught:
        adapters._git(project, "diff", "--cached")
    assert caught.value.reason == "context_too_large"


def test_capture_base_outside_a_repository_leaves_none(tmp_path):
    run = _run(tmp_path, tmp_path)
    run.base_revision = "stale"
    adapters.capture_base(run)
    assert run.base_revision is None


def test_capture_base_is_skipped_when_ineligible(tmp_path):
    run = runtime.JevRun.from_env(JevContext("feature-build", tmp_path), env={})
    adapters.capture_base(run)
    assert getattr(run, "base_revision", None) is None


async def test_planning_paths(repo):
    project, spec = repo
    ineligible = runtime.JevRun.from_env(
        JevContext("feature-build", project, spec), env={}
    )
    assert (await adapters.assess_planning(ineligible, "x")).reason == "disabled"

    empty = _run(project, None)
    assert (await adapters.assess_planning(empty, "   ")).reason == "missing_context"

    def handler(_request):
        probabilities = dict.fromkeys(rubrics._CLASSES, 0.0)
        probabilities["planning"] = 1.0
        return httpx.Response(
            200,
            json={
                "model": "jev-test",
                "answers": {
                    "task_class": {
                        "type": "choice",
                        "choice": "planning",
                        "confidence": 0.99,
                        "probabilities": probabilities,
                    }
                },
            },
        )

    run = _run(project, spec, client=_client(handler))
    outcome = await adapters.assess_planning(run, "plan the work")
    assert rubrics.classification_hint(outcome) == "planning"
    assert run.classification is outcome


async def test_review_input_without_a_diff_is_bypassed(tmp_path):
    run = _run(tmp_path, None, workflow="github-review")
    review = adapters.ReviewInput("t", "b", [], "  ", "rev")
    assert (await adapters.assess_review(run, review)).reason == "missing_context"


# --------------------------------------------------------------------------
# Evidence selection
# --------------------------------------------------------------------------


def test_diff_with_an_unparsable_header_is_refused():
    with pytest.raises(context.JevContextError):
        context.select_state(
            request="r", acceptance="a", files=[], diff='diff --git "a/x b/x\n'
        )


def test_diff_with_a_malformed_header_is_refused():
    with pytest.raises(context.JevContextError):
        context.select_state(
            request="r", acceptance="a", files=[], diff="diff --git a/x\n"
        )


def test_a_rename_to_a_secret_file_is_dropped():
    diff = (
        "diff --git a/config.txt b/notes.txt\nrename from config.txt\nrename to .env\n"
        "diff --git a/app.py b/app.py\n+ok\n"
    )
    state = context.select_state(request="r", acceptance="a", files=[], diff=diff)
    assert state["diff"] == "diff --git a/app.py b/app.py\n+ok\n"


# --------------------------------------------------------------------------
# Client and service
# --------------------------------------------------------------------------


async def test_transport_error_is_unavailable():
    def handler(request):
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(Exception) as caught:
        await _client(handler).post(key="k", payload={}, timeout_seconds=1)
    assert caught.value.reason == "unavailable"


async def test_payload_that_cannot_be_encoded_is_invalid():
    client = _client(lambda _r: httpx.Response(200, json={}))
    with pytest.raises(Exception) as caught:
        await client.post(key="k", payload={"x": float("nan")}, timeout_seconds=1)
    assert caught.value.reason == "invalid_response"


SCORE = {"s": JevQuestion("score", "rate", ("low", "mid", "high"))}
CHOICE = {"c": JevQuestion("choice", "pick", {"a": "A", "b": "B"})}
NOUL = {"n": JevQuestion("noul", "how unlikely")}


@pytest.mark.parametrize(
    ("questions", "answer"),
    [
        (
            CHOICE,
            {
                "type": "choice",
                "choice": "a",
                "confidence": 0.9,
                "probabilities": {"a": 2.0, "b": -1.0},
            },
        ),
        (
            CHOICE,
            {
                "type": "choice",
                "choice": "a",
                "confidence": 0.9,
                "probabilities": {"a": 0.5, "b": 0.4},
            },
        ),
        (NOUL, {"type": "noul", "noul": 1.5}),
        (
            CHOICE,
            {
                "type": "choice",
                "choice": "a",
                "confidence": 1.5,
                "probabilities": {"a": 1.0, "b": 0.0},
            },
        ),
        (SCORE, {**_review_answer(), "score": 5}),
        (SCORE, {**_review_answer(), "score": 2.0}),
        (SCORE, {**_review_answer(), "legend": {"0": "a"}}),
    ],
)
def test_answers_that_do_not_hold_are_invalid(questions, answer):
    name = next(iter(questions))
    outcome = service.validate_response(
        {"model": "jev-x", "answers": {name: answer}}, questions, 0.5
    )
    assert outcome.reason == "invalid_response"


@pytest.mark.parametrize(
    "usage", [[1, 2], {"input_tokens": -1}, {"output_tokens": True}]
)
def test_usage_must_be_counts(usage):
    response = {
        "model": "jev-x",
        "answers": {"n": {"type": "noul", "noul": 0.2}},
        "usage": usage,
    }
    assert service.validate_response(response, NOUL, 0.5).reason == "invalid_response"


def test_noul_answer_and_usage_are_kept():
    response = {
        "model": "jev-x",
        "answers": {"n": {"type": "noul", "noul": 0.25}},
        "usage": {"input_tokens": 3, "other": 9},
    }
    outcome = service.validate_response(response, NOUL, 0.5)
    assert outcome.status == "evaluated"
    assert outcome.answers["n"].value == 0.25
    assert dict(outcome.usage) == {"input_tokens": 3}


def _ctx(tmp_path, spec=None):
    return JevContext("feature-build", tmp_path, spec)


async def _evaluate(tmp_path, state, questions=NOUL, client=None, spec=None):
    return await service.evaluate(
        JevSettings(enabled=True),
        _ctx(tmp_path, spec),
        point="review",
        key="k",
        state=state,
        questions=questions,
        client=client or _client(lambda _r: httpx.Response(500)),
    )


async def test_evaluate_refuses_empty_oversized_or_unencodable_state(tmp_path):
    assert (await _evaluate(tmp_path, {})).reason == "missing_context"
    assert (
        await _evaluate(tmp_path, {"a": 1}, questions={})
    ).reason == "missing_context"
    assert (
        await _evaluate(tmp_path, {"a": "x" * 70_000})
    ).reason == "context_too_large"
    assert (await _evaluate(tmp_path, {"a": float("nan")})).reason == "missing_context"


async def test_evaluate_bypasses_before_any_request(tmp_path):
    outcome = await service.evaluate(
        JevSettings(enabled=False),
        _ctx(tmp_path),
        point="review",
        key="k",
        state={"a": 1},
        questions=NOUL,
        client=_client(lambda _r: pytest.fail("no request when disabled")),
    )
    assert outcome.reason == "disabled"


async def test_pause_during_the_request_raises(tmp_path, monkeypatch):
    spec = tmp_path / "spec"
    spec.mkdir()
    paused = {"value": False}
    monkeypatch.setattr(service, "is_paused", lambda _d: paused["value"])

    class SlowClient:
        async def post(self, **_kwargs):
            paused["value"] = True
            await asyncio.sleep(5)

    with pytest.raises(BuildPaused):
        await _evaluate(tmp_path, {"a": 1}, client=SlowClient(), spec=spec)


async def test_pause_noticed_after_the_answer_raises(tmp_path, monkeypatch):
    spec = tmp_path / "spec"
    spec.mkdir()
    calls = {"n": 0}

    def is_paused(_d):
        calls["n"] += 1
        return calls["n"] > 2  # free before the request, paused once it returns

    monkeypatch.setattr(service, "is_paused", is_paused)

    class FastClient:
        async def post(self, **_kwargs):
            return {"model": "jev-x", "answers": {"n": {"type": "noul", "noul": 0.1}}}

    with pytest.raises(BuildPaused):
        await _evaluate(tmp_path, {"a": 1}, client=FastClient(), spec=spec)


# --------------------------------------------------------------------------
# Settings, runtime, rubrics, reviews
# --------------------------------------------------------------------------


def test_unreadable_offline_policy_counts_as_offline(tmp_path, monkeypatch):
    def broken(*_paths):
        raise OSError("unreadable")

    monkeypatch.setattr(settings, "airgap_status", broken)
    assert (
        settings.bypass_reason(JevSettings(enabled=True), _ctx(tmp_path), has_key=True)
        == "offline"
    )


def test_server_context_follows_the_server_settings(tmp_path, monkeypatch):
    import server.config as server_config

    class Settings:
        server_mode = True

    monkeypatch.setattr(server_config, "get_settings", lambda: Settings())
    assert runtime._server_context(_ctx(tmp_path)).server_mode is True

    def broken():
        raise RuntimeError("settings exploded")

    monkeypatch.setattr(server_config, "get_settings", broken)
    # A boundary that cannot be read closes: the service treats it as server mode.
    assert runtime._server_context(_ctx(tmp_path)).server_mode is True


def test_server_context_without_the_server_package(tmp_path, monkeypatch):
    import sys

    monkeypatch.setitem(sys.modules, "server.config", None)
    assert runtime._server_context(_ctx(tmp_path)).server_mode is False


def test_lists_are_redacted_item_by_item(tmp_path):
    run = runtime.JevRun(
        JevSettings(), _ctx(tmp_path), key="tsk-secret-value", run_id="r1"
    )
    assert run._redact(["a tsk-secret-value b", 3]) == ["a [redacted] b", 3]


def test_hint_and_advice_only_for_evaluated_outcomes():
    bypassed = JevOutcome("bypassed", "disabled")
    assert rubrics.classification_hint(bypassed) is None
    assert rubrics.advice_text(None) == ""
    assert rubrics.advice_text(bypassed) == ""
    evaluated = JevOutcome("evaluated", answers={"risk": JevAnswer("score", 1.0, 0.9)})
    text = rubrics.advice_text(evaluated)
    assert text.startswith("Optional JEV assessment (advisory only")
    assert "- risk: 1.0; confidence: 0.9" in text


def test_review_context_advice_reads_its_outcome():
    class Ctx:
        jev_outcome = JevOutcome(
            "evaluated", answers={"coverage": JevAnswer("score", 2.0, 0.8)}
        )

    assert "coverage: 2.0" in reviews.context_advice(Ctx())
    assert reviews.context_advice(object()) == ""


# --------------------------------------------------------------------------
# Observations
# --------------------------------------------------------------------------


def _row(**changes):
    row = {
        "point": "review",
        "passId": "qa",
        "revision": "r",
        "status": "evaluated",
        "reason": None,
        "answers": {"risk": {"value": 1.0, "confidence": 0.9}},
        "model": "jev-x",
        "usage": {"input_tokens": 2},
        "createdAt": "2026-11-14T00:00:00+00:00",
    }
    row.update(changes)
    return row


def _write(directory: Path, record) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "jev-evaluations.json").write_text(
        json.dumps(record), encoding="utf-8"
    )


def _record(*rows, **changes):
    record = {
        "version": 1,
        "runId": "run1",
        "workflow": "feature-build",
        "evaluations": list(rows),
    }
    record.update(changes)
    return record


@pytest.mark.parametrize(
    "record",
    [
        _record(workflow="Bad Workflow!"),
        _record(evaluations="nope"),
        _record(*([_row()] * 51)),
        _record("not a row"),
        _record(_row(reason="made_up")),
        _record(_row(passId=7)),
        _record(_row(answers=["x"])),
        _record(_row(answers={"other": {"value": 1}})),
        _record(_row(answers={"risk": {"value": "free text"}})),
        _record(_row(answers={"risk": {"value": 1.0, "confidence": 3}})),
    ],
)
def test_observations_that_do_not_hold_are_ignored(tmp_path, record):
    _write(tmp_path, record)
    assert observations.read_observations(tmp_path) is None


def test_observation_model_and_usage_are_cleaned(tmp_path):
    _write(
        tmp_path,
        _record(
            _row(model="not-jev", usage={"input_tokens": True, "output_tokens": 4}),
            _row(usage="x"),
        ),
    )
    rows = observations.read_observations(tmp_path)["evaluations"]
    assert rows[0]["model"] is None
    assert rows[0]["usage"] == {"output_tokens": 4}
    assert rows[1]["usage"] == {}


def test_oversized_observation_is_not_written(tmp_path):
    observations.write_observation(tmp_path / "obs", {"blob": "z" * (300 * 1024)})
    assert not (tmp_path / "obs").exists()


def test_leftover_temporary_that_cannot_be_removed_is_tolerated(
    tmp_path, monkeypatch, caplog
):
    def refuse(self, missing_ok=False):
        raise OSError("busy")

    monkeypatch.setattr(Path, "unlink", refuse)
    caplog.set_level("DEBUG", logger=observations.logger.name)
    observations.write_observation(tmp_path, {"version": 1})
    assert json.loads(
        (tmp_path / "jev-evaluations.json").read_text(encoding="utf-8")
    ) == {"version": 1}
    assert "could not be removed" in caplog.text


@pytest.mark.parametrize(
    "response",
    [
        {"model": "gpt-4", "answers": {"n": {"type": "noul", "noul": 0.1}}},
        {"model": "jev-x", "answers": {"other": {"type": "noul", "noul": 0.1}}},
    ],
)
def test_unknown_model_or_unasked_answers_are_invalid(response):
    assert service.validate_response(response, NOUL, 0.5).reason == "invalid_response"


async def test_a_paused_build_never_sends_the_request(tmp_path, monkeypatch):
    spec = tmp_path / "spec"
    spec.mkdir()
    monkeypatch.setattr(service, "is_paused", lambda _d: True)
    with pytest.raises(BuildPaused):
        await _evaluate(
            tmp_path,
            {"a": 1},
            client=_client(lambda _r: pytest.fail("sent")),
            spec=spec,
        )
