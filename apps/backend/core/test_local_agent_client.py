#!/usr/bin/env python3
"""
Tests for LocalAgentClient (OpenAI-compatible local LLM servers)
================================================================

Covers base-URL normalization, source-priority resolution, the optional-key
placeholder, provider identity, and the forced-off OpenAI-only payload params.
These are pure/offline checks — no local server is contacted.
"""

import pytest
from core.agent_client import (
    _LOCAL_STALL_SECONDS,
    LocalAgentClient,
    _env_flag,
    _extract_text_tool_calls,
    _format_generation_progress,
    _format_not_loaded_diagnosis,
    _format_placement_diagnosis,
    _looks_like_waiting_for_human,
    _merge_native_chunk,
    _next_no_tool_action,
    _normalize_local_base_url,
    _resolve_local_base_url,
)


class TestExtractTextToolCalls:
    """Recovering tool calls that a local model emitted as JSON text."""

    KNOWN = {"read_file", "write_file", "run_command"}

    def test_bare_json_object(self):
        content = '{"name": "read_file", "arguments": {"path": "./spec.md"}}'
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert out == [
            {"function": {"name": "read_file", "arguments": {"path": "./spec.md"}}}
        ]

    def test_fenced_json_block_in_prose(self):
        content = (
            "Sure, let me read the spec first:\n"
            '```json\n{"name": "read_file", "arguments": {"path": "spec.md"}}\n```\n'
        )
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert len(out) == 1
        assert out[0]["function"]["name"] == "read_file"

    def test_function_wrapper_shape(self):
        content = '{"function": {"name": "run_command", "arguments": {"cmd": "ls"}}}'
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert out[0]["function"]["arguments"] == {"cmd": "ls"}

    def test_unknown_tool_name_ignored(self):
        # A plain data object with a "name" key must NOT be taken as a tool call.
        out = _extract_text_tool_calls('{"name": "John", "age": 30}', self.KNOWN)
        assert out == []

    def test_string_arguments_are_parsed(self):
        content = '{"name": "read_file", "arguments": "{\\"path\\": \\"a.txt\\"}"}'
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert out[0]["function"]["arguments"] == {"path": "a.txt"}

    def test_no_known_tools_returns_empty(self):
        out = _extract_text_tool_calls('{"name": "read_file"}', set())
        assert out == []

    # ── XML-style tool calls (Windsurf <tool_call>, qwen/llama <tool_use>) ──

    def test_xml_tool_use_with_json_body(self):
        # The exact shape llama3.1 emitted: <tool_use name="..."> + JSON args.
        content = (
            '<tool_use name="write_file">\n'
            '{"path": "./build-progress.txt", "content": "ok"}\n'
            "</tool_use>"
        )
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert out == [
            {
                "function": {
                    "name": "write_file",
                    "arguments": {"path": "./build-progress.txt", "content": "ok"},
                }
            }
        ]

    def test_xml_tool_call_tag_and_prose_wrapper(self):
        content = (
            "Let me run the tests now.\n"
            '<tool_call name="run_command">{"command": "pytest -q"}</tool_call>\n'
            "Done."
        )
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert out[0]["function"]["name"] == "run_command"
        assert out[0]["function"]["arguments"] == {"command": "pytest -q"}

    def test_xml_unknown_tool_ignored(self):
        out = _extract_text_tool_calls(
            '<tool_use name="DropDatabase">{"x": 1}</tool_use>', self.KNOWN
        )
        assert out == []

    def test_xml_no_args_yields_empty_arguments(self):
        out = _extract_text_tool_calls(
            '<tool_use name="run_command"></tool_use>', self.KNOWN
        )
        assert out == [{"function": {"name": "run_command", "arguments": {}}}]

    def test_xml_and_json_deduplicated(self):
        # Same call expressed twice (XML + JSON) collapses to one.
        content = (
            '<tool_use name="read_file">{"path": "a.txt"}</tool_use>\n'
            '{"name": "read_file", "arguments": {"path": "a.txt"}}'
        )
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert out == [
            {"function": {"name": "read_file", "arguments": {"path": "a.txt"}}}
        ]

    # ── Lenient JSON + alt arg key (the exact llama3.1 planning failure) ──

    def test_recovers_over_escaped_apostrophe(self):
        # `\'` is INVALID JSON; a French "d'avertissement" over-escaped this way
        # made the whole Write call un-parseable and dropped. The lenient
        # fallback fixes it.
        content = r"""{"name": "write_file", "arguments": {"path": "x", "content": "d\'oh"}}"""
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert out == [
            {
                "function": {
                    "name": "write_file",
                    "arguments": {"path": "x", "content": "d'oh"},
                }
            }
        ]

    def test_recovers_parameters_key(self):
        # llama3.1 used "parameters" (not "arguments") — already supported, but
        # pin it since it was part of the dropped Write call.
        content = '{"name": "run_command", "parameters": {"command": "pytest -q"}}'
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert out[0]["function"]["arguments"] == {"command": "pytest -q"}

    def test_recovers_python_false_literal(self):
        # The exact llama3.1 failure: `"EmptyFile": False` is a Python bool, not
        # JSON — strict json.loads rejected it and dropped the whole Write. The
        # ast.literal_eval fallback recovers it (and keeps False a real bool).
        content = (
            '{"name": "write_file", "parameters": '
            '{"path": "p", "content": "x", "EmptyFile": False}}'
        )
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert out[0]["function"]["name"] == "write_file"
        assert out[0]["function"]["arguments"]["EmptyFile"] is False

    def test_recovers_single_quoted_python_dict(self):
        # Single-quoted "JSON" (invalid JSON, valid Python) also recovers.
        content = "{'name': 'run_command', 'arguments': {'command': 'ls'}}"
        out = _extract_text_tool_calls(content, self.KNOWN)
        assert out[0]["function"]["arguments"] == {"command": "ls"}


