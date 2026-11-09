"""The code's story told in prose by the active text model (#349).

The chapters (``story.py``) are facts read from the repository: paths,
counts, decision titles. Asked for, the active model turns each chapter into a
short paragraph in the reader's language, the way a colleague would tell it.

The facts come from the project (file names, commit subjects, decision
titles), so they reach the model through ``quote_untrusted``, as data. Its
answer is reduced to plain text: one paragraph per known chapter, markup and
links stripped, 900 characters at most. A chapter it did not answer keeps its
lines; nothing is invented to fill the gap.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Callable
from typing import Any

__all__ = ["LANGUAGES", "MAX_PARAGRAPH", "clean_paragraph", "narrate"]

logger = logging.getLogger(__name__)

LANGUAGES = {"en": "English", "fr": "French"}
MAX_PARAGRAPH = 900

_SYSTEM = (
    "You explain a software project to a developer who joins the team. You are given "
    "facts measured on the repository, chapter by chapter. For each chapter, write one "
    "short paragraph (at most 120 words) that tells those facts plainly, in the requested "
    "language, as a colleague would. Use only the facts given: never invent a file, a "
    "number, a person or a decision. Name files as they are written. No markdown, no "
    'lists, no links. Answer with one JSON object: {"<chapter id>": "<paragraph>"}.'
)

_MARKUP = re.compile(
    r"<[^>]{0,200}>|!\[[^\]]*\]\([^)]*\)|\[([^\]]*)\]\([^)]*\)|[*_#>`]{1,3}"
)
_URL = re.compile(r"\b(?:https?|ftp|file|javascript|data):\S+", re.I)


def clean_paragraph(value: object) -> str:
    """The model's paragraph as plain text, or ``""`` when it is not one."""
    if not isinstance(value, str):
        return ""
    plain = _MARKUP.sub(lambda m: m.group(1) or "", value)
    plain = _URL.sub("", plain)
    plain = " ".join(plain.split())
    if len(plain) > MAX_PARAGRAPH:
        cut = plain[:MAX_PARAGRAPH].rsplit(" ", 1)[0]
        plain = cut.rstrip(",;:") + "…"
    return plain


def _ask(prompt: str, project_dir: str | None) -> str:
    from core.oneshot import oneshot_completion

    return asyncio.run(
        oneshot_completion(
            prompt, system_prompt=_SYSTEM, project_dir=project_dir, max_turns=1
        )
    )


def _answer(text: str) -> dict[str, Any]:
    match = re.search(r"\{.*\}", text or "", re.S)
    if not match:
        return {}
    try:
        data = json.loads(match.group(0))
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def narrate(
    chapters: list[Any],
    language: str,
    project_dir: str | None = None,
    ask: Callable[[str, str | None], str] | None = None,
) -> dict[str, Any]:
    """``{"paragraphs": {chapter id: text}, "answered": bool, "missing": [ids]}``."""
    from security.untrusted import quote_untrusted

    if language not in LANGUAGES:
        raise ValueError("Unsupported language")
    facts = {
        chapter.id: {
            "title": chapter.title.fallback,
            "lines": [line.fallback for line in chapter.lines][:12],
            "facts": chapter.facts,
        }
        for chapter in chapters
    }
    if not facts:
        return {"paragraphs": {}, "answered": False, "missing": []}
    prompt = (
        f"Language: {LANGUAGES[language]}\nChapters: {', '.join(facts)}\n\n"
        + quote_untrusted(
            json.dumps(facts, ensure_ascii=False, indent=1, default=str)[:40_000],
            kind="file_content",
            source="repository facts",
        )
        + "\n\nAnswer with the JSON object only."
    )
    try:
        answer = _answer((ask or _ask)(prompt, project_dir))
    except (RuntimeError, OSError, ValueError, ImportError) as exc:
        logger.info("No model to tell the story: %s", type(exc).__name__)
        answer = {}
    paragraphs = {cid: clean_paragraph(answer.get(cid)) for cid in facts}
    paragraphs = {cid: text for cid, text in paragraphs.items() if text}
    return {
        "paragraphs": paragraphs,
        "answered": bool(answer),
        "missing": [cid for cid in facts if cid not in paragraphs],
    }
