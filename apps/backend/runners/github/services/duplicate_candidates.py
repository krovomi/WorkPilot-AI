"""The issues triage shows the model as possible duplicates of the one it reads.

With an embedding service, the open issues closest in meaning to the issue
(cosine similarity of title and body, `DuplicateDetector`, cached per issue);
without one, the issues whose titles share words with it, as before. The
model makes the call either way: this only chooses what it compares.

Which service: `ISSUE_EMBEDDINGS_PROVIDER` (`huggingface`, `openai`, `voyage`,
`local`, or `none` for shared words), else the first one with a key, Hugging
Face first since its token is the cheapest way in. A project under strict
offline mode only embeds locally, and only when asked to.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

EMBEDDING_PROVIDERS = ("huggingface", "openai", "voyage", "local")
_WORDS_ONLY = ("none", "off", "words")
# How many open issues are compared, the most recent first: each one costs an
# embedding the first time it is seen.
MAX_COMPARED = 200
MAX_CANDIDATES = 5
# Shared-words fallback: a share of the issue's title words.
WORD_OVERLAP = 0.3


def _key_for(provider: str) -> str | None:
    """The key of an embedding service, from the environment."""
    if provider == "huggingface":
        from gateway_providers import env_key

        return env_key("huggingface")
    name = {"openai": "OPENAI_API_KEY", "voyage": "VOYAGE_API_KEY"}.get(provider)
    if name is None:
        return None
    return (os.environ.get(name) or "").strip() or None


def _offline(project_dir: Path | None) -> bool:
    from offline_policy import airgap_status

    return bool(airgap_status(project_dir)["airgapStrict"]) if project_dir else False


def embedding_provider(project_dir: Path | None = None) -> str | None:
    """The embedding service triage uses, or None for shared words."""
    choice = (os.environ.get("ISSUE_EMBEDDINGS_PROVIDER") or "").strip().lower()
    if choice in _WORDS_ONLY:
        return None
    if _offline(project_dir):
        return "local" if choice == "local" else None
    if choice == "local":
        return "local"
    if choice in EMBEDDING_PROVIDERS:
        return choice if _key_for(choice) else None
    for name in ("huggingface", "openai", "voyage"):
        if _key_for(name):
            return name
    return None


def _shared_words(issue: dict, others: list[dict]) -> list[dict]:
    title_words = set(str(issue.get("title", "")).lower().split())
    out = []
    for other in others:
        other_words = set(str(other.get("title", "")).lower().split())
        overlap = len(title_words & other_words) / max(len(title_words), 1)
        if overlap > WORD_OVERLAP:
            out.append(other)
    return out[:MAX_CANDIDATES]


async def _closest(
    issue: dict,
    others: list[dict],
    *,
    provider: str,
    repo: str,
    cache_dir: Path,
) -> list[dict]:
    try:
        from ..duplicates import SIMILAR_THRESHOLD, DuplicateDetector, EmbeddingProvider
    except (ImportError, ValueError):  # pragma: no cover - flat layout
        # The runner's flat layout (test_flat_layout_imports runs it).
        from runners.github.duplicates import (
            SIMILAR_THRESHOLD,
            DuplicateDetector,
            EmbeddingProvider,
        )

    model = (os.environ.get("ISSUE_EMBEDDINGS_MODEL") or "").strip() or None
    embedder = EmbeddingProvider(provider, api_key=_key_for(provider), model=model)
    # One cache per service and model: vectors of two models do not compare.
    folder = f"{provider}-{embedder.model}".replace("/", "_")
    detector = DuplicateDetector(
        cache_dir=cache_dir / folder, embedding_provider=provider
    )
    detector.embedding_provider = embedder

    async def vector(item: dict) -> list[float]:
        return await detector.get_embedding(
            repo,
            int(item["number"]),
            str(item.get("title", "")),
            str(item.get("body") or ""),
        )

    target = await vector(issue)
    scored = []
    for other in others:
        score = detector.cosine_similarity(target, await vector(other))
        if score >= SIMILAR_THRESHOLD:
            scored.append({**other, "similarity": round(score, 2)})
    scored.sort(key=lambda item: item["similarity"], reverse=True)
    return scored[:MAX_CANDIDATES]


async def potential_duplicates(
    issue: dict,
    all_issues: list[dict[str, Any]],
    *,
    repo: str,
    cache_dir: Path,
    project_dir: Path | None = None,
) -> list[dict]:
    """The open issues to show as possible duplicates of `issue`, closest
    first; a `similarity` is set when they were compared by meaning."""
    others = [o for o in all_issues if o.get("number") != issue.get("number")]
    others = others[:MAX_COMPARED]
    provider = embedding_provider(project_dir)
    if provider:
        try:
            return await _closest(
                issue, others, provider=provider, repo=repo, cache_dir=cache_dir
            )
        except (httpx.HTTPError, ValueError, KeyError, TypeError, ImportError) as e:
            # A service down, refused or not installed: shared words still help.
            logger.warning(
                "Issue embeddings unavailable (%s): %s", provider, type(e).__name__
            )
    return _shared_words(issue, others)
