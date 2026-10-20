"""Entry point of the ``workpilot-docintel`` MCP server (stdio).

    python runners/docintel_mcp.py --project-dir /path/to/project

Without ``--project-dir``, the project is ``WORKPILOT_DOCINTEL_ROOT``, then the
working directory — which is what an agent's MCP configuration usually starts
the server in.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from docintel.mcp_server import resolve_root, serve  # noqa: E402

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-dir", default=None)
    serve(resolve_root(parser.parse_args().project_dir))
