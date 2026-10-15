"""Code split where a reader would split it: one chunk per symbol.

`search_code` (lot 7) ranks chunks, not files. A file is too coarse to hand a
model, which then reads all of it for one function; a fixed window cuts a
function in two and loses its name. A chunk is a function, a method or a class
head, and its path and symbol are written in front of it before it is indexed
(`Chunk.context`): ``core/client.py create_client`` is the free version of
contextual retrieval, since the words a model asks with are often in the path
and the name rather than in the body.

| Language | How it is split |
|---|---|
| Python | `ast`: functions, classes, methods (``Class.method``); decorators and the comments right above included |
| TypeScript / JavaScript, C#, Java, Go, Rust | declaration lines found by pattern; the body ends where its braces balance, counted outside strings and comments |
| anything else, or a Python file that does not parse | windows of `WINDOW_LINES` lines |

The heuristics are partial on purpose: no grammar is vendored, so no new
dependency. A brace in a string spanning lines, a raw string or a macro can end
a chunk early or late; no line that holds a word is lost for it. The lines
between symbols become ``code`` chunks under their class, or at module level,
and a chunk longer than `MAX_CHUNK_LINES` is cut into parts.

Pure, table-tested in ``tests/harness/test_code_chunks.py``.
"""

from __future__ import annotations

import ast
import functools
import re
from dataclasses import dataclass, field

#: A chunk longer than this is cut into parts: an excerpt shows a window of it,
#: and one very long chunk would win on term counts alone.
MAX_CHUNK_LINES = 120
#: The fallback window, also used for the code between symbols.
WINDOW_LINES = 60
#: Lines a signature may span before its body opens.
_SIGNATURE_LINES = 12

#: The kinds that name a symbol the chunk defines, as opposed to the code
#: around symbols (``code``) and the fallback (``window``).
SYMBOL_KINDS = frozenset({"function", "method", "class", "type"})


@dataclass(frozen=True, slots=True)
class Chunk:
    """A run of lines of one file, and the symbol it belongs to."""

    path: str  # posix, relative to the project root
    symbol: str  # "Class.method", "function"; "" outside any symbol
    kind: str  # function, method, class, type, code, window
    start: int  # first line, 1-based
    end: int  # last line, inclusive

    @property
    def context(self) -> str:
        """What is indexed in front of the chunk's lines."""
        return f"{self.path} {self.symbol}".strip()

    @property
    def location(self) -> str:
        """``path:start-end · symbol (kind)``: enough to read it again exactly."""
        where = f"{self.path}:{self.start}-{self.end}"
        return f"{where} · {self.symbol} ({self.kind})" if self.symbol else where


LANGUAGES: dict[str, str] = {
    ".py": "python",
    ".pyi": "python",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".cs": "csharp",
    ".java": "java",
    ".go": "go",
    ".rs": "rust",
}


def language_of(path: str) -> str | None:
    """The language a path's extension names, among those split by symbol."""
    dot = path.rfind(".")
    if dot <= path.rfind("/"):
        return None
    return LANGUAGES.get(path[dot:].lower())


# (first line, last line, symbol, kind), 1-based and inclusive.
_Span = tuple[int, int, str, str]


@dataclass
class _Found:
    spans: list[_Span] = field(default_factory=list)
    # Classes and the like, whose lines between members belong to them.
    containers: list[_Span] = field(default_factory=list)


def chunk_file(path: str, text: str) -> list[Chunk]:
    """``text`` (the content of ``path``) as chunks, in line order.

    Every line that holds a word is in exactly one chunk.
    """
    lines = text.splitlines()
    if not any(line.strip() for line in lines):
        return []
    language = language_of(path)
    found: _Found | None = None
    if language == "python":
        found = _python(text, lines)
    elif language in _GRAMMARS:
        found = _braces(lines, _GRAMMARS[language])
    return _assemble(path, lines, found or _Found())


def _with_comments(
    lines: list[str], start: int, floor: int, markers: tuple[str, ...]
) -> int:
    """``start`` moved up over the comment lines right above it, not past ``floor``."""
    while start - 1 >= max(1, floor):
        above = lines[start - 2].strip()
        if not above or not above.startswith(markers):
            break
        start -= 1
    return start


# --- Python -----------------------------------------------------------------

