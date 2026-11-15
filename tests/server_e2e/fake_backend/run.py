"""The fake agent in place of the backend's ``run.py`` (build, qa, merge, pr)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fake_agent import main  # noqa: E402

#: The flag the server adds for each phase (``run_manager.PHASE_ARGS``).
_PHASE_FLAGS = {"--qa": "qa", "--merge": "merge", "--create-pr": "pr"}


def _phase(argv: list[str]) -> str:
    return next((_PHASE_FLAGS[arg] for arg in argv if arg in _PHASE_FLAGS), "build")


if __name__ == "__main__":
    sys.exit(main(_phase(sys.argv[1:]), sys.argv[1:]))
