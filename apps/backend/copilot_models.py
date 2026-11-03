"""The Copilot models this GitHub account can actually call.

Copilot's catalogue used to come from the public registry (models.dev): every
model GitHub has released to Copilot, whatever the account's plan, its
organisation's policy or the models the user enabled. Picking one the account
does not get ends in ``400 model_not_supported`` — which the Arena showed as
Copilot's answer. ``api.githubcopilot.com/models`` answers for *this* account,
with the same authentication the chat calls use.

A unit of its own, importing nothing from the backend: the model catalogue
(``provider_models_catalog``) reads it without joining ``core``'s import
cycle, and ``core.agent_clients.copilot`` takes its constants from here.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token"
MODELS_URL = "https://api.githubcopilot.com/models"
# Statuses with which the internal exchange refuses a GitHub token that
# api.githubcopilot.com still accepts directly (see
# `CopilotAgentClient._get_copilot_token`).
EXCHANGE_REFUSED_STATUSES = frozenset({403, 404})

# IDE impersonation headers — required by the Copilot API gateway.
# Omitting any of these causes 400 / 421 errors on Copilot Enterprise.
IDE_HEADERS = {
    "editor-version": "vscode/1.104.3",
    "editor-plugin-version": "copilot-chat/0.26.7",
    "user-agent": "GitHubCopilotChat/0.26.7",
    "x-vscode-user-agent-library-version": "electron-fetch",
}

_TIMEOUT = httpx.Timeout(8.0, connect=4.0)


def usable_chat_models(entries: Any) -> list[dict[str, Any]]:
    """The entries of a ``/models`` answer a chat completion can use.

    Kept: chat models offered in the model picker whose policy is not
    ``disabled``. The list also holds embedding models, and internal or
    superseded ids GitHub keeps routable but hides from every picker.
    """
    if not isinstance(entries, list):
        return []
    usable: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            continue
        capabilities = entry.get("capabilities")
        if not isinstance(capabilities, dict) or capabilities.get("type") != "chat":
            continue
        if entry.get("model_picker_enabled") is False:
            continue
        policy = entry.get("policy")
        if isinstance(policy, dict) and policy.get("state") == "disabled":
            continue
        usable.append(entry)
    return usable


def is_served(model: str, entries: Any) -> bool:
    """Whether ``model`` is one of the usable entries of a ``/models`` answer."""
    return any(entry["id"] == model for entry in usable_chat_models(entries))


def _bearer(github_token: str, headers: dict[str, str]) -> str:
    """The token the Copilot API takes for ``github_token`` (sync twin of
    ``CopilotAgentClient._get_copilot_token``, without its cache)."""
    response = httpx.get(
        TOKEN_EXCHANGE_URL,
        headers={
            **headers,
            "Authorization": f"token {github_token}",
            "Accept": "application/json",
        },
        timeout=_TIMEOUT,
    )
    if response.status_code == 200:
        return str(response.json()["token"])
    if response.status_code in EXCHANGE_REFUSED_STATUSES:
        return github_token
    response.raise_for_status()
    raise ValueError(f"token exchange answered {response.status_code}")


def _github_token() -> str:
    """``GITHUB_TOKEN``, else the GitHub CLI's token, else ``""``."""
    import os
    import shutil
    import subprocess

    token = os.environ.get("GITHUB_TOKEN", "")
    if token:
        return token
    gh_exe = os.environ.get("GITHUB_CLI_PATH") or shutil.which("gh")
    if not gh_exe:
        return ""
    try:
        result = subprocess.run(
            [gh_exe, "auth", "token", "--hostname", "github.com"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as error:
        logger.info("[copilot_models] `gh auth token` failed: %s", error)
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def fetch_catalog() -> list[dict[str, Any]]:
    """The catalogue entries for this account's Copilot models.

    Empty when no GitHub token is available: the caller then falls back to the
    registry, as it did before. HTTP failures propagate, so the catalogue can
    report them.
    """
    github_token = _github_token()
    if not github_token:
        return []
    headers = dict(IDE_HEADERS)
    bearer = _bearer(github_token, headers)
    response = httpx.get(
        MODELS_URL,
        headers={
            **headers,
            "Authorization": f"Bearer {bearer}",
            "Accept": "application/json",
        },
        timeout=_TIMEOUT,
    )
    response.raise_for_status()
    data = response.json()
    entries = data.get("data") if isinstance(data, dict) else None
    catalog: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in usable_chat_models(entries):
        mid = entry["id"]
        if mid in seen:
            continue
        seen.add(mid)
        name = entry.get("name")
        label = name if isinstance(name, str) and name.strip() else mid
        supports = (entry.get("capabilities") or {}).get("supports") or {}
        catalog.append(
            {
                "value": mid,
                "label": label,
                "supportsThinking": bool(
                    isinstance(supports, dict)
                    and (
                        supports.get("thinking")
                        or supports.get("adaptive_thinking")
                        or supports.get("reasoning_effort")
                    )
                ),
            }
        )
    logger.info("[copilot_models] %d usable models for this account", len(catalog))
    return catalog