_LOCAL_ENV_VARS = (
    "OLLAMA_BASE_URL",
    "LOCAL_LLM_BASE_URL",
    "LMSTUDIO_BASE_URL",
    "OLLAMA_API_KEY",
    "LOCAL_LLM_API_KEY",
    "LMSTUDIO_API_KEY",
)


@pytest.fixture(autouse=True)
def _clear_local_env(monkeypatch):
    """Each test starts from a clean local-LLM env so results are deterministic."""
    for var in _LOCAL_ENV_VARS:
        monkeypatch.delenv(var, raising=False)


class TestNormalizeLocalBaseUrl:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            # bare root → append /v1/chat/completions; localhost pinned to IPv4
            ("http://localhost:11434", "http://127.0.0.1:11434/v1/chat/completions"),
            ("http://localhost:1234", "http://127.0.0.1:1234/v1/chat/completions"),
            # trailing slash tolerated
            ("http://localhost:1234/", "http://127.0.0.1:1234/v1/chat/completions"),
            # /v1 already present
            ("http://localhost:1234/v1", "http://127.0.0.1:1234/v1/chat/completions"),
            ("http://localhost:1234/v1/", "http://127.0.0.1:1234/v1/chat/completions"),
            # full path is idempotent (and still IPv4-pinned)
            (
                "http://localhost:1234/v1/chat/completions",
                "http://127.0.0.1:1234/v1/chat/completions",
            ),
            # an explicit 127.0.0.1 passes through unchanged
            (
                "http://127.0.0.1:11434",
                "http://127.0.0.1:11434/v1/chat/completions",
            ),
            # a non-loopback host is NOT rewritten
            (
                "http://192.168.1.50:11434",
                "http://192.168.1.50:11434/v1/chat/completions",
            ),
            # empty/None → IPv4 Ollama default
            ("", "http://127.0.0.1:11434/v1/chat/completions"),
            (None, "http://127.0.0.1:11434/v1/chat/completions"),
        ],
    )
    def test_normalization(self, raw, expected):
        assert _normalize_local_base_url(raw) == expected

    def test_localhost_without_port_is_pinned(self):
        # No explicit port: the loopback host is still rewritten to IPv4.
        assert (
            _normalize_local_base_url("http://localhost")
            == "http://127.0.0.1/v1/chat/completions"
        )

    def test_lookalike_host_not_rewritten(self):
        # "localhostfoo" is a different host — the boundary check must not touch it.
        assert _normalize_local_base_url("http://localhostfoo:11434").startswith(
            "http://localhostfoo:11434"
        )