_DEFINITIONS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


def _python(text: str, lines: list[str]) -> _Found | None:
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        return None  # windows: a file that does not parse is still searchable
    found = _Found()
    found.spans = _python_body(tree.body, "", lines, found, floor=1, in_class=False)
    return found


def _python_body(
    body: list[ast.stmt],
    prefix: str,
    lines: list[str],
    found: _Found,
    *,
    floor: int,
    in_class: bool,
) -> list[_Span]:
    spans: list[_Span] = []
    for node in body:
        if not isinstance(node, _DEFINITIONS):
            continue
        first = min([node.lineno, *(d.lineno for d in node.decorator_list)])
        start = _with_comments(lines, first, floor, ("#",))
        end = node.end_lineno or node.lineno
        name = prefix + node.name
        if isinstance(node, ast.ClassDef):
            members = _python_body(
                node.body,
                name + ".",
                lines,
                found,
                floor=node.lineno + 1,
                in_class=True,
            )
            head_end = members[0][0] - 1 if members else end
            found.containers.append((start, end, name, "class"))
            spans.append((start, head_end, name, "class"))
            spans.extend(members)
        else:
            spans.append((start, end, name, "method" if in_class else "function"))
        floor = end + 1
    return spans


# --- Brace languages ----------------------------------------------------------


@dataclass(frozen=True)
class _Rule:
    """A declaration line, and what it opens.

    ``leaf``: a chunk. ``container``: a head chunk, then its members.
    ``transparent``: its members only, named as if it were not there (a C#
    namespace, a Rust ``mod``). ``block`` bodies end at their closing brace;
    ``statement`` ones (``const f = () => {…};``) at the end of the statement.
    """

    pattern: re.Pattern[str]
    kind: str
    role: str = "leaf"
    body: str = "block"


@dataclass(frozen=True)
class _Grammar:
    top: tuple[_Rule, ...]
    members: tuple[_Rule, ...]
    comments: tuple[str, ...]
    single_quote_strings: bool = False  # '…' is a string, not a character
    backtick_strings: bool = False  # `…` may span lines


#: Words a declaration pattern may catch that never name a symbol.
_KEYWORDS = frozenset(
    {
        "if",
        "else",
        "for",
        "foreach",
        "while",
        "do",
        "switch",
        "case",
        "catch",
        "try",
        "finally",
        "return",
        "throw",
        "new",
        "delete",
        "typeof",
        "sizeof",
        "nameof",
        "await",
        "yield",
        "using",
        "lock",
        "fixed",
        "checked",
        "unchecked",
        "with",
        "function",
        "super",
        "this",
        "base",
        "default",
        "synchronized",
    }
)

_JS = r"[A-Za-z_$][\w$]*"
_JS_TOP = (
    _Rule(
        re.compile(
            rf"^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?"
            rf"class\s+(?P<name>{_JS})"
        ),
        "class",
        "container",
    ),
    _Rule(
        re.compile(
            rf"^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?(?:interface|enum)\s+(?P<name>{_JS})"
        ),
        "type",
    ),
    _Rule(
        re.compile(
            rf"^\s*(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+(?P<name>{_JS})"
        ),
        "type",
        "transparent",
    ),
    _Rule(
        re.compile(
            rf"^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?"
            rf"function\b\s*\*?\s*(?P<name>{_JS})"
        ),
        "function",
    ),
    # `const f = (…) => {`, `const f = async function`, `const f = useCallback((…) => {`
    _Rule(
        re.compile(
            rf"^\s*(?:export\s+)?(?:const|let|var)\s+(?P<name>{_JS})[^=]*=(?![=>])"
            r"(?=.*(?:=>|\bfunction\b))"
        ),
        "function",
        body="statement",
    ),
)
_JS_MEMBERS = (
    _Rule(
        re.compile(
            r"^\s*(?:(?:public|private|protected|static|readonly|async|override|abstract"
            r"|declare|accessor|get|set)\s+)*\*?\s*"
            rf"(?P<name>#?{_JS})\s*(?:<[^<>()]*>)?\s*\("
        ),
        "method",
    ),
    _Rule(
        re.compile(
            r"^\s*(?:(?:public|private|protected|static|readonly|override)\s+)*"
            rf"(?P<name>#?{_JS})\s*(?::[^=]*)?=(?![=>])(?=.*(?:=>|\bfunction\b))"
        ),
        "method",
        body="statement",
    ),
)

