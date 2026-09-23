"""Per-execution state. No global credentials, event loop objects or network cache."""

from __future__ import annotations

import os
from collections.abc import MutableMapping
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from .client import JevClient
from .context import redact
from .models import (
    WORKFLOW_ID,
    JevContext,
    JevOutcome,
    JevPoint,
    JevQuestion,
    JevSettings,
    JevSettingsError,
)
from .observations import write_observation
from .service import evaluate
from .settings import bypass_reason, consume_api_key, settings_from_env


def _server_context(context: JevContext) -> JevContext:
    if context.server_mode:
        return context
    try:
        from server.config import get_settings

        return replace(context, server_mode=bool(get_settings().server_mode))
    except ImportError:
        return context
    except Exception:
        # Failure to establish the security boundary only disables this optional service.
        return replace(context, server_mode=True)


class JevRun:
    def __init__(
        self,
        settings: JevSettings,
        context: JevContext,
        *,
        key: str | None,
        run_id: str,
        client: JevClient | None = None,
        invalid_config: bool = False,
    ) -> None:
        self.settings = settings
        self.context = _server_context(context)
        self._key = key if not self.context.server_mode else None
        self.run_id = run_id
        self.client = client or JevClient()
        self.invalid_config = invalid_config
        self._cached: dict[tuple[str, str, str], JevOutcome] = {}
        self._suspended_reason = None
        self.observation: dict = {
            "version": 1,
            "runId": run_id,
            "workflow": context.workflow,
            "evaluations": [],
        }

    @classmethod
    def from_env(
        cls, context: JevContext, *, env: MutableMapping[str, str] | None = None
    ) -> JevRun:
        source = os.environ if env is None else env
        context = _server_context(context)
        key = None if context.server_mode else consume_api_key(source)
        invalid = False
        try:
            settings = settings_from_env(source)
        except JevSettingsError:
            settings = JevSettings()
            invalid = True
        return cls(
            settings, context, key=key, run_id=uuid4().hex, invalid_config=invalid
        )

    def fork(self, context: JevContext | None = None) -> JevRun:
        """A fresh review in the same worker retains its private credential, not prior results."""
        return JevRun(
            self.settings,
            context or self.context,
            key=self._key,
            run_id=uuid4().hex,
            client=self.client,
            invalid_config=self.invalid_config,
        )

    def _redact(self, value: Any) -> Any:
        if isinstance(value, str):
            return redact(value, (self._key,) if self._key else ())
        if isinstance(value, dict):
            return {key: self._redact(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self._redact(item) for item in value]
        return value

    def record(
        self, point: JevPoint, *, pass_id: str, revision: str, outcome: JevOutcome
    ) -> JevOutcome:
        row = {
            **outcome.to_dict(),
            "point": point,
            "passId": pass_id,
            "revision": revision,
            "createdAt": datetime.now(UTC).isoformat(),
        }
        # Only machine-controlled ids and validated values are recorded.
        self.observation["evaluations"] = [
            *self.observation["evaluations"][-49:],
            self._redact(row),
        ]
        directory = self.context.spec_dir
        if (
            directory is None
            and WORKFLOW_ID.fullmatch(self.context.workflow)
            and WORKFLOW_ID.fullmatch(self.run_id)
        ):
            directory = (
                self.context.project_dir
                / ".workpilot"
                / "jev"
                / self.context.workflow
                / self.run_id
            )
        if directory:
            write_observation(directory, self.observation)
        return outcome

    def eligibility(self) -> str | None:
        reason = bypass_reason(self.settings, self.context, has_key=bool(self._key))
        if reason in ("offline", "unsupported_context"):
            return reason
        if self.invalid_config:
            return "invalid_config"
        return reason or self._suspended_reason

    async def evaluate(
        self,
        point: JevPoint,
        *,
        pass_id: str,
        revision: str,
        state: dict,
        questions: dict[str, JevQuestion],
    ) -> JevOutcome:
        reason = self.eligibility()
        if reason:
            outcome = JevOutcome("bypassed", reason)
        else:
            cache_key = (point, pass_id, revision)
            outcome = self._cached.get(cache_key)
            if outcome is None:
                outcome = await evaluate(
                    self.settings,
                    self.context,
                    point=point,
                    key=self._key,
                    state=self._redact(state),
                    questions=questions,
                    client=self.client,
                )
                self._cached[cache_key] = outcome
                if outcome.reason in (
                    "unauthorized",
                    "rate_limited",
                    "unavailable",
                    "timeout",
                ):
                    self._suspended_reason = outcome.reason
        return self.record(point, pass_id=pass_id, revision=revision, outcome=outcome)
