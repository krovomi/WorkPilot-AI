"""Entry point of the ``workpilot-brain`` MCP server (stdio).

    python runners/brain_mcp.py            # the brain in WORKPILOT_BRAIN_DIR, or ~/.workpilot/brain

This is the command `brain/connect.py` registers in every agent's configuration.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from brain.mcp_server import serve  # noqa: E402

if __name__ == "__main__":
    serve()