class TestResolveLocalBaseUrl:
    def test_explicit_arg_wins(self, monkeypatch):
        monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:9999")
        assert (
            _resolve_local_base_url("http://localhost:1234")
            == "http://127.0.0.1:1234/v1/chat/completions"
        )

    def test_env_used_when_no_arg(self, monkeypatch):
        monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:1234")
        assert (
            _resolve_local_base_url(None) == "http://127.0.0.1:1234/v1/chat/completions"
        )

    def test_lmstudio_env_supported(self, monkeypatch):
        monkeypatch.setenv("LMSTUDIO_BASE_URL", "http://127.0.0.1:1234")
        assert (
            _resolve_local_base_url(None) == "http://127.0.0.1:1234/v1/chat/completions"
        )

    def test_default_when_nothing_set(self, monkeypatch):
        # No env, and force the saved-config lookup to yield nothing.
        monkeypatch.setattr(
            "core.agent_client._resolve_local_base_url",
            _resolve_local_base_url,
        )
        # load_provider_config may or may not exist on the host; the result must
        # still fall back to the Ollama default rather than raise.
        result = _resolve_local_base_url(None)
        assert result.endswith("/v1/chat/completions")


class TestLocalAgentClient:
    def test_provider_name_is_ollama(self):
        client = LocalAgentClient(model="qwen2.5-coder")
        assert client.provider_name() == "ollama"

    def test_tool_calling_unsupported_defaults_false(self):
        # The "this model can't tool-call" verdict starts unset; receive_response
        # flips it only after a turn-0 no-tool-call. handle_local_model_no_tools
        # reads it to halt agentic phases fast.
        client = LocalAgentClient(model="qwen2.5-coder")
        assert client.tool_calling_unsupported is False

    def test_base_url_from_env(self, monkeypatch):
        monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:1234")
        client = LocalAgentClient(model="qwen2.5-coder")
        assert client._api_base == "http://127.0.0.1:1234/v1/chat/completions"

    def test_explicit_base_url_arg(self):
        client = LocalAgentClient(model="m", base_url="http://localhost:8080/v1")
        assert client._api_base == "http://127.0.0.1:8080/v1/chat/completions"

    def test_api_key_placeholder_when_unset(self):
        client = LocalAgentClient(model="m")
        # Non-empty so the inherited missing-key guard doesn't abort the loop.
        assert client._api_key == "local"

    def test_api_key_from_env(self, monkeypatch):
        monkeypatch.setenv("OLLAMA_API_KEY", "secret-token")
        client = LocalAgentClient(model="m")
        assert client._api_key == "secret-token"

    def test_openai_only_params_forced_off(self):
        client = LocalAgentClient(
            model="m", reasoning_effort="high", prompt_cache_key="abc"
        )
        assert client._reasoning_effort is None
        assert client._prompt_cache_key is None

    def test_default_model(self):
        client = LocalAgentClient()
        assert client.model == "llama3.3"

    def test_native_chat_url_derived_from_base(self):
        client = LocalAgentClient(model="m", base_url="http://localhost:11434")
        assert client._native_chat_url() == "http://127.0.0.1:11434/api/chat"

    def test_native_chat_url_with_custom_port(self):
        client = LocalAgentClient(model="m", base_url="http://localhost:1234/v1")
        assert client._native_chat_url() == "http://127.0.0.1:1234/api/chat"

    def test_num_ctx_reports_the_floor_until_a_prompt_sizes_it(self, monkeypatch):
        # OLLAMA_CONTEXT_LENGTH is now the CEILING, not the window: until a
        # prompt has been measured, the session reports the floor so the
        # budgets derived from it are never sized for memory it may not get.
        # See TestNumCtxSizing for the resolution itself.
        monkeypatch.delenv("OLLAMA_CONTEXT_LENGTH", raising=False)
        assert LocalAgentClient(model="m")._num_ctx() == 8192
        monkeypatch.setenv("OLLAMA_CONTEXT_LENGTH", "16384")
        client = LocalAgentClient(model="m")
        assert client._num_ctx() == 8192
        client._model_max_ctx = 131_072
        assert client._resolve_num_ctx(500_000) == 16384
        assert client._num_ctx() == 16384

    def test_connection_error_message_is_friendly(self):
        """A connection failure is rephrased into an actionable Ollama hint."""
        client = LocalAgentClient(model="m", base_url="http://localhost:11434")
        msg = client._describe_request_error(
            OSError("Cannot connect to host localhost:11434 ssl:default")
        )
        assert "Ollama ne répond pas" in msg
        # The hint shows the IPv4-pinned root the client actually dials.
        assert "http://127.0.0.1:11434" in msg
        assert "Télécharger" in msg
        # The raw aiohttp text must not leak through.
        assert "ssl:default" not in msg

    def test_non_connection_error_passthrough(self):
        """A genuine API error (not a connection failure) keeps its detail."""
        client = LocalAgentClient(model="m")
        msg = client._describe_request_error(ValueError("model not found"))
        assert "model not found" in msg
        assert "Ollama ne répond pas" not in msg


