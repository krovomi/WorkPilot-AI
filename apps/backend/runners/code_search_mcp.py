"""Entry point of the ``workpilot-code`` MCP server (stdio).

    python runners/code_search_mcp.py --project-dir /path/to/project

Without ``--project-dir``, the project is ``WORKPILOT_CODE_ROOT``, then the
working directory, which is where an agent's MCP configuration usually starts
the server.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from harness.tools.code_search_mcp import resolve_root, serve  # noqa: E402

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-dir", default=None)
    args = parser.parse_args()
    serve(resolve_root(args.project_dir))
