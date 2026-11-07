"""The fake agent in place of ``runners/spec_runner.py`` (the ``spec`` phase)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_agent import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main("spec", sys.argv[1:]))