class TestNextNoToolAction:
    """The decision for a turn that returned no tool call: end / nudge / give_up."""

    def test_empty_reply_ends(self):
        # No content at all → nothing to nudge against, just stop.
        assert (
            _next_no_tool_action(
                any_tool_called=False,
                tools_offered=True,
                has_content=False,
                waiting_for_human=False,
                nudge_sent=False,
                turn=0,
                max_turns=50,
            )
            == "end"
        )

    def test_finished_after_using_tools_ends(self):
        # The model acted earlier and now stops with prose (not waiting on a
        # human) → legitimately done.
        assert (
            _next_no_tool_action(
                any_tool_called=True,
                tools_offered=True,
                has_content=True,
                waiting_for_human=False,
                nudge_sent=False,
                turn=5,
                max_turns=50,
            )
            == "end"
        )

    def test_no_tools_offered_ends(self):
        # A text-only session (no tools) ending with prose is not a failure.
        assert (
            _next_no_tool_action(
                any_tool_called=False,
                tools_offered=False,
                has_content=True,
                waiting_for_human=False,
                nudge_sent=False,
                turn=0,
                max_turns=50,
            )
            == "end"
        )

    def test_first_narration_triggers_nudge(self):
        # Tools offered, model narrated, never acted, not yet nudged → nudge once.
        assert (
            _next_no_tool_action(
                any_tool_called=False,
                tools_offered=True,
                has_content=True,
                waiting_for_human=False,
                nudge_sent=False,
                turn=0,
                max_turns=50,
            )
            == "nudge"
        )

    def test_waiting_for_human_after_acting_triggers_nudge(self):
        # Even after calling a tool, asking a human to run commands is a stall —
        # there is no human to answer, so nudge it to act on its own.
        assert (
            _next_no_tool_action(
                any_tool_called=True,
                tools_offered=True,
                has_content=True,
                waiting_for_human=True,
                nudge_sent=False,
                turn=2,
                max_turns=50,
            )
            == "nudge"
        )

    def test_waiting_for_human_after_nudge_gives_up(self):
        # Already nudged and still deferring to a human → unable to self-drive.
        assert (
            _next_no_tool_action(
                any_tool_called=True,
                tools_offered=True,
                has_content=True,
                waiting_for_human=True,
                nudge_sent=True,
                turn=3,
                max_turns=50,
            )
            == "give_up"
        )

    def test_narration_after_nudge_gives_up(self):
        # Already nudged and still only narrating → unable to drive tools.
        assert (
            _next_no_tool_action(
                any_tool_called=False,
                tools_offered=True,
                has_content=True,
                waiting_for_human=False,
                nudge_sent=True,
                turn=1,
                max_turns=50,
            )
            == "give_up"
        )

    def test_no_nudge_on_last_turn(self):
        # No room left to retry → give up rather than nudge into nothing.
        assert (
            _next_no_tool_action(
                any_tool_called=False,
                tools_offered=True,
                has_content=True,
                waiting_for_human=False,
                nudge_sent=False,
                turn=49,
                max_turns=50,
            )
            == "give_up"
        )


