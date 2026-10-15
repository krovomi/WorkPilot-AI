"""`WindsurfAgentClient` — the Windsurf provider.

Split out of `core/agent_client.py` (audit lot L11, F36), which re-exports
every name defined here.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

from harness.domain import from_chat_completion
from harness.domain.progress import ProgressTracker

# Common token-optimization trunk shared by every generic (OpenAI-style)
# multi-turn loop: head+tail tool-result truncation and over-budget history
# compaction. The module is importable under both package layouts.
try:
    from core.llm_optimization import (
        compact_messages,
        truncate_tool_result,
    )
except ImportError:  # pragma: no cover - alternate package layout
    from apps.backend.core.llm_optimization import (
        compact_messages,
        truncate_tool_result,
    )
from .base import (
    CONTENT_TYPE_JSON,
    AgentClient,
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
)

# The name the monolith logged under, kept so logging configuration and log
# filters keyed on it still match: `core.agent_client`, or
# `apps.backend.core.agent_client` under the repo-root layout.
logger = logging.getLogger(__name__.rpartition(".agent_clients.")[0] + ".agent_client")


# =============================================================================
# Windsurf Agent Client — dual-mode (gRPC proxy + REST fallback)
# =============================================================================


class WindsurfAgentClient(AgentClient):
    """Agent client backed by Windsurf/Codeium with dual-mode support.

    Mode 1 (gRPC, for sk-ws-* IDE keys): gRPC to local Windsurf IDE language server.
        Routes through the running Windsurf IDE → Codeium cloud.
        Consumes Windsurf credits.  Tool execution via text-based tool calling
        (tool definitions in system prompt, ``<tool_call>`` XML tags parsed
        from model output).
        Requires Windsurf IDE to be running and authenticated.

    Mode 2 (REST, for SSO/enterprise/API keys): OpenAI-compatible REST API.
        Uses stored API key, SSO token, or OAuth token.
        Supports full agentic tool execution via OpenAI function calling.
        API key sourced from: env vars → state.vscdb → running IDE process.

    Authentication:
    - gRPC mode: CSRF token + API key from running language server process
    - REST mode: Bearer token from WINDSURF_API_KEY, state.vscdb, or IDE credentials
    """

    # Anthropic model names → Windsurf-compatible model names
    _MODEL_NAME_MAP: dict[str, str] = {
        # Anthropic SDK format → Windsurf format
        "claude-sonnet-4-5-20250929": "claude-4.5-sonnet",
        "claude-sonnet-4-20250514": "claude-4-sonnet",
        "claude-opus-4-20250514": "claude-4-opus",
        "claude-3-7-sonnet-20250219": "claude-3.7-sonnet",
        "claude-3-5-sonnet-20241022": "claude-3.5-sonnet",
        "claude-3-5-sonnet-20240620": "claude-3.5-sonnet",
        "claude-3-5-haiku-20241022": "claude-3.5-haiku",
        "claude-3-opus-20240229": "claude-3-opus",
        "claude-3-sonnet-20240229": "claude-3-sonnet",
        "claude-3-haiku-20240307": "claude-3-haiku",
        # Common aliases
        "claude-sonnet-4": "claude-4-sonnet",
        "claude-opus-4": "claude-4-opus",
        "claude-sonnet-4.5": "claude-4.5-sonnet",
        "claude-opus-4.5": "claude-4.5-opus",
        "claude-sonnet-4.6": "claude-4.6-sonnet",
        "claude-opus-4.6": "claude-4.6-opus",
    }

    def __init__(
        self,
        model: str = "claude-4-sonnet",
        system_prompt: str | None = None,
        max_turns: int = 50,
        project_dir: str | None = None,
        agent_type: str = "coder",
        spec_dir: str | None = None,
    ):
        import os as _os

        # Normalize model name to Windsurf-compatible format
        original_model = model
        self.model = self._MODEL_NAME_MAP.get(model, model)
        if self.model != original_model:
            logger.info(
                f"[WindsurfAgent] Model name normalized: '{original_model}' → '{self.model}'"
            )

        self.system_prompt = system_prompt
        self.max_turns = max_turns
        self._project_dir = project_dir
        self._agent_type = agent_type
        # See OpenAIAgentClient: only for the watermark ledger's spec directory.
        self._spec_dir = spec_dir
        self._credentials: Any = None  # WindsurfCredentials (Mode 1)
        self._use_local_grpc = False
        self._api_key: str | None = None  # For Mode 2
        self._pending_query: str | None = None
        self._http_client: Any = None
        self._tool_executor: Any = None  # ToolExecutor instance
        self._tool_definitions: list[dict[str, Any]] = []
        # Usage accumulated across REST turns (gRPC mode: credits only, no token count)
        self.last_usage: dict | None = None
        # Context fill of the latest turn (prompt tokens the provider reported),
        # read by context_mgmt's guard; None until a turn reports it.
        self.last_context_tokens: int | None = None
        self.context_window_tokens: int | None = None
        self.context_usage_source = "reported"
        # Ordered list of base URLs to try.  `server.codeium.com` is the
        # documented base for analytics/billing, but chat completions may live
        # elsewhere — or may not be exposed at all for sk-ws-* keys.
        # An explicit WINDSURF_BASE_URL env-var overrides the probing list.
        env_url = _os.environ.get("WINDSURF_BASE_URL")
        if env_url:
            self._rest_base_urls: list[str] = [env_url]
        else:
            self._rest_base_urls = [
                "https://windsurf.com/api/v1",
                "https://api.codeium.com/v1",
                "https://server.codeium.com/api/v1",
            ]
        self._rest_base_url = self._rest_base_urls[0]
        self._rest_url_probed = False  # True once we've found a working URL

    async def __aenter__(self):
        import os as _os

        from integrations.windsurf_proxy.auth import (
            discover_credentials,
            get_api_key,
            is_windsurf_running,
        )

        # =====================================================================
        # Step 1: Discover API key from all sources
        # =====================================================================
        # For agentic sessions (project_dir set), we ALWAYS prefer REST mode
        # because it supports OpenAI function calling (tool execution loop).
        # gRPC mode is text-only and cannot do tool execution.

        # 1a. Check environment variables first
        self._api_key = (
            _os.environ.get("WINDSURF_API_KEY")
            or _os.environ.get("WINDSURF_OAUTH_TOKEN")
            or _os.environ.get("CODEIUM_API_KEY")
        )
        if self._api_key:
            logger.info("[WindsurfAgent] Found API key from environment variable")

        # 1b. Try reading from Windsurf's local state.vscdb (SSO/enterprise tokens)
        if not self._api_key:
            try:
                self._api_key = get_api_key()
                logger.info("[WindsurfAgent] Found API key/SSO token from state.vscdb")
            except Exception as e:
                logger.debug(f"[WindsurfAgent] state.vscdb key lookup failed: {e}")

        # 1c. For sk-ws-* keys from env var, check if state.vscdb has a fresher key.
        # After a Windsurf re-login, state.vscdb is updated with the new key but the
        # env var still carries the stale key injected from saved frontend settings.
        # state.vscdb always reflects the current login session, so prefer it.
        if self._api_key and self._api_key.startswith("sk-ws-"):
            try:
                from integrations.windsurf_proxy.auth import _get_api_key_from_state_db

                db_key = _get_api_key_from_state_db()
                if db_key and db_key != self._api_key:
                    logger.info(
                        "[WindsurfAgent] state.vscdb has a different key than env var "
                        "(user likely re-logged into Windsurf) — preferring state.vscdb key"
                    )
                    self._api_key = db_key
            except Exception as e:
                logger.debug(f"[WindsurfAgent] state.vscdb freshness check failed: {e}")

        # 1c. If Windsurf IDE is running, extract API key from its credentials
        if not self._api_key and is_windsurf_running():
            try:
                creds = discover_credentials()
                self._api_key = creds.api_key
                logger.info(
                    "[WindsurfAgent] Extracted API key from running Windsurf IDE"
                )
            except Exception as e:
                logger.warning(f"[WindsurfAgent] Failed to extract key from IDE: {e}")

        # =====================================================================
        # Step 2: Choose mode based on API key type and IDE availability
        # =====================================================================
        # sk-ws-* keys → gRPC through local Windsurf IDE (consumes credits)
        # Other keys (SSO/enterprise) → REST API with function calling
        # No key but IDE running → gRPC through local IDE

        is_ide_key = bool(self._api_key and self._api_key.startswith("sk-ws-"))

        # Check if REST mode is forced via environment variable
        # NOTE: sk-ws-* keys are designed for gRPC only and should ignore WINDSURF_FORCE_REST

        # sk-ws-* keys ALWAYS use gRPC mode (ignore WINDSURF_FORCE_REST)
        # These keys are specifically designed for Windsurf IDE gRPC communication
        if is_ide_key:
            # sk-ws-* keys only work through the local Windsurf IDE language
            # server (gRPC).  They do NOT work with any REST chat completions
            # endpoint.  Tool execution is handled via text-based tool calling.
            if is_windsurf_running():
                try:
                    self._credentials = discover_credentials()
                    self._use_local_grpc = True
                    logger.info(
                        f"[WindsurfAgent] Mode 1 (gRPC): sk-ws-* key → routing "
                        f"through local Windsurf IDE at localhost:{self._credentials.port} "
                        f"(model={self.model}, consumes Windsurf credits, "
                        f"text-based tool execution)"
                    )
                    print(
                        "[WindsurfAgent] Using Windsurf IDE (gRPC) — credits will be consumed",
                        flush=True,
                    )
                except Exception as e:
                    raise RuntimeError(
                        f"Windsurf: sk-ws-* key detected but gRPC credential "
                        f"discovery failed: {e}.\n"
                        "Please ensure Windsurf IDE is running and accessible."
                    )
            else:
                raise RuntimeError(
                    "Windsurf: sk-ws-* key detected but Windsurf IDE is not running.\n"
                    "sk-ws-* keys only work through the local Windsurf IDE.\n"
                    "Please start Windsurf IDE to use your Windsurf credits."
                )
        elif self._api_key:
            # Non-IDE key (SSO/enterprise/OAuth token).
            # PREFER REST mode for OAuth tokens - it supports full tool execution via
            # OpenAI function calling and doesn't require Windsurf IDE to be running.
            # Only fall back to gRPC if REST fails or if explicitly configured.

            # Debug logging (sanitized: do not log API key contents/metadata)
            logger.info("[WindsurfAgent] API key found")
            logger.info(
                f"[WindsurfAgent] Windsurf IDE running: {is_windsurf_running()}"
            )

            # Check if this is an OAuth token (starts with specific prefixes or is long)
            is_oauth_token = (
                self._api_key.startswith("oauth_")
                or self._api_key.startswith("sso_")
                or len(self._api_key) > 100  # OAuth tokens are typically long
            )

            logger.info("[WindsurfAgent] OAuth token detection completed")

            if is_oauth_token:
                # OAuth token → prefer REST mode for reliability
                self._use_local_grpc = False
                logger.info(
                    "[WindsurfAgent] Mode 2 (REST): OAuth token detected → using REST API "
                    "with function calling (model=%s)",
                    self.model,
                )
                print(
                    "[WindsurfAgent] Using REST API (OAuth token) - full tool execution support",
                    flush=True,
                )
            elif is_windsurf_running():
                # Non-OAuth token (SSO/enterprise) + IDE running → try gRPC first
                try:
                    self._credentials = discover_credentials()
                    self._use_local_grpc = True
                    logger.info(
                        f"[WindsurfAgent] Mode 1 (gRPC): SSO/enterprise token + IDE running → "
                        f"routing through local language server at localhost:{self._credentials.port} "
                        f"(model={self.model})"
                    )
                    print(
                        "[WindsurfAgent] Using Windsurf IDE gRPC (SSO/enterprise token, IDE running)",
                        flush=True,
                    )
                except Exception as e:
                    # gRPC discovery failed — fall back to REST with a warning
                    logger.warning(
                        f"[WindsurfAgent] gRPC discovery failed ({e}), falling back to REST"
                    )
                    self._use_local_grpc = False
                    logger.info(
                        "[WindsurfAgent] Mode 2 (REST): %s (model=%s)",
                        self._rest_base_url,
                        self.model,
                    )
                    print(
                        "[WindsurfAgent] ⚠️ gRPC failed, falling back to REST API",
                        flush=True,
                    )
            else:
                # No IDE running — try REST (may not work if no enterprise endpoint configured)
                self._use_local_grpc = False
                logger.warning(
                    "[WindsurfAgent] Mode 2 (REST): Windsurf IDE not running. "
                    "REST chat endpoints may return 404. "
                    "Start Windsurf IDE or set WINDSURF_BASE_URL to a valid enterprise endpoint."
                )
                print(
                    "[WindsurfAgent] ⚠️ Windsurf IDE not running — REST mode may fail. "
                    "Start Windsurf IDE for reliable operation.",
                    flush=True,
                )
        elif is_windsurf_running():
            # No key in env but IDE running: gRPC mode
            try:
                self._credentials = discover_credentials()
                self._use_local_grpc = True
                logger.info(
                    f"[WindsurfAgent] Mode 1 (gRPC): no explicit key, using "
                    f"local Windsurf IDE at localhost:{self._credentials.port} "
                    f"(model={self.model}, text-based tool execution)"
                )
            except Exception as e:
                raise RuntimeError(
                    f"Windsurf: no API key found and gRPC discovery failed: {e}.\n"
                    "Please set WINDSURF_API_KEY or start Windsurf IDE."
                )
        else:
            raise RuntimeError(
                "Windsurf: no API key found (checked env vars, state.vscdb, running IDE).\n"
                "Please either:\n"
                "  1. Start Windsurf IDE (for sk-ws-* key via gRPC), or\n"
                "  2. Set WINDSURF_API_KEY environment variable, or\n"
                "  3. Set WINDSURF_OAUTH_TOKEN or CODEIUM_API_KEY env var."
            )

        # =====================================================================
        # Step 3: Initialize tool execution support (both gRPC and REST)
        # =====================================================================
        # gRPC mode uses text-based tool calling (tool definitions in prompt,
        # tool calls parsed from text output).
        # REST mode uses OpenAI function calling (native tool_calls).
        if self._project_dir:
            try:
                from core.runtimes.tool_executor import (
                    ToolExecutor,
                    get_tool_definitions,
                )

                self._tool_executor = ToolExecutor(
                    self._project_dir,
                    spec_dir=getattr(self, "_spec_dir", None),
                    agent_type=self._agent_type,
                )
                self._tool_definitions = get_tool_definitions(
                    self._agent_type, getattr(self, "_spec_dir", None)
                )
                mode_label = (
                    "gRPC text-based"
                    if self._use_local_grpc
                    else "REST function calling"
                )
                logger.info(
                    f"[WindsurfAgent] Tool execution enabled ({mode_label}): "
                    f"{len(self._tool_definitions)} tools for agent_type={self._agent_type}"
                )
            except Exception as e:
                logger.warning(
                    f"[WindsurfAgent] Tool executor init failed (text-only mode): {e}"
                )

        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._http_client is not None:
            await self._http_client.close()
            self._http_client = None

    async def query(self, prompt: str) -> None:
        """Queue a prompt for the next receive_response() call."""
        self._pending_query = prompt

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        """Execute the queued prompt against Windsurf.

        Routes to gRPC (Mode 1) or REST (Mode 2) based on connection state.
        REST mode uses a full tool execution loop with OpenAI function calling.
        """
        if not self._pending_query:
            return

        prompt = self._pending_query
        self._pending_query = None

        if self._use_local_grpc:
            if self._tool_executor and self._tool_definitions:
                async for msg in self._grpc_response_with_tools(prompt):
                    yield msg
            else:
                yield await self._grpc_response(prompt)
        else:
            async for msg in self._rest_response_with_tools(prompt):
                yield msg

    # =================================================================
    # gRPC mode (text-based tool calling through local Windsurf IDE)
    # =================================================================

    async def _grpc_response(self, prompt: str) -> AgentMessage:
        """Send prompt via gRPC to local Windsurf language server (no tools)."""
        from integrations.windsurf_proxy import grpc_client as _grpc_mod
        from integrations.windsurf_proxy.auth import (
            discover_credentials,
            invalidate_process_cache,
        )
        from integrations.windsurf_proxy.cascade_client import cascade_chat
        from integrations.windsurf_proxy.grpc_client import stream_chat
        from integrations.windsurf_proxy.models import requires_cascade, resolve_model

        model_enum, model_name = resolve_model(self.model)
        use_cascade = requires_cascade(self.model)
        messages = []

        if self.system_prompt:
            messages.append({"role": "system", "content": self.system_prompt})
        # If resume(history) was queued, inject the prior transcript so this
        # provider sees the same context the previous one had.
        self._consume_resumed_history_as_system_message(messages)
        messages.append({"role": "user", "content": prompt})

        last_error: Exception | None = None
        text_parts: list[str] = []
        for attempt in range(2):
            if attempt > 0:
                # Refresh credentials to get a fresh CSRF token and re-init panel.
                # IMPORTANT: invalidate the process-info cache first — without this,
                # discover_credentials() returns the same stale CSRF token (10s TTL).
                logger.warning(
                    "[WindsurfAgent] Refreshing credentials before retry (attempt 2)"
                )
                _grpc_mod._panel_initialized = False
                invalidate_process_cache()
                # Brief pause: lets Windsurf's internal session recover before we re-init.
                import asyncio as _asyncio

                await _asyncio.sleep(1.5)
                try:
                    self._credentials = discover_credentials()
                except Exception as refresh_err:
                    logger.error(
                        f"[WindsurfAgent] Credential refresh failed: {refresh_err}"
                    )
                    break

            text_parts = []
            try:
                if use_cascade:
                    full = await cascade_chat(
                        credentials=self._credentials,
                        messages=messages,
                        model_enum=model_enum,
                        model_uid=model_name,
                    )
                    if full:
                        text_parts.append(full)
                else:
                    async for chunk in stream_chat(
                        credentials=self._credentials,
                        messages=messages,
                        model_enum=model_enum,
                        model_name=model_name,
                        system_prompt=self.system_prompt,
                    ):
                        text_parts.append(chunk)
                last_error = None
            except Exception as e:
                last_error = e
                err_str = str(e).lower()
                if attempt == 0 and (
                    "failed_precondition" in err_str or "cascade session" in err_str
                ):
                    logger.warning(
                        f"[WindsurfAgent] Cascade session error (exception), retrying: {e}"
                    )
                    _grpc_mod._panel_initialized = False
                    continue
                logger.error(f"[WindsurfAgent] gRPC streaming error: {e}")
                break

            # Windsurf sometimes streams the error as text (HTTP 200) with no real content.
            # Detect this: if the full response is only the error message, retry.
            full_text = "".join(text_parts)
            if (
                "failed_precondition" in full_text.lower()
                and "cascade session" in full_text.lower()
                and attempt == 0
            ):
                logger.warning(
                    "[WindsurfAgent] Cascade session error in response text, retrying with fresh credentials"
                )
                _grpc_mod._panel_initialized = False
                invalidate_process_cache()
                import asyncio as _asyncio

                await _asyncio.sleep(1.5)
                try:
                    self._credentials = discover_credentials()
                except Exception as refresh_err:
                    logger.error(
                        f"[WindsurfAgent] Credential refresh failed: {refresh_err}"
                    )
                    break
                continue

            break  # success or non-retryable error

        if last_error is not None:
            return AgentMessage(
                role=MessageRole.SYSTEM,
                content=[
                    ContentBlock(
                        type=ContentBlockType.TEXT,
                        text=f"Windsurf gRPC error: {last_error}",
                    )
                ],
            )

        full_text = "".join(text_parts)
        if not full_text:
            full_text = "(Empty response from Windsurf)"

        return AgentMessage(
            role=MessageRole.ASSISTANT,
            content=[ContentBlock(type=ContentBlockType.TEXT, text=full_text)],
        )

    def _build_tool_prompt_text(self) -> str:
        """Format tool definitions as text for the gRPC system prompt.

        In gRPC mode the model doesn't have native function calling, so we
        describe the tools in the system prompt and ask it to emit structured
        ``<tool_call>`` XML tags that we parse client-side.
        """
        if not self._tool_definitions:
            return ""

        lines = [
            "\n\n## Available Tools",
            "",
            "You can use the following tools. To call a tool, output a "
            "`<tool_call>` XML tag containing a JSON object with `name` and "
            "`arguments` keys:",
            "",
            "```",
            "<tool_call>",
            '{"name": "tool_name", "arguments": {"param": "value"}}',
            "</tool_call>",
            "```",
            "",
            "You may make multiple tool calls in a single response. After each "
            "tool call I will provide the result in `<tool_result>` tags. "
            "Continue working based on the results.",
            "",
            "When you are finished and have no more tool calls, provide your "
            "final answer WITHOUT any `<tool_call>` tags.",
            "",
            "### Tool Definitions",
            "",
        ]

        for td in self._tool_definitions:
            name = td["name"]
            desc = td.get("description", "")
            params = td.get("parameters", {})
            props = params.get("properties", {})
            required = params.get("required", [])

            lines.append(f"**{name}** — {desc}")
            if props:
                for pname, pinfo in props.items():
                    req_marker = " (required)" if pname in required else ""
                    pdesc = pinfo.get("description", "")
                    ptype = pinfo.get("type", "string")
                    lines.append(f"  - `{pname}` ({ptype}{req_marker}): {pdesc}")
            lines.append("")

        return "\n".join(lines)

    @staticmethod
    def _parse_tool_calls_from_text(text: str) -> tuple[str, list[dict[str, Any]]]:
        """Parse ``<tool_call>`` blocks from model text output.

        Returns:
            (clean_text, tool_calls) where *clean_text* is the response with
            ``<tool_call>`` blocks removed and *tool_calls* is a list of dicts
            with ``name`` and ``arguments`` keys.
        """
        import json as _json
        import re as _re

        tool_calls: list[dict[str, Any]] = []
        clean_parts: list[str] = []
        last_end = 0

        for match in _re.finditer(
            r"<tool_call>\s*(.*?)\s*</tool_call>", text, _re.DOTALL
        ):
            clean_parts.append(text[last_end : match.start()])
            last_end = match.end()

            raw = match.group(1).strip()
            try:
                parsed = _json.loads(raw)
                if isinstance(parsed, dict) and "name" in parsed:
                    tool_calls.append(
                        {
                            "name": parsed["name"],
                            "arguments": parsed.get("arguments", {}),
                        }
                    )
                else:
                    logger.warning(
                        f"[WindsurfAgent] Skipping malformed tool_call (no 'name'): {raw[:200]}"
                    )
            except _json.JSONDecodeError as e:
                logger.warning(
                    f"[WindsurfAgent] Skipping unparseable tool_call JSON: {e} — {raw[:200]}"
                )

        clean_parts.append(text[last_end:])
        clean_text = "".join(clean_parts).strip()
        return clean_text, tool_calls

    async def _grpc_response_with_tools(
        self, prompt: str
    ) -> AsyncIterator[AgentMessage]:
        """Execute prompt via gRPC with text-based tool execution loop.

        The Windsurf language server (gRPC) does not support OpenAI function
        calling.  Instead we:
        1. Include tool definitions in the system prompt as structured text
        2. Parse ``<tool_call>`` XML blocks from the model's text response
        3. Execute tools locally via ``ToolExecutor``
        4. Feed results back as a new user message with ``<tool_result>`` tags
        5. Repeat until the model responds without tool calls (or max_turns)

        This consumes Windsurf credits because all inference goes through
        the local Windsurf IDE language server → Codeium cloud.
        """

        import asyncio as _asyncio

        from integrations.windsurf_proxy import grpc_client as _grpc_mod
        from integrations.windsurf_proxy.auth import (
            discover_credentials,
            invalidate_process_cache,
        )
        from integrations.windsurf_proxy.cascade_client import cascade_chat
        from integrations.windsurf_proxy.grpc_client import stream_chat
        from integrations.windsurf_proxy.models import requires_cascade, resolve_model

        model_enum, model_name = resolve_model(self.model)
        use_cascade = requires_cascade(self.model)

        # Build system prompt with tool definitions appended
        tool_prompt = self._build_tool_prompt_text()
        full_system_prompt = (self.system_prompt or "") + tool_prompt

        # Conversation history for multi-turn
        messages: list[dict[str, str]] = []
        if full_system_prompt:
            messages.append({"role": "system", "content": full_system_prompt})
        # If resume(history) was queued, inject the prior transcript so this
        # provider sees the same context the previous one had.
        self._consume_resumed_history_as_system_message(messages)
        messages.append({"role": "user", "content": prompt})

        logger.info(
            f"[WindsurfAgent] gRPC+tools: starting (model={self.model}, "
            f"tools={len(self._tool_definitions)}, prompt_len={len(prompt)})"
        )
        print(
            f"[WindsurfAgent] 🔌 gRPC request via local Windsurf IDE "
            f"(model={self.model}, {len(self._tool_definitions)} tools, "
            f"consumes Windsurf credits)",
            flush=True,
        )
        # Text mode keeps 8k chars of a tool result: the paging tools fit
        # their pages under that, instead of being cut in the middle.
        if self._tool_executor is not None:
            self._tool_executor.result_max_chars = 8000
        # Text mode reports no usage: the ledger stays empty rather than
        # holding the previous response's calls, so nothing downstream
        # measures this response against another one's numbers.
        self._start_usage_ledger()
        progress = ProgressTracker()

        for turn in range(self.max_turns):
            logger.info(
                f"[WindsurfAgent] gRPC turn {turn + 1}/{self.max_turns}: "
                f"sending {len(messages)} messages..."
            )

            # Send to Windsurf via gRPC — retry once with fresh credentials on Cascade session errors
            text_parts: list[str] = []
            turn_error: Exception | None = None
            for attempt in range(2):
                if attempt > 0:
                    # Invalidate process cache so discover_credentials() fetches a
                    # fresh CSRF token instead of returning the cached stale one.
                    logger.warning(
                        "[WindsurfAgent] Refreshing credentials before retry"
                    )
                    _grpc_mod._panel_initialized = False
                    invalidate_process_cache()
                    await _asyncio.sleep(1.5)
                    try:
                        self._credentials = discover_credentials()
                    except Exception as refresh_err:
                        logger.error(
                            f"[WindsurfAgent] Credential refresh failed: {refresh_err}"
                        )
                        break

                text_parts = []
                try:
                    if use_cascade:
                        # Cascade flattens the whole conversation into one
                        # text payload, so we pass the already-built messages
                        # list (incl. system prompt + tool preamble) and let
                        # cascade_chat stitch it server-side.
                        full = await cascade_chat(
                            credentials=self._credentials,
                            messages=messages,
                            model_enum=model_enum,
                            model_uid=model_name,
                        )
                        if full:
                            text_parts.append(full)
                    else:
                        async for chunk in stream_chat(
                            credentials=self._credentials,
                            messages=messages,
                            model_enum=model_enum,
                            model_name=model_name,
                            system_prompt=full_system_prompt,
                        ):
                            text_parts.append(chunk)
                    turn_error = None
                except Exception as e:
                    turn_error = e
                    err_str = str(e).lower()
                    if attempt == 0 and (
                        "failed_precondition" in err_str or "cascade session" in err_str
                    ):
                        logger.warning(
                            f"[WindsurfAgent] Cascade session error on turn {turn + 1}, retrying: {e}"
                        )
                        _grpc_mod._panel_initialized = False
                        continue
                    logger.error(
                        f"[WindsurfAgent] gRPC streaming error (turn {turn + 1}): {e}"
                    )
                    break

                # Windsurf sometimes returns the Cascade session error as HTTP 200 text.
                # Detect this and retry with fresh credentials (same as _grpc_response).
                if turn_error is None and attempt == 0:
                    partial_text = "".join(text_parts).lower()
                    if (
                        "failed_precondition" in partial_text
                        and "cascade session" in partial_text
                    ):
                        logger.warning(
                            f"[WindsurfAgent] Cascade session error in response text on turn {turn + 1}, "
                            "retrying with fresh credentials"
                        )
                        _grpc_mod._panel_initialized = False
                        invalidate_process_cache()
                        await _asyncio.sleep(1.5)
                        try:
                            self._credentials = discover_credentials()
                        except Exception as refresh_err:
                            logger.error(
                                f"[WindsurfAgent] Credential refresh failed: {refresh_err}"
                            )
                            break
                        continue  # retry with fresh credentials

                break  # success or non-retryable error

            if turn_error is not None:
                yield AgentMessage(
                    role=MessageRole.SYSTEM,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TEXT,
                            text=f"Windsurf gRPC error: {turn_error}",
                        )
                    ],
                )
                return

            full_text = "".join(text_parts)
            if not full_text:
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TEXT,
                            text="(Empty response from Windsurf)",
                        )
                    ],
                )
                return

            # Parse tool calls from text
            clean_text, tool_calls = self._parse_tool_calls_from_text(full_text)

            logger.info(
                f"[WindsurfAgent] gRPC turn {turn + 1}: "
                f"text_len={len(clean_text)}, tool_calls={len(tool_calls)}"
            )

            # Yield text content (the non-tool-call part)
            if clean_text:
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[ContentBlock(type=ContentBlockType.TEXT, text=clean_text)],
                )

            # No tool calls → done
            if not tool_calls:
                if not clean_text:
                    yield AgentMessage(
                        role=MessageRole.ASSISTANT,
                        content=[
                            ContentBlock(
                                type=ContentBlockType.TEXT,
                                text="(No response from Windsurf)",
                            )
                        ],
                    )
                logger.info(
                    f"[WindsurfAgent] gRPC session complete after {turn + 1} turn(s)"
                )
                return

            # Add assistant message to conversation history
            messages.append({"role": "assistant", "content": full_text})

            # Execute each tool call and collect results
            result_parts: list[str] = []
            turn_calls: list[tuple[str, Any, str]] = []
            for i, tc in enumerate(tool_calls):
                tool_name = tc["name"]
                tool_args = tc["arguments"]
                tool_id = f"grpc_{turn}_{i}_{tool_name}"

                logger.info(
                    f"[WindsurfAgent] gRPC turn {turn + 1}: "
                    f"tool_call {tool_name}({list(tool_args.keys())})"
                )
                print(f"[WindsurfAgent] 🔧 Tool: {tool_name}", flush=True)

                # Yield TOOL_USE block
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TOOL_USE,
                            tool_name=tool_name,
                            tool_id=tool_id,
                            tool_input=tool_args,
                        )
                    ],
                )

                # Execute tool
                result_text = ""
                is_error = False
                try:
                    result = await self._tool_executor.execute(tool_name, tool_args)
                    result_text = str(result) if result is not None else ""
                except Exception as e:
                    result_text = f"Error: {e}"
                    is_error = True
                    logger.warning(f"[WindsurfAgent] Tool {tool_name} failed: {e}")

                # Yield TOOL_RESULT block
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TOOL_RESULT,
                            tool_use_id=tool_id,
                            is_error=is_error,
                            result_content=result_text,
                        )
                    ],
                )

                # Format result for next gRPC message (head+tail truncation —
                # build/test verdicts sit at the END of the output)
                status = "error" if is_error else "success"
                truncated = truncate_tool_result(result_text, limit=8000)
                result_parts.append(
                    f'<tool_result name="{tool_name}" status="{status}">\n'
                    f"{truncated}\n"
                    f"</tool_result>"
                )
                turn_calls.append((tool_name, tool_args, result_text))

            # Add tool results as a user message for the next turn
            results_message = "\n\n".join(result_parts)
            messages.append({"role": "user", "content": results_message})

            stop = self._check_progress(progress, turn_calls, messages)
            if stop is not None:
                yield stop
                return

            # Elide stale tool results once the conversation exceeds the char
            # budget (text-mode results are user messages starting with
            # <tool_result — compact_messages handles both shapes).
            compacted = compact_messages(messages)
            if compacted:
                logger.info(
                    f"[WindsurfAgent] History compaction: elided {compacted} "
                    "stale tool result(s)"
                )

            # Continue loop — next turn sends updated conversation

        logger.warning(
            f"[WindsurfAgent] gRPC reached max_turns ({self.max_turns}) — stopping"
        )
        print(
            f"[WindsurfAgent] ⚠️ Reached max turns ({self.max_turns})",
            flush=True,
        )

    # =================================================================
    # REST mode (OpenAI-compatible function calling)
    # =================================================================

    def _get_openai_tools(self) -> list[dict[str, Any]]:
        """Convert internal tool definitions to OpenAI function calling format."""
        if not self._tool_definitions:
            return []
        return [
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

    def _ensure_http_client(self):
        """Lazy-init an aiohttp ClientSession for REST mode."""
        if self._http_client is None:
            try:
                import aiohttp
            except ImportError:
                raise ImportError(
                    "aiohttp is required for WindsurfAgentClient REST mode. "
                    "Install with: pip install aiohttp"
                )
            self._http_client = aiohttp.ClientSession(
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Content-Type": CONTENT_TYPE_JSON,
                    "Accept": CONTENT_TYPE_JSON,
                }
            )
        return self._http_client

    async def _rest_response_with_tools(
        self, prompt: str
    ) -> AsyncIterator[AgentMessage]:
        """Execute prompt via REST API with full tool execution loop.

        Implements OpenAI-compatible function calling:
        1. Send messages + tool definitions to API
        2. If response contains tool_calls → execute each tool, add results, continue
        3. If no tool_calls → yield final text response and stop
        4. Repeat up to max_turns
        """
        import json as _json

        session = self._ensure_http_client()

        messages: list[dict[str, Any]] = []
        if self.system_prompt:
            messages.append({"role": "system", "content": self.system_prompt})
        # If resume(history) was queued, inject the prior transcript so this
        # provider sees the same context the previous one had.
        self._consume_resumed_history_as_system_message(messages)
        messages.append({"role": "user", "content": prompt})

        tools = self._get_openai_tools()
        url = f"{self._rest_base_url}/chat/completions"

        # Log initial request details for debugging (no key material)
        logger.info(
            "[WindsurfAgent] REST request: url=%s, model=%s, tools=%d, prompt_len=%d, key_present=%s",
            url,
            self.model,
            len(tools),
            len(prompt),
            bool(self._api_key),
        )
        print(
            f"[WindsurfAgent] Sending REST API request to {url} "
            f"(model={self.model}, {len(tools)} tools)",
            flush=True,
        )

        _ws_total_in = 0
        _ws_total_out = 0
        self._start_usage_ledger()
        progress = ProgressTracker()

        for turn in range(self.max_turns):
            payload: dict[str, Any] = {
                "model": self.model,
                "messages": messages,
                "stream": False,
            }
            if tools:
                payload["tools"] = tools
                payload["tool_choice"] = "auto"

            logger.info(
                f"[WindsurfAgent] Turn {turn + 1}/{self.max_turns}: "
                f"sending {len(messages)} messages to API..."
            )

            # ----------------------------------------------------------
            # URL probing:  On the first request, try each base URL in
            # turn until one returns a non-404/non-502 status.  Once a
            # working URL is found it is cached for subsequent turns.
            # ----------------------------------------------------------
            urls_to_try: list[str]
            if not self._rest_url_probed:
                urls_to_try = [
                    f"{base}/chat/completions" for base in self._rest_base_urls
                ]
            else:
                urls_to_try = [url]

            data: dict[str, Any] | None = None
            last_error_status: int = 0
            last_error_text: str = ""

            for try_url in urls_to_try:
                try:
                    async with session.post(try_url, json=payload) as resp:
                        resp_status = resp.status
                        if resp_status == 200:
                            data = await resp.json()
                            # Cache the working base URL
                            if not self._rest_url_probed:
                                base = try_url.removesuffix("/chat/completions")
                                self._rest_base_url = base
                                url = try_url
                                self._rest_url_probed = True
                                logger.info(
                                    f"[WindsurfAgent] ✅ Found working endpoint: {try_url}"
                                )
                                print(
                                    f"[WindsurfAgent] ✅ Working endpoint: {try_url}",
                                    flush=True,
                                )
                            break  # success
                        else:
                            error_text = await resp.text()
                            logger.warning(
                                f"[WindsurfAgent] Endpoint {try_url} returned HTTP {resp_status}: {error_text[:200]}"
                            )
                            last_error_status = resp_status
                            last_error_text = error_text
                            # 404/502 → try next URL; other errors → stop probing
                            if resp_status not in (404, 502, 503):
                                break
                except Exception as probe_err:
                    logger.warning(
                        f"[WindsurfAgent] Endpoint {try_url} failed: {probe_err}"
                    )
                    last_error_status = 0
                    last_error_text = str(probe_err)

            if data is None:
                # All URLs failed
                self._rest_url_probed = True  # don't re-probe
                error_msg = (
                    f"Windsurf REST API error ({last_error_status}): {last_error_text}"
                    if last_error_status
                    else f"Windsurf REST API error: {last_error_text}"
                )
                logger.error(f"[WindsurfAgent] {error_msg}")
                print(
                    f"[WindsurfAgent] ❌ All endpoints failed: {error_msg[:200]}",
                    flush=True,
                )
                yield AgentMessage(
                    role=MessageRole.SYSTEM,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TEXT,
                            text=error_msg,
                        )
                    ],
                )
                return

            logger.info(
                f"[WindsurfAgent] Turn {turn + 1}: API responded 200 OK "
                f"(keys={list(data.keys())})"
            )

            # Parse usage from response (for logging and cost tracking)
            usage = data.get("usage", {})
            if usage:
                logger.info(
                    f"[WindsurfAgent] Token usage: "
                    f"prompt={usage.get('prompt_tokens', '?')}, "
                    f"completion={usage.get('completion_tokens', '?')}, "
                    f"total={usage.get('total_tokens', '?')}"
                )
                _ws_total_in += usage.get("prompt_tokens", 0)
                _ws_total_out += usage.get("completion_tokens", 0)
                if usage.get("prompt_tokens"):
                    self.last_context_tokens = int(usage["prompt_tokens"])
                self._record_call(from_chat_completion(usage))

            choices = data.get("choices", [])
            if not choices:
                logger.warning(f"[WindsurfAgent] Empty choices in response: {data}")
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TEXT,
                            text="(Empty response from Windsurf REST API)",
                        )
                    ],
                )
                return

            message = choices[0].get("message", {})
            content = message.get("content", "")
            tool_calls = message.get("tool_calls", [])
            finish_reason = choices[0].get("finish_reason", "")

            logger.info(
                f"[WindsurfAgent] Turn {turn + 1}: "
                f"content_len={len(content or '')}, "
                f"tool_calls={len(tool_calls)}, "
                f"finish_reason={finish_reason}"
            )

            # Yield text content if present
            if content:
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[ContentBlock(type=ContentBlockType.TEXT, text=content)],
                )

            # No tool calls → done
            if not tool_calls:
                if not content:
                    yield AgentMessage(
                        role=MessageRole.ASSISTANT,
                        content=[
                            ContentBlock(
                                type=ContentBlockType.TEXT,
                                text="(No response from Windsurf)",
                            )
                        ],
                    )
                logger.info(
                    f"[WindsurfAgent] Session complete after {turn + 1} turn(s) "
                    f"(finish_reason={finish_reason})"
                )
                # Windsurf uses credits (not per-token billing) — store tokens, cost=0
                self.last_usage = {
                    "input_tokens": _ws_total_in,
                    "output_tokens": _ws_total_out,
                    "cost_usd": 0.0,
                }
                return

            # Add assistant message (with tool_calls) to conversation history
            assistant_msg: dict[str, Any] = {"role": "assistant"}
            if content:
                assistant_msg["content"] = content
            assistant_msg["tool_calls"] = tool_calls
            messages.append(assistant_msg)

            # Execute each tool call
            turn_calls: list[tuple[str, Any, str]] = []
            for tc in tool_calls:
                func = tc.get("function", {})
                tool_name = func.get("name", "")
                tool_id = tc.get("id", f"call_{turn}_{tool_name}")

                try:
                    args = _json.loads(func.get("arguments", "{}"))
                except (_json.JSONDecodeError, TypeError):
                    args = {}

                logger.info(
                    f"[WindsurfAgent] Turn {turn + 1}: tool_call {tool_name}({list(args.keys())})"
                )
                print(f"[WindsurfAgent] 🔧 Tool: {tool_name}", flush=True)

                # Yield TOOL_USE block so session handler counts it
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TOOL_USE,
                            tool_name=tool_name,
                            tool_id=tool_id,
                            tool_input=args,
                        )
                    ],
                )

                # Execute tool
                result_text = ""
                is_error = False
                if self._tool_executor:
                    try:
                        result = await self._tool_executor.execute(tool_name, args)
                        result_text = str(result) if result is not None else ""
                    except Exception as e:
                        result_text = f"Tool error: {e}"
                        is_error = True
                        logger.warning(f"[WindsurfAgent] Tool {tool_name} failed: {e}")
                else:
                    result_text = "Tool executor not available (no project_dir)"
                    is_error = True

                # Yield TOOL_RESULT block so session handler logs it
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TOOL_RESULT,
                            tool_use_id=tool_id,
                            is_error=is_error,
                            result_content=result_text,
                        )
                    ],
                )

                # Add tool result to conversation for next API call (head+tail
                # truncation — build/test verdicts sit at the END of the output)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_id,
                        "content": truncate_tool_result(result_text),
                    }
                )
                turn_calls.append((tool_name, args, result_text))

            stop = self._check_progress(progress, turn_calls, messages)
            if stop is not None:
                yield stop
                break

            # Elide stale tool results once the conversation exceeds the char
            # budget (no-op below budget, preserving the cacheable prefix).
            compacted = compact_messages(messages)
            if compacted:
                logger.info(
                    f"[WindsurfAgent] History compaction: elided {compacted} "
                    "stale tool result(s)"
                )

            # Continue loop — next turn will send updated messages with tool results
        else:
            logger.warning(
                f"[WindsurfAgent] Reached max_turns ({self.max_turns}) — stopping tool loop"
            )
            print(
                f"[WindsurfAgent] ⚠️ Reached max turns ({self.max_turns})",
                flush=True,
            )
        self.last_usage = {
            "input_tokens": _ws_total_in,
            "output_tokens": _ws_total_out,
            "cost_usd": 0.0,
        }

    def supports_subagents(self) -> bool:
        return False

    def provider_name(self) -> str:
        return "windsurf"
