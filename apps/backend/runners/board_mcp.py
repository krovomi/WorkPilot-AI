"""Entry point of the ``workpilot-board`` MCP server (stdio).

    python runners/board_mcp.py --project-dir /path/to/project

Without ``--project-dir``, the project is ``WORKPILOT_BOARD_ROOT``, then the
working directory. To drive the board from Claude Code in a terminal:

    claude mcp add workpilot-board -- python <WorkPilot>/apps/backend/runners/board_mcp.py --project-dir <project>
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from board_mcp.server import resolve_root, serve  # noqa: E402

if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-dir", default=None)
    args = parser.parse_args()
    serve(resolve_root(args.project_dir))