class TestLooksLikeWaitingForHuman:
    """Detecting a model that defers to a human instead of acting."""

    @pytest.mark.parametrize(
        "text",
        [
            "Please execute this command and provide the output.",
            "```bash\nls ./Sources/\n```\nPlease execute this command and provide the output.",
            "Could you run the tests and let me know the result?",
            "Please provide the directory structure of the project.",
            "Paste the output here so I can continue.",
        ],
    )
    def test_detects_deferral(self, text):
        assert _looks_like_waiting_for_human(text) is True

    @pytest.mark.parametrize(
        "text",
        [
            "",
            "I created the plan and wrote implementation_plan.json.",
            "Please review the implementation plan before merging.",
            "The investigation is complete; all files are in place.",
        ],
    )
    def test_ignores_normal_prose(self, text):
        assert _looks_like_waiting_for_human(text) is False


class TestMergeNativeChunk:
    """Folding Ollama /api/chat objects — streamed or not — into one turn."""

    def test_streamed_content_is_concatenated(self):
        acc = {}
        for piece in ("Hello", " ", "world"):
            _merge_native_chunk(acc, {"message": {"content": piece}})
        assert acc["content"] == "Hello world"
        # One content-bearing chunk ≈ one token: that is the heartbeat's counter.
        assert acc["tokens"] == 3

    def test_returns_added_characters(self):
        acc = {}
        assert _merge_native_chunk(acc, {"message": {"content": "abc"}}) == 3
        # A keep-alive chunk carries no content and must not look like output.
        assert _merge_native_chunk(acc, {"message": {"content": ""}}) == 0
        assert acc["tokens"] == 1

    def test_non_streamed_single_object_folds_identically(self):
        acc = {}
        _merge_native_chunk(
            acc,
            {
                "message": {"content": "done", "tool_calls": [{"function": {}}]},
                "done": True,
                "prompt_eval_count": 120,
                "eval_count": 7,
            },
        )
        assert acc["content"] == "done"
        assert len(acc["tool_calls"]) == 1
        assert acc["done"] is True
        assert (acc["prompt_eval_count"], acc["eval_count"]) == (120, 7)

    def test_tool_calls_accumulate_across_chunks(self):
        acc = {}
        _merge_native_chunk(acc, {"message": {"tool_calls": [{"id": "a"}]}})
        _merge_native_chunk(acc, {"message": {"tool_calls": [{"id": "b"}]}})
        assert [tc["id"] for tc in acc["tool_calls"]] == ["a", "b"]

    def test_mid_stream_error_is_captured(self):
        acc = {}
        _merge_native_chunk(acc, {"error": "model runner has terminated"})
        assert acc["error"] == "model runner has terminated"


class TestFormatGenerationProgress:
    """The heartbeat has to say what changed, not that time passed."""

    def _line(self, **overrides):
        kwargs = {
            "turn": 3,
            "max_turns": 50,
            "elapsed": 60,
            "tokens": 0,
            "silent_for": 0,
        }
        kwargs.update(overrides)
        return _format_generation_progress("llama3.3", **kwargs)

    def test_names_the_turn(self):
        assert "tour 3/50" in self._line()

    def test_prompt_evaluation_is_distinguished_from_generation(self):
        # No token yet: the server is still reading the context.
        assert "chargement ou le traitement du contexte" in self._line(tokens=0)
        assert "génère" in self._line(tokens=200, elapsed=60)

    def test_generation_reports_count_and_rate(self):
        line = self._line(tokens=300, elapsed=60)
        assert "300 fragments" in line
        assert "5,0 fragments/s" in line

    def test_no_token_past_the_stall_threshold_is_a_warning(self):
        # What it must NOT do is guess the cause — see
        # TestPlacementDiagnosis.test_the_stall_line_no_longer_blames_the_context.
        line = self._line(tokens=0, elapsed=_LOCAL_STALL_SECONDS)
        assert line.startswith("⚠️")
        assert "aucun fragment" in line

    def test_output_that_stopped_is_reported_as_a_stall(self):
        line = self._line(tokens=300, elapsed=900, silent_for=_LOCAL_STALL_SECONDS)
        assert line.startswith("⚠️")
        assert "plus rien" in line

    def test_elapsed_is_human_readable(self):
        assert "1 min 30 s" in self._line(tokens=10, elapsed=90)

    def test_non_streamed_turn_does_not_read_silence_as_a_stall(self):
        # The fallback path observes nothing until the turn ends, so zero
        # tokens is not evidence of anything and must not be reported as such.
        line = self._line(tokens=0, elapsed=_LOCAL_STALL_SECONDS, streaming=False)
        assert "non streamée" in line
        assert not line.startswith("⚠️")


