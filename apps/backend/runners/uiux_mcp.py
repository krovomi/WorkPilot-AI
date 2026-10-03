"""Entry point of the ``workpilot-uiux`` MCP server (stdio).

    python runners/uiux_mcp.py --project-dir /path/to/project

Without ``--project-dir``, the project is ``WORKPILOT_UIUX_ROOT``, then the
working directory — which is what an agent's MCP configuration usually starts
the server in. For Claude Code on a project of your own::

    claude mcp add workpilot-uiux -- python <WorkPilot>/apps/backend/runners/uiux_mcp.py --project-dir .
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from uiux.mcp_server import resolve_root, serve  # noqa: E402

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-dir", default=None)
    serve(resolve_root(parser.parse_args().project_dir))
