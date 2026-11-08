"""Code smells outside Python, for the Refactoring agent.

``SmellDetector`` reads Python with the ``ast`` module. Every other stack
WorkPilot supports (.NET, Java/Kotlin/Scala, Go, Rust, Swift, PHP, Ruby,
Dart, C/C++, JS/TS) goes through this line-based reader instead: the
declarations come from ``doc_languages`` and a function's body is the block
its braces (or, for Ruby, its ``end``) close. Like ``doc_languages``, the
reader prefers missing a smell to inventing one.

The checks mirror the Python ones: long method, long parameter list, deep
nesting (control blocks only), too many returns, god class, missing doc
comment, magic number; the file-level checks (large file, duplicate block)
are language-agnostic and reused from ``SmellDetector``.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Protocol

try:
    from doc_languages import LANGUAGES, extract_symbols, language_for
    from doc_languages.polyglot import doc_status
except ImportError:  # pragma: no cover - imported as apps.backend.*
    from apps.backend.doc_languages import (  # type: ignore[no-redef]
        LANGUAGES,
        extract_symbols,
        language_for,
    )
    from apps.backend.doc_languages.polyglot import (  # type: ignore[no-redef]
        doc_status,
    )

from .refactorer_smells import CodeSmell, SmellSeverity, SmellType


class _Detector(Protocol):
    """What the polyglot pass reuses from ``refactorer.SmellDetector``."""

    thresholds: dict[str, int]

    def _check_large_file(
        self, lines: list[str], file_path: str
    ) -> list[CodeSmell]: ...


# Words that open a control block: only these count towards nesting depth.
_CONTROL = re.compile(
    r"^(?:\}\s*)?(?:else\s+if|else|if|elif|elsif|unless|for|foreach|while|do|"
    r"switch|match|when|case|try|catch|rescue|finally|ensure|loop|guard|"
    r"using|lock|with|select|defer)\b"
)
_RETURN = re.compile(r"\breturn\b")
_NUMBER = re.compile(
    r"(?<![\w.])-?(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?)(?:[mMfFdDlLuU]{1,2})?(?![\w.])"
)
_CONSTANT_LINE = re.compile(
    r"\b(?:const|final|static\s+readonly|readonly|val|let|enum|#define|"
    r"public\s+static\s+final|private\s+static\s+final|static\s+final|"
    r"case|default)\b|^[A-Z][A-Z0-9_]*\s*[:=]"
)
_STRING = re.compile(r"\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|`[^`]*`")
_SAFE_NUMBERS = {"0", "1", "-1", "2", "10", "100"}

# Language guessing for pasted code (no file name): (language id, pattern, weight).
_HINTS: tuple[tuple[str, str, int], ...] = (
    (
        "csharp",
        r"^\s*using\s+System|^\s*namespace\s+[\w.]+\s*[;{]?\s*$|\bpublic\s+(?:async\s+)?Task\b|\bvar\s+\w+\s*=\s*new\b",
        3,
    ),
    (
        "csharp",
        r"\b(?:public|private|internal|protected)\s+(?:static\s+)?(?:readonly\s+)?\w+(?:<[^>]+>)?\s+\w+\s*\{\s*get",
        3,
    ),
    (
        "java",
        r"^\s*package\s+[\w.]+;|^\s*import\s+java\.|\bpublic\s+static\s+void\s+main\b|System\.out\.print",
        3,
    ),
    (
        "kotlin",
        r"^\s*fun\s+\w+|\bval\s+\w+\s*[:=]|\bdata\s+class\b|^\s*package\s+[\w.]+\s*$",
        3,
    ),
    (
        "scala",
        r"^\s*object\s+\w+|\bcase\s+class\b|\bdef\s+\w+\s*\([^)]*\)\s*:\s*\w+\s*=",
        2,
    ),
    (
        "go",
        r"^\s*package\s+\w+\s*$|^\s*func\s+(?:\(\w+\s+\*?\w+\)\s*)?\w+\(|:=|\bfmt\.\w+",
        3,
    ),
    (
        "rust",
        r"^\s*(?:pub\s+)?fn\s+\w+|\blet\s+mut\b|\bimpl\b|->\s*Result<|::new\(|\bprintln!",
        3,
    ),
    (
        "swift",
        r"^\s*import\s+(?:Foundation|UIKit|SwiftUI)|\bfunc\s+\w+\([^)]*\)\s*->|\bguard\s+let\b|\bvar\s+\w+\s*:\s*\w+",
        3,
    ),
    ("php", r"<\?php|\$\w+\s*=|\bfunction\s+\w+\s*\(.*\$|->\w+\(", 3),
    (
        "ruby",
        r"^\s*def\s+\w+[?!]?\s*(?:\(|$)|^\s*end\s*$|\bputs\b|\battr_accessor\b|\brequire\s+'",
        3,
    ),
    (
        "dart",
        r"^\s*import\s+'package:|\bWidget\s+build\b|\bfinal\s+\w+\s+\w+\s*=|\bvoid\s+main\s*\(\)",
        3,
    ),
    ("cpp", r"#include\s*<|\bstd::|\bcout\s*<<|::\w+\s*\(", 3),
    (
        "typescript",
        r"\binterface\s+\w+\s*\{|:\s*(?:string|number|boolean)\b|\bexport\s+(?:default\s+)?(?:function|const|class)\b|=>\s*\{|\bconst\s+\w+\s*=",
        2,
    ),
    (
        "python",
        r"^\s*def\s+\w+\(.*\)\s*(?:->\s*[\w\[\], ]+)?:\s*$|^\s*import\s+\w+\s*$|^\s*from\s+[\w.]+\s+import\b|\bself\.\w+|^\s*class\s+\w+(?:\([^)]*\))?:\s*$",
        3,
    ),
)


def guess_language(source: str) -> str:
    """The most likely language id of a pasted snippet ("" when unsure)."""
    scores: dict[str, int] = {}
    for lang, pattern, weight in _HINTS:
        hits = len(re.findall(pattern, source, flags=re.MULTILINE))
        if hits:
            scores[lang] = scores.get(lang, 0) + weight * min(hits, 5)
    if not scores:
        return ""
    return max(scores, key=lambda lang: scores[lang])


def snippet_path(language: str) -> str:
    """A display file name with the language's extension ("snippet.cs")."""
    for lang in LANGUAGES:
        if lang.id == language:
            return f"snippet{lang.extensions[0]}"
    return "snippet.txt"


