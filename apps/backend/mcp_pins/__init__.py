"""MCP tool pinning: a custom server's tools reach an agent only as the person approved them.

Against tool poisoning (instructions hidden in a tool's description, which the
model reads and the person never sees) and the rug pull (a server approved
once that changes its tools later). See docs/architecture/mcp-pins.md.
"""

from .fingerprint import ToolSnapshot, config_digest, tool_snapshot
from .scan import description_findings
from .store import (
    APPROVED,
    CHANGED,
    PENDING,
    PINS_FILE,
    UNKNOWN,
    PinError,
    Verdict,
    approve,
    load_pins,
    pins_path,
    pins_root,
    reconcile,
    server_states,
)

__all__ = [
    "APPROVED",
    "CHANGED",
    "PENDING",
    "PINS_FILE",
    "UNKNOWN",
    "PinError",
    "ToolSnapshot",
    "Verdict",
    "approve",
    "config_digest",
    "description_findings",
    "load_pins",
    "pins_path",
    "pins_root",
    "reconcile",
    "server_states",
    "tool_snapshot",
]
