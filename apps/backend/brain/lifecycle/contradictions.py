"""Two memories that say opposite things: found without a model.

A sync brings a teammate's notes in. Most add to what is there; some say the
opposite of a note this machine already has — "always run the migrations
before the tests" against "never run the migrations before the tests",
``timeout: 30`` against ``timeout: 60``, "use Prisma for billing" against "use
Drizzle for billing". Merged naively, every agent gets both and follows
whichever it reads first.

This module flags such a pair, deterministically, on any machine, offline,
for every provider: the same rules give the same verdict everywhere, which is
what lets two teammates' syncs resolve the same pair the same way.

A pair is a **contradiction** when it speaks of the same subject — enough of
its words in common once the markers below are set aside — and one of three
signals says the two disagree:

| Signal | Example |
|---|---|
| ``value`` | the same setting with two values: ``retries = 3`` / ``retries = 5`` |
| ``recommendation`` | the same verb recommending two different things, same context |
| ``negation`` | one says to do it, the other not to |

Precision first. A false alarm goes to a person's queue and costs a click; a
missed one leaves things as they were before this module. So two notes scoped
to different places (``applies_to``) are never compared, a pair whose
statements are identical is not a contradiction, and "use X" against "don't
use Y" is complementary advice, not a clash. A model can refine a flagged pair
(`advisor.py`); it never decides which pairs are looked at.

English and French markers; the code a note talks about can be in any
language — only its prose is read.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from ..notes import Note
from .store import iter_live, own_text

__all__ = [
    "Contradiction",
    "CHECKED_FOLDERS",
    "compare",
    "find_for",
    "statement",
]

CHECKED_FOLDERS = ("gotchas", "patterns")
"""Claims a build follows. Files' descriptions, outcomes and sessions are
records of what happened, not advice that can contradict."""

SUBJECT_OVERLAP = 0.5
"""Share of the shorter note's subject words the other must have too."""

_WORD = re.compile(r"[a-z0-9][a-z0-9_.+#-]*[a-z0-9+#]|[a-z0-9]", re.IGNORECASE)
_STOP = frozenset(
    """
    the a an and or for with that this from into are was were has have but you your
    when then than its it is be to of in on at by as so if all any each every
    always must should can could would will may might also only just very more most
    le la les l un une des du de et ou pour dans avec sur est sont que qui quand
    puis ce cet cette ces son sa ses leur au aux en par il elle on se ne
    toujours doit doivent faut peut tout tous chaque aussi plus
    """.split()
)
_NEGATIONS = frozenset(
    """
    not never no don't dont doesn't doesnt didn't isn't aren't avoid without
    mustn't shouldn't can't cannot stop disable disallow forbid forbidden prevent
    pas jamais aucun aucune sans éviter eviter évitez evitez interdit interdire
    désactiver desactiver don doesn didn isn aren mustn shouldn can
    """.split()
)
_REC_VERBS = frozenset(
    """
    use uses using prefer prefers choose pick adopt opt
    utiliser utilisez utilise utilisons préférer préférez préfère preferer preferez
    choisir choisissez choisis adopter adoptez
    """.split()
)
_ARTICLES = frozenset("the a an le la les l un une des du de d".split())
_BOUNDARIES = frozenset(
    """
    for in with on to when instead rather than because since if over
    pour dans avec sur quand plutôt plutot que car si au aux
    """.split()
)
_SETTING = re.compile(
    r"(?<![\w.-])([A-Za-z_][\w.-]{1,60})\s*(?:=|:)\s*([\"'`]?)([\w.+%/-]{1,40})\2"
)
_SET_TO = re.compile(
    r"\b(?:set|mettre|régler|regler|fixer)\s+(?:the\s+|le\s+|la\s+|l')?"
    r"([A-Za-z_][\w.-]{1,60})\s+(?:to|à|a|sur)\s+([\w.+%/-]{1,40})",
    re.IGNORECASE,
)
_NUMBER = re.compile(
    r"\b([A-Za-z_][\w-]{2,40})\s+(?:of\s+|de\s+|is\s+|est\s+|à\s+|to\s+|at\s+|=\s*)?"
    r"(\d+(?:[.,]\d+)?)\s*(ms|s|sec|seconds?|secondes?|min|minutes?|h|hours?|heures?|kb|mb|gb|%)?\b",
    re.IGNORECASE,
)
_BOLD_LABEL = re.compile(r"\*\*[^*\n]{1,40}\*\*")
_ITALIC_LINE = re.compile(r"^_.*_$")
_CODE = re.compile(r"```.*?```", re.DOTALL)


