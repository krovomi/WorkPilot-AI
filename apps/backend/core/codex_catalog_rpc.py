"""Bounded, read-only Codex app-server model discovery (no agent turn)."""

import json
import os
import queue
import signal
import subprocess
import threading
import time
from contextlib import suppress
from typing import Any

from core.platform import build_windows_command, find_executable, is_windows

TIMEOUT_SECONDS = 10
MAX_LINE_BYTES = 1024 * 1024


def _command(executable: str) -> list[str] | str:
    command = build_windows_command(executable, ["app-server"])
    if is_windows() and executable.lower().endswith((".cmd", ".bat")):
        # Popen's list2cmdline escapes the wrapper's quotes as backslash-quote,
        # which cmd.exe treats literally. Keep its /s /c command as raw text.
        return subprocess.list2cmdline(command[:4]) + ' "' + command[4] + '"'
    return command


def discover_models() -> list[dict[str, Any]]:
    """Query the same PATH and inherited CODEX_HOME as task execution."""
    executable = find_executable("codex")
    if not executable:
        raise OSError("Codex CLI is unavailable")
    process = subprocess.Popen(
        _command(executable),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if is_windows() else 0,
        start_new_session=not is_windows(),
    )
    messages: queue.Queue[bytes | None] = queue.Queue(maxsize=32)
    stopped = threading.Event()

    def read_stdout() -> None:
        assert process.stdout is not None
        while not stopped.is_set():
            line = process.stdout.readline(MAX_LINE_BYTES + 1)
            value = line if line and len(line) <= MAX_LINE_BYTES else None
            while not stopped.is_set():
                try:
                    messages.put(value, timeout=0.1)
                    break
                except queue.Full:
                    continue
            if value is None:
                return

    reader = threading.Thread(target=read_stdout, daemon=True)
    reader.start()
    deadline = time.monotonic() + TIMEOUT_SECONDS

    def send(message: dict[str, Any]) -> None:
        assert process.stdin is not None
        process.stdin.write((json.dumps(message) + "\n").encode("utf-8"))
        process.stdin.flush()

    def request(request_id: int, method: str, params: dict[str, Any]) -> dict:
        send({"id": request_id, "method": method, "params": params})
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Codex discovery timed out")
            try:
                line = messages.get(timeout=remaining)
            except queue.Empty as exc:
                raise TimeoutError("Codex discovery timed out") from exc
            if line is None:
                raise ValueError("Codex closed its discovery stream")
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("Invalid Codex response")
            if message.get("id") != request_id:
                continue
            if "error" in message or not isinstance(message.get("result"), dict):
                raise ValueError("Codex rejected discovery")
            return message["result"]

    try:
        request(
            1, "initialize", {"clientInfo": {"name": "workpilot", "version": "1.0.0"}}
        )
        send({"method": "initialized", "params": {}})
        models: dict[str, dict[str, Any]] = {}
        cursor = None
        seen_cursors: set[str] = set()
        for request_id in range(2, 22):
            result = request(
                request_id,
                "model/list",
                {"limit": 100, "includeHidden": False, "cursor": cursor},
            )
            entries = result.get("data")
            if not isinstance(entries, list):
                raise ValueError("Invalid Codex model list")
            for entry in entries:
                if not isinstance(entry, dict) or entry.get("hidden"):
                    continue
                model = entry.get("model")
                if not isinstance(model, str) or not model.strip():
                    continue
                label = entry.get("displayName")
                models[model] = {
                    "value": model,
                    "label": label if isinstance(label, str) and label else model,
                    "tier": (
                        "fast"
                        if any(
                            marker in f"{model} {label or ''}".lower()
                            for marker in ("mini", "nano", "small", "fast", "lite")
                        )
                        else (
                            "flagship"
                            if any(
                                marker in f"{model} {label or ''}".lower()
                                for marker in ("pro", "opus", "flagship")
                            )
                            else "standard"
                        )
                    ),
                    "supportsThinking": bool(entry.get("supportedReasoningEfforts")),
                }
            cursor = result.get("nextCursor")
            if cursor is None:
                if not models:
                    raise ValueError("Codex returned no visible models")
                return list(models.values())
            if not isinstance(cursor, str) or cursor in seen_cursors:
                raise ValueError("Invalid Codex model pagination")
            seen_cursors.add(cursor)
        raise ValueError("Codex model pagination limit exceeded")
    finally:
        stopped.set()
        if process.stdin:
            # The CLI may already have exited after a protocol error.
            with suppress(BrokenPipeError):
                process.stdin.close()
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            if is_windows():
                # npm's .cmd wrapper may own a child node/native process.
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=2,
                    check=False,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
            else:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=2)
        reader.join(timeout=1)
        if process.stdout:
            process.stdout.close()
