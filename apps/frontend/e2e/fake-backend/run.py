"""The fake `run.py` of the Electron E2E (see fake_agent.py)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fake_agent import run_main  # noqa: E402

if __name__ == "__main__":
    sys.exit(run_main(sys.argv[1:]))
