import asyncio

import httpx
import pytest
from core.build_signals import BuildPaused
from integrations.jev.client import JevClient
from integrations.jev.models import JevContext, JevQuestion, JevSettings
from integrations.jev.service import evaluate

QUESTIONS = {"kind": JevQuestion("choice", "Choose kind", {"a": "A", "b": "B"})}


def answer(**updates):
    result = {
        "type": "choice",
        "choice": "a",
        "confidence": 0.9,
        "probabilities": {"a": 0.9, "b": 0.1},
    }
    result.update(updates)
    return result


async def ask(tmp_path, value, settings=None):
    client = JevClient(
        httpx.MockTransport(
            lambda _: httpx.Response(
                200,
                json={
                    "model": "jev-test",
                    "answers": {"kind": value},
                    "usage": {"input_tokens": 2, "output_tokens": 1},
                },
            )
        )
    )
    return await evaluate(
        settings or JevSettings(enabled=True),
        JevContext("feature-build", tmp_path),
        point="classification",
        key="test-key",
        state={"request": "hello"},
        questions=QUESTIONS,
        client=client,
    )


@pytest.mark.asyncio
async def test_valid_choice(tmp_path):
    result = await ask(tmp_path, answer())
    assert result.status == "evaluated"
    assert result.answers["kind"].value == "a"


@pytest.mark.parametrize(
    "changes",
    [
        {"choice": "other"},
        {"confidence": True},
        {"confidence": 2},
        {"probabilities": {"a": 0.5}},
        {"type": "score"},
        {"probabilities": {"a": -0.1, "b": 1.1}},
        {"choice": "b"},
    ],
)
@pytest.mark.asyncio
async def test_bad_answer_is_bypassed(tmp_path, changes):
    assert (await ask(tmp_path, answer(**changes))).reason == "invalid_response"


@pytest.mark.asyncio
async def test_low_confidence(tmp_path):
    assert (await ask(tmp_path, answer(confidence=0.4))).reason == "low_confidence"


@pytest.mark.parametrize(
    "settings,key,reason",
    [
        (JevSettings(), "test-key", "disabled"),
        (JevSettings(enabled=True), None, "missing_key"),
    ],
)
@pytest.mark.asyncio
async def test_bypass_never_touches_transport(tmp_path, settings, key, reason):
    def forbidden(_):
        raise AssertionError("unexpected network")

    result = await evaluate(
        settings,
        JevContext("feature-build", tmp_path),
        point="classification",
        key=key,
        state={},
        questions=QUESTIONS,
        client=JevClient(httpx.MockTransport(forbidden)),
    )
    assert result.reason == reason


@pytest.mark.asyncio
async def test_pause_closes_inflight_request(tmp_path, monkeypatch):
    entered = asyncio.Event()
    closed = asyncio.Event()
    paused = False

    async def respond(_):
        entered.set()
        try:
            await asyncio.sleep(60)
        finally:
            closed.set()

    monkeypatch.setattr("integrations.jev.service.is_paused", lambda _: paused)
    task = asyncio.create_task(
        evaluate(
            JevSettings(enabled=True),
            JevContext("feature-build", tmp_path, tmp_path),
            point="classification",
            key="k",
            state={"request": "hello"},
            questions=QUESTIONS,
            client=JevClient(httpx.MockTransport(respond)),
        )
    )
    await entered.wait()
    paused = True
    with pytest.raises(BuildPaused):
        await task
    assert closed.is_set()


@pytest.mark.asyncio
async def test_noul_has_no_confidence_and_score_is_fractional(tmp_path):
    questions = {
        "yes": JevQuestion("noul", "True?"),
        "score": JevQuestion("score", "Rate", ("low", "high")),
    }
    response = {
        "model": "jev-test",
        "answers": {
            "yes": {"type": "noul", "noul": 0.6},
            "score": {
                "type": "score",
                "score": 0.7,
                "confidence": 0.9,
                "probabilities": {"0": 0.3, "1": 0.7},
                "legend": {"0": "low", "1": "high"},
            },
        },
    }
    result = await evaluate(
        JevSettings(enabled=True),
        JevContext("feature-build", tmp_path),
        point="review",
        key="k",
        state={"request": "hello"},
        questions=questions,
        client=JevClient(
            httpx.MockTransport(lambda _: httpx.Response(200, json=response))
        ),
    )
    assert result.status == "evaluated"
    assert result.answers["yes"].confidence is None
    assert result.answers["score"].value == 0.7
