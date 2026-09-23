"""Typed, non-secret values exchanged with the optional JEV integration."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Literal

JevMode = Literal["inherit", "enabled", "bypass"]
JevPoint = Literal["classification", "review"]
BypassReason = Literal[
    "disabled",
    "workflow_bypass",
    "offline",
    "missing_key",
    "invalid_config",
    "missing_context",
    "context_too_large",
    "unauthorized",
    "rate_limited",
    "timeout",
    "unavailable",
    "invalid_response",
    "low_confidence",
    "unsupported_context",
]
WORKFLOW_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,79}$")
MODEL_ID = re.compile(r"^jev-[a-zA-Z0-9_.-]{1,75}$")


class JevSettingsError(ValueError):
    """Invalid non-sensitive configuration."""


def finite_number(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


@dataclass(frozen=True)
class JevSettings:
    enabled: bool = False
    workflows: Mapping[str, JevMode] = field(default_factory=dict)
    model: str = "jev-latest"
    minimum_confidence: float = 0.8
    timeout_seconds: float = 5.0

    def __post_init__(self) -> None:
        if not isinstance(self.enabled, bool) or not isinstance(
            self.workflows, Mapping
        ):
            raise JevSettingsError("invalid configuration")
        if any(
            not isinstance(k, str)
            or not WORKFLOW_ID.fullmatch(k)
            or v not in ("inherit", "enabled", "bypass")
            for k, v in self.workflows.items()
        ):
            raise JevSettingsError("invalid workflow modes")
        if not isinstance(self.model, str) or not MODEL_ID.fullmatch(self.model):
            raise JevSettingsError("invalid model")
        if (
            not finite_number(self.minimum_confidence)
            or not 0 <= self.minimum_confidence <= 1
        ):
            raise JevSettingsError("invalid confidence")
        if (
            not finite_number(self.timeout_seconds)
            or not 0 < self.timeout_seconds <= 60
        ):
            raise JevSettingsError("invalid timeout")
        object.__setattr__(self, "workflows", MappingProxyType(dict(self.workflows)))


@dataclass(frozen=True)
class JevContext:
    workflow: str
    project_dir: Path
    spec_dir: Path | None = None
    server_mode: bool = False


@dataclass(frozen=True)
class JevQuestion:
    type: Literal["choice", "score", "noul"]
    instructions: str
    criteria: Mapping[str, str] | tuple[str, ...] | None = None

    def to_dict(self) -> dict:
        result = {"type": self.type, "instructions": self.instructions}
        if self.criteria is not None:
            result["criteria"] = (
                dict(self.criteria)
                if isinstance(self.criteria, Mapping)
                else list(self.criteria)
            )
        return result


@dataclass(frozen=True)
class JevAnswer:
    type: Literal["choice", "score", "noul"]
    value: str | float
    confidence: float | None = None
    probabilities: Mapping[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class JevOutcome:
    status: Literal["evaluated", "bypassed"]
    reason: BypassReason | None = None
    answers: Mapping[str, JevAnswer] = field(default_factory=dict)
    model: str | None = None
    usage: Mapping[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "reason": self.reason,
            "model": self.model,
            "answers": {
                key: {
                    "type": answer.type,
                    "value": answer.value,
                    "confidence": answer.confidence,
                    "probabilities": dict(answer.probabilities),
                }
                for key, answer in self.answers.items()
            },
            "usage": dict(self.usage),
        }