def supported_languages() -> list[dict[str, str]]:
    """The languages the reader knows, for the language picker."""
    return [{"id": lang.id, "label": lang.label} for lang in LANGUAGES]


@dataclass
class _Block:
    start: int  # 0-based line of the declaration
    end: int  # 0-based line of the closing brace / end
    body: list[str]


def _code_only(line: str, lang_hash: bool) -> str:
    """The line without strings and trailing comments."""
    text = _STRING.sub('""', line)
    cut = text.find("//")
    if cut >= 0:
        text = text[:cut]
    if lang_hash:
        cut = text.find("#")
        if cut >= 0:
            text = text[:cut]
    return text


_CONTINUATION = re.compile(
    r"^(?:[{)\]:,]|->|=>|where\b|throws\b|extends\b|implements\b|with\b|:)"
)
_EXPRESSION_BODY = re.compile(r"\)\s*(?::\s*[^={]+)?=\s*[^=>]")


def _brace_block(lines: list[str], start: int, lang_hash: bool) -> _Block | None:
    """The block the declaration at ``start`` opens with ``{``, or None.

    Before the brace, a line only belongs to the declaration while its
    parentheses are still open or it continues the signature (``)``, ``->``,
    ``where``...): an abstract or protocol member never borrows the next
    declaration's body.
    """
    depth = 0
    parens = 0
    opened = False
    for index in range(start, len(lines)):
        code = _code_only(lines[index], lang_hash)
        if not opened:
            stripped = code.strip()
            if (
                index > start
                and parens <= 0
                and stripped
                and not _CONTINUATION.match(stripped)
            ):
                return None
            if index - start > 6:
                return None
            head = code.split("{", 1)[0]
            if (
                ";" in head
                or ("=>" in head and "{" not in code)
                or _EXPRESSION_BODY.search(head)
            ):
                return None  # abstract, interface or expression-bodied member
            parens += head.count("(") - head.count(")")
        for char in code:
            if char == "{":
                depth += 1
                opened = True
            elif char == "}":
                depth -= 1
                if opened and depth == 0:
                    return _Block(start, index, lines[start : index + 1])
    return None


