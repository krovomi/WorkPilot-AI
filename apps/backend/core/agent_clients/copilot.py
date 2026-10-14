"""`CopilotAgentClient` — the GitHub Copilot Models API (OpenAI-compatible),
with its model-id normalisation, history limits, timeouts and retry policy.

Split out of `core/agent_client.py` (audit lot L11, F36), which re-exports
every name defined here.
"""

from __future__ import annotations

import logging
import re
from collections.abc import AsyncIterator
from typing import Any

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
    _FILE_WRITE_TOOL_NAMES,
    _WRITE_NUDGE_TURNS_REMAINING,
    CONTENT_TYPE_JSON,
    AgentClient,
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
    SubagentDefinition,
    _env_float,
    _parse_retry_after,
    _required_output,
)

# The name the monolith logged under, kept so logging configuration and log
# filters keyed on it still match: `core.agent_client`, or
# `apps.backend.core.agent_client` under the repo-root layout.
logger = logging.getLogger(__name__.rpartition(".agent_clients.")[0] + ".agent_client")

# Copilot API enforces a prompt token limit that varies by model.
# These are safe upper bounds (in characters, ≈ 4 chars/token) for the
# history preamble injected on provider switch.  We leave ~20 % headroom
# for the system prompt, tool definitions, and user message.
# Key: Copilot model id as used in the API payload.
_COPILOT_HISTORY_CHAR_LIMIT: dict[str, int] = {
    # 1 M-token models — generous budget
    "gpt-4.1": 2_000_000,
    "gemini-2.5-pro": 2_000_000,
    # 200 k-token models (Claude 4.x, o-series) — 160 k token budget
    "claude-opus-4.8": 640_000,
    "claude-opus-4.7": 640_000,
    "claude-opus-4.6": 640_000,
    "claude-opus-4.5": 640_000,
    "claude-sonnet-4.6": 640_000,
    "claude-sonnet-4.5": 640_000,
    "claude-3.7-sonnet": 640_000,
    "o1": 640_000,
    "o3": 640_000,
    "o3-mini": 640_000,
    "o4-mini": 640_000,
    # GPT-5.x — assume 200 k by default
    "gpt-5.5": 640_000,
    "gpt-5.4": 640_000,
    # 128 k-token models — 100 k token budget
    "gpt-4o": 400_000,
    "gpt-4o-mini": 400_000,
    "gpt-4.1-mini": 400_000,
    "claude-haiku-4.5": 400_000,
    "gemini-2.0-flash": 400_000,
    "o1-mini": 400_000,
}
# Default for unknown Copilot models: 100 k tokens (~400 k chars)
_COPILOT_HISTORY_CHAR_LIMIT_DEFAULT = 400_000

# L'API GitHub Copilot exige la notation pointée pour les modèles Claude
# (ex. "claude-sonnet-4.5"). Les identifiants au format natif Anthropic,
# versionnés par tirets (ex. "claude-sonnet-4-5-20250929", "claude-opus-4-6"),
# sont rejetés avec « 400 model_not_supported ». Cette regex capture la famille
# et la version pour reconstruire la forme pointée attendue par Copilot.
_COPILOT_VERSIONED_MODEL_RE = re.compile(
    r"^(claude-(?:opus|sonnet|haiku))-(\d+)-(\d+)(?:-\d+)?$"
)

# Modèle Copilot de repli largement disponible, utilisé lorsqu'un modèle reste
# rejeté après normalisation (ex. un flagship pas encore servi par le plan
# Copilot de l'utilisateur, comme "claude-opus-4.8").
_COPILOT_DEFAULT_FALLBACK_MODEL = "claude-sonnet-4.5"


def _normalize_copilot_model_id(model: str | None) -> str | None:
    """Convertit un id Claude au format natif Anthropic vers la notation Copilot.

    L'API Copilot utilise la notation pointée (``claude-sonnet-4.5``) alors que
    les tâches peuvent transporter l'id natif Anthropic versionné par tirets
    (``claude-sonnet-4-5-20250929``), que Copilot rejette avec
    ``400 model_not_supported``. La date de version éventuelle est supprimée.

    Les identifiants déjà au bon format (point) ou non-Claude sont renvoyés tels
    quels. Reflète le comportement de ``phase_config._resolve_provider_model``.
    """
    if not model:
        return model
    match = _COPILOT_VERSIONED_MODEL_RE.match(model)
    if match:
        family, major, minor = match.group(1), match.group(2), match.group(3)
        return f"{family}-{major}.{minor}"
    return model


def _copilot_fallback_model(model: str) -> str:
    """Retourne un modèle Copilot de repli quand ``model`` est rejeté (400).

    Tente d'abord la normalisation tirets→point (qui récupère l'intention du
    modèle d'origine) ; si l'id est déjà au format pointé mais reste non
    supporté, bascule vers un modèle Copilot par défaut.
    """
    normalized = _normalize_copilot_model_id(model)
    if normalized and normalized != model:
        return normalized
    return _COPILOT_DEFAULT_FALLBACK_MODEL


