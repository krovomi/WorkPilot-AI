"""The labels of a screen, and how two lists of them are compared.

A screen is compared three ways in lot E — the base branch against the task,
a mockup against the render, what a phone shows against what it was expected
to show — and all three are the same question: *which of these labels are the
same label?* Asked of OCR, that question needs tolerance. Tesseract reads
`Enregistrer` as `Enreqistrer`, drops an accent, merges a colon into the word;
a designer writes `Save changes` and the developer ships `Save Changes`. An
exact comparison would report every one of those as a changed label, and a
diff that is always full is a diff nobody reads.

So the comparison is in two steps, and they are kept apart on purpose:

- **normalisation** removes what never carries meaning on a screen — case,
  accents, punctuation, spacing, a trailing ellipsis or colon;
- **edit distance** measures what is left, and the caller decides the
  threshold: a before/after diff wants to pair a rewording, a mockup check
  wants to forgive an OCR slip and still report a different word.

Nothing here reads a file other than a `*.figma.json` handed to it, and
nothing here calls a model: labels are data, compared as data.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .engines.base import OcrBox

#: Longer than this is a paragraph, not a label.
MAX_LABEL_CHARS = 120
MAX_LABELS = 200

#: A `.figma.json` written by lot F (Figma import): the maquette's texts,
#: already structured. Read here, never fetched here.
FIGMA_SUFFIX = ".figma.json"
MAX_FIGMA_BYTES = 2 * 1024 * 1024
MAX_FRAMES = 60
MAX_FRAME_TEXTS = 300

_TRAILING = re.compile(r"(?:\s*(?:…|\.\.\.|:|\*))+$")


def normalize_label(text: str) -> str:
    """What is left of a label once what never carries meaning is removed.

    Unicode-aware: accents are dropped (NFKD, combining marks removed), but a
    non-Latin script is kept as it is — a Japanese label has no ASCII to fold
    to, and folding to ASCII would compare every Japanese label as equal.
    """
    text = _TRAILING.sub("", unicodedata.normalize("NFKC", text or ""))
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    kept = "".join(
        ch if ch.isalnum() else " "
        for ch in decomposed
        if not unicodedata.combining(ch)
    )
    return " ".join(kept.split())


def levenshtein(a: str, b: str) -> int:
    """Edit distance, two rows of memory."""
    if a == b:
        return 0
    if len(a) < len(b):
        a, b = b, a
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(
                min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb))
            )
        previous = current
    return previous[-1]


def similarity(a: str, b: str) -> float:
    """1.0 for the same normalised label, 0.0 for nothing in common."""
    na, nb = normalize_label(a), normalize_label(b)
    if not na and not nb:
        return 1.0
    if not na or not nb:
        return 0.0
    return 1.0 - levenshtein(na, nb) / max(len(na), len(nb))


def same_label(a: str, b: str) -> bool:
    """Equal after normalisation, or one OCR slip apart on a long enough label.

    One edit in a word of six letters or more is what OCR does to a correct
    label far more often than what a developer does to it; below that, one
    letter is often the whole difference (`Yes` / `Yet`).
    """
    na, nb = normalize_label(a), normalize_label(b)
    if na == nb:
        return bool(na)
    return min(len(na), len(nb)) >= 6 and levenshtein(na, nb) <= 1


def readable(text: str) -> bool:
    """A label and not OCR noise: letters, not too long, not a row of symbols."""
    stripped = text.strip()
    if not stripped or len(stripped) > MAX_LABEL_CHARS:
        return False
    letters = sum(ch.isalpha() for ch in stripped)
    return letters >= 1 and letters >= 0.4 * len(stripped.replace(" ", ""))


def _dedupe(labels: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for label in labels:
        key = normalize_label(label)
        if key and key not in seen:
            seen.add(key)
            out.append(label)
    return out[:MAX_LABELS]


def labels_from_text(text: str) -> list[str]:
    """One label per line — what is left when an engine gave no boxes."""
    return _dedupe(
        [line.strip() for line in (text or "").splitlines() if readable(line)]
    )


def labels_from_boxes(boxes: tuple[OcrBox, ...] | list[OcrBox]) -> list[str]:
    """Labels from where the words are: a line split where the gap is wide.

    Tesseract returns a toolbar as one line — `Save Cancel Delete` — and the
    three buttons are three labels. The split is the one `tables.py` uses for
    table cells (a run of words closer than about two character widths),
    because a toolbar is a row of cells.
    """
    from .tables import char_gap, row_cells

    words = [b for b in boxes if b.text.strip()]
    if not words:
        return []
    gap = char_gap(words)
    by_line: dict[int, list[OcrBox]] = {}
    for box in words:
        by_line.setdefault(box.line, []).append(box)
    labels: list[str] = []
    for _, line_words in sorted(by_line.items()):
        labels.extend(
            text.strip() for _, _, text in row_cells(line_words, gap) if readable(text)
        )
    return _dedupe(labels)


# ---------------------------------------------------------------------------
# Before / after
# ---------------------------------------------------------------------------


def _pairing(before: str, after: str) -> float:
    """How likely `after` is `before` reworded: edit similarity, or one label
    extending the other word for word (`Annuler` → `Annuler la commande`)."""
    score = similarity(before, after)
    nb, na = f" {normalize_label(before)} ", f" {normalize_label(after)} "
    if len(nb.strip()) >= 3 and len(na.strip()) >= 3 and (nb in na or na in nb):
        score = max(score, 0.6)
    return score


@dataclass
class LabelChange:
    before: str
    after: str
    similarity: float


@dataclass
class LabelDiff:
    changed: list[LabelChange] = field(default_factory=list)
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    unchanged: int = 0

    @property
    def empty(self) -> bool:
        return not (self.changed or self.added or self.removed)

    def to_dict(self) -> dict:
        return asdict(self)


def diff_labels(
    before: list[str], after: list[str], *, pair_threshold: float = 0.5
) -> LabelDiff:
    """What changed between two screens' labels.

    Equal labels (with the OCR tolerance of `same_label`) are unchanged; what
    remains is paired by similarity, best pair first, when the pair is close
    enough to be a rewording rather than two unrelated labels (`Save` →
    `Save draft`, not `Save` → `Delete`); the rest was added or removed.
    """
    remaining_after = list(after)
    left: list[str] = []
    diff = LabelDiff()
    for label in before:
        match = next((a for a in remaining_after if same_label(label, a)), None)
        if match is None:
            left.append(label)
        else:
            remaining_after.remove(match)
            diff.unchanged += 1

    candidates = sorted(
        (
            (_pairing(b, a), bi, ai)
            for bi, b in enumerate(left)
            for ai, a in enumerate(remaining_after)
        ),
        reverse=True,
    )
    used_b: set[int] = set()
    used_a: set[int] = set()
    for score, bi, ai in candidates:
        if score < pair_threshold:
            break
        if bi in used_b or ai in used_a:
            continue
        used_b.add(bi)
        used_a.add(ai)
        diff.changed.append(LabelChange(left[bi], remaining_after[ai], round(score, 2)))
    diff.removed = [b for i, b in enumerate(left) if i not in used_b]
    diff.added = [a for i, a in enumerate(remaining_after) if i not in used_a]
    return diff


# ---------------------------------------------------------------------------
# Mockup against render
# ---------------------------------------------------------------------------


@dataclass
class NearLabel:
    expected: str
    rendered: str
    similarity: float


@dataclass
class MockupMatch:
    #: Labels of the mockup found on the render (tolerantly).
    matched: int = 0
    #: Close but not the same — a rewording, a typo, or an OCR misreading.
    near: list[NearLabel] = field(default_factory=list)
    #: Labels of the mockup nowhere on the render.
    missing: list[str] = field(default_factory=list)
    total: int = 0

    @property
    def coverage(self) -> float:
        return round(self.matched / self.total, 2) if self.total else 0.0

    def to_dict(self) -> dict:
        return {**asdict(self), "coverage": self.coverage}


def match_mockup(
    expected: list[str], rendered: list[str], *, near_threshold: float = 0.75
) -> MockupMatch:
    """Each label of the mockup: on the render, close to one, or missing.

    A mockup label contained in a longer rendered one counts as found: OCR
    joins a label and its neighbour when they sit close, and "missing" for a
    label that is on the screen is the error that makes a check unreadable.
    """
    result = MockupMatch(total=len(expected))
    normalized = [normalize_label(r) for r in rendered]
    for label in expected:
        key = normalize_label(label)
        if not key:
            result.total -= 1
            continue
        if any(same_label(label, r) for r in rendered) or any(
            len(key) >= 3 and f" {key} " in f" {n} " for n in normalized
        ):
            result.matched += 1
            continue
        best = max(
            ((similarity(label, r), r) for r in rendered),
            default=(0.0, ""),
        )
        if best[0] >= near_threshold:
            result.near.append(NearLabel(label, best[1], round(best[0], 2)))
        else:
            result.missing.append(label)
    return result


# ---------------------------------------------------------------------------
# Figma (lot F's output, read as structured data)
# ---------------------------------------------------------------------------


@dataclass
class MockupFrame:
    id: str
    name: str
    texts: list[str]


@dataclass
class FigmaMockup:
    file_key: str
    frames: list[MockupFrame]


def is_figma(path: Path) -> bool:
    return path.name.lower().endswith(FIGMA_SUFFIX)


def _text(value: object, limit: int = MAX_LABEL_CHARS) -> str:
    return " ".join(str(value or "").split())[:limit]


def load_figma(path: Path) -> FigmaMockup | None:
    """The contract with lot F, and nothing looser.

    ``{"source": "figma", "file_key": "…", "frames": [{"id", "name",
    "texts": [...]}]}`` — anything else is not a Figma mockup and returns
    None, so a JSON file that merely ends in `.figma.json` cannot pose as one.
    Texts are data a third party wrote: the caller masks and scans them.
    """
    try:
        if path.is_symlink() or path.stat().st_size > MAX_FIGMA_BYTES:
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict) or payload.get("source") != "figma":
        return None
    frames_raw = payload.get("frames")
    if not isinstance(frames_raw, list):
        return None
    frames: list[MockupFrame] = []
    for raw in frames_raw[:MAX_FRAMES]:
        if not isinstance(raw, dict) or not isinstance(raw.get("texts"), list):
            continue
        texts = [_text(t) for t in raw["texts"][:MAX_FRAME_TEXTS] if isinstance(t, str)]
        frames.append(
            MockupFrame(
                id=_text(raw.get("id"), 80),
                name=_text(raw.get("name"), 120),
                texts=_dedupe([t for t in texts if t]),
            )
        )
    return FigmaMockup(file_key=_text(payload.get("file_key"), 80), frames=frames)
