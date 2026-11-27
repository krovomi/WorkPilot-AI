"""The ``if`` of an approval rule: a small, closed expression language.

The policy file is versioned and reviewed, but it is still text: it is parsed
here, never handed to ``eval``. The grammar:

.. code-block:: text

    expr    := or
    or      := and ( "OR" and )*
    and     := not ( "AND" not )*
    not     := "NOT" not | atom
    atom    := "(" expr ")" | fact op value | fact "HAS" value
    op      := "=" | "!=" | "<" | "<=" | ">" | ">="

``fact`` is one of ``FACTS``; ``value`` a whole number, a quoted string or a
bare word. ``HAS`` asks whether a list fact (``pr/labels``, ``pr/layers``)
holds the value. Keywords are case-insensitive, string comparisons too.

A fact that is not known (a trust score never measured) makes its comparison
false. A rule that should fire on an unknown says so with ``NOT``, which the
built-in tiers never do: they only fire on what was measured.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .model import PRFacts

MAX_CONDITION_CHARS = 1_024
MAX_DEPTH = 8

#: The facts a condition may read, and how to read them from ``PRFacts``.
#: ``rule/files_changed`` is filled in by the rule being judged.
FACTS: dict[str, Callable[[PRFacts, int], Any]] = {
    "pr/type": lambda f, _n: f.type,
    "pr/breaking": lambda f, _n: "true" if f.breaking else "false",
    "pr/bump": lambda f, _n: f.bump or "none",
    "pr/files_changed": lambda f, _n: f.files_changed,
    "pr/diff_lines": lambda f, _n: f.diff_lines,
    "pr/layers": lambda f, _n: len(f.layers),
    "pr/layer_names": lambda f, _n: list(f.layers),
    "pr/base": lambda f, _n: f.base,
    "pr/labels": lambda f, _n: list(f.labels),
    "ci": lambda f, _n: f.ci,
    "review": lambda f, _n: f.review,
    "trust": lambda f, _n: f.trust,
    "rule/files_changed": lambda _f, n: n,
}

_TOKEN = re.compile(
    r"\s*(?:(?P<num>\d{1,9})(?![\w/])|(?P<str>'[^']*'|\"[^\"]*\")"
    r"|(?P<op><=|>=|!=|=|<|>)|(?P<paren>[()])|(?P<word>[A-Za-z_][\w/.-]*))"
)
_COMPARISONS = ("=", "!=", "<", "<=", ">", ">=")


class ConditionError(ValueError):
    """The text is not a condition of this grammar."""


@dataclass(frozen=True)
class _Tok:
    kind: str
    text: str


def _tokens(text: str) -> list[_Tok]:
    out: list[_Tok] = []
    pos = 0
    while pos < len(text):
        if text[pos:].strip() == "":
            break
        match = _TOKEN.match(text, pos)
        if match is None or match.end() == pos:
            raise ConditionError(f"unexpected text at '{text[pos : pos + 20].strip()}'")
        kind = match.lastgroup or ""
        value = match.group(kind)
        if kind == "str":
            value = value[1:-1]
        out.append(_Tok(kind, value))
        pos = match.end()
    return out


# A parsed condition is a tree of tuples, evaluated by ``_eval``:
# ("or", [a, b]), ("and", [a, b]), ("not", a), ("cmp", fact, op, value).
Node = tuple


class _Parser:
    def __init__(self, tokens: list[_Tok]) -> None:
        self.tokens = tokens
        self.pos = 0
        self.depth = 0

    def peek(self) -> _Tok | None:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def keyword(self, word: str) -> bool:
        tok = self.peek()
        if tok and tok.kind == "word" and tok.text.upper() == word:
            self.pos += 1
            return True
        return False

    def take(self) -> _Tok:
        tok = self.peek()
        if tok is None:
            raise ConditionError("the condition ends too early")
        self.pos += 1
        return tok

    def parse(self) -> Node:
        node = self.or_()
        if self.peek() is not None:
            raise ConditionError(f"unexpected '{self.peek().text}'")  # type: ignore[union-attr]
        return node

    def or_(self) -> Node:
        items = [self.and_()]
        while self.keyword("OR"):
            items.append(self.and_())
        return items[0] if len(items) == 1 else ("or", items)

    def and_(self) -> Node:
        items = [self.not_()]
        while self.keyword("AND"):
            items.append(self.not_())
        return items[0] if len(items) == 1 else ("and", items)

    def not_(self) -> Node:
        if self.keyword("NOT"):
            return ("not", self.not_())
        return self.atom()

    def atom(self) -> Node:
        tok = self.take()
        if tok.kind == "paren" and tok.text == "(":
            self.depth += 1
            if self.depth > MAX_DEPTH:
                raise ConditionError(f"more than {MAX_DEPTH} levels of parentheses")
            node = self.or_()
            closing = self.take()
            if closing.kind != "paren" or closing.text != ")":
                raise ConditionError("a '(' is not closed")
            self.depth -= 1
            return node
        if tok.kind != "word" or tok.text.lower() not in FACTS:
            raise ConditionError(
                f"'{tok.text}' is not a fact ({', '.join(sorted(FACTS))})"
            )
        fact = tok.text.lower()
        op_tok = self.take()
        if op_tok.kind == "word" and op_tok.text.upper() == "HAS":
            op = "has"
        elif op_tok.kind == "op" and op_tok.text in _COMPARISONS:
            op = op_tok.text
        else:
            raise ConditionError(f"'{op_tok.text}' is not a comparison after '{fact}'")
        value_tok = self.take()
        if value_tok.kind not in ("num", "str", "word"):
            raise ConditionError(f"'{value_tok.text}' is not a value")
        value: Any = int(value_tok.text) if value_tok.kind == "num" else value_tok.text
        return ("cmp", fact, op, value)


def parse_condition(text: str) -> Node:
    """The tree of ``text``; raises ``ConditionError`` when it does not parse."""
    if not isinstance(text, str) or not text.strip():
        raise ConditionError("the condition is empty")
    if len(text) > MAX_CONDITION_CHARS:
        raise ConditionError(
            f"the condition is longer than {MAX_CONDITION_CHARS} characters"
        )
    if any(ord(c) < 32 and c not in "\t" for c in text):
        raise ConditionError("the condition holds a control character")
    return _Parser(_tokens(text)).parse()


def _compare(actual: Any, op: str, expected: Any) -> bool:
    if actual is None:
        return False
    if op == "has":
        if not isinstance(actual, list):
            return False
        return str(expected).lower() in {str(a).lower() for a in actual}
    if isinstance(actual, list):
        return False
    if isinstance(actual, int) and not isinstance(actual, bool):
        if not isinstance(expected, int):
            return False
        return {
            "=": actual == expected,
            "!=": actual != expected,
            "<": actual < expected,
            "<=": actual <= expected,
            ">": actual > expected,
            ">=": actual >= expected,
        }[op]
    left, right = str(actual).lower(), str(expected).lower()
    if op == "=":
        return left == right
    if op == "!=":
        return left != right
    return False  # an order between words means nothing here


def evaluate(node: Node, facts: PRFacts, rule_files: int = 0) -> bool:
    kind = node[0]
    if kind == "or":
        return any(evaluate(n, facts, rule_files) for n in node[1])
    if kind == "and":
        return all(evaluate(n, facts, rule_files) for n in node[1])
    if kind == "not":
        return not evaluate(node[1], facts, rule_files)
    _, fact, op, value = node
    return _compare(FACTS[fact](facts, rule_files), op, value)


__all__ = ["FACTS", "ConditionError", "Node", "evaluate", "parse_condition"]