@dataclass
class Contradiction:
    signal: str
    """``value``, ``recommendation``, ``negation`` or ``textual``."""
    detail: str = ""
    """What disagrees, for a person: ``timeout: 30 ≠ 60``."""


@dataclass
class _Analysis:
    words: set[str] = field(default_factory=set)
    negated: bool = False
    objects: set[str] = field(default_factory=set)
    settings: dict[str, str] = field(default_factory=dict)


def _fold(text: str) -> str:
    return unicodedata.normalize("NFC", text or "").lower().replace("’", "'")


def statement(text: str) -> str:
    """What a note *says*: its own text without links, footers or labels.

    The learning loop's ``_confidence 0.82, seen 3×._`` line and a gotcha's
    ``_Contexte : …_`` are about the note, not part of its claim; two copies of
    one pattern whose counters drifted apart state the same thing.
    """
    lines = []
    for line in own_text(text).splitlines():
        stripped = line.strip()
        if not stripped or _ITALIC_LINE.match(stripped):
            continue
        lines.append(stripped)
    return "\n".join(lines).strip()


def _prose(text: str) -> str:
    return _BOLD_LABEL.sub(" ", _CODE.sub(" ", statement(text)))


def _tokens(text: str) -> list[str]:
    return [m.group(0).lower().strip(".") for m in _WORD.finditer(_fold(text))]


_NEGATION = re.compile(
    r"\b(?:not|never|no|don'?t|doesn'?t|didn'?t|isn'?t|aren'?t|avoid|without"
    r"|mustn'?t|shouldn'?t|can'?t|cannot|stop|disable|disallow|forbid(?:den)?"
    r"|prevent|pas|jamais|aucune?|sans|[ée]vite[rz]?|interdi(?:t|re)"
    r"|d[ée]sactive[rz]?)\b|\bn'|\bne\s"
)


def _negated(folded: str) -> bool:
    return bool(_NEGATION.search(folded))


def _objects(tokens: list[str]) -> set[str]:
    """The words a recommendation verb points at, up to the next boundary."""
    out: set[str] = set()
    for index, token in enumerate(tokens):
        if token not in _REC_VERBS:
            continue
        taken = 0
        for word in tokens[index + 1 :]:
            if word in _BOUNDARIES or taken >= 3:
                break
            if word in _ARTICLES or word in _NEGATIONS:
                continue
            out.add(word)
            taken += 1
    return out


