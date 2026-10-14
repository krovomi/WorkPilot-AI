"""The size of a model's context window, in tokens.

In order of trust: what the client measured (Claude's ``maxTokens``, Ollama's
``num_ctx``), what models.dev records for the model (cache only), then the
prefix table below. The table mirrors ``CONTEXT_WINDOW_BY_MODEL_PREFIX`` in
``apps/frontend/src/shared/constants/models.ts``, so the gauge and the engine
agree; ``tests/test_context_mgmt.py`` fails when they drift. It may hold more
entries than the frontend's (providers the frontend does not size).
"""

from __future__ import annotations

DEFAULT_CONTEXT_WINDOW = 128_000

CONTEXT_WINDOW_BY_MODEL_PREFIX: tuple[tuple[str, int], ...] = (
    # Anthropic / Claude
    ("[1m]", 1_000_000),
    ("claude-opus", 200_000),
    ("claude-sonnet", 200_000),
    ("claude-haiku", 200_000),
    ("claude-3.7", 200_000),
    ("claude-3-7", 200_000),
    ("claude", 200_000),
    ("opus", 200_000),
    ("sonnet", 200_000),
    ("haiku", 200_000),
    ("fable", 200_000),
    # OpenAI
    ("gpt-5", 256_000),
    ("gpt-4.1", 1_000_000),
    ("gpt-4-1", 1_000_000),
    ("gpt-4o", 128_000),
    ("gpt-4", 128_000),
    ("o4", 200_000),
    ("o3", 200_000),
    ("o1", 200_000),
    ("codex", 256_000),
    # Google
    ("gemini", 1_000_000),
    # xAI / DeepSeek / Mistral
    ("grok-4", 256_000),
    ("grok", 128_000),
    ("deepseek", 128_000),
    ("mistral", 128_000),
    ("codestral", 256_000),
    ("devstral", 128_000),
)


def window_from_table(model: str | None) -> int:
    """Window for ``model`` from the prefix table. Pure."""
    if not model:
        return DEFAULT_CONTEXT_WINDOW
    normalized = model.lower().strip()
    for prefix, window in CONTEXT_WINDOW_BY_MODEL_PREFIX:
        if prefix in normalized:
            return window
    return DEFAULT_CONTEXT_WINDOW


def resolve_context_window(model: str | None, client_window: int | None = None) -> int:
    """The best known window for ``model``. Never raises."""
    if isinstance(client_window, int) and client_window > 0:
        return client_window
    try:
        from public_model_registry import cached_context_window

        registered = cached_context_window(model)
        if registered:
            return registered
    except Exception:  # noqa: BLE001 - the table answers
        pass
    return window_from_table(model)
