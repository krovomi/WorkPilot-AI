"""The generic mutator: simple inversions on the lines a task wrote.

Any stack, no tool to install: a lexical pass, one mutation at a time, on the
code of a line, never inside a comment or a string. The language is told by
the file's extension, only to know how its comments and strings are written
(``#`` or ``//``, triple quotes, backticks, verbatim strings, raw strings).

The operators are the ones mutation tools share, chosen so a surviving one
reads as a missing test:

- comparisons: ``==`` / ``!=`` (and ``===`` / ``!==``), ``<`` / ``<=``,
  ``>`` / ``>=``, only when the operator stands between spaces, so generics
  (``List<int>``), arrows (``=>``, ``->``), shifts and Go's ``<-`` are left
  alone;
- logic: ``&&`` / ``||``, Python's and Ruby's ``and`` / ``or``;
- literals: ``true`` / ``false`` (``True`` / ``False``);
- arithmetic: ``+`` / ``-`` between spaces.

A line that looks like an import, a declaration of a type or an annotation is
skipped: inverting nothing a test could see would only make noise.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import PurePosixPath

__all__ = ["Mutant", "language_of", "mask_code", "mutants_for"]

# Comment and string syntax, by family.
_HASH = "hash"  # Python, Ruby, shell, Elixir, R, YAML-like
_SLASH = "slash"  # C, C++, C#, Java, Kotlin, Scala, JS/TS, Go, Rust, Swift, Dart
_PHP = "php"  # both

_FAMILY: dict[str, str] = {
    **dict.fromkeys((".py", ".rb", ".ex", ".exs", ".r", ".jl", ".cr"), _HASH),
    **dict.fromkeys(
        (
            ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".cs", ".java", ".kt",
            ".kts", ".scala", ".groovy", ".js", ".jsx", ".mjs", ".cjs", ".ts",
            ".tsx", ".mts", ".cts", ".go", ".rs", ".swift", ".dart", ".vue",
            ".svelte", ".razor", ".cshtml", ".m", ".mm", ".zig", ".fs",
        ),
        _SLASH,
    ),
    ".php": _PHP,
}  # fmt: skip

_SKIP_LINE = re.compile(
    r"^\s*(?:import\b|from\s+\S+\s+import\b|using\b|package\b|namespace\b|"
    r"#include\b|@\w|use\s|require\b|export\s+(?:type|interface)\b|"
    r"(?:public\s+|private\s+|internal\s+|protected\s+)*(?:interface|enum|struct)\b)"
)

# (pattern on masked code, replacement, description). Ordered: a longer
# operator first, so ``<=`` is never read as ``<``.
_OPERATORS: tuple[tuple[re.Pattern[str], str, str], ...] = (
    (re.compile(r"(?<=\s)===(?=\s)"), "!==", "=== becomes !=="),
    (re.compile(r"(?<=\s)!==(?=\s)"), "===", "!== becomes ==="),
    (re.compile(r"(?<=\s)==(?=\s)"), "!=", "== becomes !="),
    (re.compile(r"(?<=\s)!=(?=\s)"), "==", "!= becomes =="),
    (re.compile(r"(?<=\s)<=(?=\s)"), "<", "<= becomes <"),
    (re.compile(r"(?<=\s)>=(?=\s)"), ">", ">= becomes >"),
    (re.compile(r"(?<=\s)<(?=\s)"), "<=", "< becomes <="),
    (re.compile(r"(?<=\s)>(?=\s)"), ">=", "> becomes >="),
    (re.compile(r"&&"), "||", "&& becomes ||"),
    (re.compile(r"\|\|"), "&&", "|| becomes &&"),
    (re.compile(r"(?<=\s)\+(?=\s)"), "-", "+ becomes -"),
    (re.compile(r"(?<=\s)-(?=\s)"), "+", "- becomes +"),
)
_WORDS: dict[str, tuple[tuple[re.Pattern[str], str, str], ...]] = {
    _HASH: (
        (re.compile(r"\band\b"), "or", "and becomes or"),
        (re.compile(r"\bor\b"), "and", "or becomes and"),
        (re.compile(r"\bTrue\b"), "False", "True becomes False"),
        (re.compile(r"\bFalse\b"), "True", "False becomes True"),
        (re.compile(r"\btrue\b"), "false", "true becomes false"),
        (re.compile(r"\bfalse\b"), "true", "false becomes true"),
    ),
    _SLASH: (
        (re.compile(r"\btrue\b"), "false", "true becomes false"),
        (re.compile(r"\bfalse\b"), "true", "false becomes true"),
    ),
}
_WORDS[_PHP] = _WORDS[_SLASH]


@dataclass(frozen=True)
class Mutant:
    path: str
    line: int  # 1-based
    column: int  # 0-based, in the line
    original: str
    replacement: str
    description: str

    @property
    def key(self) -> str:
        return f"{self.path}:{self.line}:{self.column}:{self.replacement}"

    def apply(self, text: str) -> str:
        """``text`` (the whole file) with this one mutation."""
        lines = text.split("\n")
        row = lines[self.line - 1]
        end = self.column + len(self.original)
        if row[self.column : end] != self.original:
            raise ValueError(f"{self.path}:{self.line} changed since it was mutated")
        lines[self.line - 1] = row[: self.column] + self.replacement + row[end:]
        return "\n".join(lines)


def language_of(path: str) -> str | None:
    """The comment family of a source file, None for what this does not mutate."""
    suffix = PurePosixPath(path.replace("\\", "/")).suffix.lower()
    return _FAMILY.get(suffix)


def _string_end(text: str, i: int, family: str) -> int:
    """The index just past the string literal starting at ``text[i]``."""
    ch = text[i]
    if ch in "\"'" and text.startswith(ch * 3, i) and family in (_HASH, _SLASH):
        close = text.find(ch * 3, i + 3)  # Python, Kotlin, Swift, Dart, C# 11
        return len(text) if close < 0 else close + 3
    raw = ch == "`" or (i > 0 and text[i - 1] == "@" and ch == '"')
    j = i + 1
    while j < len(text):
        c = text[j]
        if c == "\\" and not raw:
            j += 2
            continue
        if c == ch:
            if raw and ch == '"' and text.startswith('""', j):
                j += 2  # C# verbatim: "" is a quote
                continue
            return j + 1
        if c == "\n" and ch != "`" and not raw:
            return j  # an unterminated string ends with its line
        j += 1
    return len(text)


def mask_code(text: str, family: str) -> str:
    """``text`` with comments and strings blanked (same length, newlines kept)."""
    out = list(text)
    i, n = 0, len(text)
    hash_comments = family in (_HASH, _PHP)
    slash_comments = family in (_SLASH, _PHP)
    while i < n:
        ch = text[i]
        end = -1
        if (hash_comments and ch == "#") or (
            slash_comments and text.startswith("//", i)
        ):
            end = text.find("\n", i)
            end = n if end < 0 else end
        elif slash_comments and text.startswith("/*", i):
            close = text.find("*/", i + 2)
            end = n if close < 0 else close + 2
        elif ch in "\"'`" and not (ch == "`" and family == _HASH):
            if ch == "'" and family == _SLASH and _is_char_or_lifetime(text, i):
                end = min(n, i + 3) if text[i + 1 : i + 2] != "\\" else min(n, i + 4)
            else:
                end = _string_end(text, i, family)
        if end >= 0:
            for k in range(i, end):
                if out[k] != "\n":
                    out[k] = " "
            i = max(end, i + 1)
            continue
        i += 1
    return "".join(out)


def _is_char_or_lifetime(text: str, i: int) -> bool:
    """``'a'`` (a char) or ``'a`` (a Rust lifetime): never a long string."""
    nxt = text[i + 1 : i + 4]
    return len(nxt) >= 2 and (nxt[1] == "'" or (nxt[0] == "\\" and nxt[2:3] == "'"))


def mutants_for(path: str, text: str, lines: set[int] | frozenset[int]) -> list[Mutant]:
    """Every mutant of ``lines`` (1-based) of the file ``path`` holding ``text``."""
    family = language_of(path)
    if family is None or not lines:
        return []
    raw_lines = text.split("\n")
    masked_lines = mask_code(text, family).split("\n")
    operators = _OPERATORS + _WORDS.get(family, ())
    found: list[Mutant] = []
    for number in sorted(lines):
        if not 1 <= number <= len(raw_lines):
            continue
        raw, masked = raw_lines[number - 1], masked_lines[number - 1]
        if not masked.strip() or _SKIP_LINE.match(masked):
            continue
        taken: set[int] = set()
        for pattern, replacement, description in operators:
            for match in pattern.finditer(masked):
                start = match.start()
                span = set(range(start, match.end()))
                if span & taken:
                    continue
                taken |= span
                found.append(
                    Mutant(
                        path=path,
                        line=number,
                        column=start,
                        original=raw[start : match.end()],
                        replacement=replacement,
                        description=description,
                    )
                )
    return found