_CS_MODIFIERS = (
    r"(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly"
    r"|unsafe|new|virtual|override|async|extern|file|required|ref)\s+)*"
)
_CS_ATTRIBUTES = r"(?:\[[^\]]*\]\s*)*"
_CS_TYPE = _Rule(
    re.compile(
        rf"^\s*{_CS_ATTRIBUTES}{_CS_MODIFIERS}"
        r"(?:class|struct|interface|record(?:\s+(?:class|struct))?)\s+(?P<name>\w+)"
    ),
    "class",
    "container",
)
_CS_ENUM = _Rule(
    re.compile(rf"^\s*{_CS_ATTRIBUTES}{_CS_MODIFIERS}enum\s+(?P<name>\w+)"), "type"
)
# Each word of a return type ends in whitespace, so the repetition cannot
# split one word two ways (no catastrophic backtracking on a non-match).
_CS_METHOD = _Rule(
    re.compile(
        rf"^\s*{_CS_ATTRIBUTES}{_CS_MODIFIERS}(?:[\w<>\[\],.?()]+\s+)*"
        r"(?P<name>~?\w+)\s*(?:<[^<>()]*>)?\s*\("
    ),
    "method",
)
_CS = _Grammar(
    top=(
        _Rule(re.compile(r"^\s*namespace\s+(?P<name>[\w.]+)"), "type", "transparent"),
        _CS_TYPE,
        _CS_ENUM,
    ),
    members=(_CS_TYPE, _CS_ENUM, _CS_METHOD),
    comments=("//", "/*", "*", "["),
)

_JAVA_MODIFIERS = (
    r"(?:(?:public|private|protected|static|final|abstract|synchronized|native|default"
    r"|strictfp|sealed|non-sealed|transient|volatile)\s+)*"
)
_JAVA_ANNOTATIONS = r"(?:@\w+(?:\([^)]*\))?\s+)*"
_JAVA_TYPE = _Rule(
    re.compile(
        rf"^\s*{_JAVA_ANNOTATIONS}{_JAVA_MODIFIERS}"
        r"(?:class|interface|enum|record|@interface)\s+(?P<name>\w+)"
    ),
    "class",
    "container",
)
_JAVA_METHOD = _Rule(
    re.compile(
        rf"^\s*{_JAVA_ANNOTATIONS}{_JAVA_MODIFIERS}(?:<[^()]*?>\s+)?"
        r"(?:[\w<>\[\],.?]+\s+)*(?P<name>\w+)\s*\("
    ),
    "method",
)
_JAVA = _Grammar(
    top=(_JAVA_TYPE,),
    members=(_JAVA_TYPE, _JAVA_METHOD),
    comments=("//", "/*", "*", "@"),
)

_GO = _Grammar(
    top=(
        _Rule(
            re.compile(
                r"^func\s*(?:\(\s*(?:\w+\s+)?\*?\s*(?P<owner>\w+)(?:\[[^\]]*\])?\s*\)\s*)?"
                r"(?P<name>\w+)"
            ),
            "function",
        ),
        _Rule(re.compile(r"^type\s+(?P<name>\w+)"), "type"),
    ),
    members=(),
    comments=("//", "/*", "*"),
    backtick_strings=True,
)

_RUST_VISIBILITY = r"(?:pub(?:\s*\([^)]*\))?\s+)?"
_RUST_FN = _Rule(
    re.compile(
        rf"^\s*{_RUST_VISIBILITY}(?:(?:default|const|async|unsafe|extern)\s+)*fn\s+(?P<name>\w+)"
    ),
    "function",
)
_RUST = _Grammar(
    top=(
        _RUST_FN,
        _Rule(
            re.compile(rf"^\s*{_RUST_VISIBILITY}(?:struct|enum|union)\s+(?P<name>\w+)"),
            "type",
        ),
        _Rule(
            re.compile(rf"^\s*{_RUST_VISIBILITY}(?:unsafe\s+)?trait\s+(?P<name>\w+)"),
            "type",
            "container",
        ),
        _Rule(
            re.compile(
                r"^\s*(?:unsafe\s+)?impl\b(?:\s*<[^{]*?>)?\s+(?:[^{]*?\bfor\s+)?"
                r"(?:\w+::)*(?P<name>\w+)"
            ),
            "type",
            "container",
        ),
        _Rule(
            re.compile(rf"^\s*{_RUST_VISIBILITY}mod\s+(?P<name>\w+)"),
            "type",
            "transparent",
        ),
    ),
    members=(_Rule(_RUST_FN.pattern, "method"),),
    comments=("//", "/*", "*", "#[", "#!["),
)

