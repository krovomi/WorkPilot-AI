"""The two MCP extensions WorkPilot's own loop speaks as a client.

**Tasks** (``io.modelcontextprotocol/tasks``, MCP 2026-07-28). Declared on
every request of a 2026-07-28 connection. A server may then answer a
``tools/call`` with a task handle instead of the result; `resolve_task` polls
``tasks/get`` at the interval the server suggests until the task ends, and
returns what the call would have returned. Cancelled builds cancel the task
(``tasks/cancel``). A task that asks for input is cancelled with a result that
says so: nobody is there to answer it during a build.

**Apps** (``io.modelcontextprotocol/ui``). Declared only when the session has
a task panel to show a view in (a spec directory). A tool whose ``_meta.ui``
names a ``ui://`` resource is shown after its call: `capture_app_view` reads
the resource from the same session, keeps it in the spec directory and tells
the card (``MCP_APP_VIEW``). The view is rendered by the app, in an iframe
without ``allow-same-origin`` (``docs/architecture/mcp-2026.md``).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import secrets
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, ClassVar, Literal

from mcp_tasks import APP_MIME_TYPE, APPS_EXTENSION, TASKS_EXTENSION, TERMINAL_STATUSES

logger = logging.getLogger(__name__)

TASK_TIMEOUT_ENV = "WORKPILOT_MCP_TASK_TIMEOUT"
DEFAULT_TASK_TIMEOUT = 30 * 60.0
MIN_POLL_SECONDS = 0.5
MAX_POLL_SECONDS = 10.0

#: A view larger than this is not kept: the card says nothing rather than
#: half an app.
MAX_VIEW_HTML_CHARS = 1_000_000
MAX_VIEW_RESULT_CHARS = 256_000
APP_VIEWS_DIR = "mcp-apps"
VIEW_ID = re.compile(r"^[0-9a-f]{16}$")


def task_timeout() -> float:
    try:
        value = float(os.environ.get(TASK_TIMEOUT_ENV, ""))
    except ValueError:
        return DEFAULT_TASK_TIMEOUT
    return value if value > 0 else DEFAULT_TASK_TIMEOUT


def _models():
    """The wire models, built on first use: `mcp` is imported lazily here."""
    global _MODELS
    if _MODELS is not None:
        return _MODELS
    from mcp_types import Request, RequestParams, Result
    from pydantic import Field

    class CreateTaskResult(Result):
        result_type: Literal["task"] = Field(alias="resultType")
        task_id: str
        status: str
        status_message: str | None = None
        poll_interval_ms: int | None = None
        ttl_ms: int | None = None

    class DetailedTask(Result):
        result_type: str | None = None
        task_id: str
        status: str
        status_message: str | None = None
        poll_interval_ms: int | None = None
        result: dict[str, Any] | None = None
        error: dict[str, Any] | None = None
        input_requests: dict[str, Any] | None = None

    class EmptyTaskResult(Result):
        result_type: str | None = None

    class TaskIdParams(RequestParams):
        task_id: str

    class GetTaskRequest(Request[TaskIdParams, Literal["tasks/get"]]):
        name_param: ClassVar[str | None] = "taskId"

    class CancelTaskRequest(Request[TaskIdParams, Literal["tasks/cancel"]]):
        name_param: ClassVar[str | None] = "taskId"

    _MODELS = {
        "CreateTaskResult": CreateTaskResult,
        "DetailedTask": DetailedTask,
        "EmptyTaskResult": EmptyTaskResult,
        "TaskIdParams": TaskIdParams,
        "GetTaskRequest": GetTaskRequest,
        "CancelTaskRequest": CancelTaskRequest,
    }
    return _MODELS


_MODELS: dict[str, Any] | None = None


def is_task_handle(result: Any) -> bool:
    return isinstance(result, _models()["CreateTaskResult"])


def _error_result(text: str):
    from mcp_types import CallToolResult, TextContent

    return CallToolResult(content=[TextContent(type="text", text=text)], is_error=True)


def _poll_seconds(interval_ms: int | None) -> float:
    if not interval_ms or interval_ms <= 0:
        return 1.0
    return min(MAX_POLL_SECONDS, max(MIN_POLL_SECONDS, interval_ms / 1000))


async def _cancel(session: Any, task_id: str) -> None:
    models = _models()
    with contextlib.suppress(Exception):
        await session.send_request(
            models["CancelTaskRequest"](
                method="tasks/cancel", params=models["TaskIdParams"](task_id=task_id)
            ),
            models["EmptyTaskResult"],
        )


async def resolve_task(
    session: Any,
    created: Any,
    *,
    timeout: float | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    clock: Callable[[], float] = time.monotonic,
):
    """Poll a task to its end and return the ``CallToolResult`` it stands for."""
    from mcp_types import CallToolResult
    from pydantic import ValidationError

    models = _models()
    limit = timeout if timeout is not None else task_timeout()
    deadline = clock() + limit
    task_id = created.task_id
    status, interval = created.status, created.poll_interval_ms
    detail = None
    try:
        while status not in TERMINAL_STATUSES:
            if status == "input_required":
                await _cancel(session, task_id)
                return _error_result(
                    "The MCP server's task asks for input; nobody can answer it during "
                    "a build, so the task was cancelled."
                )
            if clock() >= deadline:
                await _cancel(session, task_id)
                return _error_result(
                    f"The MCP task did not finish within {int(limit)}s "
                    f"({TASK_TIMEOUT_ENV}); it was cancelled."
                )
            await sleep(_poll_seconds(interval))
            detail = await session.send_request(
                models["GetTaskRequest"](
                    method="tasks/get", params=models["TaskIdParams"](task_id=task_id)
                ),
                models["DetailedTask"],
            )
            if detail.task_id != task_id:
                return _error_result("The MCP server answered for another task.")
            status, interval = detail.status, detail.poll_interval_ms or interval
    except asyncio.CancelledError:
        # The build stopped: stop the server's work too.
        await asyncio.shield(_cancel(session, task_id))
        raise
    if status == "completed":
        try:
            return CallToolResult.model_validate(
                (detail.result if detail else None) or {}
            )
        except ValidationError:
            return _error_result(
                "The MCP task completed with a result that is not a tool result."
            )
    if status == "failed":
        message = ((detail.error if detail else None) or {}).get("message") or (
            detail.status_message if detail else None
        )
        return _error_result(f"The MCP task failed: {message or 'no reason given'}")
    return _error_result("The MCP server cancelled the task.")


def sdk_speaks_2026() -> bool:
    """Whether the installed `mcp` SDK has extensions and ``server/discover``.

    `mcp` arrives unpinned, through `claude-agent-sdk`: an older install
    keeps the handshake and plain tool calls, and never sees a task (a server
    returns one only to a client that declares the extension).
    """
    try:
        import mcp.client._probe  # noqa: F401, PLC0415
        import mcp.client.extension  # noqa: F401, PLC0415
    except ImportError:
        return False
    return True


def session_options(*, apps: bool) -> dict[str, Any]:
    """``extensions`` and ``result_claims`` for a `ClientSession`, when the SDK has them."""
    if not sdk_speaks_2026():
        return {}
    from mcp.client.extension import ResultClaim  # noqa: PLC0415

    async def resolve(created, ctx):
        return await resolve_task(ctx.session, created)

    extensions: dict[str, dict[str, Any]] = {TASKS_EXTENSION: {}}
    if apps:
        extensions[APPS_EXTENSION] = {"mimeTypes": [APP_MIME_TYPE]}
    claims = {
        TASKS_EXTENSION: [
            ResultClaim(
                result_type="task", model=_models()["CreateTaskResult"], resolve=resolve
            )
        ]
    }
    return {"extensions": extensions, "result_claims": claims}


# ── Apps ────────────────────────────────────────────────────────────────


def tool_ui(meta: Any) -> dict[str, Any]:
    """A tool's ``_meta.ui`` (the flat, deprecated ``ui/resourceUri`` too)."""
    if not isinstance(meta, dict):
        return {}
    ui = meta.get("ui")
    ui = dict(ui) if isinstance(ui, dict) else {}
    legacy = meta.get("ui/resourceUri")
    if "resourceUri" not in ui and isinstance(legacy, str):
        ui["resourceUri"] = legacy
    return ui


