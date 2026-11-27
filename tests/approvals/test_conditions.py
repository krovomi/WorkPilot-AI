"""The ``if`` of an approval rule: parsed by a closed grammar, never ``eval``."""

from __future__ import annotations

import pytest
from approvals.conditions import ConditionError, evaluate, parse_condition
from approvals.model import ChangedFile, PRFacts


def _facts(**kw) -> PRFacts:
    base = {
        "files": (ChangedFile("src/a.py", 10, 2), ChangedFile("src/b.py", 1, 1)),
        "type": "fix",
        "layers": ("apps/backend",),
        "labels": ("Security",),
        "ci": "green",
        "review": "agree",
    }
    base.update(kw)
    return PRFacts(**base)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("pr/type = fix", True),
        ("pr/type = FIX", True),
        ("pr/type != feat", True),
        ("pr/files_changed >= 2", True),
        ("pr/files_changed > 2", False),
        ("pr/diff_lines < 15", True),
        ("pr/layers = 1", True),
        ("pr/labels HAS security", True),
        ("pr/labels has 'docs'", False),
        ("ci = green AND review = agree", True),
        ("ci = red OR review = agree", True),
        ("NOT (ci = green)", False),
        ("(pr/type = feat OR pr/type = fix) AND pr/layers <= 1", True),
        ("rule/files_changed = 3", True),
    ],
)
def test_conditions_read_the_facts(text, expected):
    assert evaluate(parse_condition(text), _facts(), rule_files=3) is expected


def test_an_unknown_fact_never_satisfies_a_comparison():
    facts = _facts(trust=None)
    assert evaluate(parse_condition("trust < 50"), facts) is False
    assert evaluate(parse_condition("trust >= 50"), facts) is False


def test_words_are_not_ordered_and_numbers_are_not_words():
    assert evaluate(parse_condition("pr/type > aaa"), _facts()) is False
    assert evaluate(parse_condition("pr/files_changed = two"), _facts()) is False
    assert evaluate(parse_condition("pr/labels = security"), _facts()) is False


@pytest.mark.parametrize(
    "text",
    [
        "",
        "   ",
        "__import__('os')",
        "pr/type",
        "pr/type ==",
        "unknown/fact = 1",
        "pr/type = fix AND",
        "(pr/type = fix",
        "pr/type = fix)",
        "pr/type = fix; rm",
        "pr/type ~ fix",
        "pr/type = fix\x00",
        "(" * 9 + "pr/type = fix" + ")" * 9,
        "pr/type = " + "a" * 1100,
    ],
)
def test_text_outside_the_grammar_is_refused(text):
    with pytest.raises(ConditionError):
        parse_condition(text)