# Per-request HTTP timeouts for the Copilot chat-completions call. Without an
# explicit timeout a genuinely hung response freezes the whole agent loop
# (the socket stays open, no bytes arrive), which surfaces as a build that is
# "stuck and never restarts" and a frozen frontend.
#
# CRITICAL: these requests are sent with ``stream: False``. A non-streaming
# completion sends NO bytes until the ENTIRE response has been generated, so
# ``sock_read`` measures the full generation time — NOT connection liveness.
# A reasoning model (e.g. Opus 4.8 with "Ultra Think") working over a large
# prompt legitimately produces no bytes for several minutes; a tight 90 s
# ``sock_read`` therefore kills healthy slow turns. The symptom: a turn that
# takes >90 s to generate is aborted, retried ~4× (≈6 min of invisible
# stalls), then the phase loops and repeats — the task "seems blocked".
#
# The values below must accommodate the slowest expected SINGLE-TURN
# generation while still eventually catching a truly dead socket. They are
# env-overridable so operators can widen them further for very slow models.
_COPILOT_REQUEST_TOTAL_TIMEOUT = _env_float("COPILOT_REQUEST_TOTAL_TIMEOUT", 600.0)
_COPILOT_REQUEST_CONNECT_TIMEOUT = _env_float("COPILOT_REQUEST_CONNECT_TIMEOUT", 20.0)
# Silence-between-reads guard. For non-streaming requests this is effectively
# "max time the model may take to produce the whole completion". Kept slightly
# below ``total`` so a stall is attributed to read-silence (clearer logs)
# rather than the overall ceiling.
_COPILOT_REQUEST_SOCK_READ_TIMEOUT = _env_float(
    "COPILOT_REQUEST_SOCK_READ_TIMEOUT", 540.0
)
# A transient CONNECTION error (reset/disconnect/DNS) is cheap to retry — it
# usually fails within seconds — so we retry it several times before failing.
_COPILOT_REQUEST_MAX_RETRIES = 3
# A full-duration TIMEOUT is different: the server held the connection open for
# the entire (now generous) ceiling without completing. Retrying the identical
# payload rarely helps and each retry costs another full ceiling, so cap timeout
# retries to bound the worst-case "stuck" window (2 retries → at most 3 ×
# ceiling before the turn surfaces an error instead of looping invisibly).
_COPILOT_TIMEOUT_MAX_RETRIES = int(_env_float("COPILOT_TIMEOUT_MAX_RETRIES", 2))
# Base back-off (seconds) between retries; grows linearly per attempt.
_COPILOT_REQUEST_RETRY_BACKOFF = 2.0

# HTTP statuses that are TRANSIENT and should be ridden out with a back-off
# retry instead of aborting the turn:
#   * 429 — GitHub Copilot enforces a per-MINUTE request-rate limit that is
#     entirely separate from the token/usage quota. Bursting subtasks (the loop
#     auto-continues every few seconds) can trip it even when plenty of tokens
#     remain — exactly the "I still have tokens but get 429" symptom. The right
#     answer is to wait the short reset window (honouring ``Retry-After`` when
#     present) and retry, NOT to surface an error and burn an attempt.
#   * 500/502/503/529 — momentary server-side hiccups that usually clear on the
#     next request.
_COPILOT_RETRYABLE_STATUSES = frozenset({429, 500, 502, 503, 529})
# How many times to retry a transient/rate-limited response before giving up.
# Generous because a per-minute window can need several short waits to clear.
_COPILOT_RATE_LIMIT_MAX_RETRIES = int(_env_float("COPILOT_RATE_LIMIT_MAX_RETRIES", 6))
# Base back-off (seconds) when the server does NOT send a ``Retry-After``
# header; grows exponentially per attempt, capped by the MAX below.
_COPILOT_RATE_LIMIT_BACKOFF = _env_float("COPILOT_RATE_LIMIT_BACKOFF", 5.0)
# Upper bound (seconds) for a single rate-limit back-off wait, whether derived
# from ``Retry-After`` or exponential growth. Keeps the worst-case stall sane.
_COPILOT_RATE_LIMIT_MAX_BACKOFF = _env_float("COPILOT_RATE_LIMIT_MAX_BACKOFF", 60.0)

# Claude served through the OpenAI-compatible Copilot API occasionally returns
# ``finish_reason=tool_calls`` with an EMPTY ``tool_calls`` array — the model
# "intended" to call a tool but no call materialised. We re-prompt ("nudge") and
# retry, which normally recovers on the next turn. This caps the number of
# CONSECUTIVE empty re-samples so a pathological model that never emits a real
# tool call can no longer burn the entire turn budget spinning in place. The
# counter resets to zero as soon as a turn produces actual work (a tool call or
# a genuine stop), so legitimate intermittent empties never trip it.
_COPILOT_MAX_CONSECUTIVE_EMPTY_TOOL_CALLS = 5

# The Copilot API occasionally returns a 200 response whose ``choices`` array is
# EMPTY — no message, no tool call, nothing. This is almost always a transient
# server-side hiccup (rate limiting, content filtering, a momentary glitch)
# rather than a real "the model is done" signal. Previously a single empty
# response ended the whole session ("(Empty response from Copilot)"), aborting
# the phase mid-cycle. Instead we re-issue the same turn after a short back-off,
# up to this many CONSECUTIVE times, before finally giving up. The counter
# resets to zero as soon as a turn returns a usable response, so isolated
# empties never accumulate toward the cap.
_COPILOT_MAX_CONSECUTIVE_EMPTY_RESPONSES = int(
    _env_float("COPILOT_MAX_CONSECUTIVE_EMPTY_RESPONSES", 4)
)
# Base back-off (seconds) between empty-response re-samples; grows linearly.
_COPILOT_EMPTY_RESPONSE_BACKOFF = _env_float("COPILOT_EMPTY_RESPONSE_BACKOFF", 2.0)


# =============================================================================
# Copilot Agent Client — uses GitHub Copilot Models API
# =============================================================================


