"""Resolve opt-in settings without creating an HTTP client."""

from __future__ import annotations

import json
from collections.abc import Mapping, MutableMapping

from core.offline_policy import airgap_status

from .models import BypassReason, JevContext, JevSettings, JevSettingsError


def settings_from_env(env: Mapping[str, str]) -> JevSettings:
    enabled = env.get("WORKPILOT_JEV_ENABLED", "0").strip().lower()
    if enabled not in ("1", "true", "yes", "on", "0", "false", "no", "off"):
        raise JevSettingsError("invalid enabled value")
    try:
        return JevSettings(
            enabled=enabled in ("1", "true", "yes", "on"),
            workflows=json.loads(env.get("WORKPILOT_JEV_WORKFLOW_MODES", "{}")),
            model=env.get("WORKPILOT_JEV_MODEL", "jev-latest"),
            minimum_confidence=float(
                env.get("WORKPILOT_JEV_MINIMUM_CONFIDENCE", "0.8")
            ),
            timeout_seconds=float(env.get("WORKPILOT_JEV_TIMEOUT_SECONDS", "5")),
        )
    except (ValueError, TypeError, OverflowError) as exc:
        raise JevSettingsError("invalid configuration") from exc


def bypass_reason(
    settings: JevSettings, context: JevContext, *, has_key: bool
) -> BypassReason | None:
    try:
        if airgap_status(context.project_dir, context.spec_dir)["airgapStrict"]:
            return "offline"
    except (OSError, ValueError, TypeError):
        return "offline"
    if context.server_mode:
        return "unsupported_context"
    mode = settings.workflows.get(context.workflow, "inherit")
    if mode == "bypass":
        return "workflow_bypass"
    if mode != "enabled" and not settings.enabled:
        return "disabled"
    if not has_key:
        return "missing_key"
    return None


def consume_api_key(env: MutableMapping[str, str]) -> str | None:
    return env.pop("TYPESAFE_API_KEY", "").strip() or None
