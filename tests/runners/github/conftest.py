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

_GITHUB_RUNNER = (
    Path(__file__).resolve().parents[3] / "apps" / "backend" / "runners" / "github"
)
if str(_GITHUB_RUNNER) not in sys.path:
    sys.path.append(str(_GITHUB_RUNNER))
