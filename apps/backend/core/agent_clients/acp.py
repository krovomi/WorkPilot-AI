"""`AcpAgentClient` — an agent turn run by an Agent Client Protocol agent.

ACP (https://agentclientprotocol.com, protocol version 1) is JSON-RPC 2.0, one
message per line, on the agent's stdin/stdout. Each agent is one entry of
``capabilities/providers.yaml`` with an ``acp:`` block; this client is the
same for all of them. What the boundary is, as read from the schema (v1.19)
and from Gemini CLI 0.65 in ``tests/fixtures/acp/gemini-cli/`` (captured by
the ``capture.py`` beside them):

- ``initialize`` answers without a login and says what the agent can do:
  ``agentCapabilities`` (``loadSession``, ``promptCapabilities``,
  ``mcpCapabilities``) and ``authMethods``. Only what it declares is used: a
  session is loaded only when ``loadSession`` is true, and the capabilities
  are traced as declared, never filled in.
- ``session/new`` (``cwd``, ``mcpServers``) answers ``sessionId`` and, for
  Gemini, ``modes`` (``default``, ``autoEdit``, ``yolo``, ``plan``). Without a
  login it is refused with code -32000; the client then tries the login method
  whose variable (``auth_env``) is set, once, and otherwise names the fix.
- ``session/prompt`` streams ``session/update`` notifications
  (``agent_message_chunk``, ``tool_call``, ``tool_call_update``,
  ``usage_update`` with ``used``/``size``, …) and answers ``stopReason`` and,
  unstable, ``usage``. ``session/load`` replays the history as updates before
  its answer; those are dropped.
- The agent calls back: ``session/request_permission`` (a question for the
  person, see ``acp_permissions``) and ``fs/write_text_file``. The client
  declares ``fs.readTextFile: false``: Gemini cannot tell a missing file from
  an error over ACP (it reads the JSON-RPC error as a plain object), so a new
  file could not be created; reads stay with the agent, inside its workspace.
  ``terminal: false``: the agent runs its own commands.

Rights are the agent type's declaration, three times over:

1. **The mode.** A type that declares none of Write/Edit/Bash runs in the
   agent's ``read_only_mode`` (Gemini's ``plan``: ``write_file`` is "denied by
   policy" and ``run_shell_command`` does not run) when the agent offers it;
   every other type runs in ``approval_mode``. A mode in
   ``auto_approve_modes`` is put back as soon as the agent reports it.
2. **The question.** A permission request whose tool kind the type does not
   declare (``edit`` without Write/Edit, ``execute`` without Bash…), or whose
   locations leave the build's write roots or name a protected file, is
   refused without asking anyone. The others go to the person.
3. **What ran anyway.** Gemini runs a command it reads as harmless without
   asking. A tool of a kind the type does not declare that starts running
   stops the turn (``session/cancel``) and fails it: seen, not prevented, and
   said so.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from foundation.platform import build_windows_command, find_executable
from harness.domain import from_acp_usage

from .acp_permissions import (
    OPTION_KINDS,
    PermissionBroker,
    PermissionOption,
    PermissionQuestion,
    broker_for,
    display_text,
)
from .base import AgentMessage, MessageRole
from .cli_subprocess import (
    CliSubprocessAgentClient,
    ProcessFactory,
    as_int,
    declares_no_writes,
    safe_error_text,
    text_message,
    tool_messages,
    validated_option,
)
from .pi_cli import ENV_DENYLIST

logger = logging.getLogger(__name__)

__all__ = [
    "ACP_PROTOCOL_VERSION",
    "CLIENT_CAPABILITIES",
    "AcpAgentClient",
    "AcpAuthenticationError",
    "AcpError",
    "acp_model",
    "kind_allowed",
]

ACP_PROTOCOL_VERSION = 1

#: What WorkPilot offers the agent. Reads stay with the agent (see above).
CLIENT_CAPABILITIES = {
    "fs": {"readTextFile": False, "writeTextFile": True},
    "terminal": False,
}

#: JSON-RPC error codes.
_AUTH_REQUIRED = -32000
_METHOD_NOT_FOUND = -32601
_INVALID_PARAMS = -32602

#: Tool kinds (`ToolKind`) → the declared tools that grant them.
_KIND_RIGHTS: dict[str, frozenset[str]] = {
    "read": frozenset({"Read", "Grep", "Glob"}),
    "search": frozenset({"Read", "Grep", "Glob"}),
    "edit": frozenset({"Write", "Edit"}),
    "delete": frozenset({"Write", "Edit"}),
    "move": frozenset({"Write", "Edit"}),
    "execute": frozenset({"Bash"}),
    "fetch": frozenset({"WebFetch", "WebSearch"}),
}

#: Kinds whose locations are paths the tool writes.
_WRITING_KINDS = frozenset({"edit", "delete", "move"})

#: `stopReason` values that end a turn without an answer to keep.
_STOP_ERRORS = {
    "max_tokens": "the answer was cut by the model's output limit; the turn is incomplete.",
    "max_turn_requests": "the agent reached its limit of model requests for one turn.",
    "refusal": "the agent refused to continue.",
    "cancelled": "the turn was cancelled.",
}


#: What a refused login looks like in a prompt error (Gemini: "API key not valid").
_AUTH_MARKERS = (
    "api key not valid",
    "invalid api key",
    "unauthorized",
    "unauthenticated",
    "permission_denied",
)


class AcpError(RuntimeError):
    """A safe, user-facing failure from an ACP agent."""


class AcpAuthenticationError(AcpError):
    """The agent has no usable login."""


class _RpcError(Exception):
    def __init__(self, code: object, message: object) -> None:
        super().__init__(str(message))
        self.code = code if isinstance(code, int) else None
        self.message = safe_error_text(message)


def kind_allowed(kind: str | None, agent_type: str) -> bool:
    """Whether the agent type's declaration covers a tool of this ACP kind.

    ``think`` needs nothing. ``switch_mode`` and ``other`` (an agent's own tools
    and MCP tools) are left to a type that may change things. An unregistered
    type is permissive, as everywhere else (`declares_no_writes`).
    """
    from agents.tools_pkg.permissions import declared_tools

    declared = declared_tools(agent_type)
    if declared is None:
        return True
    if kind == "think":
        return True
    rights = _KIND_RIGHTS.get(kind or "other")
    if rights is None:
        return not declares_no_writes(agent_type)
    return bool(declared & rights)


def acp_model(model: str | None, prefixes: tuple[str, ...], label: str) -> str | None:
    """The model id to pass, or None for the agent's own default.

    A ``google/…`` style id loses its provider part; an id the agent does not
    take (one inherited from another provider) is dropped, not sent to fail.
    """
    candidate = (model or "").strip()
    if not candidate or candidate.lower() == "default":
        return None
    candidate = candidate.rsplit("/", 1)[-1]
    if prefixes and not candidate.startswith(prefixes):
        logger.warning(
            "[%s] Model %r is not one it takes; using its default", label, candidate
        )
        return None
    return candidate


class AcpAgentClient(CliSubprocessAgentClient):
    """Run agent turns through one ACP agent process per session."""

    def __init__(
        self,
        *,
        provider: str,
        model: str | None = None,
        system_prompt: str | None = None,
        project_dir: str,
        agent_type: str = "coder",
        session_id: str | None = None,
        spec_dir: str | Path | None = None,
        broker: PermissionBroker | None = None,
        executable: str | None = None,
        process_factory: ProcessFactory | None = None,
        spec: Any = None,
    ) -> None:
        if spec is None:
            from skills_registry.providers import get_provider_capabilities

            spec = get_provider_capabilities(provider).acp
        if spec is None:
            raise AcpError(
                f"{provider} is not an ACP agent in capabilities/providers.yaml."
            )
        self.spec = spec
        self.provider = provider
        self.cli_label = spec.label or provider
        super().__init__(
            model=acp_model(model, spec.model_prefixes, self.cli_label) or "default",
            system_prompt=system_prompt,
            project_dir=project_dir,
            agent_type=agent_type,
            session_id=session_id,
            executable=executable,
            process_factory=process_factory,
        )
        self._spec_dir = Path(spec_dir) if spec_dir else None
        self._broker = broker
        self._read_only = declares_no_writes(agent_type)
        self.context_usage_source = "estimated"
        # Filled by `initialize`, as the agent declared it.
        self.agent_info: dict[str, Any] = {}
        self.agent_capabilities: dict[str, Any] = {}
        self.auth_methods: tuple[str, ...] = ()
        self.modes: tuple[str, ...] = ()
        self.current_mode: str | None = None
        self.expected_mode: str | None = None
        self._session: str | None = None
        self._ids = 0
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._updates: asyncio.Queue[dict[str, Any]] | None = None
        self._reader: asyncio.Task[None] | None = None
        self._stderr: asyncio.Task[bytes] | None = None
        self._callbacks: set[asyncio.Task[None]] = set()
        self._violation: str | None = None
        self._kept_history: list[AgentMessage] = []

    # ── what the base class asks ─────────────────────────────────────────
    def provider_name(self) -> str:
        return self.provider

    def resumes_native_session(self) -> bool:
        # Whether the agent can load a session is only known once it said so
        # in `initialize`. The conversation log is therefore always replayed
        # into `resume`, and dropped if `session/load` takes over.
        return False

    async def resume(self, history: list[AgentMessage]) -> None:
        await super().resume(history)
        self._kept_history = list(history or [])

    def _resolve_executable(self) -> str | None:
        return self._executable or find_executable(self.spec.executable)

    def _subprocess_env(self) -> dict[str, str]:
        """WorkPilot's environment less the loader-injection variables, the JEV
        key and the Claude Code token (pi's `ENV_DENYLIST`). The agent's own
        credential (`GEMINI_API_KEY`…) stays: it is the process that needs it."""
        return {
            k: v for k, v in super()._subprocess_env().items() if k not in ENV_DENYLIST
        }

    def _command(self, executable: str) -> list[str]:
        args = list(self.spec.command[1:])
        if self.spec.model_flag and self.model != "default":
            args += [
                self.spec.model_flag,
                validated_option(self.model, "model", self.cli_label),
            ]
        return build_windows_command(executable, args)

    # ── JSON-RPC over the process ─────────────────────────────────────────
    async def _start(self) -> None:
        executable = self._resolve_executable()
        if not executable:
            raise AcpError(
                f"{self.cli_label} is not installed or is not on PATH"
                + (f" ({self.spec.docs})." if self.spec.docs else ".")
            )
        # Through the OS sandbox like every CLI that runs its own commands: the
        # card reports `session_sandbox()`, so the process must be the one it wraps.
        argv, env = self._launch(self._command(executable))
        try:
            process = await self._process_factory(
                *argv,
                cwd=self._project_dir,
                env=env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except (OSError, ValueError) as error:
            raise AcpError(
                f"{self.cli_label} could not start: {safe_error_text(error)}"
            ) from error
        self._process = process
        self._updates = asyncio.Queue()
        self._reader = asyncio.create_task(self._read(process))
        self._stderr = asyncio.create_task(process.stderr.read())

    async def _write(self, message: dict[str, Any]) -> None:
        process = self._process
        if process is None or process.stdin is None:
            raise AcpError(f"{self.cli_label} is not running.")
        process.stdin.write(
            (json.dumps({"jsonrpc": "2.0", **message}) + "\n").encode("utf-8")
        )
        await process.stdin.drain()

    async def _request(self, method: str, params: dict[str, Any]) -> Any:
        self._ids += 1
        request_id = self._ids
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await self._write({"id": request_id, "method": method, "params": params})
            return await future
        finally:
            self._pending.pop(request_id, None)

    async def _read(self, process: Any) -> None:
        try:
            async for message in self._json_events(process):
                if "method" in message:
                    if "id" in message:
                        task = asyncio.create_task(self._answer(message))
                        self._callbacks.add(task)
                        task.add_done_callback(self._callbacks.discard)
                    else:
                        self._notified(message)
                elif isinstance(message.get("id"), int):
                    future = self._pending.get(message["id"])
                    if future is None or future.done():
                        continue
                    if "error" in message:
                        error = message.get("error") or {}
                        if not isinstance(error, dict):
                            error = {"message": error}
                        future.set_exception(
                            _RpcError(error.get("code"), error.get("message"))
                        )
                    else:
                        future.set_result(message.get("result"))
        finally:
            closed = AcpError(f"{self.cli_label} closed its stream.")
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(closed)
            if self._updates is not None:
                self._updates.put_nowait({"__closed__": True})

    def _notified(self, message: dict[str, Any]) -> None:
        if message.get("method") != "session/update":
            return
        params = message.get("params") or {}
        if not isinstance(params, dict) or params.get("sessionId") != self._session:
            return
        update = params.get("update")
        if not isinstance(update, dict):
            return
        kind = update.get("sessionUpdate")
        if kind == "current_mode_update":
            self._mode_changed(update.get("currentModeId"))
        elif kind == "usage_update":
            used, size = update.get("used"), update.get("size")
            if isinstance(used, int) and used >= 0:
                self.last_context_tokens = used
                self.context_usage_source = "exact"
            if isinstance(size, int) and size > 0:
                self.context_window_tokens = size
        if self._updates is not None and self._turn_open:
            self._updates.put_nowait(update)

    _turn_open = False

    # ── the agent's requests ──────────────────────────────────────────────
    async def _answer(self, request: dict[str, Any]) -> None:
        method = request.get("method")
        params = (
            request.get("params") if isinstance(request.get("params"), dict) else {}
        )
        try:
            if method == "session/request_permission":
                result: Any = await self._permission(params)
            elif method == "fs/write_text_file":
                result = self._write_file(params)
            else:
                raise _RpcError(
                    _METHOD_NOT_FOUND, f"Method not found: {display_text(method, 80)}"
                )
            reply: dict[str, Any] = {"id": request.get("id"), "result": result}
        except _RpcError as error:
            reply = {
                "id": request.get("id"),
                "error": {"code": error.code, "message": error.message},
            }
        try:
            await self._write(reply)
        except (AcpError, OSError, RuntimeError):
            logger.debug("[%s] could not answer %s", self.cli_label, method)

    def _roots(self) -> list[Path]:
        from security.path_guard import resolve_write_roots

        return resolve_write_roots(self._project_dir, self._spec_dir)

    def _write_refusal(self, path: object) -> str | None:
        """Why the agent may not write ``path``, or None."""
        from security.path_guard import is_within_roots, protected_config_refusal

        if self._read_only:
            return "this agent type declares no write"
        if not isinstance(path, str) or not path or not Path(path).is_absolute():
            return "a write needs an absolute path"
        if not is_within_roots(path, self._roots(), Path(self._project_dir)):
            return "the path is outside this build's write roots"
        return protected_config_refusal(path, Path(self._project_dir))

    def _write_file(self, params: dict[str, Any]) -> dict[str, Any]:
        path, content = params.get("path"), params.get("content")
        if params.get("sessionId") != self._session or not isinstance(content, str):
            raise _RpcError(_INVALID_PARAMS, "Invalid params")
        refusal = self._write_refusal(path)
        if refusal:
            self._feed(f"refused a write to {display_text(path, 200)}: {refusal}")
            raise _RpcError(_INVALID_PARAMS, f"Refused: {refusal}")
        target = Path(path)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(f".{target.name}.workpilot-acp.tmp")
            temporary.write_text(content, encoding="utf-8")
            os.replace(temporary, target)
        except OSError as error:
            raise _RpcError(
                -32603, f"Write failed: {safe_error_text(error)}"
            ) from error
        return {}

    async def _permission(self, params: dict[str, Any]) -> dict[str, Any]:
        call = (
            params.get("toolCall") if isinstance(params.get("toolCall"), dict) else {}
        )
        options = tuple(
            PermissionOption(
                option_id=str(o["optionId"]),
                name=display_text(o.get("name") or o["optionId"], 80),
                kind=str(o.get("kind")),
            )
            for o in params.get("options") or []
            if isinstance(o, dict)
            and isinstance(o.get("optionId"), str)
            and 0 < len(o["optionId"]) <= 128
            and o.get("kind") in OPTION_KINDS
        )[:8]
        kind = call.get("kind") if isinstance(call.get("kind"), str) else "other"
        title = display_text(call.get("title") or kind, 300)
        locations = tuple(
            str(location["path"])
            for location in call.get("locations") or []
            if isinstance(location, dict) and isinstance(location.get("path"), str)
        )[:10]
        refuse = next((o for o in options if o.kind == "reject_once"), None) or next(
            (o for o in options if o.kind == "reject_always"), None
        )

        def refused() -> dict[str, Any]:
            if refuse is None:
                return {"outcome": {"outcome": "cancelled"}}
            return {"outcome": {"outcome": "selected", "optionId": refuse.option_id}}

        if params.get("sessionId") != self._session or not options:
            return refused()
        reason = None
        if not kind_allowed(kind, self._agent_type):
            reason = f"the `{self._agent_type}` agent does not declare a tool of kind `{kind}`"
        elif kind in _WRITING_KINDS:
            reason = next(
                filter(None, (self._write_refusal(p) for p in locations)), None
            )
        if reason:
            self._feed(f"refused without asking: {title} ({reason})")
            return refused()
        question = PermissionQuestion(
            agent=self.cli_label,
            title=title,
            kind=kind,
            options=options,
            locations=tuple(self._shown_path(p) for p in locations),
        )
        broker = self._broker or broker_for(self._spec_dir)
        chosen = await broker.ask(question)
        option = question.option(chosen)
        if option is None:
            self._feed(f"no answer to: {title}; refused")
            return refused()
        self._feed(f"{option.name}: {title}")
        return {"outcome": {"outcome": "selected", "optionId": option.option_id}}

    def _shown_path(self, path: str) -> str:
        try:
            # Forward slashes on every OS: the card shows the same path everywhere.
            return display_text(
                Path(path)
                .resolve()
                .relative_to(Path(self._project_dir).resolve())
                .as_posix(),
                300,
            )
        except (OSError, ValueError):
            return display_text(path, 300)

    def _feed(self, message: str) -> None:
        logger.info("[%s] %s", self.cli_label, message)
        if self._spec_dir is None:
            return
        try:
            from task_logger import get_task_logger

            task_logger = get_task_logger()
            if task_logger is not None and Path(task_logger.spec_dir) == self._spec_dir:
                task_logger.log_info(f"{self.cli_label}: {message}")
        except Exception as exc:  # pragma: no cover - tracing must not break a run
            logger.debug("could not write to the task feed: %s", exc)

    # ── the session ───────────────────────────────────────────────────────
    async def _ensure_session(self) -> None:
        process = self._process
        if self._session and process is not None and process.returncode is None:
            return
        await self._start()
        try:
            init = await self._request(
                "initialize",
                {
                    "protocolVersion": ACP_PROTOCOL_VERSION,
                    "clientCapabilities": CLIENT_CAPABILITIES,
                    "clientInfo": {"name": "workpilot", "title": "WorkPilot AI"},
                },
            )
        except _RpcError as error:
            raise AcpError(
                f"{self.cli_label} refused initialize: {error.message}"
            ) from error
        init = init if isinstance(init, dict) else {}
        version = init.get("protocolVersion")
        if version != ACP_PROTOCOL_VERSION:
            raise AcpError(
                f"{self.cli_label} speaks ACP version {display_text(version, 20)}; "
                f"WorkPilot speaks {ACP_PROTOCOL_VERSION}."
            )
        self.agent_info = (
            init.get("agentInfo") if isinstance(init.get("agentInfo"), dict) else {}
        )
        caps = init.get("agentCapabilities")
        self.agent_capabilities = caps if isinstance(caps, dict) else {}
        self.auth_methods = tuple(
            m["id"]
            for m in init.get("authMethods") or []
            if isinstance(m, dict) and isinstance(m.get("id"), str)
        )
        self._feed(f"connected ({self.declared_summary()})")
        await self._open_session()

    def declared_summary(self) -> str:
        """What the agent declared, and only that."""
        caps = self.agent_capabilities
        prompt = (
            caps.get("promptCapabilities")
            if isinstance(caps.get("promptCapabilities"), dict)
            else {}
        )
        mcp = (
            caps.get("mcpCapabilities")
            if isinstance(caps.get("mcpCapabilities"), dict)
            else {}
        )
        declared = [
            name
            for name, value in (
                ("session/load", caps.get("loadSession")),
                ("images", prompt.get("image")),
                ("audio", prompt.get("audio")),
                ("embedded context", prompt.get("embeddedContext")),
                ("MCP over HTTP", mcp.get("http")),
                ("MCP over SSE", mcp.get("sse")),
            )
            if value is True
        ]
        name = display_text(
            self.agent_info.get("title")
            or self.agent_info.get("name")
            or self.cli_label,
            60,
        )
        version = display_text(self.agent_info.get("version") or "", 30)
        head = f"{name} {version}".strip()
        return f"{head}; declares: {', '.join(declared) if declared else 'nothing beyond prompts'}"

    async def _open_session(self) -> None:
        params = {"cwd": str(Path(self._project_dir).resolve()), "mcpServers": []}
        result: Any = None
        if self.session_id and self.agent_capabilities.get("loadSession") is True:
            self._session = self.session_id
            try:
                # The history replays as updates before the answer: no turn is
                # open, so they are dropped.
                result = await self._request(
                    "session/load", {"sessionId": self.session_id, **params}
                )
                self._resumed_history = []
                self._kept_history = []
            except _RpcError as error:
                self._feed(
                    f"could not load session {display_text(self.session_id, 64)}: {error.message}"
                )
                self._session = None
        elif self.session_id:
            self._feed(
                "does not declare session/load; the session starts over with the conversation log"
            )
        if self._session is None:
            if self._kept_history and not self._resumed_history:
                self._resumed_history = self._kept_history
            result = await self._new_session(params)
            self._session = (
                result.get("sessionId") if isinstance(result, dict) else None
            )
            if not isinstance(self._session, str) or not self._session:
                raise AcpError(
                    f"{self.cli_label} answered session/new without a session id."
                )
            self.session_id = (
                None  # a new session: the system prompt goes in its first turn
            )
        self.last_session_id = self._session
        self._read_modes(result)
        await self._keep_mode()

    async def _new_session(self, params: dict[str, Any]) -> dict[str, Any]:
        try:
            result = await self._request("session/new", params)
        except _RpcError as error:
            if error.code != _AUTH_REQUIRED:
                raise AcpError(
                    f"{self.cli_label} refused session/new: {error.message}"
                ) from error
            method = next(
                (
                    m
                    for m, variable in self.spec.auth_env
                    if m in self.auth_methods and os.environ.get(variable)
                ),
                None,
            )
            if method is None:
                raise AcpAuthenticationError(
                    f"{self.cli_label} is not signed in ({error.message}). {self.spec.login}".strip()
                ) from error
            try:
                await self._request("authenticate", {"methodId": method})
                result = await self._request("session/new", params)
            except _RpcError as retry:
                raise AcpAuthenticationError(
                    f"{self.cli_label} could not sign in with {method}: {retry.message}. {self.spec.login}".strip()
                ) from retry
        return result if isinstance(result, dict) else {}

    def _read_modes(self, result: Any) -> None:
        modes = result.get("modes") if isinstance(result, dict) else None
        if not isinstance(modes, dict):
            self.modes, self.current_mode = (), None
            return
        self.modes = tuple(
            m["id"]
            for m in modes.get("availableModes") or []
            if isinstance(m, dict) and isinstance(m.get("id"), str)
        )
        current = modes.get("currentModeId")
        self.current_mode = current if isinstance(current, str) else None

    async def _keep_mode(self) -> None:
        """Put the session in the mode its rights call for, if the agent has it."""
        wanted = (
            self.spec.read_only_mode if self._read_only else self.spec.approval_mode
        )
        if self._read_only and wanted not in self.modes:
            self._feed(
                "offers no read-only mode; this read-only agent type relies on refused "
                "permissions and on stopping a turn that runs a tool it does not declare"
            )
            wanted = self.spec.approval_mode
        if wanted not in self.modes:
            self.expected_mode = None
            return
        self.expected_mode = wanted
        if self.current_mode != wanted:
            await self._set_mode(wanted)

    async def _set_mode(self, mode: str) -> None:
        try:
            await self._request(
                "session/set_mode", {"sessionId": self._session, "modeId": mode}
            )
        except _RpcError as error:
            raise AcpError(
                f"{self.cli_label} refused mode {mode}: {error.message}"
            ) from error
        self.current_mode = mode

    def _mode_changed(self, mode: object) -> None:
        if not isinstance(mode, str):
            return
        self.current_mode = mode
        if (
            self.expected_mode
            and mode != self.expected_mode
            and (mode in self.spec.auto_approve_modes or self._read_only)
        ):
            # A mode that acts without asking (or leaves read-only) is not kept.
            self._feed(
                f"switched to mode {display_text(mode, 40)}; back to {self.expected_mode}"
            )
            task = asyncio.create_task(self._set_mode(self.expected_mode))
            self._callbacks.add(task)
            task.add_done_callback(self._callbacks.discard)

    # ── a turn ────────────────────────────────────────────────────────────
    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        prompt = self._pending_query
        self._pending_query = None
        if not prompt:
            return
        await self._ensure_session()
        sections = []
        if self.system_prompt and not self.session_id:
            sections.append(self.system_prompt)
            # Sent once: the session carries it from now on.
            self.session_id = self._session
        if self._resumed_history:
            sections.append(self._format_history_as_preamble(self._resumed_history))
            self._resumed_history = []
        sections.append(prompt)
        text = "\n\n".join(s for s in sections if s)

        self._start_usage_ledger()
        self._violation = None
        updates = self._updates
        assert updates is not None
        while not updates.empty():
            updates.get_nowait()
        self._turn_open = True
        answer = asyncio.create_task(
            self._request(
                "session/prompt",
                {
                    "sessionId": self._session,
                    "prompt": [{"type": "text", "text": text}],
                },
            )
        )
        buffer: list[str] = []
        calls: dict[str, dict[str, Any]] = {}
        seen_output = False
        try:
            while True:
                getter = asyncio.create_task(updates.get())
                done, _ = await asyncio.wait(
                    {answer, getter}, return_when=asyncio.FIRST_COMPLETED
                )
                if getter not in done:
                    getter.cancel()
                    await asyncio.gather(getter, return_exceptions=True)
                    while not updates.empty():
                        for message in self._consume(
                            updates.get_nowait(), buffer, calls
                        ):
                            seen_output = True
                            yield message
                    break
                update = getter.result()
                if update.get("__closed__"):
                    break
                for message in self._consume(update, buffer, calls):
                    seen_output = True
                    yield message
                if self._violation:
                    await self._cancel_turn()
                    raise AcpError(self._violation)
            if buffer:
                seen_output = True
                yield text_message(MessageRole.ASSISTANT, "".join(buffer))
            result = await self._settled(answer)
        except asyncio.CancelledError:
            await self._cancel_turn()
            raise
        except AcpError:
            # A failed turn leaves the agent mid-way: the next one starts a
            # process again and loads the session when the agent can.
            await self._stop_process()
            raise
        finally:
            self._turn_open = False
            if not answer.done():
                answer.cancel()
                await asyncio.gather(answer, return_exceptions=True)
        self._finish(result, seen_output)

    async def _settled(self, answer: asyncio.Task[Any]) -> dict[str, Any]:
        try:
            result = await answer
        except _RpcError as error:
            lowered = error.message.lower()
            if error.code in (401, 403) or any(
                marker in lowered for marker in _AUTH_MARKERS
            ):
                raise AcpAuthenticationError(
                    f"{self.cli_label} was refused by its provider ({error.message}). {self.spec.login}".strip()
                ) from error
            raise AcpError(f"{self.cli_label}: {error.message}") from error
        except AcpError as error:
            stderr = await self._stderr_text()
            raise AcpError(
                f"{error}" + (f" stderr: {stderr}" if stderr else "")
            ) from error
        return result if isinstance(result, dict) else {}

    def _finish(self, result: dict[str, Any], seen_output: bool) -> None:
        usage = result.get("usage")
        if isinstance(usage, dict):
            self.last_usage = {
                "input_tokens": as_int(usage.get("inputTokens")),
                "output_tokens": as_int(usage.get("outputTokens")),
                "reasoning_tokens": as_int(usage.get("thoughtTokens")),
                "cache_read_input_tokens": as_int(usage.get("cachedReadTokens")),
                "cache_creation_input_tokens": as_int(usage.get("cachedWriteTokens")),
            }
            self._record_call(from_acp_usage(usage))
            if self.context_usage_source != "exact":
                self.context_usage_source = "reported"
        stop = result.get("stopReason")
        if stop in _STOP_ERRORS:
            raise AcpError(f"{self.cli_label}: {_STOP_ERRORS[stop]}")
        if stop != "end_turn":
            raise AcpError(
                f"{self.cli_label} ended the turn with {display_text(stop, 40)!r}."
            )
        if not seen_output:
            raise AcpError(f"{self.cli_label} returned no response.")

    def _consume(
        self,
        update: dict[str, Any],
        buffer: list[str],
        calls: dict[str, dict[str, Any]],
    ) -> list[AgentMessage]:
        kind = update.get("sessionUpdate")
        if kind == "agent_message_chunk":
            content = update.get("content")
            if (
                isinstance(content, dict)
                and content.get("type") == "text"
                and isinstance(content.get("text"), str)
            ):
                buffer.append(content["text"])
            return []
        if kind not in ("tool_call", "tool_call_update"):
            return []
        call_id = update.get("toolCallId")
        if not isinstance(call_id, str):
            return []
        call = calls.setdefault(call_id, {})
        for key in ("kind", "title", "status", "rawInput", "rawOutput", "content"):
            if update.get(key) is not None:
                call[key] = update[key]
        status = call.get("status")
        if status in ("in_progress", "completed") and not kind_allowed(
            call.get("kind"), self._agent_type
        ):
            self._violation = (
                f"{self.cli_label} ran a tool of kind `{call.get('kind')}` "
                f"({display_text(call.get('title'), 120)}) that the `{self._agent_type}` agent "
                "does not declare; the turn was stopped."
            )
            return []
        if status not in ("completed", "failed") or call.get("reported"):
            return []
        call["reported"] = True
        out: list[AgentMessage] = []
        if buffer:
            out.append(text_message(MessageRole.ASSISTANT, "".join(buffer)))
            buffer.clear()
        raw_input = call.get("rawInput")
        out += tool_messages(
            tool_id=call_id,
            name=display_text(call.get("title") or call.get("kind") or "tool", 120),
            tool_input=raw_input
            if isinstance(raw_input, dict)
            else {"kind": call.get("kind")},
            output=_tool_output(call),
            is_error=status == "failed",
        )
        return out

    async def _cancel_turn(self) -> None:
        if (
            self._session is None
            or self._process is None
            or self._process.returncode is not None
        ):
            return
        try:
            await self._write(
                {"method": "session/cancel", "params": {"sessionId": self._session}}
            )
        except (AcpError, OSError, RuntimeError):
            logger.debug("[%s] session/cancel could not be sent", self.cli_label)

    async def _stderr_text(self) -> str:
        task = self._stderr
        if task is None or not task.done():
            return ""
        try:
            return safe_error_text(task.result().decode("utf-8", "replace"))
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 - diagnostics only
            return ""

    async def _stop_process(self) -> None:
        process = self._process
        if (
            process is not None
            and process.returncode is None
            and process.stdin is not None
        ):
            try:
                process.stdin.close()
                await asyncio.wait_for(process.wait(), timeout=5)
            except (OSError, RuntimeError, TimeoutError):
                logger.debug("[%s] did not exit on stdin close", self.cli_label)
        for task in (self._reader, self._stderr, *self._callbacks):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(
                t
                for t in (self._reader, self._stderr, *self._callbacks)
                if t is not None
            ),
            return_exceptions=True,
        )
        self._reader = self._stderr = None
        self._callbacks.clear()
        self._session = None
        await super()._stop_process()


def _tool_output(call: dict[str, Any]) -> Any:
    """The text of a finished tool call: its content blocks, else its raw output."""
    parts: list[str] = []
    for block in call.get("content") or []:
        if not isinstance(block, dict):
            continue
        inner = block.get("content")
        if (
            block.get("type") == "content"
            and isinstance(inner, dict)
            and isinstance(inner.get("text"), str)
        ):
            parts.append(inner["text"])
        elif block.get("type") == "diff" and isinstance(block.get("path"), str):
            parts.append(f"diff {block['path']}")
    if parts:
        return "\n".join(parts)
    return call.get("rawOutput")
