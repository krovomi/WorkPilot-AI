"""`OpenAIAgentClient` — the OpenAI chat-completions loop the other
OpenAI-style clients (Google, compatible providers, local models) extend.

Split out of `core/agent_client.py` (audit lot L11, F36), which re-exports
every name defined here.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Sequence
from contextlib import aclosing
from typing import Any

from harness.application.loop import run_turns
from harness.domain import from_chat_completion
from harness.domain.stop import StopReason
from harness.ports import Measured, Outcome, Reply, ToolCall, ToolResult

# Common token-optimization trunk shared by every generic (OpenAI-style)
# multi-turn loop: head+tail tool-result truncation. The module is importable
# under both package layouts.
try:
    from core.llm_optimization import truncate_tool_result
except ImportError:  # pragma: no cover - alternate package layout
    from apps.backend.core.llm_optimization import truncate_tool_result
from .base import (
    CONTENT_TYPE_JSON,
    AgentClient,
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    LoopAdapter,
    MessageRole,
    SubagentDefinition,
)

# The name the monolith logged under, kept so logging configuration and log
# filters keyed on it still match: `core.agent_client`, or
# `apps.backend.core.agent_client` under the repo-root layout.
logger = logging.getLogger(__name__.rpartition(".agent_clients.")[0] + ".agent_client")


# =============================================================================
# OpenAI Agent Client — direct REST calls to OpenAI API
# =============================================================================


def _openai_cost_usd(
    model: str, input_tokens: int, output_tokens: int, provider: str = "openai"
) -> float:
    """Estimate cost in USD for a call, from the pricing catalog.

    $0 when the catalog has no price for the model. The import is local and
    layout-agnostic: the backend runs both with apps/backend on sys.path
    (`python -m cli.main`, which the streaming server spawns) and from the repo
    root (apps.backend.*).
    """
    try:
        from cost_intelligence.catalog import PricingCatalog
    except ImportError:  # pragma: no cover - alternate package layout
        from apps.backend.cost_intelligence.catalog import PricingCatalog

    pricing = PricingCatalog().get_pricing(provider, model)
    if pricing is None:
        return 0.0
    return pricing.cost_for_tokens(
        input_tokens=input_tokens, output_tokens=output_tokens
    )


class ChatCompletionsAdapter(LoopAdapter):
    """The OpenAI chat-completions protocol, for the WorkPilot loop.

    An answer is the first choice's message; its tool calls carry their
    arguments as a JSON string; the assistant turn goes back with its calls,
    each result as a ``tool`` message, cut head and tail. Copilot and
    Windsurf REST speak it too: they keep their own call and endings.
    """

    label = "OpenAIAgentClient"
    # What a reply with neither text nor tool call reads as.
    silence = "(No response from OpenAI)"

    def __init__(self, client: AgentClient, messages: list[dict[str, Any]]):
        super().__init__(client, messages)
        self.finish_reason = ""

    def read_choice(self, choices: list[dict[str, Any]], turn: int) -> Reply:
        # An OpenAI-compatible endpoint may send a field as null: `or`, not a default.
        message = choices[0].get("message") or {}
        content = message.get("content") or ""
        tool_calls = message.get("tool_calls") or []
        self.finish_reason = choices[0].get("finish_reason") or ""

        logger.info(
            f"[{self.label}] Turn {turn + 1}: "
            f"content_len={len(content)}, tool_calls={len(tool_calls)}, "
            f"finish_reason={self.finish_reason}"
        )
        if not tool_calls:
            return Reply(content)
        calls = tuple(self._tool_call(tc, turn) for tc in tool_calls)
        return Reply(content, calls, raw=tool_calls)

    @staticmethod
    def _tool_call(tc: dict[str, Any], turn: int) -> ToolCall:
        func = tc.get("function") or {}
        tool_name = func.get("name", "")
        tool_id = tc.get("id", f"call_{turn}_{tool_name}")
        try:
            args = json.loads(func.get("arguments", "{}"))
        except (json.JSONDecodeError, TypeError):
            args = {}
        return ToolCall(tool_id, tool_name, args)

    def settle(self, reply: Reply, turn: int) -> tuple[list[Any], Outcome]:
        notes = [] if reply.text else [self.text(self.silence)]
        logger.info(f"[{self.label}] Session complete after {turn + 1} turn(s)")
        return notes, Outcome.DONE

    def reinject(self, reply: Reply, results: Sequence[ToolResult]) -> None:
        assistant_msg: dict[str, Any] = {"role": "assistant"}
        if reply.text:
            assistant_msg["content"] = reply.text
        assistant_msg["tool_calls"] = reply.raw
        self.messages.append(assistant_msg)
        for call, result in zip(reply.calls, results, strict=True):
            # Head+tail truncation — build/test verdicts sit at the END.
            self.messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": truncate_tool_result(result.text),
                }
            )


class _OpenAIAdapter(ChatCompletionsAdapter):
    """One response of ``OpenAIAgentClient`` and the clients that extend it."""

    def __init__(
        self,
        client: OpenAIAgentClient,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]],
        session: Any,
        headers: dict[str, str],
    ):
        super().__init__(client, messages)
        self.tools = tools
        self.session = session
        self.headers = headers
        self.total_in = 0
        self.total_out = 0

    def assemble(self, turn: int) -> dict[str, Any]:
        client = self.client
        payload: dict[str, Any] = {
            "model": client.model,
            "messages": self.messages,
            "stream": False,
        }
        if self.tools:
            payload["tools"] = self.tools
            payload["tool_choice"] = "auto"
        # Provider-specific token optimizations (omitted when None):
        if client._reasoning_effort:
            payload["reasoning_effort"] = client._reasoning_effort
        if client._prompt_cache_key:
            payload["prompt_cache_key"] = client._prompt_cache_key

        logger.info(
            f"[OpenAIAgentClient] Turn {turn + 1}/{client.max_turns}: "
            f"sending {len(self.messages)} messages..."
        )
        return payload

    async def call(self, payload: dict[str, Any], turn: int) -> AsyncIterator[Any]:
        client = self.client
        data: Any = None
        failure: str | None = None
        try:
            async with self.session.post(
                client._api_base,
                json=payload,
                headers=self.headers,
                allow_redirects=not getattr(client, "_offline_only", False),
            ) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    logger.error(
                        f"[OpenAIAgentClient] API error ({resp.status}): {error_text[:500]}"
                    )
                    failure = f"OpenAI API error ({resp.status}): {error_text}"
                else:
                    data = await resp.json()
        except Exception as e:
            logger.error(f"[OpenAIAgentClient] Request failed: {e}")
            failure = client._describe_request_error(e)
        if failure is not None:
            yield self.notice(failure)
            yield Outcome.HALT
            return

        # Accumulate token usage from each turn
        _u = data.get("usage") or {}
        self.total_in += _u.get("prompt_tokens", 0)
        self.total_out += _u.get("completion_tokens", 0)
        if _u.get("prompt_tokens"):
            client.last_context_tokens = int(_u["prompt_tokens"])
        yield Measured(from_chat_completion(_u))

        choices = data.get("choices") or []
        if not choices:
            yield self.text("(Empty response from OpenAI)")
            yield Outcome.HALT
            return
        yield self.read_choice(choices, turn)

    async def execute(self, call: ToolCall) -> ToolResult:
        return await self.run_tool(call, mcp=self.client._mcp_manager)

    def finish(self, reason: StopReason) -> None:
        client = self.client
        if reason == "max_turns":
            logger.warning(
                f"[OpenAIAgentClient] Reached max_turns ({client.max_turns}) — stopping tool loop"
            )
            print(
                f"[OpenAIAgentClient] ⚠️ Reached max turns ({client.max_turns})",
                flush=True,
            )
        client.last_usage = {
            "input_tokens": self.total_in,
            "output_tokens": self.total_out,
            "cost_usd": _openai_cost_usd(
                client.model, self.total_in, self.total_out, client._provider_name
            ),
        }


class OpenAIAgentClient(AgentClient):
    """Agent client backed by OpenAI API (direct REST calls).

    Requires a valid OpenAI API key (sk-...) from https://platform.openai.com/api-keys.
    Uses /v1/chat/completions with full tool-use loop.
    """

    def __init__(
        self,
        model: str = "gpt-4o",
        system_prompt: str | None = None,
        max_turns: int = 50,
        project_dir: str | None = None,
        agent_type: str = "coder",
        reasoning_effort: str | None = None,
        prompt_cache_key: str | None = None,
        spec_dir: str | None = None,
        api_key: str | None = None,
        api_base: str | None = None,
        provider: str = "openai",
    ):
        import os as _os

        self.model = model
        self.system_prompt = system_prompt
        self.max_turns = max_turns
        self._project_dir = project_dir
        self._agent_type = agent_type
        # Only so the tool executor can record what it stripped from a generated
        # file. `<spec_dir>/watermarks.jsonl` is the record of the one place a
        # build edits bytes a model wrote without telling it, and every one of
        # these clients used to build the executor without a spec directory — so
        # the cleaning happened and the record never did, on exactly the
        # providers that never reach `create_client`'s hooks.
        self._spec_dir = spec_dir
        # Token optimizations (provider-specific layer on the common trunk):
        # reasoning_effort maps the Kanban thinking level to OpenAI reasoning
        # models; prompt_cache_key routes same-task sessions to the same
        # automatic-prompt-cache shard. Both omitted from payload when None.
        self._reasoning_effort = reasoning_effort
        self._prompt_cache_key = prompt_cache_key
        self._api_key: str = (
            api_key if api_key is not None else _os.environ.get("OPENAI_API_KEY", "")
        )
        self._api_base = api_base or "https://api.openai.com/v1/chat/completions"
        self._provider_name = provider
        self._pending_query: str | None = None
        self._http_client: Any = None
        self._tool_executor: Any = None
        self._tool_definitions: list[dict[str, Any]] = []
        # Optional MCP bridge: configured MCP servers (CUSTOM_MCP_SERVERS) are
        # surfaced as extra OpenAI tools so OpenAI/Google/local agents can use
        # them just like the Claude SDK path. Initialised in __aenter__.
        self._mcp_manager: Any = None
        # Usage accumulated across the session's turns
        self.last_usage: dict | None = None
        # Context fill of the latest turn (prompt tokens the provider reported),
        # read by context_mgmt's guard; None until a turn reports it.
        self.last_context_tokens: int | None = None
        self.context_window_tokens: int | None = None
        self.context_usage_source = "reported"

    def set_tool_working_directory(self, directory: str) -> None:
        """Set relative tool paths without changing the project security boundary."""
        from core.runtimes.tool_executor import ToolExecutor

        executor = ToolExecutor(self._project_dir, directory)
        self._tool_working_directory = str(executor.working_directory)

    def _get_http_client(self):
        """Lazy-init an aiohttp ClientSession."""
        if self._http_client is None:
            try:
                import aiohttp

                self._http_client = aiohttp.ClientSession(
                    headers={
                        "Content-Type": CONTENT_TYPE_JSON,
                        "Accept": CONTENT_TYPE_JSON,
                    }
                )
            except ImportError:
                raise ImportError(
                    "aiohttp is required for OpenAIAgentClient. "
                    "Install it with: pip install aiohttp"
                )
        return self._http_client

    async def __aenter__(self):
        definitions: list[dict[str, Any]] = list(self._tool_definitions)
        if self._project_dir:
            try:
                from core.runtimes.tool_executor import (
                    ToolExecutor,
                    get_tool_definitions,
                )

                self._tool_executor = ToolExecutor(
                    self._project_dir,
                    getattr(self, "_tool_working_directory", None),
                    spec_dir=getattr(self, "_spec_dir", None),
                    agent_type=self._agent_type,
                )
                definitions = get_tool_definitions(
                    self._agent_type, getattr(self, "_spec_dir", None)
                )
                logger.info(
                    f"[OpenAIAgentClient] Tool execution enabled: "
                    f"{len(definitions)} tools for agent_type={self._agent_type}"
                )
            except Exception as e:
                logger.warning(
                    f"[OpenAIAgentClient] Tool executor init failed (text-only mode): {e}"
                )
        # A delegated child bridges no MCP server: its tools are its role's,
        # and a bridge is paid in connection time and schema on every call.
        if not getattr(self, "_offline_only", False) and self.delegation_scope is None:
            definitions += await self._bridge_mcp_tools()
        # One tool set for the whole session, MCP tools included: sorted and
        # serialized one way (harness.domain.tools), so every turn — and every
        # session given the same tools — sends the same bytes.
        if definitions:
            self._freeze_tools(definitions)
        return self

    async def _bridge_mcp_tools(self) -> list[dict[str, Any]]:
        """The tools of the configured MCP servers, bridged for this session.

        Only the servers this type may reach: the same per-agent answer the
        Claude SDK gets from `create_client`. Best-effort: an MCP error never
        fails client setup.
        """
        try:
            from core.mcp_tools import MCPToolManager, load_mcp_server_configs_for

            servers = load_mcp_server_configs_for(
                self._agent_type, self._project_dir, getattr(self, "_spec_dir", None)
            )
            if servers:
                manager = MCPToolManager(self._project_dir, servers)
                await manager.connect()
                mcp_defs = manager.tool_definitions()
                if mcp_defs:
                    self._mcp_manager = manager
                    logger.info(
                        f"[OpenAIAgentClient] MCP enabled: {len(mcp_defs)} tool(s) "
                        f"from {len(servers)} server(s)"
                    )
                    return mcp_defs
                await manager.aclose()
        except Exception as e:  # noqa: BLE001 — MCP must never block client setup
            logger.warning(f"[OpenAIAgentClient] MCP bridge unavailable: {e}")
        return []

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._mcp_manager is not None:
            await self._mcp_manager.aclose()
            self._mcp_manager = None
        if self._http_client is not None:
            await self._http_client.close()
            self._http_client = None

    async def query(self, prompt: str) -> None:
        """Queue a prompt for the next receive_response() call."""
        self._pending_query = prompt

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        """Execute the queued prompt against the OpenAI API (/v1/chat/completions).

        Requires a valid OpenAI API key (sk-...) from https://platform.openai.com/api-keys.
        The multi-turn tool-use loop is the shared WorkPilot loop
        (``harness.application.loop``); ``_OpenAIAdapter`` speaks the protocol.
        """
        if not self._pending_query:
            return

        if not self._api_key:
            yield AgentMessage(
                role=MessageRole.SYSTEM,
                content=[
                    ContentBlock(
                        type=ContentBlockType.TEXT,
                        text="OpenAI auth error: OPENAI_API_KEY not set.",
                    )
                ],
            )
            return

        prompt = self._pending_query
        self._pending_query = None

        messages: list[dict[str, Any]] = []
        if self.system_prompt:
            messages.append({"role": "system", "content": self.system_prompt})
        # If resume(history) was queued, inject the prior transcript so this
        # provider sees the same context the previous one had.
        self._consume_resumed_history_as_system_message(messages)
        messages.append({"role": "user", "content": prompt})

        tools = [
            {
                "type": "function",
                "function": {
                    "name": td["name"],
                    "description": td.get("description", ""),
                    "parameters": td.get(
                        "parameters", {"type": "object", "properties": {}}
                    ),
                },
            }
            for td in self._tool_definitions
        ]

        request_headers = {
            "Authorization": f"Bearer {self._api_key}",
        }

        logger.info(
            f"[OpenAIAgentClient] Starting session (model={self.model}, "
            f"tools={len(tools)}, prompt_len={len(prompt)})"
        )
        print(
            f"[OpenAIAgentClient] 🤖 Starting OpenAI session "
            f"(model={self.model}, {len(tools)} tools)",
            flush=True,
        )

        session = self._get_http_client()

        ledger = self._start_usage_ledger()
        adapter = _OpenAIAdapter(
            self, messages, tools=tools, session=session, headers=request_headers
        )
        async with aclosing(
            run_turns(adapter, max_turns=self.max_turns, ledger=ledger)
        ) as turns:
            async for message in turns:
                yield message

    def provider_name(self) -> str:
        return self._provider_name

    @staticmethod
    def _is_connection_error(exc: Exception) -> bool:
        """True when the request failed to even reach the server (vs an API error).

        Covers aiohttp's ClientConnectorError, raw ConnectionRefusedError, and the
        textual forms seen on Windows ("Cannot connect to host", "refused").
        """
        if isinstance(exc, (ConnectionRefusedError, OSError)):
            return True
        try:
            import aiohttp

            if isinstance(exc, aiohttp.ClientConnectorError):
                return True
        except ImportError:
            pass
        text = str(exc).lower()
        return "cannot connect to host" in text or "refused" in text

    def _describe_request_error(self, exc: Exception) -> str:
        """Human-friendly text for a failed chat request. Overridable per provider."""
        return f"OpenAI API error: {exc}"

    def supports_subagents(self) -> bool:
        # Emulated: the roster is offered as the ``delegate`` tool and each
        # delegation runs as a child session of this client
        # (``harness.application.delegation``).
        return True

    def delegates(self) -> bool:
        return True

    async def run_subagents(
        self,
        agents: dict[str, SubagentDefinition],
        context_prompt: str,
    ) -> dict[str, str]:
        """Not implemented for OpenAI client; returns empty dict."""
        return {}
