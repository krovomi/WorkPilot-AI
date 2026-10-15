"""Ranking code chunks for a query: BM25, an exact identifier match, and their fusion.

Two rankings, because each misses what the other finds:

- **BM25** over code-aware tokens finds a chunk by what it is about, from words
  a model writes in a sentence ("where is the spending cap checked"). Its
  tokenizer splits ``camelCase`` and ``snake_case`` and keeps the identifier
  whole as well, so ``overBudget`` and ``over_budget`` meet, and a query naming
  the whole identifier ranks its exact holders above chunks that only share a
  part of it.
- **The exact match** ranks first the chunk that *defines* an identifier the
  query names, then the chunks that hold it whole. BM25 may prefer a short
  caller that repeats a name over the long function that defines it.

Reciprocal Rank Fusion (`rrf`) merges the two by rank alone, so neither score
scale has to be calibrated against the other.

Pure, table-tested in ``tests/harness/test_code_ranking.py``.
"""

from __future__ import annotations

import functools
import heapq
import math
import re
from array import array
from collections import Counter, defaultdict
from collections.abc import Callable, Hashable, Iterable, Mapping, Sequence

#: The ``k`` of Reciprocal Rank Fusion: 60, the value of the original paper,
#: which damps the weight of the very first ranks.
RRF_K = 60
#: Okapi BM25's usual constants: term-frequency saturation and length weight.
BM25_K1 = 1.2
BM25_B = 0.75

#: English words that carry no meaning in a query or a comment. Code keywords
#: are left to BM25's IDF, which weighs a word present everywhere at nearly 0.
STOPWORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "does",
        "for",
        "from",
        "how",
        "in",
        "is",
        "it",
        "of",
        "on",
        "or",
        "that",
        "the",
        "this",
        "to",
        "was",
        "what",
        "when",
        "where",
        "which",
        "who",
        "why",
        "with",
    }
)

# An identifier (Unicode letters included) or a number of two digits or more.
_WORD = re.compile(r"[^\W\d]\w*|\d{2,}")
# The parts of an ASCII identifier piece: HTTPResponse -> HTTP, Response.
_CAMEL = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+")


def _camel_parts(piece: str) -> list[str]:
    if piece.isascii():
        return _CAMEL.findall(piece)
    # A non-ASCII piece is split where case or digits change: \p{Lu} is not
    # available to `re`.
    parts: list[str] = []
    current = piece[0]
    for previous, char in zip(piece, piece[1:]):
        if (previous.islower() and char.isupper()) or (
            previous.isdigit() != char.isdigit()
        ):
            parts.append(current)
            current = char
        else:
            current += char
    parts.append(current)
    return parts


def _parts(word: str) -> list[str]:
    return [
        p.lower() for piece in word.split("_") if piece for p in _camel_parts(piece)
    ]


@functools.lru_cache(maxsize=1 << 16)
def identifier_terms(word: str) -> tuple[str, ...]:
    """The terms one identifier contributes: its parts, then itself, whole.

    ``getHTTPResponse`` gives ``get``, ``http``, ``response`` and
    ``gethttpresponse``. The whole form drops case and underscores, so a
    ``snake_case`` name and its ``camelCase`` twin are one term. One-letter
    parts and stopwords are dropped; a whole identifier never is.
    """
    parts = _parts(word)
    terms = [p for p in parts if len(p) > 1 and p not in STOPWORDS]
    whole = "".join(parts)
    if len(parts) > 1 and len(whole) > 1:
        terms.append(whole)
    return tuple(terms)


def code_tokens(text: str) -> list[str]:
    """Every term of ``text``, in order."""
    tokens: list[str] = []
    for word in _WORD.findall(text):
        tokens.extend(identifier_terms(word))
    return tokens