class TestLocalContextBudgets:
    """Shared budgets are sized for a 200k window; a local model has 8k."""

    def test_history_budget_fits_the_local_window(self, monkeypatch):
        monkeypatch.delenv("OLLAMA_CONTEXT_LENGTH", raising=False)
        client = LocalAgentClient(model="m")
        # Half of 8192 tokens at ~3 chars/token — an order of magnitude below
        # the 300k shared default, which never fired before the window blew.
        assert client._local_history_budget() < 50_000

    def test_tool_result_cap_fits_the_local_window(self, monkeypatch):
        monkeypatch.delenv("OLLAMA_CONTEXT_LENGTH", raising=False)
        client = LocalAgentClient(model="m")
        assert client._local_tool_result_cap() < 10_000

    def test_budgets_grow_with_the_window_but_never_past_the_shared_default(
        self, monkeypatch
    ):
        monkeypatch.setenv("OLLAMA_CONTEXT_LENGTH", "262144")
        client = LocalAgentClient(model="m")
        client._model_max_ctx = 1_000_000
        client._resolve_num_ctx(200_000)  # a window this wide really was asked for
        assert client._local_history_budget() == 300_000
        assert client._local_tool_result_cap() == 10_000


class TestNumCtxSizing:
    """The context window is sized to the prompt, inside a ceiling.

    A constant is wrong in both directions: 8192 did not fit a single agent
    phase (a complexity assessment with six tools measures ~8.2k tokens, and
    Ollama answers an overflow by silently dropping the head of the prompt —
    the system prompt with it), while raising the constant would make every
    session allocate a KV cache it never uses.
    """

    def _client(self, monkeypatch, *, model_max=131072):
        monkeypatch.delenv("OLLAMA_CONTEXT_LENGTH", raising=False)
        client = LocalAgentClient(model="llama3.3")
        # Never contact a server from a unit test.
        client._model_max_ctx = model_max
        return client

    def test_a_prompt_that_fits_keeps_the_floor(self, monkeypatch):
        client = self._client(monkeypatch)
        assert client._resolve_num_ctx(2_000) == 8192

    def test_the_reported_case_grows_the_window(self, monkeypatch):
        # The user's own log: ~8227 tokens against a window of 8192.
        client = self._client(monkeypatch)
        assert client._resolve_num_ctx(8_227) == 16_384

    def test_growth_is_bounded_by_the_default_cap(self, monkeypatch):
        client = self._client(monkeypatch)
        assert client._resolve_num_ctx(500_000) == 32_768

    def test_a_model_with_a_small_window_caps_lower(self, monkeypatch):
        # gemma-style 8k model: never ask for more than it can load.
        client = self._client(monkeypatch, model_max=8_192)
        assert client._resolve_num_ctx(30_000) == 8_192

    def test_env_is_a_ceiling_not_a_target(self, monkeypatch):
        monkeypatch.setenv("OLLAMA_CONTEXT_LENGTH", "16384")
        client = LocalAgentClient(model="llama3.3")
        client._model_max_ctx = 131_072
        # Small prompt: we do NOT allocate the whole 16k the user allowed…
        assert client._resolve_num_ctx(1_000) == 8_192
        # …and we never exceed it either, so the setting can only reduce memory.
        client._resolved_num_ctx = None
        assert client._resolve_num_ctx(500_000) == 16_384

    def test_a_garbage_env_value_falls_back_to_the_cap(self, monkeypatch):
        monkeypatch.setenv("OLLAMA_CONTEXT_LENGTH", "beaucoup")
        client = LocalAgentClient(model="llama3.3")
        client._model_max_ctx = 131_072
        assert client._resolve_num_ctx(500_000) == 32_768

    def test_the_window_is_stable_across_turns(self, monkeypatch):
        # Ollama keys the loaded model on its options, so a num_ctx that moves
        # between turns evicts and reloads the weights — minutes, on a 70B.
        client = self._client(monkeypatch)
        first = client._resolve_num_ctx(8_227)
        assert client._num_ctx() == first
        assert client._num_ctx() == first

    def test_budgets_follow_the_resolved_window(self, monkeypatch):
        client = self._client(monkeypatch)
        narrow = client._local_history_budget()  # floor, nothing resolved yet
        client._resolve_num_ctx(8_227)
        assert client._local_history_budget() > narrow


