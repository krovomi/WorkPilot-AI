"""
Abstract Agent Client Interface
================================

Provides a provider-agnostic abstraction layer over agent execution backends.
This enables transparent switching between Claude Agent SDK and GitHub Copilot
without altering the Kanban task processing pipeline.

Architecture (one module per provider under ``core/agent_clients/``):
    AgentClient (ABC)                       base.py
    ├── ClaudeAgentClient                   claude.py — wraps ClaudeSDKClient
    ├── CopilotAgentClient                  copilot.py — GitHub Copilot Models API
    ├── WindsurfAgentClient                 windsurf.py
    ├── OpenAIAgentClient                   openai.py — chat completions
    │   ├── GoogleAgentClient               google.py
    │   ├── CompatibleProviderAgentClient   compatible.py
    │   └── LocalAgentClient                local.py — Ollama, LM Studio…
    └── CliSubprocessAgentClient            cli_subprocess.py — a coding-agent CLI
        ├── OpenCodeCliAgentClient          opencode_cli.py — `opencode run`
        ├── PiCliAgentClient                pi_cli.py — `pi --mode json`
        ├── AcpAgentClient                  acp.py — any Agent Client Protocol agent
        └── AntigravityCliAgentClient       antigravity_cli.py — `agy` print mode

Usage:
    from core.agent_client import create_agent_client

    client = create_agent_client(
        provider="claude",  # or "copilot"
        project_dir=project_dir,
        spec_dir=spec_dir,
        model=model,
        agent_type="coder",
    )

    async with client:
        await client.query("Implement the feature")
        async for msg in client.receive_response():
            ...
"""

from __future__ import annotations

from .agent_clients.acp import (  # noqa: F401
    AcpAgentClient,
    AcpAuthenticationError,
    AcpError,
)
from .agent_clients.antigravity_cli import (  # noqa: F401
    AntigravityCliAgentClient,
    AntigravityCliAuthenticationError,
    AntigravityCliError,
)

# Every adapter moved to `core/agent_clients/<provider>.py` (audit lot L11, F36).
# Re-exported here, private names included, so the module keeps its whole
# surface while callers migrate. A test that monkeypatches a module constant
# (`_LOCAL_HEARTBEAT_SECONDS`, `_COPILOT_RATE_LIMIT_BACKOFF`) patches the
# provider module that reads it.
from .agent_clients.base import (  # noqa: F401
    _FILE_WRITE_TOOL_NAMES,
    _REQUIRED_OUTPUT_FILE,
    _WRITE_NUDGE_TURNS_REMAINING,
    CONTENT_TYPE_JSON,
    AgentClient,
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
    SubagentDefinition,
    _env_flag,
    _env_float,
    _parse_retry_after,
    _required_output,
)
from .agent_clients.claude import (  # noqa: F401
    ClaudeAgentClient,
)
from .agent_clients.compatible import (  # noqa: F401
    CompatibleProviderAgentClient,
)
from .agent_clients.copilot import (  # noqa: F401
    _COPILOT_DEFAULT_FALLBACK_MODEL,
    _COPILOT_EMPTY_RESPONSE_BACKOFF,
    _COPILOT_HISTORY_CHAR_LIMIT,
    _COPILOT_HISTORY_CHAR_LIMIT_DEFAULT,
    _COPILOT_MAX_CONSECUTIVE_EMPTY_RESPONSES,
    _COPILOT_MAX_CONSECUTIVE_EMPTY_TOOL_CALLS,
    _COPILOT_RATE_LIMIT_BACKOFF,
    _COPILOT_RATE_LIMIT_MAX_BACKOFF,
    _COPILOT_RATE_LIMIT_MAX_RETRIES,
    _COPILOT_REQUEST_CONNECT_TIMEOUT,
    _COPILOT_REQUEST_MAX_RETRIES,
    _COPILOT_REQUEST_RETRY_BACKOFF,
    _COPILOT_REQUEST_SOCK_READ_TIMEOUT,
    _COPILOT_REQUEST_TOTAL_TIMEOUT,
    _COPILOT_RETRYABLE_STATUSES,
    _COPILOT_TIMEOUT_MAX_RETRIES,
    _COPILOT_VERSIONED_MODEL_RE,
    CopilotAgentClient,
    _copilot_fallback_model,
    _normalize_copilot_model_id,
)
from .agent_clients.google import (  # noqa: F401
    GoogleAgentClient,
)
from .agent_clients.local import (  # noqa: F401
    _LOCAL_CHAT_CONNECT_TIMEOUT,
    _LOCAL_CHAT_SOCK_READ_TIMEOUT,
    _LOCAL_HEARTBEAT_SECONDS,
    _LOCAL_MAX_CONNECT_RETRIES,
    _LOCAL_NOT_LOADED_GRACE,
    _LOCAL_NUM_CTX_DEFAULT_CAP,
    _LOCAL_NUM_CTX_REPLY_HEADROOM,
    _LOCAL_STALL_SECONDS,
    _TOOL_USE_NUDGE,
    _UNSET,
    _WAITING_FOR_HUMAN_RE,
    LocalAgentClient,
    LocalModelRuntimeError,
    _balanced_json_objects,
    _canonical_local_model,
    _extract_text_tool_calls,
    _force_ipv4_loopback,
    _format_bytes_fr,
    _format_duration_fr,
    _format_generation_progress,
    _format_not_loaded_diagnosis,
    _format_placement_diagnosis,
    _looks_like_waiting_for_human,
    _merge_native_chunk,
    _next_no_tool_action,
    _normalize_local_base_url,
    _normalize_text_tool_call,
    _resolve_local_base_url,
)
from .agent_clients.openai import (  # noqa: F401
    OpenAIAgentClient,
    _openai_cost_usd,
)
from .agent_clients.opencode_cli import (  # noqa: F401
    OpenCodeCliAgentClient,
    OpenCodeCliAuthenticationError,
    OpenCodeCliError,
)
from .agent_clients.pi_cli import (  # noqa: F401
    PiCliAgentClient,
    PiCliAuthenticationError,
    PiCliError,
)
from .agent_clients.windsurf import (  # noqa: F401
    WindsurfAgentClient,
)