_JS_GRAMMAR = _Grammar(
    top=_JS_TOP,
    members=_JS_MEMBERS,
    comments=("//", "/*", "*", "@"),
    single_quote_strings=True,
    backtick_strings=True,
)
_GRAMMARS: dict[str, _Grammar] = {
    "typescript": _JS_GRAMMAR,
    "javascript": _JS_GRAMMAR,
    "csharp": _CS,
    "java": _JAVA,
    "go": _GO,
    "rust": _RUST,
}

_WORDY = re.compile(r"\w")
_NOT_NEWLINE = re.compile(r"[^\n]")


@functools.cache
def _literals(grammar: _Grammar) -> re.Pattern[str]:
    """Comments and strings, the earliest first: what may hold a brace that is not code."""
    alternatives = [
        r"//[^\n]*",
        r"/\*.*?(?:\*/|\Z)",
        r'"(?:\\.|[^"\\\n])*(?:"|$)',
        # A JS string, or else a character literal ('a', '\n', '\u{1F600}'),
        # never a Rust lifetime ('a>).
        r"'(?:\\.|[^'\\\n])*(?:'|$)"
        if grammar.single_quote_strings
        else r"'(?:\\[^'\n]{1,10}|[^'\\\n])'",
    ]
    if grammar.backtick_strings:  # a template literal or a Go raw string, multi-line
        alternatives.append(r"`(?:\\.|[^`\\])*(?:`|\Z)")
    return re.compile("|".join(alternatives), re.DOTALL | re.MULTILINE)


def _mask(lines: list[str], grammar: _Grammar) -> list[str]:
    """Each line with its comments and strings blanked: only code braces count."""
    masked = _literals(grammar).sub(
        lambda match: _NOT_NEWLINE.sub(" ", match.group()), "\n".join(lines)
    )
    return masked.split("\n")


def _depths(masked: list[str]) -> list[int]:
    """The brace depth at the start of each line (never below zero)."""
    depths: list[int] = []
    depth = 0
    for line in masked:
        depths.append(depth)
        depth = max(0, depth + line.count("{") - line.count("}"))
    return depths


def _block_end(masked: list[str], first: int, last: int, base: int) -> int | None:
    """Last line of the body a declaration at ``first`` opens, or None if it opens none.

    The body opens at the first brace outside parentheses; a ``;`` before it
    ends a declaration that has no body (an abstract method, a type alias).
    """
    depth, nesting, opened = base, 0, False
    for k in range(first, last + 1):
        if not opened and k - first >= _SIGNATURE_LINES:
            return None
        for char in masked[k]:
            if char in "([":
                nesting += 1
            elif char in ")]":
                nesting = max(0, nesting - 1)
            elif char == "{":
                opened = opened or nesting == 0
                depth += 1
            elif char == "}":
                depth -= 1
                if opened and depth <= base:
                    return k
            elif char == ";" and not opened and nesting == 0 and depth == base:
                return None
    return last if opened else None


def _statement_end(masked: list[str], first: int, last: int, base: int) -> int | None:
    """Last line of a statement that holds a body, or None if it holds no brace."""
    depth, nesting, braced = base, 0, False
    for k in range(first, last + 1):
        if not braced and k - first >= _SIGNATURE_LINES:
            return None
        for char in masked[k]:
            if char in "([":
                nesting += 1
            elif char in ")]":
                nesting = max(0, nesting - 1)
            elif char == "{":
                braced = True
                depth += 1
            elif char == "}":
                depth -= 1
            elif char == ";" and nesting == 0 and depth <= base:
                return k if braced else None
        if braced and depth <= base and nesting == 0:
            return k
    return last if braced else None


@dataclass
class _Source:
    lines: list[str]
    masked: list[str]
    depths: list[int]
    grammar: _Grammar
    found: _Found