class TestModelMaxContext:
    """`/api/show` answers how wide the model can actually go."""

    def _show(self, monkeypatch, payload):
        import json as _json
        from unittest.mock import MagicMock

        response = MagicMock()
        response.read.return_value = _json.dumps(payload).encode("utf-8")
        response.__enter__ = lambda self: self
        response.__exit__ = lambda *a: False
        monkeypatch.setattr(
            "urllib.request.urlopen", lambda *a, **k: response, raising=True
        )

    def test_reads_the_architecture_prefixed_key(self, monkeypatch):
        self._show(monkeypatch, {"model_info": {"llama.context_length": 131072}})
        assert LocalAgentClient(model="llama3.3")._model_max_context() == 131072

    def test_any_architecture_works(self, monkeypatch):
        self._show(monkeypatch, {"model_info": {"qwen2.context_length": 32768}})
        assert LocalAgentClient(model="qwen2.5-coder")._model_max_context() == 32768

    def test_a_server_that_cannot_answer_is_not_an_error(self, monkeypatch):
        def _boom(*_a, **_k):
            raise OSError("connection refused")

        monkeypatch.setattr("urllib.request.urlopen", _boom, raising=True)
        # LM Studio has no /api/show at all; the caller falls back to the cap.
        assert LocalAgentClient(model="llama3.3")._model_max_context() is None

    def test_the_lookup_happens_once(self, monkeypatch):
        calls = []
        self._show(monkeypatch, {"model_info": {"llama.context_length": 131072}})
        real = __import__("urllib.request").request.urlopen
        monkeypatch.setattr(
            "urllib.request.urlopen",
            lambda *a, **k: (calls.append(1), real(*a, **k))[1],
            raising=True,
        )
        client = LocalAgentClient(model="llama3.3")
        client._model_max_context()
        client._model_max_context()
        assert len(calls) == 1


class TestPlacementDiagnosis:
    """Where Ollama put the model is the fact that explains a dead turn.

    A model too big for the VRAM is not refused: Ollama runs the layers that fit
    on the GPU and the rest on the CPU, an order of magnitude slower. Nothing in
    the protocol says so — the request just takes hours — so a heartbeat that
    only counts minutes describes the symptom of a machine that is too small
    exactly as it describes a model that is thinking.
    """

    GO = 1024**3

    def test_a_model_entirely_on_cpu_says_so(self):
        line = _format_placement_diagnosis(
            "llama3.3", size=43 * self.GO, size_vram=0, parameter_size="70.6B"
        )
        assert "entièrement sur le CPU" in line
        assert "70.6B" in line
        # The remedy is a smaller model, never a smaller context.
        assert "plus petit" in line

    def test_a_partially_offloaded_model_reports_the_split(self):
        line = _format_placement_diagnosis(
            "llama3.3",
            size=40 * self.GO,
            size_vram=10 * self.GO,
            parameter_size="70.6B",
        )
        assert "25%" in line
        assert "10.0 Go" in line and "40.0 Go" in line
        assert "ne tient pas dans la VRAM" in line

    def test_a_model_fully_on_gpu_clears_the_machine(self):
        # Same silence, opposite cause: nothing to fix but the model's size.
        line = _format_placement_diagnosis(
            "llama3.3",
            size=40 * self.GO,
            size_vram=40 * self.GO,
            parameter_size="70.6B",
        )
        assert "entièrement sur le GPU" in line
        assert "pas d'un débordement mémoire" in line

    def test_an_absent_model_names_the_server_it_asked(self):
        # `ollama ps` in a terminal queries the CLI's server, not the one the
        # app opened a socket to. Naming the URL is what separates "still
        # loading" from "you are looking at a different daemon".
        line = _format_not_loaded_diagnosis(
            "llama3.3", server_root="http://127.0.0.1:11434", others=[]
        )
        assert "http://127.0.0.1:11434" in line
        assert "aucun modèle chargé" in line
        assert "lecture depuis le disque" in line

    def test_an_absent_model_lists_what_is_loaded_instead(self):
        line = _format_not_loaded_diagnosis(
            "llama3.3",
            server_root="http://127.0.0.1:11434",
            others=["qwen2.5-coder:7b"],
        )
        assert "modèles chargés : qwen2.5-coder:7b" in line

    def test_a_server_that_reports_no_size_does_not_invent_one(self):
        line = _format_placement_diagnosis(
            "llama3.3", size=0, size_vram=0, parameter_size=None
        )
        assert "ne rapporte pas sa répartition" in line

    def test_the_stall_line_no_longer_blames_the_context(self):
        # The window is now sized to fit the prompt by construction, so the old
        # "your context is too big" was wrong exactly when it mattered most.
        line = _format_generation_progress(
            "llama3.3",
            turn=1,
            max_turns=50,
            elapsed=_LOCAL_STALL_SECONDS,
            tokens=0,
            silent_for=_LOCAL_STALL_SECONDS,
        )
        assert "OLLAMA_CONTEXT_LENGTH" not in line
        assert "diagnostic de chargement" in line


