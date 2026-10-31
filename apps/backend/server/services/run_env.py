"""The environment an agent run starts with, on a shared server.

A run executes an agent that reads untrusted content (issues, tickets, the
repository it works on) and runs commands. On a shared server, the API's own
process environment holds what makes it the server: the key that signs every
user's token, the key that decrypts every user's stored secrets, the database
address and password, the mail password. Handing that environment to a run
would hand any tenant's agent the keys to every other tenant.

So the run environment is built, not inherited (docs/rules/security.md, S4):
the API environment minus every variable the server reads for itself, plus
what the run needs (its streaming token, its user, that user's own
integration secrets). Provider credentials the operator set for builds
(``CLAUDE_CODE_OAUTH_TOKEN`` and the like) stay: the run needs them, and they
are the deployment's, not a tenant's.

``tests/backend/test_run_env.py`` reads every ``WORKPILOT_*`` name the
``server`` package uses and fails when one is neither stripped here nor listed
as passed to runs, so a new server setting cannot leak by default.
"""

from __future__ import annotations

from collections.abc import Mapping

#: Read by the server for itself (``server/config.py``, ``server/scripts``,
#: the deploy files). Never given to a run.
SERVER_ONLY_ENV: frozenset[str] = frozenset(
    {
        "WORKPILOT_SERVER_MODE",
        "WORKPILOT_DATABASE_URL",
        "WORKPILOT_JWT_SECRET",
        "WORKPILOT_JWT_ISSUER",
        "WORKPILOT_SECRETS_MASTER_KEY",
        "WORKPILOT_ACCESS_TOKEN_TTL_MINUTES",
        "WORKPILOT_REFRESH_TOKEN_TTL_DAYS",
        "WORKPILOT_INVITATION_TTL_HOURS",
        "WORKPILOT_PASSWORD_MIN_LENGTH",
        "WORKPILOT_PASSWORD_HIBP_CHECK",
        "WORKPILOT_PUBLIC_BASE_URL",
        "WORKPILOT_PUBLIC_STREAM_URL",
        "WORKPILOT_REPOS_ROOT",
        "WORKPILOT_MAX_CONCURRENT_RUNS",
        "WORKPILOT_ENTRA_TENANT_ID",
        "WORKPILOT_ENTRA_CLIENT_ID",
        "WORKPILOT_SMTP_HOST",
        "WORKPILOT_SMTP_PORT",
        "WORKPILOT_SMTP_USER",
        "WORKPILOT_SMTP_PASSWORD",
        "WORKPILOT_SMTP_FROM",
        "WORKPILOT_SMTP_USE_TLS",
        "WORKPILOT_SMTP_USE_SSL",
        "WORKPILOT_ADMIN_PASSWORD",
        "WORKPILOT_WS_ALLOWED_ORIGINS",
        # The PostgreSQL password of deploy/docker-compose.yml, which reaches
        # the API through the same env file.
        "POSTGRES_PASSWORD",
    }
)

#: ``WORKPILOT_*`` names the server sets *for* a run. Whatever the API
#: process had under these names is replaced, never passed through.
RUN_ENV: frozenset[str] = frozenset(
    {
        "WORKPILOT_WS_TOKEN",
        "WORKPILOT_RUN_USER_ID",
    }
)

#: Read by the API to reach the streaming server; harmless to a run, which
#: talks to the same server.
PASSED_TO_RUNS: frozenset[str] = frozenset({"WORKPILOT_WS_URL"})


def run_environment(
    server_env: Mapping[str, str], run_values: Mapping[str, str]
) -> dict[str, str]:
    """`server_env` without the server's own variables, plus `run_values`."""
    env = {
        name: value
        for name, value in server_env.items()
        if name not in SERVER_ONLY_ENV and name not in RUN_ENV
    }
    env.update(run_values)
    return env
