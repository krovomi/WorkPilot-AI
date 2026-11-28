"""The server's own ``runners/pr_captures_runner.py``, for the ``captures`` phase.

``serve_api.py`` points the directory runs start from at ``fake_backend/``, so
that no model runs. The ``captures`` phase runs no model either (it hosts the
published copies in the card's pull request, or takes them out), so this file
hands it to the real runner, unchanged: the end-to-end world runs the phase a
person's « Publish » starts as a deployment would.
"""

from __future__ import annotations

import runpy
import sys
from pathlib import Path

REAL = Path(__file__).resolve().parents[4] / "apps" / "backend" / "runners"

if __name__ == "__main__":
    sys.argv[0] = str(REAL / "pr_captures_runner.py")
    runpy.run_path(sys.argv[0], run_name="__main__")