def _braces(lines: list[str], grammar: _Grammar) -> _Found:
    masked = _mask(lines, grammar)
    source = _Source(lines, masked, _depths(masked), grammar, _Found())
    _scan(source, 0, len(lines) - 1, 0, grammar.top, "", floor=1)
    return source.found


def _declaration(rules: tuple[_Rule, ...], line: str) -> tuple[_Rule, str] | None:
    for rule in rules:
        match = rule.pattern.match(line)
        if match is None:
            continue
        name = match.group("name")
        if name.lstrip("#~") in _KEYWORDS:
            continue
        owner = match.groupdict().get("owner")
        return rule, f"{owner}.{name}" if owner else name
    return None


def _scan(
    source: _Source,
    first: int,
    last: int,
    depth: int,
    rules: tuple[_Rule, ...],
    prefix: str,
    *,
    floor: int,
) -> None:
    """Declarations at ``depth`` between lines ``first`` and ``last`` (0-based)."""
    i = first
    while i <= last:
        hit = (
            _declaration(rules, source.masked[i]) if source.depths[i] == depth else None
        )
        if hit is None:
            i += 1
            continue
        rule, name = hit
        ends = _statement_end if rule.body == "statement" else _block_end
        end = ends(source.masked, i, last, depth)
        if end is None:
            i += 1
            continue
        start = _with_comments(source.lines, i + 1, floor, source.grammar.comments)
        kind = "method" if "." in name and rule.kind == "function" else rule.kind
        if rule.role == "leaf":
            source.found.spans.append((start, end + 1, prefix + name, kind))
        elif rule.role == "transparent":
            _scan(source, i + 1, end - 1, depth + 1, rules, prefix, floor=i + 2)
        else:
            before = len(source.found.spans)
            _scan(
                source,
                i + 1,
                end - 1,
                depth + 1,
                source.grammar.members,
                prefix + name + ".",
                floor=i + 2,
            )
            members = source.found.spans[before:]
            head_end = min(span[0] for span in members) - 1 if members else end + 1
            source.found.containers.append((start, end + 1, prefix + name, kind))
            source.found.spans.insert(before, (start, head_end, prefix + name, kind))
        floor = end + 2
        i = end + 1


# --- Assembly -------------------------------------------------------------------


def _assemble(path: str, lines: list[str], found: _Found) -> list[Chunk]:
    """Symbols, the code between them, and parts of whatever is too long."""
    total = len(lines)
    covered = bytearray(total + 2)
    pieces: list[_Span] = []
    for start, end, symbol, kind in found.spans:
        start, end = max(1, start), min(total, end)
        if start > end or any(covered[start : end + 1]):
            continue  # a heuristic overlap: keep the first, the rest is code
        covered[start : end + 1] = b"\1" * (end - start + 1)
        pieces.append((start, end, symbol, kind))

    # Who owns each line between symbols: the innermost container around it.
    owner: list[_Span | None] = [None] * (total + 2)
    for container in sorted(found.containers, key=lambda c: (c[0], -c[1])):
        for n in range(max(1, container[0]), min(total, container[1]) + 1):
            owner[n] = container
    gap_kind = "code" if found.spans else "window"
    run: list[int] = []
    for n in range(1, total + 2):
        inside = n <= total and not covered[n]
        if run and (not inside or owner[n] is not owner[run[0]]):
            pieces.extend(_gap(lines, run, owner[run[0]], gap_kind))
            run = []
        if inside:
            run.append(n)

    chunks: list[Chunk] = []
    for start, end, symbol, kind in sorted(pieces):
        size = WINDOW_LINES if kind in ("code", "window") else MAX_CHUNK_LINES
        for part in range(start, end + 1, size):
            chunks.append(Chunk(path, symbol, kind, part, min(end, part + size - 1)))
    return chunks


def _gap(
    lines: list[str], run: list[int], owner: _Span | None, kind: str
) -> list[_Span]:
    """The stretch of a run of lines outside every symbol that holds a word.

    A run of closing braces alone is not worth a chunk.
    """
    filled = [n for n in run if _WORDY.search(lines[n - 1])]
    if not filled:
        return []
    return [(filled[0], filled[-1], owner[2] if owner else "", kind)]
