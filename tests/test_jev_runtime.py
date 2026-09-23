import asyncio
import json

import httpx
import pytest
from integrations.jev.client import JevClient
from integrations.jev.models import JevContext, JevSettings
from integrations.jev.rubrics import classification_questions
from integrations.jev.runtime import JevRun


def success():
    choices = classification_questions()["task_class"].criteria
    return {
        "model": "jev-test",
        "answers": {
            "task_class": {
                "type": "choice",
                "choice": "architecture",
                "confidence": 0.95,
                "probabilities": {k: float(k == "architecture") for k in choices},
            }
        },
    }


def test_consumption_disabled_and_multiple_event_loops(tmp_path):
    env = {"TYPESAFE_API_KEY": "test-key"}
    run = JevRun.from_env(JevContext("feature-build", tmp_path, tmp_path), env=env)
    assert "TYPESAFE_API_KEY" not in env
    for pass_id in ("a", "b"):
        outcome = asyncio.run(
            run.evaluate(
                "classification",
                pass_id=pass_id,
                revision="r1",
                state={"request": "hello"},
                questions=classification_questions(),
            )
        )
        assert outcome.reason == "disabled"
    assert "test-key" not in repr(run)


@pytest.mark.asyncio
async def test_circuit_breaker_and_new_run(tmp_path):
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(429)

    client = JevClient(httpx.MockTransport(respond))
    ctx = JevContext("feature-build", tmp_path, tmp_path)
    for run_id in ("one", "two"):
        run = JevRun(
            JevSettings(enabled=True), ctx, key="test-key", run_id=run_id, client=client
        )
        for point in ("a", "b"):
            result = await run.evaluate(
                "classification",
                pass_id=point,
                revision="r1",
                state={"request": "hello"},
                questions=classification_questions(),
            )
            assert result.reason == "rate_limited"
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_revision_cache_policy_and_no_secret_persistence(tmp_path):
    calls = []

    def respond(request):
        calls.append(request)
        assert b"test-key" not in request.content
        return httpx.Response(200, json=success())

    run = JevRun(
        JevSettings(enabled=True),
        JevContext("feature-build", tmp_path, tmp_path),
        key="test-key",
        run_id="one",
        client=JevClient(httpx.MockTransport(respond)),
    )
    for rev in ("r1", "r1", "r2"):
        result = await run.evaluate(
            "classification",
            pass_id="planning",
            revision=rev,
            state={"request": "test-key"},
            questions=classification_questions(),
        )
        assert result.status == "evaluated"
    assert len(calls) == 2
    policy = tmp_path / ".workpilot" / "offline-mode.json"
    policy.parent.mkdir()
    policy.write_text('{"airgapStrict":true}', encoding="utf-8")
    result = await run.evaluate(
        "classification",
        pass_id="planning",
        revision="r2",
        state={},
        questions=classification_questions(),
    )
    assert result.reason == "offline"
    persisted = (tmp_path / "jev-evaluations.json").read_text(encoding="utf-8")
    assert "test-key" not in persisted
    assert json.loads(persisted)["evaluations"][-1]["reason"] == "offline"


def test_invalid_configuration_and_server_skip(tmp_path):
    run = JevRun.from_env(
        JevContext("feature-build", tmp_path, tmp_path),
        env={"WORKPILOT_JEV_ENABLED": "bad"},
    )
    result = asyncio.run(
        run.evaluate(
            "classification", pass_id="x", revision="r", state={}, questions={}
        )
    )
    assert result.reason == "invalid_config"
    env = {"TYPESAFE_API_KEY": "secret"}
    run = JevRun.from_env(
        JevContext("feature-build", tmp_path, server_mode=True), env=env
    )
    assert env["TYPESAFE_API_KEY"] == "secret"
    result = asyncio.run(
        run.evaluate(
            "classification", pass_id="x", revision="r", state={}, questions={}
        )
    )
    assert result.reason == "unsupported_context"