def _ruby_block(lines: list[str], start: int) -> _Block | None:
    """A Ruby ``def`` / ``class`` closed by the ``end`` at its own indentation."""
    indent = len(lines[start]) - len(lines[start].lstrip())
    for index in range(start + 1, len(lines)):
        raw = lines[index]
        if raw.strip() == "end" and len(raw) - len(raw.lstrip()) == indent:
            return _Block(start, index, lines[start : index + 1])
    return None


def _counted_lines(body: Iterable[str]) -> int:
    return sum(
        1
        for line in body
        if line.strip() and not line.strip().startswith(("//", "#", "*", "/*"))
    )


def _nesting(body: list[str], lang_hash: bool, ruby: bool) -> int:
    """Deepest stack of control blocks inside a function body."""
    deepest = 0
    if ruby:
        stack: list[bool] = []
        for raw in body[1:]:
            stripped = raw.strip()
            if stripped == "end":
                if stack:
                    stack.pop()
                continue
            if re.match(
                r"^(?:if|unless|while|until|for|case|begin)\b", stripped
            ) or re.search(r"\bdo(?:\s*\|[^|]*\|)?\s*$", stripped):
                stack.append(True)
                deepest = max(deepest, len(stack))
        return deepest
    stack = []
    pending = False  # a control line whose brace opens on the next line (Allman)
    for raw in body:
        code = _code_only(raw, lang_hash)
        stripped = code.strip()
        is_control = bool(_CONTROL.match(stripped)) or (
            pending and stripped.startswith("{")
        )
        pending = (
            bool(_CONTROL.match(stripped))
            and "{" not in code
            and not stripped.endswith(";")
        )
        for char in code:
            if char == "{":
                stack.append(is_control)
                deepest = max(deepest, sum(stack))
                is_control = False  # a second brace on the line is a nested literal
            elif char == "}" and stack:
                stack.pop()
    # the function's own brace is not a control block
    return deepest


def _magic_numbers(lines: list[str], lang_hash: bool, path: str) -> list[CodeSmell]:
    smells: list[CodeSmell] = []
    for index, raw in enumerate(lines):
        stripped = raw.strip()
        if not stripped or stripped.startswith(
            ("//", "#", "*", "/*", "import", "using", "package")
        ):
            continue
        code = _code_only(raw, lang_hash)
        if _CONSTANT_LINE.search(code.strip()):
            continue
        for match in _NUMBER.finditer(code):
            value = match.group(0).replace("_", "").rstrip("mMfFdDlLuU")
            if value in _SAFE_NUMBERS:
                continue
            smells.append(
                CodeSmell(
                    smell_type=SmellType.MAGIC_NUMBER,
                    severity=SmellSeverity.INFO,
                    file_path=path,
                    line_start=index + 1,
                    line_end=index + 1,
                    message=f"Magic number {value} found",
                    metric_value=int(value) if value.lstrip("-").isdigit() else 0,
                )
            )
    return smells