def _settings(text: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for match in _SETTING.finditer(text):
        found.setdefault(match.group(1).lower(), match.group(3).lower())
    for match in _SET_TO.finditer(text):
        found.setdefault(match.group(1).lower(), match.group(2).lower())
    for match in _NUMBER.finditer(text):
        key = match.group(1).lower()
        if key in _STOP or key in _NEGATIONS or key in _REC_VERBS:
            continue
        unit = (match.group(3) or "").lower()
        found.setdefault(key, f"{match.group(2).replace(',', '.')} {unit}".strip())
    return found


def _analyse(text: str) -> _Analysis:
    prose = _prose(text)
    folded = _fold(prose)
    tokens = _tokens(prose)
    objects = _objects(tokens)
    words = {
        t
        for t in tokens
        if len(t) >= 3
        and t not in _STOP
        and t not in _NEGATIONS
        and t not in _REC_VERBS
        and not t.replace(".", "").isdigit()
    }
    return _Analysis(
        words=words,
        negated=_negated(folded),
        objects=objects,
        settings=_settings(prose),
    )


def _overlap(a: set[str], b: set[str]) -> tuple[int, float]:
    if not a or not b:
        return 0, 0.0
    common = len(a & b)
    return common, common / min(len(a), len(b))


def _scope(note: Note) -> str:
    return str(note.meta.get("applies_to") or "").strip().lower()


def compare(a: Note | str, b: Note | str) -> Contradiction | None:
    """Whether two notes contradict each other, and how; ``None`` if not."""
    note_a = a if isinstance(a, Note) else Note(path=Path("a.md"), body=a)
    note_b = b if isinstance(b, Note) else Note(path=Path("b.md"), body=b)
    scope_a, scope_b = _scope(note_a), _scope(note_b)
    if scope_a and scope_b and scope_a != scope_b:
        return None  # "on auth/ we do this, on payments/ that": not a clash
    text_a, text_b = statement(note_a.body), statement(note_b.body)
    if not text_a or not text_b or _fold(text_a) == _fold(text_b):
        return None
    sa, sb = _analyse(note_a.body), _analyse(note_b.body)

    for key in sorted(set(sa.settings) & set(sb.settings)):
        if sa.settings[key] == sb.settings[key]:
            continue
        # The setting itself is not the subject: "timeout 30 s" for a webhook
        # and "timeout 10 s" for a database pool are two settings.
        rest_a = sa.words - _setting_words(sa.settings)
        rest_b = sb.words - _setting_words(sb.settings)
        common, ratio = _overlap(rest_a, rest_b)
        if (
            (not rest_a and not rest_b)
            or common >= 2
            or (common and ratio >= SUBJECT_OVERLAP)
        ):
            return Contradiction(
                "value", f"{key}: {sa.settings[key]} \u2260 {sb.settings[key]}"
            )

    # A recommendation is judged on its context, the objects set aside
    # ("use Prisma for billing" / "use Drizzle for billing").
    common, ratio = _overlap(sa.words - sa.objects, sb.words - sb.objects)
    disjoint = bool(sa.objects and sb.objects and not (sa.objects & sb.objects))
    if (
        disjoint
        and not sa.negated
        and not sb.negated
        and common >= 2
        and ratio >= SUBJECT_OVERLAP
    ):
        return Contradiction(
            "recommendation",
            f"{' '.join(sorted(sa.objects))} \u2260 {' '.join(sorted(sb.objects))}",
        )
    # A negation, on all the words: "use pnpm to install" / "don't use pnpm to install".
    common, ratio = _overlap(sa.words, sb.words)
    if (
        sa.negated != sb.negated
        and not disjoint
        and common >= 2
        and ratio >= SUBJECT_OVERLAP
    ):
        return Contradiction("negation", ", ".join(sorted(sa.words & sb.words)[:4]))
    return None


def _setting_words(settings: dict[str, str]) -> set[str]:
    words: set[str] = set()
    for key, value in settings.items():
        words |= set(_tokens(key)) | set(_tokens(value)) | {key, value}
    return words


def find_for(root: Path, base: Path | str, rel: str) -> list[tuple[str, Contradiction]]:
    """The live notes of the same kind that the note at *rel* contradicts."""
    folder = Path(rel).relative_to(Path(base)).parts[0]
    if folder not in CHECKED_FOLDERS:
        return []
    from ..notes import read_note

    try:
        note = read_note(root, rel)
    except (OSError, ValueError):
        return []
    out = []
    for other_rel, other in iter_live(root, base, (folder,)):
        if other_rel == rel:
            continue
        found = compare(note, other)
        if found is not None:
            out.append((other_rel, found))
    return out
