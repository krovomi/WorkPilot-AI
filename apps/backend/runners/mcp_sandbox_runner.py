"""
MCP sandbox runner — whether this machine starts a confined MCP server.

Spawned by the Electron main process (``main/mcp-security/sandbox-status.ts``)
so the marketplace and Agent Tools can say, next to a server that must run
confined, that it will not start here and why. The answer is the one the
backend applies when it starts the server (``core.mcp_confinement``,
``machine_confinement``): no second detector in the app.

One JSON object on stdout::

  {"available": false, "kind": "missing", "backend": "bubblewrap", "reason": "..."}

Usage::

    python mcp_sandbox_runner.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from core.mcp_confinement import machine_confinement  # noqa: E402


def main() -> int:
    print(json.dumps(machine_confinement().to_dict()), flush=True)
    return 0


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    sys.exit(main())