class TestLoadedModelPlacement:
    """`/api/ps` answers where the model is, keyed on Ollama's own identity."""

    def _ps(self, monkeypatch, payload):
        import json as _json
        from unittest.mock import MagicMock

        response = MagicMock()
        response.read.return_value = _json.dumps(payload).encode("utf-8")
        response.__enter__ = lambda self: self
        response.__exit__ = lambda *a: False
        monkeypatch.setattr(
            "urllib.request.urlopen", lambda *a, **k: response, raising=True
        )

    def test_an_absent_model_is_reported_not_swallowed(self, monkeypatch):
        # The first version returned None here, so the log said nothing in
        # exactly the situation the probe exists for: `ollama ps` empty while a
        # request is in flight.
        self._ps(
            monkeypatch,
            {"models": [{"model": "qwen2.5-coder:7b", "size": 5, "size_vram": 5}]},
        )
        placement = LocalAgentClient(model="llama3.3")._loaded_model_placement()
        assert placement == {"loaded": False, "others": ["qwen2.5-coder:7b"]}

    def test_nothing_loaded_at_all(self, monkeypatch):
        self._ps(monkeypatch, {"models": []})
        assert LocalAgentClient(model="llama3.3")._loaded_model_placement() == {
            "loaded": False,
            "others": [],
        }

    def test_matches_the_bare_name_against_the_latest_tag(self, monkeypatch):
        # The phase stores "llama3.3"; /api/ps reports "llama3.3:latest".
        self._ps(
            monkeypatch,
            {
                "models": [
                    {
                        "model": "llama3.3:latest",
                        "size": 40_000,
                        "size_vram": 10_000,
                        "details": {"parameter_size": "70.6B"},
                    }
                ]
            },
        )
        placement = LocalAgentClient(model="llama3.3")._loaded_model_placement()
        assert placement == {
            "loaded": True,
            "size": 40_000,
            "size_vram": 10_000,
            "parameter_size": "70.6B",
        }

    def test_a_server_without_api_ps_is_not_an_error(self, monkeypatch):
        def _boom(*_a, **_k):
            raise OSError("404")

        monkeypatch.setattr("urllib.request.urlopen", _boom, raising=True)
        assert LocalAgentClient(model="llama3.3")._loaded_model_placement() is None


class TestEnvFlag:
    @pytest.mark.parametrize("raw", ["0", "false", "FALSE", "no", "off"])
    def test_falsy_shapes(self, raw, monkeypatch):
        monkeypatch.setenv("OLLAMA_STREAM", raw)
        assert _env_flag("OLLAMA_STREAM", True) is False

    @pytest.mark.parametrize("raw", ["1", "true", "yes", "on"])
    def test_truthy_shapes(self, raw, monkeypatch):
        monkeypatch.setenv("OLLAMA_STREAM", raw)
        assert _env_flag("OLLAMA_STREAM", False) is True

    def test_unset_and_garbage_keep_the_default(self, monkeypatch):
        monkeypatch.delenv("OLLAMA_STREAM", raising=False)
        assert _env_flag("OLLAMA_STREAM", True) is True
        monkeypatch.setenv("OLLAMA_STREAM", "maybe")
        assert _env_flag("OLLAMA_STREAM", True) is True
