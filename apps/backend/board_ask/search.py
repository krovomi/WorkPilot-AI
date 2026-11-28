"""The keyword half of « Interroger le tableau », for a server project.

The same small BM25 the desktop app runs (``apps/frontend/src/shared/utils/
board-ask-search.ts``), written for any language and without a dependency:
words are folded (case, accents), cut to a stem of :data:`STEM_LENGTH`
letters, a short query word matches the stems it begins ("admin" finds
"administration"), and scripts written without spaces (Chinese, Japanese,
Korean, Thai) are read as pairs of characters. The words a question shares
with a ticket written in another language come from the model, which adds
them to the query (``board_ask/answer.py``).
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

#: Letters a stem keeps: "administration" and "administrer" meet on "admini".
STEM_LENGTH = 6
#: A query stem shorter than this never matches by prefix ("ui" stays "ui").
MIN_PREFIX = 3
K1 = 1.2
B = 0.75

_UNSPACED = re.compile(r"[฀-๿぀-ヿ㐀-䶿一-鿿가-힯]")
_WORD = re.compile(r"[^\W_]+")

#: Words that say nothing about a subject, folded already (no accents).
STOPWORDS: dict[str, tuple[str, ...]] = {
    "en": tuple(
        "a an and are as at be been but by can could did do does for from had has "
        "have how i if in into is it its me my no not of on or our should so than "
        "that the their them then there these they this to was we were what when "
        "where which who why will with would you your".split()
    ),
    "fr": tuple(
        "a au aux avec ce ces cette comment dans de des du elle en est et etait ete "
        "il ils je la le les leur lui ma mais me mes moi mon ne nos notre nous on ou "
        "par pas pour qu que quel quelle quels qui sa se ses si son sur ta te tes toi "
        "ton tu un une vos votre vous y".split()
    ),
    "es": tuple(
        "al como con de del el en es esta este fue ha la las lo los mas para pero "
        "por que se sin su sus un una y".split()
    ),
    "de": tuple(
        "auf das dem den der des die ein eine einen fur hat ich ist mit nicht oder "
        "sich sie und von war wie wir zu".split()
    ),
    "it": tuple(
        "al che come con da del della di e gli il in la le lo nel per piu questo si "
        "sono un una".split()
    ),
    "pt": tuple(
        "ao com como da das de do dos e em foi isso mais mas na no os para por que "
        "se sem um uma".split()
    ),
    "nl": tuple(
        "aan als bij dat de die een en het hoe in is met niet of op te van voor wat "
        "wij zijn".split()
    ),
}
_ALL_STOPWORDS = frozenset(word for words in STOPWORDS.values() for word in words)
_STOPWORD_SETS = {language: frozenset(words) for language, words in STOPWORDS.items()}


def fold(text: str) -> str:
    """Lower case, accents removed: « Révisée » and "revisee" are one word."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).lower()


def _stem(word: str) -> str:
    # A trailing plural "s" first, so "pages" and "page" meet before the cut.
    singular = word[:-1] if len(word) > 3 and word.endswith("s") else word
    return singular[:STEM_LENGTH]


def _pairs(run: str) -> list[str]:
    if len(run) < 2:
        return [run]
    return [run[i : i + 2] for i in range(len(run) - 1)]


def tokenize(text: str) -> list[str]:
    """The terms of a text, in order, repeats kept (they are its frequencies)."""
    terms: list[str] = []
    for word in _WORD.findall(fold(text)):
        if _UNSPACED.search(word):
            terms.extend(_pairs(word))
        elif len(word) >= 2 and word not in _ALL_STOPWORDS:
            terms.append(_stem(word))
    return terms


def detect_languages(texts: Iterable[str]) -> list[str]:
    """The languages the texts are written in, most used first.

    Each text votes for the language whose common words it uses most; a
    language that wins fewer than one text in ten is left out.
    """
    votes: dict[str, int] = {}
    voters = 0
    for text in texts:
        words = _WORD.findall(fold(text))
        best, best_count = "", 0
        for language, common in _STOPWORD_SETS.items():
            count = sum(1 for w in words if w in common)
            if count > best_count:
                best, best_count = language, count
        if best_count >= 2:
            voters += 1
            votes[best] = votes.get(best, 0) + 1
    kept = [(lang, n) for lang, n in votes.items() if n * 10 >= voters]
    return [lang for lang, _ in sorted(kept, key=lambda item: -item[1])]


@dataclass(frozen=True)
class Field:
    """One field of a document and how much a word found in it counts."""

    text: str
    weight: float


@dataclass(frozen=True)
class Document:
    id: str
    fields: Sequence[Field]


@dataclass
class _Indexed:
    id: str
    frequencies: dict[str, float] = field(default_factory=dict)
    length: float = 0.0


class KeywordIndex:
    """The documents, indexed once, to be asked several queries."""

    def __init__(self, documents: Iterable[Document]) -> None:
        self._documents: list[_Indexed] = []
        self._df: dict[str, int] = {}
        for document in documents:
            indexed = _Indexed(document.id)
            for part in document.fields:
                for term in tokenize(part.text):
                    indexed.frequencies[term] = (
                        indexed.frequencies.get(term, 0.0) + part.weight
                    )
                    indexed.length += part.weight
            for term in indexed.frequencies:
                self._df[term] = self._df.get(term, 0) + 1
            self._documents.append(indexed)
        total = sum(d.length for d in self._documents)
        self._average = (
            (total / len(self._documents) or 1.0) if self._documents else 1.0
        )

    def __len__(self) -> int:
        return len(self._documents)

    def _expand(self, stemmed: str) -> list[str]:
        """The index terms a query stem stands for: itself, those it begins
        when it is short ("admin" → "admini"), and a short word it begins
        with ("admini" → "admin")."""
        if _UNSPACED.search(stemmed):
            return [stemmed] if stemmed in self._df else []
        short = MIN_PREFIX <= len(stemmed) < STEM_LENGTH
        return [
            term
            for term in self._df
            if term == stemmed
            or (short and term.startswith(stemmed))
            or (MIN_PREFIX + 2 <= len(term) < STEM_LENGTH and stemmed.startswith(term))
        ]

    def search(self, query: Iterable[tuple[str, float]], limit: int) -> list[str]:
        """The ids of the documents that share a term with the query, best first."""
        weights: dict[str, float] = {}
        for text, weight in query:
            if weight <= 0:
                continue
            for term in tokenize(text):
                weights[term] = max(weights.get(term, 0.0), weight)
        scores: dict[str, float] = {}
        count = len(self._documents)
        for query_term, weight in weights.items():
            for term in self._expand(query_term):
                df = self._df.get(term, 0)
                idf = math.log(1 + (count - df + 0.5) / (df + 0.5))
                for document in self._documents:
                    tf = document.frequencies.get(term)
                    if not tf:
                        continue
                    norm = tf + K1 * (1 - B + B * document.length / self._average)
                    scores[document.id] = scores.get(document.id, 0.0) + (
                        weight * idf * (tf * (K1 + 1)) / norm
                    )
        ranked = sorted(scores.items(), key=lambda item: -item[1])
        return [doc_id for doc_id, _ in ranked[: max(0, limit)]]
