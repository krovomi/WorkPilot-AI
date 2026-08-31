"""Root conftest.py — adds backend root to sys.path for all test modules."""

import sys
from pathlib import Path

# Ensure the backend root is on sys.path so absolute imports work
# (e.g. `from streaming.agent_wrapper import ...`, `from cli.main import ...`)
backend_root = str(Path(__file__).parent)
if backend_root not in sys.path:
    sys.path.insert(0, backend_root)


import pytest


@pytest.fixture(autouse=True)
def _isolate_ambient_provider_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep the caller's shell out of the provider-resolution path.

    `core.auth` treats a non-empty `ANTHROPIC_BASE_URL` as "API profile mode"
    and raises when `ANTHROPIC_AUTH_TOKEN` is missing. Both are ordinary
    variables to export — WorkPilot's own API-profile mode sets them, and so
    does the Claude Code CLI — so any test touching auth passed or failed
    depending on whose shell ran it. Seven did, here.

    A test that wants either variable sets it explicitly; ambient values are
    not input. `monkeypatch` restores whatever was there afterwards.
    """
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)


@pytest.fixture(autouse=True)
def _reset_rate_limiter_singleton() -> None:
    """Hand every test a fresh `RateLimiter`.

    `RateLimiter` is a process-wide singleton, so a test that configures it —
    a zero refill rate, an exhausted budget, a mocked method — leaves that
    configuration behind for everything that runs afterwards in the same
    session. `gh_client` then unpacked `check_github_available()` into
    `available, msg` and got an empty tuple.

    Nothing showed it while `tests/` and the backend's own tests never ran
    together. `test_rate_limiter.py` already resets in its `setup_method`,
    which protected its own class and no one else's.
    """
    try:
        from runners.github.rate_limiter import RateLimiter
    except ImportError:  # pragma: no cover - le module n'est pas toujours importable
        yield
        return

    RateLimiter.reset_instance()
    yield
    RateLimiter.reset_instance()
