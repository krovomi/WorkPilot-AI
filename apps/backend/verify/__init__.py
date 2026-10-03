"""The verification loop: launch the app the task changed and prove it works.

See `loop.py` for the loop, `tools.py` for the `verify_*` tools every provider
gets, and `docs/CLAUDE.md` → *Verification loop (verify)* for the design.
"""

from __future__ import annotations

import sys
from pathlib import Path

__all__ = ["mcp_server_config", "SERVER_KEY"]

SERVER_KEY = "workpilot-verify"
_BACKEND = Path(__file__).resolve().parent.parent


def mcp_server_config(
    project_dir: Path | str,
    spec_dir: Path | str | None = None,
    *,
    keep_apps: bool = False,
) -> dict:
    """The stdio entry that starts `workpilot-verify` for one project/spec."""
    args = [
        str(_BACKEND / "runners" / "verify_mcp.py"),
        "--project-dir",
        str(project_dir),
    ]
    if spec_dir:
        args += ["--spec-dir", str(spec_dir)]
    config: dict = {"command": sys.executable, "args": args}
    if keep_apps:
        config["env"] = {"WORKPILOT_VERIFY_KEEP_APPS": "1"}
    return config
