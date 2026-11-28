"""One ``run_script`` call: the model's JavaScript, run by Node, each tool call
answered by the session's own executor.

The script is the model's way of chaining calls without a model turn between
them: search, filter, read three files at once, run lint and the tests in
parallel, return only what matters. It adds no capability. Node runs it under
its permission model (no file, no process, no worker, no addon), in a context
without ``require``, ``process``, ``fetch`` or ``eval`` (``host.mjs``), inside
the session's OS sandbox when there is one. Everything the script does to the
project is a request that comes back here and goes through
``executor.execute``, the path of an ordinary tool call: the agent type's
rights, the delegated scope, the Agent Debugger, the path guard, the
guardrails, the command allowlist, rtk, the watermarks, the OS sandbox.

Bounds: ``MAX_CALLS`` calls per script, ``MAX_IN_FLIGHT`` at a time,
``timeout()`` seconds in all, ``MAX_LOG_CHARS`` of console output. The result
ends with the list of the calls the script made (``protocol.trailer``), which
the safety watch scores like the calls of the session itself.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from foundation.platform import find_executable, is_windows

from .protocol import InnerCall, trailer

logger = logging.getLogger(__name__)

HOST = Path(__file__).with_name("host.mjs")

#: Calls one script may make.
MAX_CALLS = 50
#: Calls of one script running at once.
MAX_IN_FLIGHT = 4
#: The longest a script may run, in seconds, and the variable that lowers it.
MAX_SECONDS = 600.0
TIMEOUT_ENV = "WORKPILOT_CODE_MODE_TIMEOUT"
#: Console output kept for the model.
MAX_LOG_CHARS = 20_000
#: The longest line either side may send (a file's content travels in one).
MAX_LINE_BYTES = 16 * 1024 * 1024
#: The heap Node may use for the script.
HEAP_MB = 256

#: Tools a script may not call: itself, and nothing that delegates.
NOT_FROM_A_SCRIPT = frozenset({"run_script", "delegate"})


class Executor(Protocol):
    """What the runner needs of ``core.runtimes.tool_executor.ToolExecutor``."""

    project_dir: Path
    working_directory: Path

    async def execute(self, tool_name: str, arguments: dict[str, Any]) -> Any:
        """Run one tool call through the session's checks."""

    def script_sandbox(self) -> Any:
        """The OS sandbox the script's Node runs in."""


class ScriptError(RuntimeError):
    """The script could not run (no Node, a bad script, a limit reached)."""


@dataclass(frozen=True)
class ScriptResult:
    """What the model reads: ``body`` (value and console), then ``calls``.

    Apart, so the executor fits the body under the result cap and keeps the
    record of the calls whole after it.
    """

    body: str
    calls: str

    def text(self) -> str:
        return "\n\n".join(part for part in (self.body, self.calls) if part)


def timeout() -> float:
    raw = os.environ.get(TIMEOUT_ENV, "")
    try:
        value = float(raw)
    except ValueError:
        return MAX_SECONDS
    if value != value or value <= 0:  # NaN or not positive
        return MAX_SECONDS
    return min(value, MAX_SECONDS)


#: The oldest Node with a permission model, and the first where it is stable.
MIN_NODE = (20, 0)
_STABLE_PERMISSION = (22, 13)


def parse_node_version(text: str) -> tuple[int, int] | None:
    """``v22.13.1`` -> ``(22, 13)``; None for anything else."""
    parts = text.strip().lstrip("v").split(".")
    try:
        return int(parts[0]), int(parts[1])
    except (IndexError, ValueError):
        return None


def permission_flag(version: tuple[int, int]) -> str:
    """The flag that turns the permission model on, by Node version."""
    return (
        "--permission" if version >= _STABLE_PERMISSION else "--experimental-permission"
    )


def node_argv(node: str, version: tuple[int, int] = _STABLE_PERMISSION) -> list[str]:
    """Node under its permission model, reading only the host script."""
    return [
        node,
        permission_flag(version),
        f"--allow-fs-read={HOST}",
        "--disallow-code-generation-from-strings",
        f"--max-old-space-size={HEAP_MB}",
        str(HOST),
    ]


