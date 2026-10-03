"""Entry point of the ``workpilot-verify`` MCP server (stdio).

    python runners/verify_mcp.py --project-dir /path/to/project [--spec-dir …]

Without ``--project-dir``, the project is ``WORKPILOT_VERIFY_ROOT``, then the
working directory — which is what an agent's MCP configuration usually starts
the server in.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from verify.mcp_server import resolve_root, serve  # noqa: E402

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-dir", default=None)
    parser.add_argument("--spec-dir", default=None)
    args = parser.parse_args()
    serve(
        resolve_root(args.project_dir), Path(args.spec_dir) if args.spec_dir else None
    )
