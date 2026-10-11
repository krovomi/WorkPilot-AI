"""
pytest configuration file — the repository's root conftest.

It applies to every test the root `pytest.ini` collects: `tests/`, and what
still lives under `apps/backend/`. The two autouse fixtures below lived in
`apps/backend/conftest.py`, where they protected only the backend's own tests;
the tests moved to `tests/` in lot L11 (audit F31) need them as much.
"""

import sys
from pathlib import Path

import pytest

# Add the project root to the Python path
project_root = Path(__file__).parent
src_path = project_root / "src"

# Ensure both project root and src are in the Python path
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))
if str(src_path) not in sys.path:
    sys.path.insert(0, str(src_path))

print(f"Python path includes: {project_root}")
print(f"Python path includes: {src_path}")


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

    Read from `sys.modules` rather than imported: this conftest serves every
    test in the repository, and importing the runner exits the interpreter in
    an environment without its dependencies (the skills-eval job installs
    three packages). A module nobody imported holds no singleton to reset.
    """
    _reset_rate_limiter()
    yield
    _reset_rate_limiter()


def _reset_rate_limiter() -> None:
    module = sys.modules.get("runners.github.rate_limiter")
    if module is not None:
        module.RateLimiter.reset_instance()
