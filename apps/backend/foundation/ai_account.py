"""
The AI account a run's sessions are billed to, as the desktop app names it.

The app starts each agent process with ``WORKPILOT_AI_ACCOUNTS``: a JSON object
from provider to the id of the account that process runs on (an account of
Settings → AI accounts, or ``claude:<profile>`` for a Claude sign-in). The ids
are opaque labels, never a key. ``usage_tracker`` writes the one of the
session's provider beside its spend, so the app can add up each account's
month (``apps/frontend/src/main/ai-accounts/account-usage.ts``).

The value comes from the environment, so it is checked like any input: a
bounded object of short ids; anything else counts as no account.
"""

from __future__ import annotations

import json
import os
import re

ENV_VAR = "WORKPILOT_AI_ACCOUNTS"

_MAX_RAW = 4_000
_ID = re.compile(r"^[A-Za-z0-9._:-]{1,100}$")

# The names a backend session gives a provider, mapped to the app's.
_ALIASES = {
    "anthropic": "claude",
    "claude-code": "claude",
    "gemini": "google",
    # The Codex CLI client (core/codex_cli_client.py); its accounts are "codex" sign-ins.
    "openai-codex-cli": "codex",
}


def _provider_key(provider: str) -> str:
    name = (provider or "").strip().lower()
    return _ALIASES.get(name, name)


def _accounts(raw: str | None) -> dict[str, str]:
    if not raw or len(raw) > _MAX_RAW:
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        _provider_key(key): value
        for key, value in data.items()
        if isinstance(key, str) and isinstance(value, str) and _ID.match(value)
    }


def account_for(provider: str, environ: dict[str, str] | None = None) -> str | None:
    """The account id the app gave for ``provider``, or None."""
    env = os.environ if environ is None else environ
    return _accounts(env.get(ENV_VAR)).get(_provider_key(provider))
