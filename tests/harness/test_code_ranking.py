"""harness.domain.code_ranking: code-aware tokens, BM25, an exact match, and RRF.

BM25 finds a chunk by the words a model asks with; the exact match puts first
the chunk that defines an identifier the query names; Reciprocal Rank Fusion
merges the two by rank alone.
"""

from __future__ import annotations

from collections import Counter

import pytest
from harness.domain.code_ranking import (
    RRF_K,
    Bm25Index,
    best_window,
    code_tokens,
    exact_ranking,
    excerpt_rows,
    identifier_key,
    identifier_terms,
    query_identifiers,
    ranked,
    rrf,
    term_counts,
)

# --- The tokenizer ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("word", "terms"),
    [
        ("parseFrontmatter", ("parse", "frontmatter", "parsefrontmatter")),
        ("parse_frontmatter", ("parse", "frontmatter", "parsefrontmatter")),
        ("ParseFrontmatter", ("parse", "frontmatter", "parsefrontmatter")),
        ("getHTTPResponse", ("get", "http", "response", "gethttpresponse")),
        ("XMLHttpRequest", ("xml", "http", "request", "xmlhttprequest")),
        ("MAX_RESULTS", ("max", "results", "maxresults")),
        ("__init__", ("init",)),
        ("budget", ("budget",)),
        ("is_valid", ("valid", "isvalid")),  # a stopword part, the whole kept
        ("x", ()),
        ("the", ()),
        ("v2", ("v2",)),
        ("404", ("404",)),
        ("réglageÉcran", ("réglage", "écran", "réglageécran")),
    ],
)
def test_an_identifier_gives_its_parts_and_itself_whole(word, terms):
    assert identifier_terms(word) == terms


def test_a_line_of_code_is_tokenized_identifier_by_identifier():
    assert code_tokens("if over_budget(spent, cap): return") == [
        "if",
        "over",
        "budget",
        "overbudget",
        "spent",
        "cap",
        "return",
    ]


def test_term_counts_counts_what_code_tokens_lists():
    text = "def over_budget(spent):\n    return over_budget(spent - 1) # over"
    assert term_counts(text) == Counter(code_tokens(text))


@pytest.mark.parametrize(
    ("query", "keys"),
    [
        ("where is over_budget checked?", ["overbudget", "checked"]),
        ("ToolExecutor.execute", ["toolexecutor", "execute"]),
        ("toolExecutor ToolExecutor tool_executor", ["toolexecutor"]),
        ("is it ok", []),  # stopwords and words under three characters
        ("(.*[", []),  # punctuation is not a word, and nothing is compiled
    ],
)
def test_the_identifiers_a_query_names(query, keys):
    assert query_identifiers(query) == keys


def test_an_identifier_key_matches_snake_and_camel_case():
    assert identifier_key("over_budget") == identifier_key("overBudget") == "overbudget"


# --- BM25 ---------------------------------------------------------------------------


def _index(*texts: str) -> Bm25Index:
    index = Bm25Index()
    for text in texts:
        index.add(term_counts(text))
    return index


def _order(index: Bm25Index, query: str) -> list[int]:
    return ranked(index.scores(code_tokens(query)), 10)


CORPUS = (
    "def over_budget(spent, cap): return spent > cap",  # 0: defines it
    "def record(call): ledger.append(call)",  # 1: unrelated
    "budget = load_budget() # the budget, the budget, the budget",  # 2: says budget a lot
    "def spend(amount): if over_budget(total, cap): stop()",  # 3: calls it
)


def test_bm25_ranks_the_chunks_that_match_the_query_best_first():
    order = _order(_index(*CORPUS), "over_budget")
    assert order[0] == 0
    assert set(order) == {0, 2, 3}  # 1 shares no term
    assert order.index(3) < order.index(2)  # the whole identifier beats its part


def test_a_rare_term_weighs_more_than_a_common_one():
    index = _index("alpha common", "beta common", "gamma common", "alpha")
    scores = index.scores(["alpha", "common"])
    assert scores[3] > scores[1]  # "alpha" alone beats "common" alone


def test_a_shorter_chunk_wins_at_the_same_count():
    index = _index("needle", "needle " + "hay " * 50)
    assert _order(index, "needle") == [0, 1]


