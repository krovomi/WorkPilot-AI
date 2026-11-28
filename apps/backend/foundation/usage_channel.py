"""The tokens a server run used, told to the server that started it.

A server run (``server/services/run_manager.py``) or job
(``server/services/project_jobs.py``) is started with one end of a pipe open
as a file descriptor, named by ``WORKPILOT_USAGE_FD``. Each agent session the
run ends writes one JSON line there (``core.usage_tracker``): its phase,
agent type, provider, model, token counts and cost. The server reads the
other end and stores the line against the run and the person who started it
(``server/services/usage_records.py``).

A pipe and not a file: the run is confined to its project (Landlock), and a
file it can write, its agent's commands can rewrite. The descriptor is made
non-inheritable as soon as this module loads, so the model's CLI and the
commands it runs never receive it.

Outside a server run the variable is unset and :func:`report` does nothing.
"""

from __future__ import annotations

import json
import os

USAGE_FD_ENV = "WORKPILOT_USAGE_FD"

#: One line stays far below this; the server refuses longer ones.
MAX_LINE_BYTES = 4096


def _channel() -> int | None:
    raw = os.environ.get(USAGE_FD_ENV, "").strip()
    if not raw.isdigit():
        return None
    fd = int(raw)
    try:
        os.fstat(fd)
    except OSError:
        return None
    return fd


def claim() -> int | None:
    """The usage descriptor of this run, made non-inheritable, or None."""
    fd = _channel()
    if fd is None:
        return None
    try:
        os.set_inheritable(fd, False)
    except OSError:
        return None
    return fd


def report(record: dict[str, object]) -> bool:
    """Write ``record`` as one line to the server. Never raises.

    Returns whether a line was written: False outside a server run, or when
    the line would be too long or the server stopped reading.
    """
    fd = _channel()
    if fd is None:
        return False
    try:
        line = (json.dumps(record, separators=(",", ":")) + "\n").encode("utf-8")
    except (TypeError, ValueError):
        return False
    if len(line) > MAX_LINE_BYTES:
        return False
    try:
        # A pipe write up to PIPE_BUF (4096 on Linux) is atomic: two sessions
        # ending at once never interleave their lines.
        return os.write(fd, line) == len(line)
    except OSError:
        return False


claim()
