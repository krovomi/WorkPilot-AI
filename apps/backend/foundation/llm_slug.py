"""The filesystem-safe slug of a (provider, model) pair.

Names the per-LLM conversation logs (``core.conversation_log``) and the
per-LLM task logs (``task_logger``). It lived in ``core.conversation_log``,
which tied the task logger to ``core`` and to the agents' import cycle (plan
of 29 October, A1).
"""

from __future__ import annotations

import hashlib
import re

__all__ = ["llm_slug"]


def llm_slug(provider: str | None, model: str | None) -> str:
    """Filesystem-safe slug identifying a (provider, model) pair.

    e.g. ("ollama", "qwen2.5-coder:latest") -> "ollama-qwen2.5-coder-latest".
    Keeps ``[A-Za-z0-9._-]``; everything else (':' '/' spaces) becomes '-'.
    Long ids (e.g. ``hf.co/org/Model-GGUF:latest``) are truncated with a short
    hash so the filename stays well under filesystem limits yet stays unique.
    """
    raw = f"{(provider or 'local').strip()}-{(model or 'default').strip()}"
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", raw).strip("-") or "default"
    if len(slug) > 80:
        digest = hashlib.sha1(  # noqa: S324 - filename uniqueness, not security
            raw.encode("utf-8"), usedforsecurity=False
        ).hexdigest()[:8]
        slug = slug[:60].rstrip("-") + "-" + digest
    return slug
