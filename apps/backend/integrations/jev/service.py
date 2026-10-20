"""Validate every answer and preserve cooperative pause/cancellation."""

from __future__ import annotations

import asyncio
import json
import math
from collections.abc import Mapping

from core.build_signals import BuildPaused
from core.pause_state import is_paused

from .client import JevClient, JevRequestError
from .context import MAX_STATE_BYTES
from .models import (
    MODEL_ID,
    JevAnswer,
    JevContext,
    JevOutcome,
    JevPoint,
    JevQuestion,
    JevSettings,
    finite_number,
)
from .settings import bypass_reason


def _probabilities(raw: object, expected: set[str]) -> dict[str, float]:
    if not isinstance(raw, dict) or set(raw) != expected:
        raise ValueError
    if any(not finite_number(v) or not 0 <= v <= 1 for v in raw.values()):
        raise ValueError
    if not math.isclose(sum(raw.values()), 1.0, abs_tol=1e-4):
        raise ValueError
    return raw


def validate_response(
    response: dict, questions: Mapping[str, JevQuestion], minimum_confidence: float
) -> JevOutcome:
    try:
        model = response["model"]
        raw_answers = response["answers"]
        if (
            not isinstance(model, str)
            or not MODEL_ID.fullmatch(model)
            or not isinstance(raw_answers, dict)
            or set(raw_answers) != set(questions)
        ):
            raise ValueError
        answers = {}
        low_confidence = False
        for name, question in questions.items():
            raw = raw_answers[name]
            if not isinstance(raw, dict) or raw.get("type") != question.type:
                raise ValueError
            confidence = None
            probabilities = {}
            if question.type == "noul":
                value = raw["noul"]
                if not finite_number(value) or not 0 <= value <= 1:
                    raise ValueError
            else:
                confidence = raw["confidence"]
                if not finite_number(confidence) or not 0 <= confidence <= 1:
                    raise ValueError
                low_confidence |= confidence < minimum_confidence
                if question.type == "choice":
                    probabilities = _probabilities(
                        raw["probabilities"], set(question.criteria or {})
                    )
                    value = raw["choice"]
                    if (
                        not isinstance(value, str)
                        or value not in probabilities
                        or probabilities[value] != max(probabilities.values())
                    ):
                        raise ValueError
                else:
                    size = len(question.criteria or ())
                    probabilities = _probabilities(
                        raw["probabilities"], {str(i) for i in range(size)}
                    )
                    value = raw["score"]
                    if not finite_number(value) or not 0 <= value <= size - 1:
                        raise ValueError
                    if not math.isclose(
                        value,
                        sum(int(i) * p for i, p in probabilities.items()),
                        abs_tol=1e-4,
                    ):
                        raise ValueError
                    if not isinstance(raw.get("legend"), dict) or set(
                        raw["legend"]
                    ) != set(probabilities):
                        raise ValueError
            answers[name] = JevAnswer(question.type, value, confidence, probabilities)
        usage = response.get("usage", {})
        if not isinstance(usage, dict):
            raise ValueError
        usage = {
            key: usage[key] for key in ("input_tokens", "output_tokens") if key in usage
        }
        if any(
            not isinstance(v, int) or isinstance(v, bool) or v < 0
            for v in usage.values()
        ):
            raise ValueError
        if low_confidence:
            return JevOutcome("bypassed", "low_confidence", model=model, usage=usage)
        return JevOutcome("evaluated", answers=answers, model=model, usage=usage)
    except (KeyError, TypeError, ValueError, OverflowError):
        return JevOutcome("bypassed", "invalid_response")


async def evaluate(
    settings: JevSettings,
    context: JevContext,
    *,
    point: JevPoint,
    key: str | None,
    state: dict,
    questions: dict[str, JevQuestion],
    client: JevClient,
) -> JevOutcome:
    reason = bypass_reason(settings, context, has_key=bool(key))
    if reason:
        return JevOutcome("bypassed", reason)
    phase = "planning" if point == "classification" else "qa"
    if context.spec_dir and is_paused(context.spec_dir):
        raise BuildPaused(phase)
    if not state or not questions:
        return JevOutcome("bypassed", "missing_context")
    try:
        if (
            len(json.dumps(state, ensure_ascii=False, allow_nan=False).encode("utf-8"))
            > MAX_STATE_BYTES
        ):
            return JevOutcome("bypassed", "context_too_large")
    except (ValueError, TypeError, RecursionError):
        return JevOutcome("bypassed", "missing_context")
    payload = {
        "model": settings.model,
        "state": state,
        "questions": {name: q.to_dict() for name, q in questions.items()},
    }

    async def watch_pause() -> None:
        while True:
            if context.spec_dir and is_paused(context.spec_dir):
                raise BuildPaused(phase)
            await asyncio.sleep(0.1)

    request = asyncio.create_task(
        client.post(
            key=key or "", payload=payload, timeout_seconds=settings.timeout_seconds
        )
    )
    watcher = asyncio.create_task(watch_pause())
    try:
        done, _ = await asyncio.wait(
            (request, watcher), return_when=asyncio.FIRST_COMPLETED
        )
        if watcher in done:
            await watcher
        response = await request
        if context.spec_dir and is_paused(context.spec_dir):
            raise BuildPaused(phase)
        return validate_response(response, questions, settings.minimum_confidence)
    except JevRequestError as exc:
        return JevOutcome("bypassed", exc.reason)
    finally:
        request.cancel()
        watcher.cancel()
        await asyncio.gather(request, watcher, return_exceptions=True)