def term_counts(text: str) -> Counter[str]:
    """How often each term of ``text`` occurs: `code_tokens`, counted.

    Each distinct word is split once, however often it occurs: a file
    repeats its identifiers far more than it introduces new ones.
    """
    counts: Counter[str] = Counter()
    for word, times in Counter(_WORD.findall(text)).items():
        for term in identifier_terms(word):
            counts[term] += times
    return counts


def identifier_key(word: str) -> str:
    """The form an identifier is matched under: ``Over_Budget`` -> ``overbudget``."""
    return "".join(_parts(word))


def query_identifiers(query: str) -> list[str]:
    """The identifiers a query names, as `identifier_key`s, in order, once each.

    A word of fewer than three characters, or a stopword, names nothing.
    """
    keys: dict[str, None] = {}
    for word in _WORD.findall(query):
        key = identifier_key(word)
        if len(key) >= 3 and key not in STOPWORDS:
            keys[key] = None
    return list(keys)


class Bm25Index:
    """Okapi BM25 over documents added and removed one at a time.

    Postings are arrays: four bytes a document id, two a term count, so a
    project of tens of thousands of chunks stays in tens of megabytes. Removing
    a document marks it dead; its postings stay until `compact`, which the owner
    calls once dead documents outnumber live ones.
    """

    def __init__(self, k1: float = BM25_K1, b: float = BM25_B) -> None:
        self.k1 = k1
        self.b = b
        self._term_ids: dict[str, int] = {}
        self._postings: list[array] = []  # per term: document ids
        self._counts: list[array] = []  # per term: occurrences in that document
        self._lengths = array("I")  # per document: its number of terms
        self._alive = bytearray()
        self._live = 0
        self._total_length = 0

    @property
    def live(self) -> int:
        return self._live

    @property
    def dead(self) -> int:
        return len(self._lengths) - self._live

    def add(self, counts: Mapping[str, int]) -> int:
        """Index a document given its `term_counts`; returns its id."""
        doc = len(self._lengths)
        length = sum(counts.values())
        self._lengths.append(length)
        self._alive.append(1)
        self._live += 1
        self._total_length += length
        for term, count in counts.items():
            term_id = self._term_ids.get(term)
            if term_id is None:
                term_id = len(self._postings)
                self._term_ids[term] = term_id
                self._postings.append(array("I"))
                self._counts.append(array("H"))
            self._postings[term_id].append(doc)
            self._counts[term_id].append(min(count, 0xFFFF))
        return doc

    def remove(self, doc: int) -> None:
        if 0 <= doc < len(self._alive) and self._alive[doc]:
            self._alive[doc] = 0
            self._live -= 1
            self._total_length -= self._lengths[doc]

    def compact(self) -> list[int]:
        """Drop dead documents; returns the new id of each old one (-1 if dead)."""
        mapping = [-1] * len(self._lengths)
        lengths = array("I")
        for old, alive in enumerate(self._alive):
            if alive:
                mapping[old] = len(lengths)
                lengths.append(self._lengths[old])
        term_ids: dict[str, int] = {}
        postings: list[array] = []
        counts: list[array] = []
        for term, term_id in self._term_ids.items():
            docs, numbers = array("I"), array("H")
            for doc, count in zip(self._postings[term_id], self._counts[term_id]):
                if mapping[doc] >= 0:
                    docs.append(mapping[doc])
                    numbers.append(count)
            if docs:
                term_ids[term] = len(postings)
                postings.append(docs)
                counts.append(numbers)
        self._term_ids, self._postings, self._counts = term_ids, postings, counts
        self._lengths = lengths
        self._alive = bytearray(b"\1" * len(lengths))
        return mapping

    def _live_postings(self, term: str) -> list[tuple[int, int]]:
        term_id = self._term_ids.get(term)
        if term_id is None:
            return []
        alive = self._alive
        return [
            (doc, count)
            for doc, count in zip(self._postings[term_id], self._counts[term_id])
            if alive[doc]
        ]

    def containing(self, term: str) -> set[int]:
        """The live documents that hold ``term``."""
        return {doc for doc, _count in self._live_postings(term)}

    def scores(self, terms: Iterable[str]) -> dict[int, float]:
        """BM25 score of every live document holding at least one of ``terms``."""
        if not self._live:
            return {}
        n = self._live
        average = self._total_length / n or 1.0
        scores: dict[int, float] = defaultdict(float)
        for term in dict.fromkeys(terms):
            postings = self._live_postings(term)
            if not postings:
                continue
            df = len(postings)
            idf = math.log(1.0 + (n - df + 0.5) / (df + 0.5))
            for doc, count in postings:
                norm = 1.0 - self.b + self.b * self._lengths[doc] / average
                scores[doc] += idf * count * (self.k1 + 1.0) / (count + self.k1 * norm)
        return dict(scores)