def visible_to_model(meta: Any) -> bool:
    """A tool whose ``visibility`` leaves out ``model`` is the app's, not the agent's."""
    visibility = tool_ui(meta).get("visibility")
    return not isinstance(visibility, list) or "model" in visibility


def app_resource_uri(meta: Any) -> str | None:
    uri = tool_ui(meta).get("resourceUri")
    return uri if isinstance(uri, str) and uri.startswith("ui://") else None


def _dump(model: Any) -> Any:
    dump = getattr(model, "model_dump", None)
    return dump(by_alias=True, mode="json", exclude_none=True) if dump else model


async def capture_app_view(
    session: Any,
    *,
    spec_dir: Path,
    server: str,
    tool: str,
    resource_uri: str,
    arguments: dict[str, Any],
    result: Any,
) -> str | None:
    """Keep a tool's view for the task panel; its id, or None when not shown.

    Best-effort: a view that cannot be read, is not an MCP App, or is too
    large is not shown, and the agent's result is unchanged.
    """
    try:
        read = await session.read_resource(resource_uri)
        contents = [
            c for c in (getattr(read, "contents", None) or []) if c.uri == resource_uri
        ]
        if not contents:
            return None
        content = contents[0]
        if (content.mime_type or "").replace(" ", "").lower() != APP_MIME_TYPE:
            return None
        html = getattr(content, "text", None)
        if html is None:
            import base64

            html = base64.b64decode(getattr(content, "blob", "") or "").decode(
                "utf-8", errors="replace"
            )
        if not html or len(html) > MAX_VIEW_HTML_CHARS:
            return None
        ui = (content.meta or {}).get("ui") if isinstance(content.meta, dict) else None
        tool_result = _dump(result)
        if len(json.dumps(tool_result, ensure_ascii=False)) > MAX_VIEW_RESULT_CHARS:
            tool_result = {
                "content": [{"type": "text", "text": "(result too large to show)"}],
                "isError": bool(getattr(result, "is_error", False)),
            }
        view_id = secrets.token_hex(8)
        folder = Path(spec_dir) / APP_VIEWS_DIR
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{view_id}.json").write_text(
            json.dumps(
                {
                    "viewId": view_id,
                    "server": server,
                    "tool": tool,
                    "resourceUri": resource_uri,
                    "html": html,
                    "ui": ui if isinstance(ui, dict) else {},
                    "toolInput": arguments,
                    "toolResult": tool_result,
                    "createdAt": time.time(),
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    except Exception as exc:  # noqa: BLE001 - a view is never worth a failed call
        logger.debug("[mcp] app view for %s/%s not kept: %s", server, tool, exc)
        return None
    try:
        from core.task_event import TaskEventEmitter

        TaskEventEmitter.from_spec_dir(Path(spec_dir)).emit(
            "MCP_APP_VIEW",
            {"mcpApp": {"viewId": view_id, "server": server, "tool": tool}},
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("[mcp] could not announce the app view: %s", exc)
    return view_id