def test_repeating_a_term_saturates():
    index = _index("cap", "cap " * 20, "other")
    scores = index.scores(["cap"])
    assert scores[1] > scores[0]
    assert scores[1] < 3 * scores[0]


def test_an_unknown_term_scores_nothing():
    assert _index(*CORPUS).scores(["nothing_like_it"]) == {}
    assert Bm25Index().scores(["budget"]) == {}


def test_a_removed_chunk_is_neither_scored_nor_counted():
    index = _index(*CORPUS)
    index.remove(0)
    index.remove(0)  # twice is once
    assert 0 not in index.scores(["budget"])
    assert index.live == 3 and index.dead == 1
    assert 0 not in index.containing("overbudget")


def test_compaction_keeps_every_score():
    index = _index(*CORPUS)
    index.remove(1)
    before = index.scores(code_tokens("over budget spent"))
    mapping = index.compact()
    assert mapping == [0, -1, 1, 2]
    after = index.scores(code_tokens("over budget spent"))
    assert after == pytest.approx({mapping[d]: s for d, s in before.items()})
    assert index.dead == 0


def test_ranked_breaks_ties_by_id():
    assert ranked({3: 1.0, 1: 1.0, 2: 2.0}, 10) == [2, 1, 3]
    assert ranked({3: 1.0, 1: 1.0, 2: 2.0}, 2) == [2, 1]


# --- The exact match ------------------------------------------------------------------


def test_the_chunk_that_defines_an_identifier_comes_first():
    holders = {"overbudget": {0, 3, 5}, "cap": {0, 3}}
    defined = {"overbudget": {5}}
    order = exact_ranking(
        ["overbudget", "cap"],
        lambda key: holders.get(key, set()),
        lambda key: defined.get(key, set()),
    )
    assert order == [5, 0, 3]  # defines one; then holds two, by id


def test_no_identifier_no_exact_match():
    assert exact_ranking([], lambda _k: {1}, lambda _k: {1}) == []


# --- Reciprocal Rank Fusion -----------------------------------------------------------


@pytest.mark.parametrize(
    ("rankings", "fused"),
    [
        ([["a", "b", "c"], ["c", "a"]], ["a", "c", "b"]),  # in both lists beats one
        ([["a"], ["b"]], ["a", "b"]),  # a tie goes to the first seen
        ([["a", "b"], []], ["a", "b"]),  # one list alone keeps its order
        ([["x", "y"], ["y", "z"]], ["y", "x", "z"]),
        ([[], []], []),
    ],
)
def test_rrf(rankings, fused):
    assert rrf(rankings) == fused


def test_rrf_sums_one_over_k_plus_rank():
    # a: 1/(k+1) + 1/(k+2); b: 1/(k+2) + 1/(k+1): the same score, the same best rank
    assert rrf([["a", "b"], ["b", "a"]]) == ["a", "b"]
    assert rrf([["a", "b"]], k=0) == ["a", "b"]
    assert RRF_K == 60


# --- What an excerpt shows -----------------------------------------------------------

BODY = ["def handle(request):"] + [f"    step_{n}()" for n in range(1, 100)]


def test_the_window_with_the_most_query_terms():
    lines = list(BODY)
    lines[60] = "    budget = over_budget(cap)"
    lines[62] = "    if budget: cap_reached()"
    assert best_window(lines, {"budget", "cap"}, 5) in range(58, 61)
    assert best_window(lines[:3], {"budget"}, 5) == 0


def test_an_excerpt_keeps_the_signature_then_the_best_window():
    lines = list(BODY)
    lines[70] = "    if over_budget(cap): stop()"
    rows = excerpt_rows(lines, {"overbudget", "cap"}, 6)
    assert rows[0] == 0 and rows[1] is None and rows[-1] is None
    shown = [r for r in rows if r is not None]
    assert 70 in shown and len(shown) == 6


@pytest.mark.parametrize(
    ("total", "max_lines", "rows"),
    [
        (3, 5, [0, 1, 2]),  # fits: all of it
        (10, 1, [0, None]),
        (10, 4, [0, 1, 2, 3, None]),  # no term: the head
    ],
)
def test_excerpt_rows(total, max_lines, rows):
    assert excerpt_rows(BODY[:total], set(), max_lines) == rows
