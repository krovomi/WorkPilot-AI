"""Processes the test session started and left running, stopped at its end.

The Windows runner ended each job by killing what the tests had left behind
(`Terminate orphan process: ... (python)`): a process a test started, whose
parent is gone, still running when pytest exits. On CI the session stops them
itself and names each one in a warning annotation, so the test that leaks it
can be found and fixed. Off CI it only reports: on a person's machine a
process born during the session may be theirs.
"""

from __future__ import annotations

import os

#: Set by the outermost session: a test that runs pytest in a subprocess must
#: not stop what the outer session's tests are running.
OWNER = "WORKPILOT_TEST_SESSION_PID"
os.environ.setdefault(OWNER, str(os.getpid()))

#: An orphan younger than the session but this close to its start may be the
#: runner's own (it starts things around the step): not ours to stop.
_GRACE_SECONDS = 2.0


def leftovers() -> list:
    """Processes started during this session whose parent is this session or gone."""
    try:
        import psutil
    except ImportError:
        return []
    me = psutil.Process()
    started = me.create_time() + _GRACE_SECONDS
    mine = {child.pid for child in me.children(recursive=True)}
    found = []
    for process in psutil.process_iter(["pid", "ppid", "create_time"]):
        info = process.info
        if info["pid"] in mine:
            found.append(process)
        elif (
            info["pid"] != me.pid
            and (info["create_time"] or 0) >= started
            and not psutil.pid_exists(info["ppid"] or 0)
        ):
            # An orphan born during the session: on Windows its parent's pid
            # stays recorded after the parent exits.
            found.append(process)
    return found


def _describe(process) -> str:
    import psutil

    try:
        name = process.name()
        command = " ".join(process.cmdline())[:300]
    except psutil.Error:
        # Gone, or protected: the pid is all there is to say.
        return f"? (pid {process.pid})"
    return f"{name} (pid {process.pid}) {command}".strip()


def stop_leftovers() -> list[str]:
    """Stop (on CI) and describe what the session left running."""
    if os.environ.get(OWNER) != str(os.getpid()):
        return []
    found = leftovers()
    if not found:
        # Also where psutil is missing (the lint job's bare toolchain).
        return []
    described = [_describe(p) for p in found]
    if not os.environ.get("CI"):
        return described
    import psutil

    for process in found:
        try:
            process.kill()
        except psutil.Error:
            # Already gone, or not ours to stop: the warning still names it.
            continue
    for line in described:
        print(f"::warning title=process left running by the tests::{line}")
    return described
