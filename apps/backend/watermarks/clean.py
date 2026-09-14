"""One function: given text an agent is about to write, give back clean text.

The decision table is upstream's and is never second-guessed here. What this
module adds is the three things upstream's CLI cannot know, because they are
about *this* caller:

1. **The options**, fixed for source code rather than prose. Four of upstream's
   five knobs are off, and `settings.py` says why for the two that are
   configurable. The two that are not configurable are the dangerous ones:

   ``nfkc``
       NFKC folds ﬁ into fi, ４ into 4, ㎏ into kg. In a paragraph that is
       tidying; in a string literal, a regex character class or a test fixture
       it is a silent behaviour change, and the file still compiles.
   ``aggressive_homoglyphs``
       Rewrites Cyrillic а to Latin a. A homoglyph in an identifier is worth
       catching — and it is `injection_guard`'s catch, with a finding somebody
       reads — not something to fix by editing a Russian translation into
       nonsense on the way to disk.

2. **The fast path.** Every codepoint the table can touch is non-ASCII, so
   `str.isascii()` answers for the overwhelming majority of generated source
   files in one C-level pass instead of a Python loop over every character.
   That property is upstream's to keep, not ours to assume, so
   `tests/test_watermarks_clean.py` asserts it over all 128 ASCII codepoints
   and fails if a future version starts touching one.

3. **The cap.** Above `WATERMARKS_MAX_BYTES` the content goes through
   untouched and the skip is reported rather than hidden, because a cleaner
   that quietly stops working above a size is a cleaner nobody can reason
   about.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from . import settings
from .runtime import engine

logger = logging.getLogger(__name__)

__all__ = ["Cleaning", "clean_generated"]


@dataclass(frozen=True)
class Cleaning:
    """What happened to one piece of content, whether or not anything did."""

    text: str
    changed: bool = False
    removed: dict[str, int] = field(default_factory=dict)
    replaced: dict[str, int] = field(default_factory=dict)
    #: Why nothing was attempted, when nothing was: ``disabled``, ``too-large``,
    #: ``no-engine``, ``ascii`` or ``error``. Empty when the table actually ran.
    skipped: str = ""

    @property
    def removed_count(self) -> int:
        return sum(self.removed.values())

    @property
    def replaced_count(self) -> int:
        return sum(self.replaced.values())

    def to_dict(self) -> dict[str, object]:
        return {
            "changed": self.changed,
            "removed": dict(self.removed),
            "replaced": dict(self.replaced),
            "removed_count": self.removed_count,
            "replaced_count": self.replaced_count,
            "skipped": self.skipped,
        }


def clean_generated(text: str, *, env: dict | None = None) -> Cleaning:
    """Strip invisible watermark carriers from content on its way to disk.

    Never raises and never returns None: every failure path gives back the
    input unchanged with a reason. The callers are a PreToolUse hook and a
    tool executor, and neither has anything useful to do with an exception
    raised by a cosmetic pass.
    """
    if not isinstance(text, str) or not text:
        return Cleaning(text=text, skipped="" if text == "" else "error")

    if not settings.is_enabled(env):
        return Cleaning(text=text, skipped="disabled")

    # Cheapest first: no ASCII codepoint is stripped, replaced or reclassified
    # by the table, so an all-ASCII file is already clean by construction.
    if text.isascii():
        return Cleaning(text=text, skipped="ascii")

    if len(text.encode("utf-8", errors="ignore")) > settings.max_bytes(env):
        return Cleaning(text=text, skipped="too-large")

    module = engine()
    if module is None:
        return Cleaning(text=text, skipped="no-engine")

    try:
        cleaned, stats = module.clean_text(
            text,
            nfkc=False,
            aggressive_homoglyphs=False,
            normalize_spaces=settings.normalize_spaces(env),
            strip_emoji_glue=False,
            strip_bidi=settings.strip_bidi(env),
        )
    except Exception:  # noqa: BLE001 - a cosmetic pass never fails a build
        logger.debug("watermarks: clean_text raised", exc_info=True)
        return Cleaning(text=text, skipped="error")

    if not isinstance(cleaned, str):
        return Cleaning(text=text, skipped="error")

    removed = stats.get("removed") if isinstance(stats, dict) else None
    replaced = stats.get("replaced") if isinstance(stats, dict) else None
    return Cleaning(
        text=cleaned,
        changed=cleaned != text,
        removed=dict(removed) if isinstance(removed, dict) else {},
        replaced=dict(replaced) if isinstance(replaced, dict) else {},
    )