#: The variables Node needs to start; nothing else of the backend's reaches it.
_HOST_ENV_KEYS = ("PATH", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG")


def host_env(environ: dict[str, str] | None = None) -> dict[str, str]:
    """The host's environment, built rather than inherited: no credential.

    The script cannot read it (its context has no ``process``), and it still
    gets none: a process that runs another's code starts without secrets.
    """
    source = os.environ if environ is None else environ
    return {key: source[key] for key in _HOST_ENV_KEYS if key in source}


_node_versions: dict[str, tuple[int, int] | None] = {}


async def _node() -> tuple[str, tuple[int, int]]:
    """The Node that runs scripts and its version, asked once per binary."""
    node = find_executable("node")
    if not node:
        raise ScriptError(
            "run_script needs Node.js on this machine; use the other tools"
        )
    if node not in _node_versions:
        version = None
        try:
            probe = await asyncio.create_subprocess_exec(
                node,
                "--version",
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            out, _ = await asyncio.wait_for(probe.communicate(), timeout=15)
            version = parse_node_version(out.decode("utf-8", errors="replace"))
        except (OSError, TimeoutError):
            version = None
        _node_versions[node] = version
    version = _node_versions[node]
    if version is None or version < MIN_NODE:
        raise ScriptError(
            "run_script needs Node.js 20 or later on this machine; use the other tools"
        )
    return node, version


async def _edit_file(executor: Executor, arguments: dict[str, Any]) -> Any:
    """Replace text in a file: read here, written by ``write_file``.

    The write goes through ``executor.execute`` like any other, so a type
    without write rights, a protected path or a guardrail refuses it there.
    """
    path = arguments.get("path")
    old, new = arguments.get("old"), arguments.get("new")
    if not isinstance(path, str) or not path:
        raise ScriptError("edit needs a path")
    if not isinstance(old, str) or not old or not isinstance(new, str):
        raise ScriptError("edit needs the text to replace and its replacement")
    target = (executor.working_directory / path).resolve()
    try:
        target.relative_to(executor.project_dir)
    except ValueError as error:
        raise ScriptError(f"Path '{path}' is outside the project directory") from error
    try:
        content = target.read_text(encoding="utf-8")
    except OSError as error:
        raise ScriptError(f"edit cannot read {path}: {error}") from error
    count = content.count(old)
    if count == 0:
        raise ScriptError(f"edit: the text to replace is not in {path}")
    if count > 1 and not arguments.get("all"):
        raise ScriptError(
            f"edit: the text to replace is in {path} {count} times; "
            "give more context or pass {all: true}"
        )
    return await executor.execute(
        "write_file", {"path": path, "content": content.replace(old, new)}
    )


#: How the executor words a call it refused rather than ran (`execute`).
_REFUSALS = ("Tool '", "Write refused", "Command refused")


def _refused(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(_REFUSALS)


def _json_value(value: Any) -> Any:
    """A tool result the script can hold: JSON as it is, anything else as text."""
    try:
        json.dumps(value)
    except (TypeError, ValueError):
        return str(value)
    return value


async def run_script(
    executor: Executor,
    code: str,
    *,
    spawn: Callable[..., Awaitable[asyncio.subprocess.Process]] | None = None,
) -> ScriptResult:
    """Run ``code``: what the model reads, its value, its logs, its calls."""
    if not isinstance(code, str) or not code.strip():
        raise ScriptError("run_script needs the script to run (code)")
    node, version = await _node()
    argv = node_argv(node, version)
    env = host_env()
    sandbox = executor.script_sandbox()
    if getattr(sandbox, "isolated", False):
        argv, env = sandbox.wrap(argv, env, cwd=executor.working_directory)
    launch = spawn or asyncio.create_subprocess_exec
    process = await launch(
        *argv,
        cwd=str(executor.working_directory),
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=MAX_LINE_BYTES,
        start_new_session=not is_windows(),
    )
    session = _Session(executor, process)
    try:
        return await asyncio.wait_for(session.run(code), timeout=timeout())
    except TimeoutError as error:
        raise ScriptError(
            f"the script ran over {timeout():g}s and was stopped; "
            "keep a script short, or split the work"
        ) from error
    finally:
        await session.stop()


class _Session:
    def __init__(self, executor: Executor, process: asyncio.subprocess.Process) -> None:
        self.executor = executor
        self.process = process
        self.calls: list[InnerCall] = []
        self.logs: list[str] = []
        self.log_chars = 0
        self.gate = asyncio.Semaphore(MAX_IN_FLIGHT)
        self.tasks: set[asyncio.Task] = set()
        self.write_lock = asyncio.Lock()

    async def send(self, message: dict[str, Any]) -> None:
        stdin = self.process.stdin
        if stdin is None or stdin.is_closing():
            return
        data = (json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8")
        async with self.write_lock:
            try:
                stdin.write(data)
                await stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                return

    async def run(self, code: str) -> ScriptResult:
        started = time.time()
        await self.send({"code": code, "maxCalls": MAX_CALLS})
        stdout = self.process.stdout
        assert stdout is not None
        while True:
            try:
                line = await stdout.readline()
            except ValueError as error:  # a line over MAX_LINE_BYTES
                raise ScriptError("the script sent a message too large") from error
            if not line:
                stderr = b""
                if self.process.stderr is not None:
                    stderr = await self.process.stderr.read(4000)
                raise ScriptError(
                    "the script host stopped: "
                    + (stderr.decode("utf-8", errors="replace").strip() or "no output")
                )
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if not isinstance(message, dict):
                continue
            kind = message.get("type")
            if kind == "call":
                self._start_call(message)
            elif kind == "log":
                self._log(str(message.get("text", "")))
            elif kind in ("done", "error"):
                await self._settle()
                logger.info(
                    "run_script: %d calls in %.1fs (%s)",
                    len(self.calls),
                    time.time() - started,
                    kind,
                )
                return self._render(message)

    def _start_call(self, message: dict[str, Any]) -> None:
        task = asyncio.create_task(self._answer(message))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def _answer(self, message: dict[str, Any]) -> None:
        call_id = message.get("id")
        tool = message.get("tool")
        args = message.get("args")
        if not isinstance(tool, str) or not isinstance(args, dict):
            await self.send(
                {
                    "id": call_id,
                    "ok": False,
                    "error": "a call needs a tool name and arguments",
                }
            )
            return
        if len(self.calls) >= MAX_CALLS:
            await self.send(
                {
                    "id": call_id,
                    "ok": False,
                    "error": f"over {MAX_CALLS} calls in one script",
                }
            )
            return
        if tool in NOT_FROM_A_SCRIPT:
            await self.send(
                {
                    "id": call_id,
                    "ok": False,
                    "error": f"{tool} cannot be called from a script",
                }
            )
            return
        recorded = InnerCall("write_file" if tool == "edit_file" else tool, args)
        self.calls.append(recorded)
        async with self.gate:
            try:
                if tool == "edit_file":
                    value = await _edit_file(self.executor, args)
                else:
                    value = await self.executor.execute(tool, args)
            except (ValueError, RuntimeError, OSError, TypeError, KeyError) as error:
                recorded.ok = False
                await self.send({"id": call_id, "ok": False, "error": str(error)})
                return
        if _refused(value):
            recorded.ok = False
        await self.send({"id": call_id, "ok": True, "value": _json_value(value)})

    def _log(self, text: str) -> None:
        if self.log_chars >= MAX_LOG_CHARS:
            return
        room = MAX_LOG_CHARS - self.log_chars
        piece = text if len(text) <= room else text[:room] + " …"
        self.logs.append(piece)
        self.log_chars += len(piece)

    async def _settle(self) -> None:
        """Calls still running when the script ends: finished, not abandoned."""
        if self.tasks:
            await asyncio.gather(*list(self.tasks), return_exceptions=True)

    def _render(self, message: dict[str, Any]) -> ScriptResult:
        parts: list[str] = []
        if message.get("type") == "error":
            parts.append("The script failed: " + str(message.get("error", ""))[:4000])
        else:
            value = message.get("value")
            parts.append(value if isinstance(value, str) else json.dumps(value))
        if self.logs:
            parts.append("Console:\n" + "\n".join(self.logs))
        body = (
            "\n\n".join(part for part in parts if part)
            or "(the script returned nothing)"
        )
        return ScriptResult(body, trailer(self.calls))

    async def stop(self) -> None:
        for task in list(self.tasks):
            task.cancel()
        if self.process.stdin is not None and not self.process.stdin.is_closing():
            self.process.stdin.close()
        if self.process.returncode is None:
            try:
                self.process.kill()
            except ProcessLookupError:
                pass
        try:
            await asyncio.wait_for(self.process.wait(), timeout=5)
        except TimeoutError:
            logger.warning("run_script: the script host did not exit")


__all__ = [
    "HOST",
    "MAX_CALLS",
    "MAX_IN_FLIGHT",
    "MAX_SECONDS",
    "NOT_FROM_A_SCRIPT",
    "ScriptError",
    "ScriptResult",
    "TIMEOUT_ENV",
    "host_env",
    "node_argv",
    "parse_node_version",
    "permission_flag",
    "run_script",
    "timeout",
]
