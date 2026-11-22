"""Code links between two cards: what shared files and the history miss.

- Cross imports: a file of one card imports a module the other card edits.
- Removed symbols: one card's changes remove (or rename) an identifier that a
  file of the other card still uses.

Pure and language-agnostic, the same rules as the desktop
(``main/conflict-waves/code-links.ts``): an import line is recognised by a
closed list of keywords many languages share, a module by its file name, an
identifier by its characters. Nothing is parsed per language and no model
is called.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field

from .scorer import Footprint, display_sort

#: Each code link adds 1 to a pair's score, at most this much.
MAX_CODE_WEIGHT = 3
#: Removed symbols kept per card.
MAX_REMOVED_SYMBOLS = 200

_IMPORT_LINE = re.compile(
    r"^(?:import|from|export\b.*\bfrom|require(?:_relative|_once)?|include(?:_once)?"
    r"|#\s*(?:include|import)|@(?:import|use|forward)|use|using|global\s+using|open"
    r"|(?:pub\s+)?mod|pub\s+use|extern\s+crate|library|source|load|alias|imports?)\b"
)
_INLINE_IMPORT = re.compile(r"\b(?:require|import)\s*\(")
_IMPORT_BLOCK_OPEN = re.compile(r"^import\s*\($")

#: File names that stand for their folder (``pkg/index.ts``, ``pkg/__init__.py``).
INDEX_STEMS = frozenset({"index", "__init__", "mod", "main", "lib", "init", "package"})
#: Names many folders have: these only match with their parent folder.
GENERIC_STEMS = frozenset(
    {
        "app",
        "base",
        "common",
        "config",
        "constants",
        "core",
        "helpers",
        "model",
        "models",
        "shared",
        "spec",
        "src",
        "styles",
        "test",
        "tests",
        "types",
        "util",
        "utils",
    }
)

_WORD_SPLIT = re.compile(r"[^\w$-]+")
#: A letter, ``_`` or ``$``, then letters, digits, ``_`` or ``$``.
_IDENTIFIER = re.compile(r"(?:[^\W\d]|\$)(?:\w|\$)*")
_LINE_BREAK = re.compile(r"\r?\n")


@dataclass
class SpecCode:
    """What a card's files say, indexed for the pair checks."""

    #: Module key (``stem`` or ``parent/stem``) -> normalized files importing it.
    imports: dict[str, list[str]] = field(default_factory=dict)
    #: Distinctive identifier -> normalized files using it.
    symbols: dict[str, list[str]] = field(default_factory=dict)
    #: Distinctive identifiers its changes removed, sorted.
    removed: list[str] = field(default_factory=list)


def _words(line: str) -> list[str]:
    return [w.strip("-") for w in _WORD_SPLIT.split(line.lower()) if w.strip("-")]


def module_key(normalized_path: str) -> str | None:
    """The key an import of this file would name, or None."""
    segments = [s for s in normalized_path.split("/") if s]
    if not segments:
        return None
    last = segments.pop()
    stem = last.split(".")[0]
    if stem in INDEX_STEMS:
        stem = segments.pop() if segments else ""
    stem = stem.strip("-")
    if len(stem) < 2:
        return None
    if stem not in GENERIC_STEMS and len(stem) >= 3:
        return stem
    return f"{segments[-1]}/{stem}" if segments else None


def _line_keys(line: str) -> list[str]:
    words = _words(line)
    return words + [f"{words[i - 1]}/{words[i]}" for i in range(1, len(words))]


def import_keys(text: str) -> set[str]:
    """Every module key the file's import lines name."""
    keys: set[str] = set()
    in_block = False
    for raw in _LINE_BREAK.split(text):
        line = raw.strip()
        if in_block:
            if line.startswith(")"):
                in_block = False
            else:
                keys.update(_line_keys(line))
            continue
        if _IMPORT_BLOCK_OPEN.match(line):
            in_block = True
            continue
        if _IMPORT_LINE.match(line) or _INLINE_IMPORT.search(line):
            keys.update(_line_keys(line))
    return keys


def is_distinctive(identifier: str) -> bool:
    """At least 4 characters, shaped like a name someone chose: ``camelCase``,
    ``snake_case``, a digit after a letter."""
    if len(identifier) < 4:
        return False
    for i in range(len(identifier) - 1):
        here, after = identifier[i], identifier[i + 1]
        if here.islower() and after.isupper():
            return True
        if here.isalpha() and after.isnumeric():
            return True
        if (
            after == "_"
            and here.isalnum()
            and i + 2 < len(identifier)
            and identifier[i + 2].isalnum()
        ):
            return True
    return False


def distinctive_identifiers(text: str) -> set[str]:
    return {
        m.group(0) for m in _IDENTIFIER.finditer(text) if is_distinctive(m.group(0))
    }


def removed_symbols(diff: str, after: Iterable[set[str]]) -> list[str]:
    """Identifiers on removed lines, on no added line, and in none of the files
    as they are now (``after``). Only hunk lines count."""
    removed: set[str] = set()
    added: set[str] = set()
    in_hunk = False
    for line in _LINE_BREAK.split(diff):
        if line.startswith("diff "):
            in_hunk = False
        elif line.startswith("@@"):
            in_hunk = True
        elif in_hunk and line.startswith("-"):
            removed |= distinctive_identifiers(line[1:])
        elif in_hunk and line.startswith("+"):
            added |= distinctive_identifiers(line[1:])
    still = list(after)
    return sorted(
        ident
        for ident in removed
        if ident not in added and not any(ident in tokens for tokens in still)
    )[:MAX_REMOVED_SYMBOLS]


def build_spec_code(files: list[tuple[str, str]], diff: str | None) -> SpecCode:
    """Indexes a card's files (``(normalized path, text)``) and its diff."""
    code = SpecCode()
    tokens_by_file: list[set[str]] = []
    for path, text in files:
        for key in import_keys(text):
            code.imports.setdefault(key, []).append(path)
        tokens = distinctive_identifiers(text)
        tokens_by_file.append(tokens)
        for token in tokens:
            code.symbols.setdefault(token, []).append(path)
    code.removed = removed_symbols(diff, tokens_by_file) if diff else []
    return code


def _import_links(
    to: Footprint, origin: Footprint, origin_code: SpecCode, links: set[str]
) -> None:
    for x, shown_x in to.items():
        if x in origin:
            continue
        key = module_key(x)
        for y in origin_code.imports.get(key, []) if key else []:
            if y not in to:
                links.add(f"{origin[y]} → {shown_x}")


def _symbol_links(
    remover: SpecCode,
    other: Footprint,
    user: Footprint,
    user_code: SpecCode,
    links: set[str],
) -> None:
    for symbol in remover.removed:
        for y in user_code.symbols.get(symbol, []):
            if y not in other:
                links.add(f"{user[y]} → {symbol}")


def code_links(
    a: Footprint, a_code: SpecCode | None, b: Footprint, b_code: SpecCode | None
) -> tuple[list[str], list[str]]:
    """(import links, symbol links), both ways, sorted; empty when either side was not read."""
    if a_code is None or b_code is None:
        return [], []
    imports: set[str] = set()
    _import_links(a, b, b_code, imports)
    _import_links(b, a, a_code, imports)
    symbols: set[str] = set()
    _symbol_links(a_code, a, b, b_code, symbols)
    _symbol_links(b_code, b, a, a_code, symbols)
    return display_sort(imports), display_sort(symbols)
