"""The fake `runners/spec_runner.py` of the Electron E2E (see fake_agent.py)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fake_agent import spec_main  # noqa: E402

if __name__ == "__main__":
    sys.exit(spec_main(sys.argv[1:]))
