"""The fake agent in place of the backend's ``run.py`` (build, qa, merge, pr)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fake_agent import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main("build", sys.argv[1:]))
