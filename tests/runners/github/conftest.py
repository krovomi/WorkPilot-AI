"""conftest.py for the runners/github tests moved out of the backend.

The runner's modules import each other by bare name (`from gh_client import
...`), so the directory they live in has to be on sys.path — the role of
`apps/backend/runners/github/conftest.py` while these tests sat beside it.

Appended, not prepended: conftests load before collection, and this
directory holds a `services` package of its own that would otherwise shadow
the backend's `services` for every test in the session.
"""

import sys
from pathlib import Path

import pytest

from tests.gh_fake import write_fake_gh

_GITHUB_RUNNER = (
    Path(__file__).resolve().parents[3] / "apps" / "backend" / "runners" / "github"
)
if str(_GITHUB_RUNNER) not in sys.path:
    sys.path.append(str(_GITHUB_RUNNER))


GH_VERSION = {"--version": {"stdout": "gh version 2.80.0\n"}}


@pytest.fixture
def gh(tmp_path, monkeypatch):
    """A fake `gh` the backend finds first (tests/gh_fake.py).

    It always passes the CLI check (`gh --version`), and `calls()` leaves that
    check out, so a test sees only the commands the code under test sent.
    """
    fake = write_fake_gh(tmp_path / "gh", GH_VERSION)
    answer, calls = fake.answer, fake.calls
    fake.answer = lambda answers: answer({**GH_VERSION, **answers})
    fake.calls = lambda: [c for c in calls() if c != ["--version"]]
    monkeypatch.setenv("GITHUB_CLI_PATH", str(fake.path))
    import core.gh_executable as gh_executable

    monkeypatch.setattr(gh_executable, "_cached_gh_path", None)
    return fake
