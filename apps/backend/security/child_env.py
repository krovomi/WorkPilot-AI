"""The environment of a child process that runs the project's own code.

The backend carries provider credentials in ``os.environ``: the main process
put them there for the agents. A test suite, a build script or any command
the task's code can change needs none of them, and the code it runs was
written by an agent that read external content (docs/rules/security.md, S1
and S4: a secret only goes to the process that needs it). Same rule as
``envWithoutCredentials`` in ``apps/frontend/src/main/utils/child-env.ts``.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping

__all__ = ["env_without_credentials", "is_credential_name"]

_NAMED = frozenset(
    {
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CONFIG_DIR",
        "SENTRY_DSN",
    }
)

# FOO_API_KEY, GH_TOKEN, DB_PASSWORD, AWS_SECRET_ACCESS_KEY, X_PAT…
_SHAPED = re.compile(
    r"(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PAT|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?|DSN)(_|$)",
    re.IGNORECASE,
)


def is_credential_name(name: str) -> bool:
    return name.upper() in _NAMED or bool(_SHAPED.search(name))


def env_without_credentials(
    base: Mapping[str, str] | None = None,
    extra: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """``base`` (default ``os.environ``) without its credentials, plus ``extra``."""
    source = os.environ if base is None else base
    env = {k: v for k, v in source.items() if not is_credential_name(k)}
    env.update(extra or {})
    return env