def ranked(scores: Mapping[int, float], limit: int) -> list[int]:
    """The ``limit`` best documents, best first; ties go to the lower id."""
    best = heapq.nsmallest(limit, scores.items(), key=lambda item: (-item[1], item[0]))
    return [doc for doc, _score in best]


def exact_ranking(
    identifiers: Sequence[str],
    containing: Callable[[str], set[int]],
    defining: Callable[[str], set[int]],
) -> list[int]:
    """Documents that hold the query's identifiers whole.

    First those that define the most of them (their symbol's own name), then
    those that hold the most; ties go to the lower id. ``containing`` and
    ``defining`` answer for one `identifier_key`. A one-word identifier is held
    by a compound that contains it as a part, too: an index of whole words only
    would cost a second set of postings.
    """
    defines: Counter[int] = Counter()
    holds: Counter[int] = Counter()
    for key in identifiers:
        defines.update(defining(key))
        holds.update(containing(key))
    docs = set(defines) | set(holds)
    return sorted(docs, key=lambda doc: (-defines[doc], -holds[doc], doc))


def rrf(rankings: Iterable[Sequence[Hashable]], k: int = RRF_K) -> list[Hashable]:
    """Reciprocal Rank Fusion: ``sum(1 / (k + rank))`` over the rankings, best first.

    A document ranked by both lists beats one ranked by a single list at the
    same rank. Ties go to the better single rank, then to the first seen.
    """
    score: dict[Hashable, float] = {}
    best: dict[Hashable, int] = {}
    for ranking in rankings:
        for rank, doc in enumerate(ranking, start=1):
            score[doc] = score.get(doc, 0.0) + 1.0 / (k + rank)
            best[doc] = min(best.get(doc, rank), rank)
    order = {doc: position for position, doc in enumerate(score)}
    return sorted(score, key=lambda doc: (-score[doc], best[doc], order[doc]))


def best_window(lines: Sequence[str], terms: set[str], size: int) -> int:
    """Start of the ``size`` consecutive lines that hold the most query terms."""
    if len(lines) <= size:
        return 0
    hits = [len(terms.intersection(code_tokens(line))) for line in lines]
    window = best = sum(hits[:size])
    start = 0
    for first in range(1, len(lines) - size + 1):
        window += hits[first + size - 1] - hits[first - 1]
        if window > best:
            best, start = window, first
    return start


def excerpt_rows(
    lines: Sequence[str], terms: set[str], max_lines: int
) -> list[int | None]:
    """Which lines of a chunk an excerpt shows; None marks lines left out.

    All of them when they fit. Otherwise the first line (the signature), then
    the window that holds the most query terms, then None if lines follow.
    """
    total = len(lines)
    size = max(1, max_lines)
    if total <= size:
        return list(range(total))
    if size == 1:
        return [0, None]
    start = 1 + best_window(lines[1:], terms, size - 1)
    rows: list[int | None] = [0]
    if start > 1:
        rows.append(None)
    rows.extend(range(start, start + size - 1))
    if start + size - 1 < total:
        rows.append(None)
    return rows