def detect_polyglot_smells(
    source: str, language: str, detector: _Detector
) -> list[CodeSmell]:
    """The smells of a non-Python source, with the detector's thresholds."""
    path = snippet_path(language)
    lang = language_for(path)
    if lang is None:
        return []
    lines = source.splitlines()
    thresholds = detector.thresholds
    ruby = lang.id == "ruby"
    smells: list[CodeSmell] = []
    smells.extend(detector._check_large_file(lines, path))

    symbols = extract_symbols(source, path)
    blocks: dict[int, _Block] = {}
    for symbol in symbols:
        start = symbol.line - 1
        block = (
            _ruby_block(lines, start)
            if ruby
            else _brace_block(lines, start, lang.hash_comments)
        )
        if block:
            blocks[symbol.line] = block

    for symbol in symbols:
        short = symbol.name.split(".")[-1]
        public = not short.startswith("_") and not re.match(
            r"^\s*private\b", lines[symbol.line - 1]
        )
        block = blocks.get(symbol.line)
        if symbol.kind == "class":
            if block:
                members = [
                    s
                    for s in symbols
                    if s.kind != "class" and block.start < s.line - 1 <= block.end
                ]
                limit = thresholds["max_class_methods"]
                if len(members) > limit:
                    smells.append(
                        CodeSmell(
                            smell_type=SmellType.GOD_CLASS,
                            severity=SmellSeverity.HIGH,
                            file_path=path,
                            line_start=symbol.line,
                            line_end=block.end + 1,
                            message=f"Class '{symbol.name}' has {len(members)} methods (threshold: {limit})",
                            symbol_name=symbol.name,
                            metric_value=len(members),
                            threshold=limit,
                        )
                    )
        else:
            params = len(symbol.args)
            limit = thresholds["max_parameters"]
            if params > limit:
                smells.append(
                    CodeSmell(
                        smell_type=SmellType.LONG_PARAMETER_LIST,
                        severity=SmellSeverity.MEDIUM,
                        file_path=path,
                        line_start=symbol.line,
                        line_end=symbol.line,
                        message=f"Method '{symbol.name}' has {params} parameters (threshold: {limit})",
                        symbol_name=symbol.name,
                        metric_value=params,
                        threshold=limit,
                    )
                )
            if block:
                length = _counted_lines(block.body)
                limit = thresholds["max_method_lines"]
                if length > limit:
                    smells.append(
                        CodeSmell(
                            smell_type=SmellType.LONG_METHOD,
                            severity=SmellSeverity.HIGH
                            if length > limit * 2
                            else SmellSeverity.MEDIUM,
                            file_path=path,
                            line_start=symbol.line,
                            line_end=block.end + 1,
                            message=f"Method '{symbol.name}' has {length} lines (threshold: {limit})",
                            symbol_name=symbol.name,
                            metric_value=length,
                            threshold=limit,
                        )
                    )
                depth = _nesting(block.body, lang.hash_comments, ruby)
                limit = thresholds["max_nesting_depth"]
                if depth > limit:
                    smells.append(
                        CodeSmell(
                            smell_type=SmellType.DEEP_NESTING,
                            severity=SmellSeverity.HIGH
                            if depth > limit + 2
                            else SmellSeverity.MEDIUM,
                            file_path=path,
                            line_start=symbol.line,
                            line_end=block.end + 1,
                            message=f"Method '{symbol.name}' has nesting depth {depth} (threshold: {limit})",
                            symbol_name=symbol.name,
                            metric_value=depth,
                            threshold=limit,
                        )
                    )
                returns = sum(
                    len(_RETURN.findall(_code_only(line, lang.hash_comments)))
                    for line in block.body
                )
                limit = thresholds["max_returns"]
                if returns > limit:
                    smells.append(
                        CodeSmell(
                            smell_type=SmellType.TOO_MANY_RETURNS,
                            severity=SmellSeverity.LOW,
                            file_path=path,
                            line_start=symbol.line,
                            line_end=block.end + 1,
                            message=f"Method '{symbol.name}' has {returns} return statements (threshold: {limit})",
                            symbol_name=symbol.name,
                            metric_value=returns,
                            threshold=limit,
                        )
                    )
        if public and doc_status(symbol, lang) == "missing":
            what = "class" if symbol.kind == "class" else "method"
            smells.append(
                CodeSmell(
                    smell_type=SmellType.MISSING_DOCSTRING,
                    severity=SmellSeverity.INFO,
                    file_path=path,
                    line_start=symbol.line,
                    line_end=symbol.line,
                    message=f"Public {what} '{symbol.name}' is missing a doc comment",
                    symbol_name=symbol.name,
                )
            )

    smells.extend(detector._check_duplicates(lines, path))
    smells.extend(_magic_numbers(lines, lang.hash_comments, path))
    return smells
