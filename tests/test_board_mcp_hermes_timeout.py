"""The timeout the app writes into a hermes entry outlasts ``wait_for_card``.

hermes cuts an MCP call at 300 s unless ``mcp_servers.<name>.timeout`` says
otherwise. The app writes that key (`HERMES_MCP_TIMEOUT_SECONDS`, TypeScript)
and the board decides how long a wait may be (`MAX_WAIT_SECONDS`, Python):
two languages, one promise, so this test reads both.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from board_mcp.server import MAX_WAIT_SECONDS  # noqa: E402

TS = REPO_ROOT / "apps" / "frontend" / "src" / "shared" / "types" / "board-mcp.ts"


def _ts_seconds() -> int:
    text = TS.read_text(encoding="utf-8")
    match = re.search(r"HERMES_MCP_TIMEOUT_SECONDS\s*=\s*([\d\s*+]+);", text)
    assert match, "HERMES_MCP_TIMEOUT_SECONDS is a constant expression of numbers"
    total = 0
    for term in match.group(1).split("+"):
        product = 1
        for factor in term.split("*"):
            product *= int(factor.strip())
        total += product
    return total


def test_the_hermes_timeout_outlasts_the_longest_wait():
    seconds = _ts_seconds()
    assert seconds > MAX_WAIT_SECONDS
    # A margin for the last poll and the answer, not a second wait.
    assert seconds - MAX_WAIT_SECONDS <= 300
