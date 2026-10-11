"""`LocalAgentClient` — Ollama / LM Studio and other local servers: base-URL
resolution, text tool-call recovery, streaming heartbeats and diagnostics.

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
        history_char_budget,
        tool_result_max_chars,
        truncate_tool_result,
    )
except ImportError:  # pragma: no cover - alternate package layout
    from apps.backend.core.llm_optimization import (
        compact_messages,
        history_char_budget,
        tool_result_max_chars,
        truncate_tool_result,
    )
from .base import (
    CONTENT_TYPE_JSON,
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
    _env_flag,
    _env_float,
)
from .openai import (
    OpenAIAgentClient,
)

# The name the monolith logged under, kept so logging configuration and log
# filters keyed on it still match: `core.agent_client`, or
# `apps.backend.core.agent_client` under the repo-root layout.
logger = logging.getLogger(__name__.rpartition(".agent_clients.")[0] + ".agent_client")


# =============================================================================
# Local LLM Agent Client — any OpenAI-compatible local server
# =============================================================================


def _normalize_local_base_url(raw: str | None) -> str:
    """Normalize a local LLM base URL into a full chat-completions endpoint.

    Accepts whatever the user typed (root, ``/v1``, or the full path, with or
    without a trailing slash) and returns ``{root}/v1/chat/completions``.
    Works for any OpenAI-compatible local server — Ollama (11434), LM Studio
    (1234), llama.cpp, vLLM, LocalAI.

    The loopback host is forced to the IPv4 literal ``127.0.0.1``: the
    app-managed Ollama daemon binds to ``127.0.0.1`` (see the frontend's
    ``ollamaHostFromUrl``), but ``localhost`` resolves to IPv6 ``::1`` first on
    many systems (notably Windows). aiohttp then connects to ``::1`` and fails
    with a spurious "connection refused / Ollama ne répond pas" even though the
    server is up and answering on IPv4 (a browser hides this via Happy
    Eyeballs). Pinning IPv4 keeps the client and the server on the same stack.

    Examples::

        http://localhost:11434              -> http://127.0.0.1:11434/v1/chat/completions
        http://localhost:1234/v1            -> http://127.0.0.1:1234/v1/chat/completions
        http://127.0.0.1:1234/v1/chat/completions (idempotent)
    """
    base = (raw or "").strip().rstrip("/")
    if not base:
        base = "http://127.0.0.1:11434"
    base = _force_ipv4_loopback(base)
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")].rstrip("/")
    if not base.endswith("/v1"):
        base = base + "/v1"
    return base + "/chat/completions"


def _force_ipv4_loopback(url: str) -> str:
    """Rewrite a ``localhost`` host in ``url`` to the IPv4 literal ``127.0.0.1``.

    Only the loopback hostname is touched (scheme/port/path preserved); other
    hosts pass through unchanged. See ``_normalize_local_base_url`` for why.
    """
    for scheme in ("http://", "https://"):
        if url.lower().startswith(scheme + "localhost"):
            rest = url[len(scheme) + len("localhost") :]
            # Only a real host boundary — ':' (port), '/' (path) or end — so we
            # never rewrite e.g. "localhostfoo".
            if rest == "" or rest[0] in ":/":
                return scheme + "127.0.0.1" + rest
            break
    return url


def _resolve_local_base_url(explicit: str | None) -> str:
    """Resolve the local LLM base URL by priority: explicit arg → env →
    saved provider config → default Ollama localhost. Returns the full
    chat-completions endpoint (already normalized)."""
    import os as _os

    resolved = (
        explicit
        or _os.environ.get("OLLAMA_BASE_URL")
        or _os.environ.get("LOCAL_LLM_BASE_URL")
        or _os.environ.get("LMSTUDIO_BASE_URL")
    )
    if not resolved:
        # Fall back to the saved provider config (~/.work_pilot_ai_llm_providers.json).
        # Lazy import — src.connectors may not be on sys.path in every caller.
        try:
            from src.connectors.llm_config import load_provider_config

            cfg = load_provider_config("ollama") or load_provider_config("local") or {}
            resolved = cfg.get("base_url")
        except Exception:  # noqa: BLE001 — never block client creation on this
            resolved = None
    return _normalize_local_base_url(resolved)


def _balanced_json_objects(text: str) -> list[str]:
    """Yield each top-level balanced ``{...}`` substring in ``text``.

    Used to pull a JSON tool-call object out of a reply that wraps it in prose
    or markdown. String contents (with escapes) are skipped so braces inside
    strings don't break the matching.
    """
    out: list[str] = []
    depth = 0
    start = -1
    in_str = False
    esc = False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}" and depth > 0:
            depth -= 1
            if depth == 0 and start >= 0:
                out.append(text[start : i + 1])
    return out


def _normalize_text_tool_call(obj: Any, known_tools: set[str]) -> dict[str, Any] | None:
    """Turn a parsed JSON object into a native tool_call, or ``None``.

    Accepts both ``{"name", "arguments"}`` and ``{"function": {...}}`` shapes.
    Only objects whose tool name the agent actually offers are accepted, so
    ordinary JSON data in a reply isn't mistaken for a tool call.
    """
    import json as _json

    if not isinstance(obj, dict):
        return None
    fn = obj.get("function") if isinstance(obj.get("function"), dict) else obj
    name = fn.get("name") or fn.get("tool") or fn.get("tool_name")
    if not isinstance(name, str) or name not in known_tools:
        return None
    args = fn.get("arguments")
    if args is None:
        args = fn.get("parameters", fn.get("args", {}))
    if isinstance(args, str):
        try:
            args = _json.loads(args)
        except (ValueError, TypeError):
            args = {}
    if not isinstance(args, dict):
        args = {}
    return {"function": {"name": name, "arguments": args}}


def _extract_text_tool_calls(
    content: str, known_tools: set[str]
) -> list[dict[str, Any]]:
    """Recover tool calls a model emitted as JSON *text* instead of structured
    ``tool_calls`` (common for GGUF/qwen models on Ollama).

    Returns native-shaped tool_calls (deduplicated). Never raises.
    """
    import json as _json
    import re as _re

    known = {t for t in known_tools if t}
    if not content or not known:
        return []
    has_json = "{" in content
    has_xml = "<tool" in content.lower()
    if not has_json and not has_xml:
        return []

    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _add(tc: dict[str, Any] | None) -> None:
        if not tc:
            return
        key = _json.dumps(tc, sort_keys=True)
        if key not in seen:
            seen.add(key)
            out.append(tc)

    def _loads(text: str) -> Any:
        """json.loads tolerant of the Python-dialect "JSON" local models emit.

        Strict JSON rejects, and thus drops the whole tool call for, several
        common local-model habits: Python literals (``False``/``True``/``None``),
        single-quoted strings, and the invalid over-escaped apostrophe (``\\'``,
        e.g. a French "d'avertissement"). We try strict JSON first (so valid JSON
        is never altered), then ``ast.literal_eval`` (literals only — no code
        execution — which natively handles ``False``/single quotes/``\\'``), then
        a last-ditch ``\\'``→``'`` fix for blobs that mix JSON ``null`` with the
        bad escape. Returns None on failure.
        """
        try:
            return _json.loads(text)
        except (ValueError, TypeError):
            pass
        try:
            import ast as _ast

            parsed = _ast.literal_eval(text)
            if isinstance(parsed, (dict, list)):
                return parsed
        except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
            pass
        try:
            return _json.loads(text.replace("\\'", "'"))
        except (ValueError, TypeError):
            return None

    # 1) JSON shapes: fenced blocks, bare reply, and JSON embedded in prose.
    if has_json:
        blobs: list[str] = []
        blobs += _re.findall(
            r"```(?:json|tool_call|tool|python)?\s*(\{.*?\}|\[.*?\])\s*```",
            content,
            _re.DOTALL,
        )
        blobs.append(content.strip())  # whole reply (bare-JSON case)
        blobs += _balanced_json_objects(content)  # JSON embedded in prose
        for blob in blobs:
            parsed = _loads(blob)
            if parsed is None:
                continue
            items = parsed if isinstance(parsed, list) else [parsed]
            for item in items:
                _add(_normalize_text_tool_call(item, known))

    # 2) XML shapes some models emit instead of JSON tool_calls, e.g.
    #    <tool_use name="Write">{"file_path": "x", "content": "..."}</tool_use>
    #    or <tool_call name="run_command">{...}</tool_call>. The body is the JSON
    #    arguments object (possibly wrapped in prose). Provider-agnostic: covers
    #    Windsurf/Codeium-style <tool_call> and Qwen/Llama <tool_use> tags.
    if has_xml:
        for m in _re.finditer(
            r"<tool[_-]?(?:use|call)\b[^>]*\bname\s*=\s*[\"']([^\"']+)[\"']"
            r"[^>]*>(.*?)</tool[_-]?(?:use|call)>",
            content,
            _re.DOTALL | _re.IGNORECASE,
        ):
            name = m.group(1).strip()
            if name not in known:
                continue
            body = m.group(2).strip()
            args: dict[str, Any] = {}
            for candidate in (body, *_balanced_json_objects(body)):
                if not candidate:
                    continue
                parsed_args = _loads(candidate)
                if isinstance(parsed_args, dict):
                    args = parsed_args
                    break
            _add({"function": {"name": name, "arguments": args}})

    return out


# Sent to a local model that stalled instead of acting, before giving up. Many
# tools-capable local models (e.g. qwen2.5-coder) either narrate the steps,
# print a file's content as text, or — worse — ask the user to run commands and
# paste the output, as if chatting with a human. A single explicit correction
# usually gets them to emit a real tool call.
_TOOL_USE_NUDGE = (
    "You are an AUTONOMOUS agent. There is NO human in this conversation to run "
    "commands, paste output, or answer questions — asking for input stalls the "
    "task forever. Do NOT ask for anything and do NOT just describe the steps: "
    "perform them YOURSELF by emitting an actual tool call now (e.g. "
    "`run_command` to run a shell command, `list_files`/`read_file` to inspect, "
    "`Write`/`write_file` with the path and full content to create a file). "
    "Output a tool call, not prose and not raw JSON/file content."
)

# High-signal phrases that mean the model is deferring to a human (waiting for
# someone to run a command / paste output) instead of acting on its own. Kept
# tight to avoid mistaking a normal closing remark ("please review") for a stall.
_WAITING_FOR_HUMAN_RE = re.compile(
    r"please (execute|run|provide)\b"
    r"|provide the (output|result|directory)"
    r"|paste the (output|result)"
    r"|let me know the (output|result)"
    r"|can you (run|execute|provide)\b"
    r"|could you (run|execute|provide)\b"
    r"|waiting for (your|the) (input|output|response)",
    re.IGNORECASE,
)


def _looks_like_waiting_for_human(content: str) -> bool:
    """True when the reply asks a human to act (run a command, paste output).

    In an autonomous loop there is no human to answer, so such a turn is a stall
    even if the model called a tool earlier — it must be nudged to act itself.
    """
    return bool(content) and _WAITING_FOR_HUMAN_RE.search(content) is not None


# How many times to retry a *connection* failure (server briefly unavailable,
# e.g. just after auto-start or while reloading a model) before surfacing the
# "Ollama ne répond pas" hint. Reset on any successful response.
_LOCAL_MAX_CONNECT_RETRIES = 2

# How long one local generation may take. aiohttp's default session timeout is
# 5 minutes TOTAL, and a large model — llama3.3 is 70B — thinking at a high
# Per-request total, initial-output and generation-idle guards below bound
# slow/stalled local calls. Socket timeout remains a final transport backstop.
_LOCAL_CHAT_SOCK_READ_TIMEOUT = 15 * 60
_LOCAL_CHAT_CONNECT_TIMEOUT = 20
# How often to say "still generating" while a turn is in flight. Silence and a
# hang look identical in a log; a heartbeat separates them.
_LOCAL_HEARTBEAT_SECONDS = 30
# How long the server may produce nothing before the heartbeat stops calling it
# normal slowness. Below this a local model is simply slow; above it, something
# is wrong (a context that does not fit, a swapping machine, a wedged runner)
# and the line says so instead of counting minutes reassuringly.
_LOCAL_STALL_SECONDS = 5 * 60
# Default ceiling on the context window when OLLAMA_CONTEXT_LENGTH is unset.
# The KV cache grows linearly with the window — on a 70B it is several hundred
# kilobytes per token — so "as much as the model advertises" (131072 for
# llama3.3) is an out-of-memory, not a default.
_LOCAL_NUM_CTX_DEFAULT_CAP = 32_768
# Room kept above the first prompt for the reply and the turns that follow it.
_LOCAL_NUM_CTX_REPLY_HEADROOM = 4_096
# How long a model may legitimately be absent from /api/ps while its weights are
# read off disk before the log says so. Two minutes covers a large model on a
# slow disk; below that the line would fire on every cold start.
_LOCAL_NOT_LOADED_GRACE = 120

# Distinguishes "not looked up yet" from "looked up, and the server did not say".
_UNSET = object()


def _format_duration_fr(seconds: int) -> str:
    """`90` → "1 min 30 s". Used by the generation heartbeat."""
    seconds = max(int(seconds), 0)
    if seconds < 60:
        return f"{seconds} s"
    minutes, rest = divmod(seconds, 60)
    return f"{minutes} min" if rest == 0 else f"{minutes} min {rest} s"


def _canonical_local_model(name: str | None) -> str:
    """Ollama's implicit tag: the bare name IS ``:latest``.

    Mirrors `canonicalLocalModelName` in
    ``apps/frontend/src/shared/utils/local-models.ts``. Nothing else collapses:
    ``llama3.3:70b`` is a genuinely different artefact.
    """
    model_id = (name or "").strip().lower()
    return model_id[: -len(":latest")] if model_id.endswith(":latest") else model_id


def _format_bytes_fr(n: float) -> str:
    """Human-readable byte count (Go/Mo)."""
    if n >= 1024**3:
        return f"{n / 1024**3:.1f} Go"
    if n >= 1024**2:
        return f"{n / 1024**2:.0f} Mo"
    return f"{max(int(n), 0)} o"


def _format_not_loaded_diagnosis(
    model: str, *, server_root: str, others: list[str]
) -> str:
    """The server answered ``/api/ps`` and our model is not in it.

    While a request is in flight this should be impossible, so it is worth a
    line of its own. Two things produce it, and they are told apart by what
    happens next: weights still being read off disk resolve on their own (a 70B
    is tens of gigabytes), a client pointed at a different server never does.
    That second case is invisible from a terminal — ``ollama ps`` there queries
    the CLI's server, not the one the app opened a socket to — so the URL is
    named rather than assumed.
    """
    loaded = (
        "aucun modèle chargé"
        if not others
        else "modèles chargés : " + ", ".join(others)
    )
    return (
        f"🧠 {server_root} répond mais ne rapporte pas « {model} » "
        f"({loaded}), alors qu'une requête est en cours. Soit les poids sont "
        "encore en cours de lecture depuis le disque — des dizaines de Go pour "
        "un 70B —, soit l'application interroge un autre serveur que votre "
        f"terminal : consultez {server_root}/api/ps sur ce même serveur."
    )


def _format_placement_diagnosis(
    model: str,
    *,
    size: int,
    size_vram: int,
    parameter_size: str | None,
) -> str:
    """Why a loaded model is producing nothing, from where Ollama put it.

    A model that does not fit in VRAM is not refused — Ollama runs the layers
    that fit on the GPU and the rest on the CPU, at a tenth of the speed or
    worse. Nothing in the protocol says so: the request simply takes hours, and
    every symptom above the driver looks like "it is thinking". This is the one
    fact that separates *slow because the machine is small* from *slow because
    the prompt is big*, and the two have opposite remedies — a smaller model
    versus a smaller context.
    """
    who = f"« {model} »" + (f" ({parameter_size})" if parameter_size else "")
    if size <= 0:
        return f"🧠 {who} est chargé, mais Ollama ne rapporte pas sa répartition."
    on_gpu = size_vram / size
    if size_vram <= 0:
        return (
            f"🧠 {who} tourne **entièrement sur le CPU** "
            f"({_format_bytes_fr(size)} en RAM, rien en VRAM). À cette taille, "
            "un tour se compte en heures : prenez un modèle plus petit "
            "(qwen2.5-coder:7b, llama3.2) ou une quantification plus légère."
        )
    if on_gpu < 0.95:
        return (
            f"🧠 {who} ne tient pas dans la VRAM : "
            f"{_format_bytes_fr(size_vram)} sur {_format_bytes_fr(size)} "
            f"({on_gpu:.0%}) sur le GPU, le reste sur le CPU. C'est ce qui rend "
            "le tour interminable. Prenez un modèle plus petit, une "
            "quantification plus légère, ou réduisez la fenêtre de contexte "
            "(OLLAMA_CONTEXT_LENGTH) dont le cache occupe aussi de la VRAM."
        )
    return (
        f"🧠 {who} est entièrement sur le GPU "
        f"({_format_bytes_fr(size_vram)} en VRAM) : la lenteur vient de la "
        "taille du modèle, pas d'un débordement mémoire."
    )


def _merge_native_chunk(acc: dict[str, Any], chunk: dict[str, Any]) -> int:
    """Fold one Ollama ``/api/chat`` object into an accumulator, in place.

    Streaming sends one object per token batch (NDJSON) and non-streaming sends
    a single object of the *same* shape, so both modes fold through here and the
    turn's downstream handling never has to know which one ran.

    Returns the number of content characters this chunk added, which is how the
    caller tells "still producing" from "stopped sending".
    """
    message = chunk.get("message") or {}
    text = message.get("content") or ""
    thinking = message.get("thinking") or ""
    if text:
        acc["content"] = acc.get("content", "") + text
    tool_calls = message.get("tool_calls") or []
    if tool_calls:
        acc.setdefault("tool_calls", []).extend(tool_calls)
    if text or thinking or tool_calls:
        # In flight this counts received fragments, not tokenizer tokens.
        # Exact token usage is reported by eval_count in the final chunk.
        acc["tokens"] = acc.get("tokens", 0) + 1
    for key in ("prompt_eval_count", "eval_count"):
        value = chunk.get(key)
        if value:
            acc[key] = int(value)
    if chunk.get("done"):
        acc["done"] = True
    if chunk.get("error"):
        acc["error"] = str(chunk["error"])
    return len(text) + len(thinking) + len(tool_calls)


def _format_generation_progress(
    model: str,
    *,
    turn: int,
    max_turns: int,
    elapsed: int,
    tokens: int,
    silent_for: int,
    streaming: bool = True,
) -> str:
    """The heartbeat line for a local turn that is still in flight.

    A local turn has two silent phases that fail for different reasons and are
    fixed differently: **prompt evaluation** (the server reading the whole
    context before emitting anything — slow because the context is big) and
    **generation** (slow because the model is big). "Thinking…" describes
    neither, which is why a log full of it told the user nothing. Naming the
    phase, the turn and the token count makes the same 30-second line carry the
    one thing a heartbeat is for: whether anything moved since the last one.

    On the non-streamed fallback there is genuinely nothing to observe until
    the turn ends, so the line says that rather than reading zero tokens as
    evidence of a stall.
    """
    where = f"tour {turn}/{max_turns}"
    if not streaming:
        return (
            f"⏳ {where} — « {model} » travaille depuis "
            f"{_format_duration_fr(elapsed)} (réponse non streamée : le serveur "
            "n'envoie rien avant la fin du tour)."
        )
    if tokens <= 0:
        if elapsed >= _LOCAL_STALL_SECONDS:
            # No guess about the cause here: the window is now sized to fit the
            # prompt by construction, so "the context is too big" was wrong
            # exactly when this line mattered most. The cause is reported
            # separately, once, from what Ollama says it actually loaded.
            return (
                f"⚠️ {where} — « {model} » : toujours aucun fragment après "
                f"{_format_duration_fr(elapsed)}. Le serveur répond mais "
                "n’a encore envoyé aucun fragment. Consultez le diagnostic de chargement ; "
                "la cause ne peut pas être déduite de cette attente seule."
            )
        return (
            f"⏳ {where} — « {model} » attend le chargement ou le traitement du contexte depuis "
            f"{_format_duration_fr(elapsed)} (aucun fragment reçu pour l'instant)."
        )
    if silent_for >= _LOCAL_STALL_SECONDS:
        return (
            f"⚠️ {where} — « {model} » : {tokens} fragments générés puis plus rien "
            f"depuis {_format_duration_fr(silent_for)}. La requête sera "
            "interrompue si la limite de silence configurée est atteinte."
        )
    rate = tokens / elapsed if elapsed > 0 else 0.0
    return (
        f"⏳ {where} — « {model} » génère : {tokens} fragments en "
        f"{_format_duration_fr(elapsed)} "
        f"(~{f'{rate:.1f}'.replace('.', ',')} fragments/s)."
    )


def _next_no_tool_action(
    *,
    any_tool_called: bool,
    tools_offered: bool,
    has_content: bool,
    waiting_for_human: bool,
    nudge_sent: bool,
    turn: int,
    max_turns: int,
) -> str:
    """Decide what to do when a turn came back with no tool calls.

    Returns one of:
      - ``"end"``    — the model is legitimately finished (it already acted and
                       isn't waiting on anyone, or no tools were offered), or it
                       returned an empty reply: stop the loop.
      - ``"nudge"``  — the model stalled (only narrated, or is asking a human to
                       run commands / paste output) and hasn't been corrected
                       yet: retry once with ``_TOOL_USE_NUDGE``.
      - ``"give_up"`` — already nudged (or out of turns) and still stalling:
                       treat the model as unable to drive tools for this task.
    """
    if not has_content:
        return "end"  # empty reply — nothing to nudge against
    if not tools_offered:
        return "end"  # text-only session — a prose ending is normal
    # Stalled when the model never acted at all, OR it acted but is now deferring
    # to a human (run this command, paste the output) — nobody will answer.
    stalled = (not any_tool_called) or waiting_for_human
    if not stalled:
        return "end"  # used tools and finished on its own
    if not nudge_sent and turn < max_turns - 1:
        return "nudge"
    return "give_up"


class LocalModelRuntimeError(RuntimeError):
    """Terminal local generation failure: changing configuration is required."""


class LocalAgentClient(OpenAIAgentClient):
    """Agent client for any OpenAI-compatible **local** LLM server.

    Reuses the proven OpenAI tool-use loop verbatim and only swaps:
      - the base URL (Ollama / LM Studio / llama.cpp / vLLM / LocalAI),
      - the API key (optional — local servers usually accept any value; a
        placeholder is used so the inherited ``if not self._api_key`` guard
        passes),
      - the default model.

    The OpenAI-only ``reasoning_effort`` / ``prompt_cache_key`` payload params
    are not part of these servers' compatibility layer, so they are forced off.
    """

    def __init__(
        self,
        model: str = "llama3.3",
        system_prompt: str | None = None,
        max_turns: int = 50,
        project_dir: str | None = None,
        agent_type: str = "coder",
        base_url: str | None = None,
        api_format: str = "ollama",
        offline_only: bool = False,
        reasoning_effort: str | None = None,  # accepted for parity; unused locally
        prompt_cache_key: str | None = None,  # accepted for parity; unused locally
        spec_dir: str | None = None,
    ):
        import os as _os

        from ollama_model_detector import is_embedding_model

        if is_embedding_model(model or ""):
            raise ValueError(
                f"Model {model!r} is an embedding model and cannot run agent tasks. "
                "Select a text-generation model with tool support."
            )

        super().__init__(
            model=model or "llama3.3",
            system_prompt=system_prompt,
            max_turns=max_turns,
            project_dir=project_dir,
            agent_type=agent_type,
            reasoning_effort=None,
            prompt_cache_key=None,
            spec_dir=spec_dir,
        )
        # Optional key — local servers don't need one. Placeholder keeps the
        # inherited missing-key guard from aborting; "Bearer local" is harmless.
        self._api_key = (
            _os.environ.get("OLLAMA_API_KEY")
            or _os.environ.get("LOCAL_LLM_API_KEY")
            or _os.environ.get("LMSTUDIO_API_KEY")
            or "local"
        )
        self._api_base = _resolve_local_base_url(base_url)
        self._api_format = api_format
        self._offline_only = offline_only
        # A large local model in non-streaming mode can legitimately take
        # minutes to produce a full completion; the aiohttp default (5 min)
        # would cut healthy slow turns. Generous, env-overridable ceiling.
        self._request_timeout = _env_float("LOCAL_LLM_REQUEST_TIMEOUT", 600.0)
        self._initial_output_timeout = _env_float(
            "LOCAL_LLM_INITIAL_OUTPUT_TIMEOUT", 300.0
        )
        self._generation_idle_timeout = _env_float(
            "LOCAL_LLM_GENERATION_IDLE_TIMEOUT", 120.0
        )
        # Context window, resolved once per session from the real prompt size
        # (see _resolve_num_ctx) and then held stable: Ollama reloads the model
        # whenever num_ctx changes, so varying it per turn costs a full reload.
        self._resolved_num_ctx: int | None = None
        self._model_max_ctx: Any = _UNSET
        # Set True by receive_response() when the model is offered tools but
        # emits none on the first turn (not even as recoverable inline JSON) —
        # the tell-tale of a model without Ollama tool-calling support. Agentic
        # phases (QA, coding, planning) read this to halt fast instead of
        # retrying a model that can only ever hallucinate. See
        # services.rate_limit_shield.handle_local_model_no_tools.
        self.tool_calling_unsupported = False

    def _get_http_client(self):
        """Lazy-init an aiohttp ClientSession with a generous local timeout."""
        if self._http_client is None:
            try:
                import aiohttp

                timeout = aiohttp.ClientTimeout(
                    total=self._request_timeout, sock_connect=20.0
                )
                self._http_client = aiohttp.ClientSession(
                    headers={
                        "Content-Type": CONTENT_TYPE_JSON,
                        "Accept": CONTENT_TYPE_JSON,
                    },
                    timeout=timeout,
                )
            except ImportError:
                raise ImportError(
                    "aiohttp is required for LocalAgentClient. "
                    "Install it with: pip install aiohttp"
                )
        return self._http_client

    def provider_name(self) -> str:
        return "ollama"

    async def resume(self, history: list[AgentMessage]) -> None:
        """Truncate a replayed transcript to fit the local context window.

        Local servers load models with a modest context (``num_ctx``; the managed
        launcher raises the floor to 8192). Replaying a long transcript — e.g.
        150+ messages after switching from Claude mid-task — overflows it and the
        request fails with ``exceeds the available context size``. Drop the oldest
        messages until the rendered preamble fits a conservative budget derived
        from ``OLLAMA_CONTEXT_LENGTH``. Mirrors ``CopilotAgentClient.resume``.
        """
        if not history:
            await super().resume(history)
            return

        import os as _os

        try:
            ctx_tokens = int(_os.environ.get("OLLAMA_CONTEXT_LENGTH", "8192"))
        except (TypeError, ValueError):
            ctx_tokens = 8192
        # Spend ~55 % of the window on replayed history; reserve the rest for the
        # system prompt, tool definitions, the current turn and the reply.
        # ~3 chars/token is a safe average for mixed code + prose.
        char_limit = max(512, int(ctx_tokens * 0.55)) * 3

        truncated = list(history)
        while len(truncated) > 1:
            if len(self._format_history_as_preamble(truncated)) <= char_limit:
                break
            truncated = truncated[1:]  # drop oldest

        dropped = len(history) - len(truncated)
        if dropped:
            logger.warning(
                "[LocalAgentClient] History truncated on provider switch: dropped "
                "%d oldest message(s) to fit the local context window "
                "(~%d tokens, %d → %d messages).",
                dropped,
                ctx_tokens,
                len(history),
                len(truncated),
            )
            print(
                f"[LocalAgentClient] ⚠️  Historique tronqué : {dropped} ancien(s) "
                f"message(s) retiré(s) pour tenir dans le contexte local "
                f"(~{ctx_tokens} tokens).",
                flush=True,
            )

        await super().resume(truncated)

    def _native_chat_url(self) -> str:
        """Ollama's native chat endpoint (root of the OpenAI-compatible base)."""
        root = self._api_base.split("/v1/")[0] or self._api_base
        return f"{root.rstrip('/')}/api/chat"

    def _num_ctx(self) -> int:
        """The context window this session runs in.

        Resolved once per session by :meth:`_resolve_num_ctx` and cached, so the
        value the budgets below are derived from is the value actually sent to
        the server — and so every turn asks for the SAME window. Ollama keys its
        loaded model on the options it was given, so changing ``num_ctx``
        mid-conversation evicts and reloads the weights: on a 70B that is
        minutes, per turn.

        Before resolution it reports the floor rather than the ceiling: a budget
        derived from a window we have not asked for yet would be sized for
        memory the session may never get.
        """
        return self._resolved_num_ctx or self._num_ctx_floor()

    @staticmethod
    def _num_ctx_floor() -> int:
        """Smallest window worth loading a model in — Ollama's own default is
        4096, which no agent prompt has ever fitted in."""
        return 8192

    def _num_ctx_ceiling(self) -> int:
        """The largest window this session may request.

        ``OLLAMA_CONTEXT_LENGTH`` used to be the window itself. It is now the
        ceiling, because a fixed window is wrong in both directions: 8192 was
        too small for every agent phase (a *complexity assessment* — the
        smallest one, six tools — measures ~8.2k tokens), and raising the
        constant would make every session pay for a KV cache it does not need.
        A user who had set the variable still gets at most what they asked for.
        """
        import os as _os

        raw = (_os.environ.get("OLLAMA_CONTEXT_LENGTH") or "").strip()
        if raw:
            try:
                return max(self._num_ctx_floor(), int(raw))
            except (TypeError, ValueError):
                logger.warning(
                    "[LocalAgentClient] OLLAMA_CONTEXT_LENGTH=%r is not a "
                    "number — ignoring it.",
                    raw,
                )
        # Unset: as much as the model itself advertises, held to a size a
        # consumer machine can actually allocate. The KV cache grows linearly
        # with the window, so an unbounded default is an out-of-memory waiting
        # for a big model.
        return min(
            self._model_max_context() or _LOCAL_NUM_CTX_DEFAULT_CAP,
            _LOCAL_NUM_CTX_DEFAULT_CAP,
        )

    def _resolve_num_ctx(self, prompt_tokens_est: int) -> int:
        """Size the window to THIS session's prompt, within the ceiling.

        Asking for the ceiling every time would allocate a KV cache nobody uses;
        asking for a constant is how an 8.2k-token prompt met an 8192-token
        window and got its head silently cut off — system prompt included.
        Rounded up to a power of two because that is how these windows are
        talked about, and because it keeps the request stable across the small
        prompt variations of consecutive runs (a different window means another
        model load).
        """
        ceiling = self._num_ctx_ceiling()
        needed = prompt_tokens_est + _LOCAL_NUM_CTX_REPLY_HEADROOM
        size = self._num_ctx_floor()
        while size < needed and size < ceiling:
            size *= 2
        self._resolved_num_ctx = min(max(size, self._num_ctx_floor()), ceiling)
        return self._resolved_num_ctx

    def _loaded_model_placement(self) -> dict[str, Any] | None:
        """Where Ollama actually put this model, via ``/api/ps``.

        ``size`` is what the loaded model weighs, ``size_vram`` how much of it
        is on the GPU. Ollama never refuses a model that does not fit — it runs
        the layers that fit and leaves the rest on the CPU — so this difference
        is the only place the difference between "fast" and "hours per turn"
        is visible at all.

        Three outcomes, and the caller must tell them apart:

        * ``{"loaded": True, "size", "size_vram", "parameter_size"}`` — the
          model is resident, and the split says whether it fits.
        * ``{"loaded": False, "others": [...]}`` — the server answered and our
          model is NOT among the loaded ones. Surprising while a request is in
          flight, and the single most informative thing the log can say: either
          the weights are still being read off disk, or the app is talking to a
          different server than the one the user's CLI shows.
        * ``None`` — no answer at all (older Ollama, LM Studio, server down).

        Returning ``None`` for the middle case is what made the first version of
        this probe silent in exactly the situation that prompted it.
        """
        try:
            import json as _json
            import urllib.request as _req

            with _req.urlopen(  # noqa: S310
                f"{self._server_root()}/api/ps", timeout=3
            ) as response:
                data = _json.loads(response.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 - advisory only
            logger.debug("[LocalAgentClient] /api/ps unavailable: %s", exc)
            return None

        wanted = _canonical_local_model(self.model)
        others: list[str] = []
        for entry in data.get("models") or []:
            name = entry.get("model") or entry.get("name") or ""
            if _canonical_local_model(name) != wanted:
                if name:
                    others.append(name)
                continue
            return {
                "loaded": True,
                "size": int(entry.get("size") or 0),
                "size_vram": int(entry.get("size_vram") or 0),
                "parameter_size": (entry.get("details") or {}).get("parameter_size"),
            }
        return {"loaded": False, "others": others}

    def _server_root(self) -> str:
        """The server's root URL, without the OpenAI-compat path."""
        root = self._api_base.split("/v1/")[0] or self._api_base
        return root.rstrip("/")

    def _model_max_context(self) -> int | None:
        """The context length the model itself advertises, via ``/api/show``.

        Best-effort and cached: no server, an older Ollama, or LM Studio (which
        has no ``/api/show``) all return ``None`` and the caller falls back to
        the default cap. Synchronous on purpose — it runs once, before the first
        request, and a blocking 3-second call to localhost costs less than the
        machinery to make it async.
        """
        if self._model_max_ctx is not _UNSET:
            return self._model_max_ctx

        self._model_max_ctx = None
        try:
            import json as _json
            import urllib.request as _req

            request = _req.Request(
                f"{self._server_root()}/api/show",
                data=_json.dumps({"name": self.model}).encode("utf-8"),
                headers={"Content-Type": CONTENT_TYPE_JSON},
                method="POST",
            )
            with _req.urlopen(request, timeout=3) as response:  # noqa: S310
                info = _json.loads(response.read().decode("utf-8"))
            model_info = info.get("model_info") or {}
            # The key is architecture-prefixed: "llama.context_length",
            # "qwen2.context_length"… Take whichever one is there rather than
            # guessing the architecture.
            for key, value in model_info.items():
                if key.endswith(".context_length") and isinstance(value, int):
                    self._model_max_ctx = value
                    break
        except Exception as exc:  # noqa: BLE001 - advisory only
            logger.debug("[LocalAgentClient] /api/show unavailable: %s", exc)
        return self._model_max_ctx

    # Roughly how many characters one token of mixed code + prose costs. Used
    # to express the token-denominated context window in the character budgets
    # the shared history helpers work in.
    _CHARS_PER_TOKEN = 3

    def _local_history_budget(self) -> int:
        """Char budget before stale tool results are elided, sized to num_ctx.

        ``compact_messages`` defaults to ~300k chars (≈75k tokens) — chosen so a
        hosted model with a 200k window never pays for compaction it does not
        need. A local model runs in 8k. At the default the conversation blew
        past ``num_ctx`` roughly ten times over before compaction so much as
        looked at it, Ollama silently dropped the head of the prompt (the system
        prompt and the task with it), and the model carried on answering a
        question nobody had asked. Half the window, never above the shared
        default.
        """
        return min(
            history_char_budget(),
            max(20_000, int(self._num_ctx() * 0.5) * self._CHARS_PER_TOKEN),
        )

    def _local_tool_result_cap(self) -> int:
        """Max chars of one tool result kept in context, sized to num_ctx.

        The shared cap is 10k chars — about 40 % of an 8k-token window for a
        single file read, which is how three reads in a row ended a turn with no
        room left for the answer.
        """
        return min(
            tool_result_max_chars(),
            max(2_000, int(self._num_ctx() * 0.2) * self._CHARS_PER_TOKEN),
        )

    @staticmethod
    def _format_duration(seconds: int) -> str:
        """`90` → "1 min 30 s". Used by the generation heartbeat."""
        return _format_duration_fr(seconds)

    @staticmethod
    def _format_bytes(n: float) -> str:
        """Human-readable byte count (Go/Mo), for pull-progress lines."""
        return _format_bytes_fr(n)

    @staticmethod
    def _explain_pull_error(model: str, raw: str) -> str:
        """Turn Ollama's pull error into something the user can act on.

        ``pull model manifest: file does not exist`` is the message Ollama
        returns for ANY name its registry does not know — a typo, a Hugging Face
        repo with no GGUF build, or (the case that produced this function) a
        hosted model id that was never a local model at all. On its own it names
        no cause and no fix.
        """
        detail = " ".join((raw or "").split())
        low = detail.lower()
        if "manifest" in low or "not found" in low or "file does not exist" in low:
            return (
                f"« {model} » est introuvable dans la bibliothèque Ollama. "
                "Vérifiez le nom du modèle (ollama.com/library), ou choisissez "
                "un modèle installé dans le sélecteur de la phase. "
                f"Détail : {detail}"
            )
        if "gguf" in low:
            return (
                f"« {model} » ne fournit pas de version GGUF (requise par Ollama). "
                f"Choisissez un dépôt « -GGUF ». Détail : {detail}"
            )
        if "no space" in low or "disk" in low:
            return (
                f"Espace disque insuffisant pour télécharger « {model} ». "
                f"Détail : {detail}"
            )
        if "no such file or directory" in low or "partial" in low:
            return (
                f"Le cache Ollama de « {model} » est incohérent (un fichier "
                "temporaire a disparu en cours de route). Relancez le "
                "téléchargement ; si cela persiste, `ollama rm " + model + "` "
                f"puis réessayez. Détail : {detail}"
            )
        return detail or "erreur inconnue"

    async def _model_is_installed(self) -> bool:
        """Is ``self.model`` on the local server right now?

        Mirrors ``ollama_model_detector.model_is_installed``: Ollama tags carry
        an explicit version (``llama3.3:latest``) while the configured name
        usually does not, so a bare name matches its ``:latest`` tag.
        """
        import aiohttp

        root = self._api_base.split("/v1/")[0] or self._api_base
        wanted = (self.model or "").strip().lower()
        if not wanted:
            return False
        try:
            async with self._get_http_client().get(
                f"{root.rstrip('/')}/api/tags",
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status != 200:
                    return False
                data = await resp.json()
        except Exception:  # noqa: BLE001 — a probe, never fatal
            return False
        for entry in data.get("models") or []:
            name = str(entry.get("name", "")).strip().lower()
            # Bare name ≡ `:latest`, and only that: with just `llama3.3:70b`
            # on disk, `llama3.3` still sends Ollama to fetch `:latest`.
            if name == wanted or name == f"{wanted}:latest":
                return True
        return False

    async def _pull_ollama_model_stream(
        self,
    ) -> AsyncIterator[tuple[str, str]]:
        """Pull ``self.model`` (Ollama API: POST /api/pull), streaming progress.

        Yields ``("progress", human_text)`` as the download advances, then
        exactly one terminal ``("done", "")`` or ``("error", message)``.

        Streaming matters more than it looks: a model is several gigabytes, and
        the non-streaming form left the task log frozen on "téléchargement
        automatique en cours" for the whole download with no way to tell a live
        pull from a hung one. Never raises.
        """
        if self._offline_only:
            yield "error", "Offline mode blocks automatic model downloads"
            return

        import json as _json
        import time as _time

        import aiohttp

        root = self._api_base.split("/v1/")[0] or self._api_base
        url = f"{root.rstrip('/')}/api/pull"
        # Emit at most one progress line every few seconds: the log is a
        # scrollback a person reads, not a progress bar, and Ollama streams
        # several updates per second.
        emit_interval = 5.0
        last_emit = 0.0
        try:
            async with self._get_http_client().post(
                url,
                json={"name": self.model, "stream": True},
                # No total cap: a 40 GB model on a slow link legitimately takes
                # longer than any fixed budget. `sock_read` is the real guard —
                # it fires when the server stops sending, which is what "stuck"
                # actually means.
                timeout=aiohttp.ClientTimeout(
                    total=None, sock_connect=20, sock_read=180
                ),
            ) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    yield "error", self._explain_pull_error(self.model, text)
                    return
                async for raw_line in resp.content:
                    line = raw_line.decode("utf-8", "replace").strip()
                    if not line:
                        continue
                    try:
                        chunk = _json.loads(line)
                    except _json.JSONDecodeError:
                        continue
                    if chunk.get("error"):
                        # Ollama reports housekeeping failures the same way it
                        # reports real ones: a pull that fetched every layer and
                        # then failed to unlink a `-partial` blob ends with
                        # "no such file or directory". The model is usable, so
                        # the only honest answer is the one the server gives.
                        if await self._model_is_installed():
                            yield "done", ""
                            return
                        yield (
                            "error",
                            self._explain_pull_error(self.model, chunk["error"]),
                        )
                        return
                    completed = chunk.get("completed")
                    total = chunk.get("total")
                    now = _time.monotonic()
                    if (
                        isinstance(completed, (int, float))
                        and isinstance(total, (int, float))
                        and total > 0
                        and now - last_emit >= emit_interval
                    ):
                        last_emit = now
                        pct = int(completed / total * 100)
                        yield (
                            "progress",
                            f"📥 « {self.model} » — {pct}% "
                            f"({self._format_bytes(completed)} / "
                            f"{self._format_bytes(total)})",
                        )
            yield "done", ""
        except Exception as e:  # noqa: BLE001 — surface as a soft failure
            # A dropped connection after the last layer landed looks identical
            # here to one that dropped mid-transfer; ask the server which it was.
            if await self._model_is_installed():
                yield "done", ""
                return
            yield "error", self._explain_pull_error(self.model, str(e))

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        """Run the tool-use loop against Ollama's NATIVE ``/api/chat`` endpoint.

        Why not the inherited OpenAI loop: Ollama's OpenAI-compatible endpoint
        ignores ``num_ctx``, so models load with a 4096-token window and large
        agent prompts fail with "exceeds the available context size". The native
        API accepts ``options.num_ctx`` per request — the only way to set context
        that works for ANY server (system or app-managed) and any model name
        (including ``hf.co/org/model``), with no model re-creation or restart.

        Message/tool shapes stay native throughout (tool-call arguments are
        objects, tool results use ``role: "tool"``), so multi-turn tool calling
        round-trips correctly.
        """
        if self._api_format == "openai":
            async for message in super().receive_response():
                yield message
            return

        import json as _json

        if not self._pending_query:
            return

        prompt = self._pending_query
        self._pending_query = None
        # Fresh session: clear any stale "no tool calling" verdict from a prior
        # receive_response() on a reused client.
        self.tool_calling_unsupported = False

        def _system_text(text: str) -> AgentMessage:
            """A one-line status message for the task log."""
            return AgentMessage(
                role=MessageRole.SYSTEM,
                content=[ContentBlock(type=ContentBlockType.TEXT, text=text)],
            )

        messages: list[dict[str, Any]] = []
        if self.system_prompt:
            messages.append({"role": "system", "content": self.system_prompt})
        self._consume_resumed_history_as_system_message(messages)
        messages.append({"role": "user", "content": prompt})

        # Tool definitions use the same {type:function, function:{…}} shape the
        # native API accepts.
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

        url = self._native_chat_url()
        # Sized to the prompt we are about to send, not to a constant. Resolved
        # BEFORE the first request and reused for every turn (see _num_ctx).
        prompt_tokens_est = (
            sum(len(str(m.get("content") or "")) for m in messages)
            + len(_json.dumps(self._tool_definitions))
        ) // self._CHARS_PER_TOKEN
        num_ctx = self._resolve_num_ctx(prompt_tokens_est)
        session = self._get_http_client()
        _total_in = 0
        _total_out = 0
        # Pull-on-demand guard: if the requested model isn't installed, we pull
        # it once (it may be a library name like "qwen2.5-coder" the user never
        # ran `ollama pull` on) and retry, instead of failing with a 404.
        model_pull_attempted = False
        # Tool-use coaxing: a tools-capable local model that only narrates gets
        # ONE explicit "call the tools" nudge before we declare it unable to act.
        any_tool_called = False
        tool_use_nudge_sent = False
        # Stream the turn unless the server (or the user, via OLLAMA_STREAM=0)
        # says otherwise. Cleared on the one documented failure mode below.
        stream_chunks = _env_flag("OLLAMA_STREAM", True)
        # One /api/ps diagnosis per session, on the first turn that stalls.
        placement_reported = False
        # Transient-connection guard: a freshly auto-started or model-reloading
        # server can briefly refuse a connection. Retry a few times (reset on any
        # success) before declaring "Ollama ne répond pas".
        connect_retries = 0

        logger.info(
            f"[LocalAgentClient] Starting session (model={self.model}, "
            f"tools={len(tools)}, num_ctx={num_ctx})"
        )
        print(
            f"[LocalAgentClient] 🤖 Starting Ollama session "
            f"(model={self.model}, {len(tools)} tools, num_ctx={num_ctx})",
            flush=True,
        )

        # What the first request will cost, before it is sent. A prompt that
        # does not fit is the single most common way a local build stalls, and
        # the server's own answer to it — silently dropping the head of the
        # context — leaves no trace anyone can act on. Say the number instead.
        yield _system_text(
            f"📐 Contexte envoyé : ~{prompt_tokens_est} tokens estimés pour une "
            f"fenêtre de {num_ctx} (modèle « {self.model} », {len(tools)} outils, "
            f"serveur {self._server_root()})."
        )
        if prompt_tokens_est + _LOCAL_NUM_CTX_REPLY_HEADROOM > num_ctx:
            model_max = self._model_max_context()
            logger.warning(
                "[LocalAgentClient] Estimated prompt (~%d tokens) does not fit "
                "num_ctx=%d (model max=%s) — the server will truncate it.",
                prompt_tokens_est,
                num_ctx,
                model_max,
            )
            # Name the ceiling that bound it, because the two cases have
            # different remedies: a model that cannot go wider is a model to
            # change, a cap we chose is a cap to raise.
            if model_max is not None and model_max <= num_ctx:
                why = (
                    f"« {self.model} » ne gère pas plus de {model_max} tokens : "
                    "choisissez un modèle à plus grande fenêtre"
                )
            else:
                why = (
                    "relevez le plafond avec OLLAMA_CONTEXT_LENGTH (variable "
                    "d'environnement, ou une ligne dans .env-files/.env à créer "
                    "à la racine du dépôt — voir .env.example)"
                )
            yield _system_text(
                f"⚠️ Le prompt (~{prompt_tokens_est} tokens) ne tient pas dans "
                f"la fenêtre de {num_ctx} : le serveur en coupera le début, "
                f"consignes système comprises. Pour corriger : {why}, ou "
                "baissez l'effort de réflexion de cette phase."
            )

        for turn in range(self.max_turns):
            payload: dict[str, Any] = {
                "model": self.model,
                "messages": messages,
                # Streamed so the heartbeat can report real output instead of
                # elapsed time; see _format_generation_progress. Cleared below
                # if the server turns out not to support streaming with tools.
                "stream": stream_chunks,
                "options": {"num_ctx": num_ctx},
            }
            if tools:
                payload["tools"] = tools

            try:
                import asyncio as _asyncio
                import time as _time

                import aiohttp as _aiohttp

                # Accumulator the reader task fills and the heartbeat reads.
                acc: dict[str, Any] = {
                    "content": "",
                    "tool_calls": [],
                    "tokens": 0,
                    "status": None,
                    "error_body": "",
                    "last_output_at": _time.monotonic(),
                }

                async def _post_chat(
                    turn_payload: dict[str, Any] = payload,
                    sink: dict[str, Any] = acc,
                ) -> None:
                    """One chat turn, folded into `sink` as it arrives.

                    `turn_payload` and `sink` are default arguments so the
                    coroutine binds THIS turn's objects rather than the loop
                    variables.
                    """
                    async with session.post(
                        url,
                        json=turn_payload,
                        allow_redirects=False,
                        # Overrides the session's 5-minute default; see
                        # _LOCAL_CHAT_SOCK_READ_TIMEOUT.
                        timeout=_aiohttp.ClientTimeout(
                            total=self._request_timeout,
                            sock_connect=_LOCAL_CHAT_CONNECT_TIMEOUT,
                            sock_read=_LOCAL_CHAT_SOCK_READ_TIMEOUT,
                        ),
                    ) as resp:
                        sink["status"] = resp.status
                        if resp.status != 200:
                            sink["error_body"] = await resp.text()
                            return
                        # Streaming sends NDJSON, one object per token batch;
                        # non-streaming sends a single object of the same shape
                        # on one line. Both fold through _merge_native_chunk.
                        async for raw_line in resp.content:
                            line = raw_line.strip()
                            if not line:
                                continue
                            try:
                                chunk = _json.loads(line)
                            except ValueError:
                                continue
                            if _merge_native_chunk(sink, chunk):
                                sink["last_output_at"] = _time.monotonic()
                            if sink.get("done") or sink.get("error"):
                                break

                # A local model can work for minutes with nothing to show. The
                # heartbeat reports what the reader has actually accumulated —
                # which turn, how many tokens, how long since the last one — so
                # a slow run and a wedged one no longer print the same line.
                request = _asyncio.ensure_future(_post_chat())
                started_at = _time.monotonic()
                try:
                    while True:
                        finished, _pending = await _asyncio.wait(
                            {request}, timeout=_LOCAL_HEARTBEAT_SECONDS
                        )
                        if finished:
                            break
                        now = _time.monotonic()
                        elapsed = int(now - started_at)
                        has_output = bool(acc.get("tokens") or acc.get("tool_calls"))
                        silence_limit = (
                            self._generation_idle_timeout
                            if has_output and stream_chunks
                            else self._initial_output_timeout
                        )
                        if (
                            now - started_at >= self._request_timeout
                            or now - acc["last_output_at"] >= silence_limit
                        ):
                            raise LocalModelRuntimeError(
                                f"Génération locale interrompue pour « {self.model} » : délai dépassé "
                                f"({int(now - started_at)} s, {int(now - acc['last_output_at'])} s sans sortie). "
                                "Choisissez un modèle plus petit ou vérifiez les ressources du serveur, puis relancez."
                            )
                        # On the first heartbeat that has nothing to show, ask the
                        # server where it put the model. At 30 seconds, not at five
                        # minutes: a model running on the CPU is knowable as soon as
                        # it is loaded, and the four wasted minutes were the point of
                        # the complaint. Latched only once an answer comes back —
                        # the model may still be loading on the first pass — and
                        # never retried after that: it cannot change while the model
                        # stays resident, and a heartbeat must not become a poller.
                        if not placement_reported:
                            placement = self._loaded_model_placement()
                            if placement and placement["loaded"]:
                                placement_reported = True
                                logger.info(
                                    "[LocalAgentClient] %s loaded with "
                                    "%d/%d bytes in VRAM.",
                                    self.model,
                                    placement["size_vram"],
                                    placement["size"],
                                )
                                yield _system_text(
                                    _format_placement_diagnosis(
                                        self.model,
                                        size=placement["size"],
                                        size_vram=placement["size_vram"],
                                        parameter_size=placement["parameter_size"],
                                    )
                                )
                            elif placement and elapsed >= _LOCAL_NOT_LOADED_GRACE:
                                # Not resident yet. Said once, and only after a grace
                                # period, because a model genuinely being read off
                                # disk occupies this state for a while and a warning
                                # on the first heartbeat would cry wolf every run.
                                placement_reported = True
                                logger.warning(
                                    "[LocalAgentClient] %s is not loaded on %s after "
                                    "%ds; loaded there: %s",
                                    self.model,
                                    self._server_root(),
                                    elapsed,
                                    placement["others"] or "none",
                                )
                                yield _system_text(
                                    _format_not_loaded_diagnosis(
                                        self.model,
                                        server_root=self._server_root(),
                                        others=placement["others"],
                                    )
                                )
                        yield _system_text(
                            _format_generation_progress(
                                self.model,
                                turn=turn + 1,
                                max_turns=self.max_turns,
                                elapsed=elapsed,
                                tokens=int(acc.get("tokens", 0)),
                                silent_for=int(now - acc["last_output_at"]),
                                streaming=stream_chunks,
                            )
                        )
                    request.result()  # re-raise transport failures below
                finally:
                    if not request.done():
                        request.cancel()
                        try:
                            await request
                        except _asyncio.CancelledError:
                            # Expected after request.cancel(): await reader cleanup
                            # without replacing the original failure or cancellation.
                            pass

                status = acc.get("status") or 0
                if status != 200:
                    error_text = acc.get("error_body", "")
                    # Model not installed → pull it once, then retry the turn.
                    if "not found" in error_text.lower() and not model_pull_attempted:
                        model_pull_attempted = True

                        # A hosted-only id can never be pulled: asking the
                        # Ollama registry for a Claude manifest is a round
                        # trip whose only possible outcome is "file does not
                        # exist". Say what is actually wrong instead.
                        from phase_config import is_hosted_only_model

                        if is_hosted_only_model(self.model):
                            logger.error(
                                "[LocalAgentClient] %s is a hosted-only model; "
                                "refusing to pull it from the Ollama registry.",
                                self.model,
                            )
                            yield _system_text(
                                f"« {self.model} » est un modèle d'API "
                                "(Claude/GPT/Gemini) : il ne peut pas "
                                "s'exécuter sur un serveur local. Choisissez "
                                "un modèle Ollama dans le sélecteur de la "
                                "phase, ou changez le fournisseur de la tâche."
                            )
                            return

                        logger.warning(
                            "[LocalAgentClient] Model %s not installed — "
                            "pulling on demand.",
                            self.model,
                        )
                        yield _system_text(
                            f"📥 Modèle « {self.model} » non installé "
                            "— téléchargement automatique en cours "
                            "(cela peut prendre plusieurs minutes)…"
                        )
                        pulled = False
                        pull_err = "téléchargement interrompu"
                        async for kind, detail in self._pull_ollama_model_stream():
                            if kind == "progress":
                                yield _system_text(detail)
                            elif kind == "done":
                                pulled = True
                            else:
                                pull_err = detail
                        if pulled:
                            yield _system_text(
                                f"✅ Modèle « {self.model} » téléchargé — "
                                "reprise de la phase."
                            )
                            continue  # retry the same turn now that it exists
                        yield _system_text(
                            f"Échec du téléchargement du modèle "
                            f"« {self.model} » : {pull_err}"
                        )
                        return
                    # Tool calling over a streamed response is recent in Ollama.
                    # A server too old to do both refuses the request rather
                    # than degrading, so fall back once to a single-shot turn
                    # instead of failing the phase. Same code path either way —
                    # only the heartbeat loses its token counter.
                    if stream_chunks and "stream" in error_text.lower():
                        stream_chunks = False
                        logger.warning(
                            "[LocalAgentClient] Server rejected a streamed "
                            "tool-calling turn (%s) — retrying without streaming.",
                            error_text[:200],
                        )
                        continue
                    logger.error(
                        f"[LocalAgentClient] API error ({status}): {error_text[:500]}"
                    )
                    raise LocalModelRuntimeError(
                        f"Ollama API error ({status}): {error_text}"
                    )
                # Ollama can also report a failure mid-stream, with HTTP 200
                # already sent. Surface it the same way rather than treating the
                # truncated content as a finished turn.
                if acc.get("error"):
                    logger.error(
                        "[LocalAgentClient] Stream error: %s", acc["error"][:500]
                    )
                    raise LocalModelRuntimeError(f"Ollama API error: {acc['error']}")
                if not acc.get("done"):
                    raise LocalModelRuntimeError(
                        "Ollama a fermé le flux avant la fin de la réponse."
                    )
                data = {
                    "message": {
                        "content": acc.get("content", ""),
                        "tool_calls": acc.get("tool_calls") or [],
                    },
                    "prompt_eval_count": acc.get("prompt_eval_count", 0),
                    "eval_count": acc.get("eval_count", 0),
                }
            except Exception as e:
                # A connection failure can be transient — the server may be cold-
                # starting (just auto-launched) or reloading a model. Retry a few
                # times with backoff before declaring it down, so a healthy but
                # momentarily-unavailable Ollama doesn't surface "ne répond pas".
                if (
                    not isinstance(e, (TimeoutError, LocalModelRuntimeError))
                    and self._is_connection_error(e)
                    and connect_retries < _LOCAL_MAX_CONNECT_RETRIES
                ):
                    import asyncio as _asyncio

                    connect_retries += 1
                    logger.warning(
                        "[LocalAgentClient] Connection to %s failed (%s) — "
                        "retry %d/%d after backoff.",
                        url,
                        e,
                        connect_retries,
                        _LOCAL_MAX_CONNECT_RETRIES,
                    )
                    await _asyncio.sleep(1.5 * connect_retries)
                    continue
                logger.error(f"[LocalAgentClient] Request failed: {e}")
                if isinstance(e, LocalModelRuntimeError):
                    raise
                detail = (
                    self._describe_request_error(e) or "délai de génération dépassé"
                )
                raise LocalModelRuntimeError(
                    f"Génération locale interrompue : {detail}"
                ) from e

            # Reached the server this turn — clear the transient-failure counter.
            connect_retries = 0
            _total_in += int(data.get("prompt_eval_count", 0) or 0)
            _total_out += int(data.get("eval_count", 0) or 0)

            message = data.get("message") or {}
            content = message.get("content") or ""
            tool_calls = message.get("tool_calls") or []

            # Fallback for local models that emit tool calls as JSON inside the
            # message *content* instead of the structured tool_calls field (very
            # common for GGUF/qwen on Ollama). Recover them so the agent can act
            # instead of looping with "the model called no tool".
            if not tool_calls and content:
                recovered = _extract_text_tool_calls(
                    content, {td.get("name", "") for td in self._tool_definitions}
                )
                if recovered:
                    logger.info(
                        "[LocalAgentClient] Recovered %d tool call(s) from inline "
                        "text content.",
                        len(recovered),
                    )
                    tool_calls = recovered
                    # Keep any narration that PRECEDED the tool-call payload so the
                    # model's reasoning is still logged (activity feed +
                    # conversation transcript) instead of being silently dropped.
                    # Cut from the first JSON ('{'/'[') or XML ('<tool') marker on.
                    _markers = [content.find("{"), content.find("[")]
                    _markers.append(content.lower().find("<tool"))
                    _cut = min((m for m in _markers if m >= 0), default=-1)
                    _head = (content[:_cut] if _cut >= 0 else content).strip()
                    content = _head if len(_head) >= 12 else ""

            logger.info(
                f"[LocalAgentClient] Turn {turn + 1}: content_len={len(content)}, "
                f"tool_calls={len(tool_calls)}"
            )

            if content:
                yield AgentMessage(
                    role=MessageRole.ASSISTANT,
                    content=[ContentBlock(type=ContentBlockType.TEXT, text=content)],
                )

            if not tool_calls:
                if not content:
                    yield AgentMessage(
                        role=MessageRole.ASSISTANT,
                        content=[
                            ContentBlock(
                                type=ContentBlockType.TEXT,
                                text="(No response from Ollama)",
                            )
                        ],
                    )

                action = _next_no_tool_action(
                    any_tool_called=any_tool_called,
                    tools_offered=bool(tools),
                    has_content=bool(content),
                    waiting_for_human=_looks_like_waiting_for_human(content),
                    nudge_sent=tool_use_nudge_sent,
                    turn=turn,
                    max_turns=self.max_turns,
                )

                # The model stalled — it narrated, printed file content, or asked
                # the (non-existent) human to run commands — and hasn't been
                # corrected yet → nudge once and retry. A tools-capable model
                # (qwen2.5-coder, llama3.1, …) usually just needs to be told to
                # act on its own rather than describe the work or wait for input.
                if action == "nudge":
                    tool_use_nudge_sent = True
                    logger.warning(
                        "[LocalAgentClient] Model %s replied without a tool call — "
                        "nudging once to use the tools instead of narrating.",
                        self.model,
                    )
                    messages.append({"role": "assistant", "content": content})
                    messages.append({"role": "user", "content": _TOOL_USE_NUDGE})
                    continue  # retry — don't burn the turn as a failure

                # Tools were offered, the model was nudged, and it STILL only
                # narrated → it can't drive tools for this task. Flag it (agentic
                # phases read this to halt fast) and surface an actionable hint.
                if action == "give_up":
                    logger.warning(
                        "[LocalAgentClient] Model %s emitted no tool call even after "
                        "a nudge — treating as unable to drive tools.",
                        self.model,
                    )
                    self.tool_calling_unsupported = True
                    yield AgentMessage(
                        role=MessageRole.SYSTEM,
                        content=[
                            ContentBlock(
                                type=ContentBlockType.TEXT,
                                text=(
                                    f"⚠️ Le modèle local « {self.model} » n'a appelé "
                                    "aucun outil alors que la tâche en exige (même après "
                                    "une relance). Il décrit le travail au lieu de "
                                    "l'exécuter. Passez cette phase à un modèle plus "
                                    "capable — un modèle local plus grand, ou un "
                                    "fournisseur cloud (Claude) — puis relancez."
                                ),
                            )
                        ],
                    )

                # action == "end" (finished or empty) falls through here too.
                self.last_usage = {
                    "input_tokens": _total_in,
                    "output_tokens": _total_out,
                    "cost_usd": 0.0,
                }
                return

            # A real tool call arrived: the model is acting. Keep the assistant
            # turn (native shape) in history for context.
            any_tool_called = True
            messages.append(
                {"role": "assistant", "content": content, "tool_calls": tool_calls}
            )

            for i, tc in enumerate(tool_calls):
                func = tc.get("function", {}) or {}
                tool_name = func.get("name", "")
                # Native arguments are already an object; tolerate a string too.
                raw_args = func.get("arguments", {})
                if isinstance(raw_args, str):
                    try:
                        args = _json.loads(raw_args or "{}")
                    except (_json.JSONDecodeError, TypeError):
                        args = {}
                else:
                    args = raw_args or {}
                tool_id = tc.get("id") or f"call_{turn}_{i}_{tool_name}"

                logger.info(
                    f"[LocalAgentClient] Turn {turn + 1}: "
                    f"tool_call {tool_name}({list(args.keys())})"
                )
                print(f"[LocalAgentClient] 🔧 Tool: {tool_name}", flush=True)

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

                result_text = ""
                is_error = False
                if self._mcp_manager is not None and self._mcp_manager.has_tool(
                    tool_name
                ):
                    try:
                        result = await self._mcp_manager.call(tool_name, args)
                        result_text = str(result) if result is not None else ""
                    except Exception as e:
                        result_text = f"MCP tool error: {e}"
                        is_error = True
                elif self._tool_executor:
                    try:
                        result = await self._tool_executor.execute(tool_name, args)
                        result_text = str(result) if result is not None else ""
                    except Exception as e:
                        result_text = f"Tool error: {e}"
                        is_error = True
                else:
                    result_text = "Tool executor not available"
                    is_error = True

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

                # Native tool result message.
                messages.append(
                    {
                        "role": "tool",
                        "tool_name": tool_name,
                        "content": truncate_tool_result(
                            result_text, limit=self._local_tool_result_cap()
                        ),
                    }
                )

            compacted = compact_messages(
                messages, char_budget=self._local_history_budget()
            )
            if compacted:
                logger.info(
                    f"[LocalAgentClient] History compaction: elided {compacted} "
                    "stale tool result(s)"
                )

        logger.warning(
            f"[LocalAgentClient] Reached max_turns ({self.max_turns}) — stopping"
        )
        self.last_usage = {
            "input_tokens": _total_in,
            "output_tokens": _total_out,
            "cost_usd": 0.0,
        }

    def _describe_request_error(self, exc: Exception) -> str:
        """Turn a raw connection failure into an actionable, localized hint.

        A local server that isn't running surfaces as a cryptic aiohttp
        "Cannot connect to host …" line. For a local LLM that almost always
        means the daemon isn't started, so we say exactly that and how to fix it.
        """
        if self._is_connection_error(exc):
            # Show the server root (strip the /v1/chat/completions suffix).
            root = self._api_base.split("/v1/")[0] or self._api_base
            return (
                f"⚠️ Ollama ne répond pas sur {root} — le serveur local n'est pas "
                "démarré. Ouvrez les réglages du fournisseur « Ollama (Local) » et "
                "cliquez « Télécharger » (installation et lancement "
                "automatiques), ou lancez « ollama serve » manuellement."
            )
        return f"Erreur API LLM local: {exc}"