class CopilotAgentClient(AgentClient):
    """Agent client backed by GitHub Copilot API.

    Authentication flow (two-step):
    1. Exchange a GitHub OAuth token (ghu_... / ghp_...) for a short-lived
       Copilot session token via:
           GET https://api.github.com/copilot_internal/v2/token
    2. Use that session token as Bearer auth against:
           POST https://api.githubcopilot.com/chat/completions

    The session token expires roughly every 30 minutes and is refreshed
    automatically before each request.

    Required IDE headers (enforced by GitHub, missing → 400/421):
        editor-version, editor-plugin-version, Copilot-Integration-Id,
        openai-intent, user-agent, x-github-api-version

    Sub-agent Strategy:
    When sub-agents are defined, CopilotAgentClient spawns parallel
    asyncio tasks — each making its own chat/completions call with
    the sub-agent's specialized system prompt. Results are collected
    and injected back into the orchestrator's context as tool results.
    """

    # IDE impersonation headers — required by the Copilot API gateway.
    # Omitting any of these causes 400 / 421 errors on Copilot Enterprise.
    # Versions verified against working open-source implementations (2025).
    _IDE_HEADERS = {
        "editor-version": "vscode/1.104.3",
        "editor-plugin-version": "copilot-chat/0.26.7",
        "user-agent": "GitHubCopilotChat/0.26.7",
        "x-vscode-user-agent-library-version": "electron-fetch",
    }

    def __init__(
        self,
        model: str = "gpt-4o",
        system_prompt: str | None = None,
        allowed_tools: list[str] | None = None,
        agents: dict[str, SubagentDefinition] | None = None,
        cwd: str | None = None,
        max_turns: int = 50,
        github_token: str | None = None,
        agent_type: str = "coder",
        spec_dir: str | None = None,
    ):
        import os

        self.model = _normalize_copilot_model_id(model) or "gpt-4o"
        # See OpenAIAgentClient: only for the watermark ledger's spec directory.
        self._spec_dir = spec_dir
        self.system_prompt = system_prompt
        self.allowed_tools = allowed_tools or []
        self.agents = agents or {}
        self.cwd = cwd
        self.max_turns = max_turns
        self._agent_type = agent_type
        self.github_token = (
            github_token
            or os.environ.get("GITHUB_TOKEN", "")
            or self._get_github_token_from_cli()
        )

        # Real Copilot chat endpoint (not api.github.com)
        self._api_base = "https://api.githubcopilot.com/chat/completions"
        # Fallback: GitHub Models API (works when org blocks api.githubcopilot.com)
        self._github_models_api_base = (
            "https://models.inference.ai.azure.com/chat/completions"
        )
        # Token-exchange endpoint: GitHub token → short-lived Copilot session token
        self._token_exchange_url = "https://api.github.com/copilot_internal/v2/token"
        # Whether we've fallen back to GitHub Models API
        self._using_github_models = False

        self._messages: list[dict[str, Any]] = []
        self._pending_query: str | None = None
        self._http_client: Any = None
        self._tool_executor: Any = None
        self._tool_definitions: list[dict[str, Any]] = []

        # Copilot session token cache (expires ~30 min)
        self._copilot_token: str = ""
        self._copilot_token_expires_at: float = 0.0
        # Usage tracking (Copilot API doesn't expose token counts — subscription-based)
        self.last_usage: dict | None = None
        # Context fill of the latest turn (prompt tokens the provider reported),
        # read by context_mgmt's guard; None until a turn reports it.
        self.last_context_tokens: int | None = None
        self.context_window_tokens: int | None = None
        self.context_usage_source = "reported"

    @staticmethod
    def _get_github_token_from_cli() -> str:
        """Attempt to retrieve a GitHub token via `gh auth token` (GitHub CLI).

        The frontend passes SELECTED_LLM_PROVIDER=copilot but does not inject
        GITHUB_TOKEN into the subprocess environment because Copilot auth is
        managed by the GitHub CLI (`gh`). This fallback calls `gh auth token`
        to obtain the current OAuth token so the Copilot session-token exchange
        can proceed without any manual token configuration.

        Returns an empty string if `gh` is unavailable or not authenticated.
        """
        import os
        import shutil
        import subprocess

        # Prefer GITHUB_CLI_PATH set by the Electron frontend (handles Windows where
        # the subprocess PATH may not include the user's `gh` installation).
        gh_exe = os.environ.get("GITHUB_CLI_PATH") or shutil.which("gh")
        if not gh_exe:
            logger.warning(
                "[CopilotAgentClient] `gh` CLI not found on PATH or GITHUB_CLI_PATH. "
                "Install GitHub CLI and run `gh auth login` to enable Copilot."
            )
            return ""

        try:
            result = subprocess.run(
                [gh_exe, "auth", "token", "--hostname", "github.com"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            token = result.stdout.strip()
            if result.returncode == 0 and token:
                # Check that the token has the 'copilot' scope.
                # gh auth status shows scopes like: Token scopes: 'gist', 'repo', 'copilot'
                # Without the copilot scope the token exchange endpoint returns 404.
                try:
                    status_result = subprocess.run(
                        [gh_exe, "auth", "status", "--hostname", "github.com"],
                        capture_output=True,
                        text=True,
                        timeout=10,
                    )
                    status_output = (
                        status_result.stdout + status_result.stderr
                    ).lower()
                    if (
                        "token scopes" in status_output
                        and "'copilot'" not in status_output
                    ):
                        logger.warning(
                            "[CopilotAgentClient] GitHub token is missing the 'copilot' scope. "
                            "Run: gh auth refresh -s copilot --hostname github.com"
                        )
                        print(
                            "[CopilotAgentClient] ⚠️  GitHub token missing 'copilot' scope. "
                            "Fix: gh auth refresh -s copilot --hostname github.com",
                            flush=True,
                        )
                except Exception:
                    pass  # scope check is best-effort; proceed anyway

                logger.info(
                    "[CopilotAgentClient] Retrieved GitHub token via `gh auth token`"
                )
                return token
            else:
                stderr = result.stderr.strip()
                logger.warning(
                    "[CopilotAgentClient] `gh auth token` returned no token "
                    "(exit %d, stderr: %s). Run `gh auth login` first.",
                    result.returncode,
                    stderr or "(none)",
                )
                return ""
        except Exception as exc:
            logger.warning(
                "[CopilotAgentClient] Failed to call `gh auth token`: %s", exc
            )
            return ""

    def _get_http_client(self):
        """Lazy-init an aiohttp ClientSession with shared IDE headers."""
        if self._http_client is None:
            try:
                import aiohttp

                # Explicit timeout so a hung/stalled response is detected and
                # retried instead of freezing the agent loop indefinitely.
                timeout = aiohttp.ClientTimeout(
                    total=_COPILOT_REQUEST_TOTAL_TIMEOUT,
                    sock_connect=_COPILOT_REQUEST_CONNECT_TIMEOUT,
                    sock_read=_COPILOT_REQUEST_SOCK_READ_TIMEOUT,
                )
                # Authorization is injected per-request (token refreshes)
                self._http_client = aiohttp.ClientSession(
                    timeout=timeout,
                    headers={
                        "Content-Type": CONTENT_TYPE_JSON,
                        "Accept": CONTENT_TYPE_JSON,
                        **self._IDE_HEADERS,
                    },
                )
            except ImportError:
                raise ImportError(
                    "aiohttp is required for CopilotAgentClient. "
                    "Install it with: pip install aiohttp"
                )
        return self._http_client

    async def _get_copilot_token(self) -> str:
        """Return a valid Copilot session token, refreshing if needed.

        Two-path authentication:
        1. (Preferred) Exchange a GitHub OAuth token at copilot_internal/v2/token
           for a short-lived session token (~30 min TTL).
        2. (Fallback) Some Copilot Business/Enterprise accounts managed by an
           organisation have the token-exchange endpoint restricted (returns 404).
           In that case the raw GitHub OAuth token (gho_…) is accepted directly
           as a Bearer token by api.githubcopilot.com.  We cache this as the
           "session token" with a 30-minute TTL to match normal behaviour.
        """
        import time

        # Return cached token if still valid (60-second safety buffer)
        if self._copilot_token and time.time() < self._copilot_token_expires_at - 60:
            return self._copilot_token

        import aiohttp

        if not self.github_token:
            raise ValueError(
                "Copilot auth error: No GitHub token available. "
                "Run `gh auth login` and ensure GitHub CLI is installed."
            )

        # Warn if token looks like a classic PAT (ghp_) — these do NOT work with
        # the Copilot internal API. Only OAuth tokens (gho_) are accepted.
        if self.github_token.startswith("ghp_"):
            logger.warning(
                "[CopilotAgentClient] Token appears to be a classic PAT (ghp_). "
                "The Copilot API requires an OAuth token (gho_). "
                "Re-authenticate with: gh auth login --web"
            )
            print(
                "[CopilotAgentClient] ⚠️  Classic PAT detected (ghp_). "
                "Copilot requires OAuth token (gho_). Fix: gh auth login --web",
                flush=True,
            )

        exchange_headers = {
            "Authorization": f"token {self.github_token}",
            "Accept": "application/json",
            "x-github-api-version": "2022-11-28",
            **self._IDE_HEADERS,
        }

        async with aiohttp.ClientSession() as session:
            async with session.get(
                self._token_exchange_url, headers=exchange_headers
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    self._copilot_token = data["token"]
                    # expires_at is a Unix timestamp; default to 30 min if absent
                    self._copilot_token_expires_at = data.get(
                        "expires_at", time.time() + 1800
                    )
                    logger.info(
                        "[CopilotAgentClient] Session token refreshed via exchange"
                    )
                    return self._copilot_token
                elif resp.status == 404:
                    # Copilot Business/Enterprise accounts managed by an organisation
                    # often restrict the internal token-exchange endpoint.  Fall back
                    # to using the raw GitHub OAuth token directly as Bearer auth —
                    # api.githubcopilot.com accepts it for these account types.
                    logger.info(
                        "[CopilotAgentClient] Token exchange endpoint returned 404 "
                        "(organisation-managed Copilot). Using GitHub token directly as Bearer."
                    )
                    print(
                        "[CopilotAgentClient] [INFO] Token exchange not available "
                        "(Copilot Business/Enterprise). Using GitHub token directly.",
                        flush=True,
                    )
                    self._copilot_token = self.github_token
                    self._copilot_token_expires_at = time.time() + 1800
                    return self._copilot_token
                else:
                    error_text = await resp.text()
                    token_hint = ""
                    if self.github_token.startswith("ghp_"):
                        token_hint = (
                            " (Your token is a classic PAT (ghp_) — Copilot requires an OAuth "
                            "token (gho_). Fix: run `gh auth login --web` to re-authenticate.)"
                        )
                    raise ValueError(
                        f"Copilot token exchange failed ({resp.status}): {error_text}{token_hint}"
                    )

    async def resume(self, history: list[AgentMessage]) -> None:
        """Preload conversation history, truncating to Copilot's context window.

        Copilot models have varying prompt-token limits (128 k – 1 M).  When
        switching from a provider with a larger context (e.g. Claude Code at
        200 k+), the accumulated conversation can easily exceed those limits,
        causing a 400 ``model_max_prompt_tokens_exceeded`` error.

        This override drops the *oldest* messages one-by-one until the
        rendered preamble fits within the model's safe character budget.
        """
        if not history:
            await super().resume(history)
            return

        char_limit = _COPILOT_HISTORY_CHAR_LIMIT.get(
            self.model, _COPILOT_HISTORY_CHAR_LIMIT_DEFAULT
        )

        truncated = list(history)
        while len(truncated) > 1:
            preamble = self._format_history_as_preamble(truncated)
            if len(preamble) <= char_limit:
                break
            truncated = truncated[1:]  # drop oldest message

        dropped = len(history) - len(truncated)
        if dropped:
            logger.warning(
                "[CopilotAgentClient] History truncated on provider switch: "
                "dropped %d oldest message(s) to fit within the %s context window "
                "(%d → %d messages, limit ≈ %d chars).",
                dropped,
                self.model,
                len(history),
                len(truncated),
                char_limit,
            )
            print(
                f"[CopilotAgentClient] ⚠️  History truncated: {dropped} old "
                f"message(s) dropped to respect {self.model} context limit.",
                flush=True,
            )

        await super().resume(truncated)

    async def query(self, prompt: str) -> None:
        """Queue a prompt for the next receive_response() call."""
        self._pending_query = prompt

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        """Execute the queued prompt against the Copilot Models API.

        Implements a full multi-turn tool-use loop:
        1. Send messages + tool definitions to API
        2. If response contains tool_calls → execute each tool locally, add results, continue
        3. If no tool_calls → yield final text response and stop
        4. Repeat up to max_turns
        """
        import json as _json

        if not self._pending_query:
            return

        # Copilot is subscription-based — no token counts in API response.
        # Mark as "recorded" immediately so session.py always logs a Copilot entry.
        self.last_usage = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}

        prompt = self._pending_query
        self._pending_query = None

        messages: list[dict[str, Any]] = []
        if self.system_prompt:
            messages.append({"role": "system", "content": self.system_prompt})
        # If resume(history) was queued, inject the prior transcript so this
        # provider sees the same context the previous one had.
        self._consume_resumed_history_as_system_message(messages)
        messages.append({"role": "user", "content": prompt})

        # Build OpenAI-format tool definitions
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
            "Authorization": "",  # set per-call after token refresh
            "Copilot-Integration-Id": "vscode-chat",
            "openai-intent": "conversation-panel",
            "x-github-api-version": "2025-04-01",
        }

        logger.info(
            f"[CopilotAgentClient] Starting session (model={self.model}, "
            f"tools={len(tools)}, prompt_len={len(prompt)})"
        )
        print(
            f"[CopilotAgentClient] 🤖 Starting Copilot session "
            f"(model={self.model}, {len(tools)} tools)",
            flush=True,
        )

        session = self._get_http_client()

        # Track whether this session must end by writing an output file (a
        # planner or spec_writer session that was offered a write tool) and
        # whether it has done so. Used to inject a budget-aware "write now"
        # nudge before turns run out.
        must_write, output_file = _required_output(self._agent_type)
        has_write_tool = must_write and any(
            td.get("name") in _FILE_WRITE_TOOL_NAMES for td in self._tool_definitions
        )
        write_tool_used = False
        write_nudge_sent = False
        # Number of CONSECUTIVE turns that returned finish_reason=tool_calls with
        # an empty tool_calls array. Reset whenever a turn does real work.
        consecutive_empty_tool_calls = 0
        # Number of CONSECUTIVE turns whose response contained no usable choices
        # (a transient API hiccup). Reset whenever a turn returns a real choice.
        consecutive_empty_responses = 0
        # Whether we already swapped the model after a 400 "model_not_supported"
        # rejection. Guards against an infinite retry loop if even the fallback
        # model is unavailable on the user's Copilot plan.
        model_fallback_attempted = False

        for turn in range(self.max_turns):
            try:
                copilot_token = await self._get_copilot_token()
            except Exception as e:
                logger.error(f"[CopilotAgentClient] Token refresh failed: {e}")
                yield AgentMessage(
                    role=MessageRole.SYSTEM,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TEXT, text=f"Copilot auth error: {e}"
                        )
                    ],
                )
                return

            request_headers["Authorization"] = f"Bearer {copilot_token}"

            # Budget-aware "write now" nudge: when a planner/spec_writer session
            # is about to run out of turns but has never called the Write tool,
            # force it to stop investigating and produce its output file. Without
            # this, large-codebase planning loops exhaust max_turns on read-only
            # exploration and the phase fails with "Did not create plan file".
            if (
                has_write_tool
                and not write_tool_used
                and not write_nudge_sent
                and (self.max_turns - turn) <= _WRITE_NUDGE_TURNS_REMAINING
            ):
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "You are about to run out of turns. STOP investigating "
                            "now — do not run any more exploration commands. "
                            f"Immediately call the Write tool to create {output_file} "
                            "in the spec directory with its COMPLETE content, based "
                            "on what you already know. This is mandatory: if you do "
                            "not write the file now, the whole task fails."
                        ),
                    }
                )
                write_nudge_sent = True
                logger.warning(
                    "[CopilotAgentClient] Injected write-now nudge "
                    f"(turn {turn + 1}/{self.max_turns}, Write tool still unused)"
                )

            payload: dict[str, Any] = {
                "model": self.model,
                "messages": messages,
                "stream": False,
            }
            if tools:
                payload["tools"] = tools
                payload["tool_choice"] = "auto"

            logger.info(
                f"[CopilotAgentClient] Turn {turn + 1}/{self.max_turns}: "
                f"sending {len(messages)} messages..."
            )

            # Determine which endpoint to use
            api_url = (
                self._github_models_api_base
                if self._using_github_models
                else self._api_base
            )

            # For GitHub Models API, use the raw GitHub token directly (not the Copilot session token)
            if self._using_github_models:
                request_headers["Authorization"] = f"Bearer {self.github_token}"

            import asyncio as _asyncio

            import aiohttp

            data = None
            # Two independent retry budgets so a burst of rate-limit (429)
            # responses never eats the connection-error budget and vice-versa.
            connection_attempts = 0
            rate_limit_attempts = 0
            while True:
                try:
                    async with session.post(
                        api_url, json=payload, headers=request_headers
                    ) as resp:
                        if resp.status == 403 and not self._using_github_models:
                            # Copilot API blocked (org restriction) — fallback to GitHub Models API
                            error_text = await resp.text()
                            logger.warning(
                                f"[CopilotAgentClient] Copilot API returned 403 — "
                                f"falling back to GitHub Models API at {self._github_models_api_base}"
                            )
                            print(
                                "[CopilotAgentClient] [INFO] Copilot API blocked by org. "
                                "Falling back to GitHub Models API.",
                                flush=True,
                            )
                            self._using_github_models = True
                            request_headers["Authorization"] = (
                                f"Bearer {self.github_token}"
                            )
                            # Retry this turn with the GitHub Models API
                            async with session.post(
                                self._github_models_api_base,
                                json=payload,
                                headers=request_headers,
                            ) as retry_resp:
                                if retry_resp.status != 200:
                                    retry_error = await retry_resp.text()
                                    logger.error(
                                        f"[CopilotAgentClient] GitHub Models API error ({retry_resp.status}): {retry_error[:500]}"
                                    )
                                    yield AgentMessage(
                                        role=MessageRole.SYSTEM,
                                        content=[
                                            ContentBlock(
                                                type=ContentBlockType.TEXT,
                                                text=f"GitHub Models API error ({retry_resp.status}): {retry_error}",
                                            )
                                        ],
                                    )
                                    return
                                data = await retry_resp.json()
                        elif resp.status in _COPILOT_RETRYABLE_STATUSES:
                            # Transient failure (429 rate-limit or 5xx hiccup).
                            # Wait — honouring ``Retry-After`` when the server
                            # sends it, else exponential back-off — and retry
                            # instead of aborting the turn. This is what keeps
                            # subtasks flowing through short Copilot per-minute
                            # rate-limit windows rather than surfacing a 429.
                            error_text = await resp.text()
                            if rate_limit_attempts < _COPILOT_RATE_LIMIT_MAX_RETRIES:
                                rate_limit_attempts += 1
                                retry_after = _parse_retry_after(
                                    resp.headers, _COPILOT_RATE_LIMIT_MAX_BACKOFF
                                )
                                if retry_after is not None:
                                    wait_s = retry_after
                                else:
                                    wait_s = min(
                                        _COPILOT_RATE_LIMIT_BACKOFF
                                        * (2 ** (rate_limit_attempts - 1)),
                                        _COPILOT_RATE_LIMIT_MAX_BACKOFF,
                                    )
                                kind = (
                                    "rate limited"
                                    if resp.status == 429
                                    else f"transient error {resp.status}"
                                )
                                logger.warning(
                                    f"[CopilotAgentClient] {kind} — retry "
                                    f"{rate_limit_attempts}/"
                                    f"{_COPILOT_RATE_LIMIT_MAX_RETRIES} "
                                    f"in {wait_s:.0f}s"
                                )
                                print(
                                    f"[CopilotAgentClient] [WARN] Copilot {kind} "
                                    f"— waiting {wait_s:.0f}s then retrying "
                                    f"({rate_limit_attempts}/"
                                    f"{_COPILOT_RATE_LIMIT_MAX_RETRIES})...",
                                    flush=True,
                                )
                                await _asyncio.sleep(wait_s)
                                continue
                            # Budget exhausted — surface the error as before.
                            logger.error(
                                f"[CopilotAgentClient] API error ({resp.status}) "
                                f"after {rate_limit_attempts} retries: "
                                f"{error_text[:500]}"
                            )
                            yield AgentMessage(
                                role=MessageRole.SYSTEM,
                                content=[
                                    ContentBlock(
                                        type=ContentBlockType.TEXT,
                                        text=f"Copilot API error ({resp.status}): {error_text}",
                                    )
                                ],
                            )
                            return
                        elif (
                            resp.status == 400
                            and not model_fallback_attempted
                            and not self._using_github_models
                        ):
                            # The Copilot API rejected the requested model. This
                            # happens when a task carries an Anthropic-native
                            # versioned id (e.g. "claude-sonnet-4-5") or a
                            # flagship not yet served by the user's Copilot plan
                            # (e.g. "claude-opus-4.8"). Swap to a supported model
                            # and retry the turn instead of failing the phase.
                            error_text = await resp.text()
                            if "model_not_supported" in error_text:
                                fallback = _copilot_fallback_model(self.model)
                                model_fallback_attempted = True
                                logger.warning(
                                    "[CopilotAgentClient] Model "
                                    f"'{self.model}' not supported by Copilot — "
                                    f"falling back to '{fallback}' and retrying."
                                )
                                print(
                                    "[CopilotAgentClient] [WARN] Model "
                                    f"'{self.model}' not supported — switching to "
                                    f"'{fallback}'.",
                                    flush=True,
                                )
                                self.model = fallback
                                payload["model"] = fallback
                                continue
                            # A different 400 (e.g. malformed request) — surface.
                            logger.error(
                                f"[CopilotAgentClient] API error (400): {error_text[:500]}"
                            )
                            yield AgentMessage(
                                role=MessageRole.SYSTEM,
                                content=[
                                    ContentBlock(
                                        type=ContentBlockType.TEXT,
                                        text=f"Copilot API error (400): {error_text}",
                                    )
                                ],
                            )
                            return
                        elif resp.status != 200:
                            error_text = await resp.text()
                            logger.error(
                                f"[CopilotAgentClient] API error ({resp.status}): {error_text[:500]}"
                            )
                            yield AgentMessage(
                                role=MessageRole.SYSTEM,
                                content=[
                                    ContentBlock(
                                        type=ContentBlockType.TEXT,
                                        text=f"Copilot API error ({resp.status}): {error_text}",
                                    )
                                ],
                            )
                            return
                        else:
                            data = await resp.json()
                            # Some Copilot models do report `usage`; when they
                            # do, it is the context fill the guard measures.
                            _cu = data.get("usage") if isinstance(data, dict) else None
                            if isinstance(_cu, dict) and _cu.get("prompt_tokens"):
                                self.last_context_tokens = int(_cu["prompt_tokens"])
                    break  # request succeeded — leave the retry loop
                except (
                    _asyncio.TimeoutError,
                    aiohttp.ClientError,
                ) as e:
                    # A hung/stalled or transient connection error. Retry before
                    # failing so a single bad response no longer freezes the whole
                    # phase. A full-duration TIMEOUT gets a tighter retry budget
                    # than a (cheap, fast-failing) connection error: each timeout
                    # retry costs another full ceiling, so we cap it to bound the
                    # worst-case "stuck" window.
                    is_timeout = isinstance(e, _asyncio.TimeoutError)
                    max_retries = (
                        _COPILOT_TIMEOUT_MAX_RETRIES
                        if is_timeout
                        else _COPILOT_REQUEST_MAX_RETRIES
                    )
                    if connection_attempts < max_retries:
                        backoff = _COPILOT_REQUEST_RETRY_BACKOFF * (
                            connection_attempts + 1
                        )
                        logger.warning(
                            f"[CopilotAgentClient] Request stalled/failed "
                            f"({type(e).__name__}: {e}) — retry "
                            f"{connection_attempts + 1}/{max_retries} "
                            f"in {backoff:.0f}s"
                        )
                        print(
                            "[CopilotAgentClient] [WARN] Copilot API request "
                            f"stalled — retrying ({connection_attempts + 1}/"
                            f"{max_retries})...",
                            flush=True,
                        )
                        connection_attempts += 1
                        await _asyncio.sleep(backoff)
                        continue
                    logger.error(
                        f"[CopilotAgentClient] Request failed after "
                        f"{connection_attempts + 1} attempt(s): {e}"
                    )
                    yield AgentMessage(
                        role=MessageRole.SYSTEM,
                        content=[
                            ContentBlock(
                                type=ContentBlockType.TEXT,
                                text=f"Copilot API error (timeout/connection): {e}",
                            )
                        ],
                    )
                    return
                except Exception as e:
                    logger.error(f"[CopilotAgentClient] Request failed: {e}")
                    yield AgentMessage(
                        role=MessageRole.SYSTEM,
                        content=[
                            ContentBlock(
                                type=ContentBlockType.TEXT,
                                text=f"Copilot API error: {e}",
                            )
                        ],
                    )
                    return

            if data is None:
                # All retries exhausted without a usable response.
                logger.error("[CopilotAgentClient] No response data after retries")
                return

            choices = data.get("choices", [])
            if not choices:
                # A 200 response with no choices is almost always a transient
                # server-side hiccup, not a genuine "done" signal. Re-issue the
                # same turn after a short back-off instead of killing the whole
                # session on the first empty response. Only give up once the
                # consecutive-empty budget is exhausted.
                consecutive_empty_responses += 1
                if (
                    consecutive_empty_responses
                    <= _COPILOT_MAX_CONSECUTIVE_EMPTY_RESPONSES
                ):
                    backoff = (
                        _COPILOT_EMPTY_RESPONSE_BACKOFF * consecutive_empty_responses
                    )
                    logger.warning(
                        f"[CopilotAgentClient] Turn {turn + 1}: empty choices in "
                        f"response — retrying "
                        f"({consecutive_empty_responses}/"
                        f"{_COPILOT_MAX_CONSECUTIVE_EMPTY_RESPONSES}) "
                        f"in {backoff:.0f}s"
                    )
                    print(
                        "[CopilotAgentClient] [WARN] Empty response from Copilot "
                        f"— retrying ({consecutive_empty_responses}/"
                        f"{_COPILOT_MAX_CONSECUTIVE_EMPTY_RESPONSES})...",
                        flush=True,
                    )
                    await _asyncio.sleep(backoff)
                    continue  # retry — don't end the session on a transient empty
                logger.error(
                    f"[CopilotAgentClient] {consecutive_empty_responses} consecutive "
                    "empty responses — giving up"
                )
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[
                        ContentBlock(
                            type=ContentBlockType.TEXT,
                            text="(Empty response from Copilot)",
                        )
                    ],
                )
                return

            # A usable choice arrived — clear the transient-empty guard counter.
            consecutive_empty_responses = 0

            message = choices[0].get("message", {})
            content = message.get("content") or ""
            tool_calls = message.get("tool_calls", [])
            finish_reason = choices[0].get("finish_reason", "")

            logger.info(
                f"[CopilotAgentClient] Turn {turn + 1}: "
                f"content_len={len(content)}, tool_calls={len(tool_calls)}, "
                f"finish_reason={finish_reason}"
            )

            # Yield text content if present
            if content:
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[ContentBlock(type=ContentBlockType.TEXT, text=content)],
                )

            # No tool calls returned
            if not tool_calls:
                if finish_reason == "tool_calls":
                    # Copilot API returned finish_reason=tool_calls but no actual tool_calls —
                    # this can occur with Claude models via the OpenAI-compatible Copilot API.
                    # Add the partial assistant message and prompt the model to proceed with tools.
                    consecutive_empty_tool_calls += 1
                    if (
                        consecutive_empty_tool_calls
                        > _COPILOT_MAX_CONSECUTIVE_EMPTY_TOOL_CALLS
                    ):
                        # The model keeps "intending" to call a tool but never
                        # emits one. Stop re-sampling so we don't spin through the
                        # entire turn budget producing no work. End the session
                        # with whatever content we have so the phase can surface a
                        # real failure instead of silently looping.
                        logger.error(
                            f"[CopilotAgentClient] Turn {turn + 1}: "
                            f"{consecutive_empty_tool_calls} consecutive empty "
                            "tool_calls responses — aborting to avoid a spin loop"
                        )
                        yield AgentMessage(
                            role=MessageRole.SYSTEM,
                            content=[
                                ContentBlock(
                                    type=ContentBlockType.TEXT,
                                    text=(
                                        "Copilot API returned no actionable tool "
                                        f"calls for {consecutive_empty_tool_calls} "
                                        "consecutive turns — stopping to avoid an "
                                        "infinite loop."
                                    ),
                                )
                            ],
                        )
                        return
                    logger.warning(
                        f"[CopilotAgentClient] Turn {turn + 1}: finish_reason=tool_calls "
                        "but no tool_calls in response — retrying with nudge "
                        f"({consecutive_empty_tool_calls}/"
                        f"{_COPILOT_MAX_CONSECUTIVE_EMPTY_TOOL_CALLS})"
                    )
                    if content:
                        messages.append({"role": "assistant", "content": content})
                    messages.append(
                        {
                            "role": "user",
                            "content": "Please proceed by calling the appropriate tools to complete your task.",
                        }
                    )
                    continue  # retry — don't return early

                # The model wants to STOP. For planner/spec_writer sessions the
                # output file is mandatory, yet the model often "finishes" by
                # DESCRIBING the plan in prose without ever calling the Write
                # tool — leaving the planning phase to fail with "Did not create
                # plan file". If Write is required and still unused, refuse the
                # early stop once and force the model to write.
                if (
                    has_write_tool
                    and not write_tool_used
                    and not write_nudge_sent
                    and turn < self.max_turns - 1
                ):
                    if content:
                        messages.append({"role": "assistant", "content": content})
                    messages.append(
                        {
                            "role": "user",
                            "content": (
                                "You have NOT yet created the required output file. "
                                "Do not stop and do not just describe it in text. "
                                "You MUST call the Write tool now to create "
                                f"{output_file} in the spec directory with its "
                                "COMPLETE content, based on your investigation so "
                                "far. Call the Write tool now."
                            ),
                        }
                    )
                    write_nudge_sent = True
                    logger.warning(
                        f"[CopilotAgentClient] Turn {turn + 1}: model tried to stop "
                        "without writing the plan — forcing a Write retry"
                    )
                    continue  # retry — don't return early

                if not content:
                    yield AgentMessage(
                        role=MessageRole.ASSISTANT,
                        content=[
                            ContentBlock(
                                type=ContentBlockType.TEXT,
                                text="(No response from Copilot)",
                            )
                        ],
                    )
                logger.info(
                    f"[CopilotAgentClient] Session complete after {turn + 1} turn(s)"
                )
                return

            # Add assistant message (with tool_calls) to conversation history
            # Real tool calls arrived — the model is making progress, so clear the
            # empty-response guard counter.
            consecutive_empty_tool_calls = 0
            assistant_msg: dict[str, Any] = {"role": "assistant"}
            if content:
                assistant_msg["content"] = content
            assistant_msg["tool_calls"] = tool_calls
            messages.append(assistant_msg)

            # Execute each tool call
            for tc in tool_calls:
                func = tc.get("function", {})
                tool_name = func.get("name", "")
                tool_id = tc.get("id", f"call_{turn}_{tool_name}")

                try:
                    args = _json.loads(func.get("arguments", "{}"))
                except (_json.JSONDecodeError, TypeError):
                    args = {}

                logger.info(
                    f"[CopilotAgentClient] Turn {turn + 1}: tool_call {tool_name}({list(args.keys())})"
                )
                print(f"[CopilotAgentClient] 🔧 Tool: {tool_name}", flush=True)

                if tool_name in _FILE_WRITE_TOOL_NAMES:
                    write_tool_used = True

                # Yield TOOL_USE block so session handler can log it
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

                # Execute tool locally
                result_text = ""
                is_error = False
                if self._tool_executor:
                    try:
                        result = await self._tool_executor.execute(tool_name, args)
                        result_text = str(result) if result is not None else ""
                    except Exception as e:
                        result_text = f"Tool error: {e}"
                        is_error = True
                        logger.warning(
                            f"[CopilotAgentClient] Tool {tool_name} failed: {e}"
                        )
                else:
                    result_text = "Tool executor not available"
                    is_error = True

                # Yield TOOL_RESULT block so session handler can log it
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

                # Add tool result for next API call (head+tail truncation —
                # build/test verdicts sit at the END of the output)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_id,
                        "content": truncate_tool_result(result_text),
                    }
                )

            # Elide stale tool results once the conversation exceeds the char
            # budget (no-op below budget, preserving the cacheable prefix).
            compacted = compact_messages(messages)
            if compacted:
                logger.info(
                    f"[CopilotAgentClient] History compaction: elided {compacted} "
                    "stale tool result(s)"
                )

            # Continue loop — next turn sends updated messages with tool results

        logger.warning(
            f"[CopilotAgentClient] Reached max_turns ({self.max_turns}) — stopping tool loop"
        )
        print(
            f"[CopilotAgentClient] ⚠️ Reached max turns ({self.max_turns})", flush=True
        )

    async def run_subagents(
        self,
        agents: dict[str, SubagentDefinition],
        context_prompt: str,
    ) -> dict[str, str]:
        """Run sub-agents in parallel using the Copilot Models API.

        Each sub-agent gets its own API call with its specialized
        system prompt and the shared context. Results are returned
        as a dict mapping agent_name -> response_text.

        Args:
            agents: Dict of agent_name -> SubagentDefinition
            context_prompt: Shared context/prompt for all agents

        Returns:
            Dict mapping agent_name -> agent response text
        """
        import asyncio

        async def _run_one(name: str, defn: SubagentDefinition) -> tuple[str, str]:
            """Run a single sub-agent API call."""
            messages = [
                {"role": "system", "content": defn.prompt},
                {"role": "user", "content": context_prompt},
            ]

            copilot_token = await self._get_copilot_token()
            session = self._get_http_client()
            payload = {
                "model": (
                    _normalize_copilot_model_id(defn.model)
                    if defn.model != "inherit"
                    else self.model
                ),
                "messages": messages,
                "stream": False,
            }
            request_headers = {
                "Authorization": f"Bearer {copilot_token}",
                "Copilot-Integration-Id": "vscode-chat",
                "openai-intent": "conversation-panel",
                "x-github-api-version": "2025-04-01",
            }

            try:
                async with session.post(
                    self._api_base, json=payload, headers=request_headers
                ) as resp:
                    if resp.status != 200:
                        error_text = await resp.text()
                        return (name, f"Error ({resp.status}): {error_text}")
                    data = await resp.json()

                choices = data.get("choices", [])
                if choices:
                    return (name, choices[0].get("message", {}).get("content", ""))
                return (name, "")
            except Exception as e:
                logger.error(f"[CopilotSubagent:{name}] Error: {e}")
                return (name, f"Error: {e}")

        # Run all sub-agents in parallel
        tasks = [_run_one(name, defn) for name, defn in agents.items()]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        output: dict[str, str] = {}
        for result in results:
            if isinstance(result, Exception):
                logger.error(f"[CopilotSubagent] Task failed: {result}")
                continue
            name, text = result
            output[name] = text

        return output

    def supports_subagents(self) -> bool:
        return True

    def provider_name(self) -> str:
        return "copilot"

    async def __aenter__(self):
        if self.cwd:
            try:
                from core.runtimes.tool_executor import (
                    ToolExecutor,
                    get_tool_definitions,
                )

                self._tool_executor = ToolExecutor(
                    self.cwd,
                    spec_dir=getattr(self, "_spec_dir", None),
                    agent_type=self._agent_type,
                )
                self._tool_definitions = get_tool_definitions(
                    self._agent_type, getattr(self, "_spec_dir", None)
                )
                logger.info(
                    f"[CopilotAgentClient] Tool execution enabled: "
                    f"{len(self._tool_definitions)} tools for agent_type={self._agent_type}"
                )
            except Exception as e:
                logger.warning(
                    f"[CopilotAgentClient] Tool executor init failed (text-only mode): {e}"
                )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._http_client is not None:
            await self._http_client.close()
            self._http_client = None
