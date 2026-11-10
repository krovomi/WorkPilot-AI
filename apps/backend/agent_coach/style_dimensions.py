"""The dimensions of a developer's style, measured on lines of code.

Each dimension has a closed list of values. A measure reads the lines a
commit added to one file and returns votes, ``(dimension, value) -> count``.
Nothing here keeps code: a vote is a dimension and one of its values.

Languages are named by file suffix (``LANGUAGES``); a dimension that a
language does not have (imports in Go, result types in Python) gets no vote
there. Every language WorkPilot builds has naming, comments, function length
and guard style; imports, error handling and test style where they apply.

Pure: no file, no git.
"""

from __future__ import annotations

import re
from collections import Counter
from pathlib import PurePosixPath

from foundation.test_conventions import is_test, is_test_dir

__all__ = [
    "DIMENSIONS",
    "LANGUAGES",
    "is_test_file",
    "language_of",
    "measure",
]

DIMENSIONS: dict[str, tuple[str, ...]] = {
    "naming_functions": ("camelCase", "snake_case", "PascalCase"),
    "naming_variables": ("camelCase", "snake_case", "PascalCase"),
    "name_length": ("short", "descriptive"),
    "comments": ("none", "minimal", "verbose"),
    "doc_comments": ("documented", "undocumented"),
    "comment_language": ("en", "fr"),
    "function_length": ("short", "medium", "long"),
    "imports": ("named", "default", "from_import", "module_import"),
    "error_handling": ("exceptions", "result_types"),
    "guard_style": ("early_return", "nested"),
    "assertions": ("few", "many"),
    "mocking": ("framework", "manual"),
}
"""Every dimension and its values: the only words a profile can hold."""

LANGUAGES: dict[str, str] = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cs": "csharp",
    ".java": "java",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".dart": "dart",
    ".scala": "scala",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".hpp": "cpp",
    ".c": "c",
    ".h": "c",
    ".fs": "fsharp",
}

_HASH_COMMENT = {"python", "ruby"}
_INDENT_BLOCKS = {"python", "fsharp"}
_KEYWORDS = frozenset(
    "if for while switch catch return new using lock foreach elif else when match "
    "try do sizeof typeof await yield throw function def fn func fun".split()
)

_FUNCTIONS: dict[str, tuple[re.Pattern[str], ...]] = {
    "python": (re.compile(r"^\s*(?:async\s+)?def\s+(\w+)"),),
    "ruby": (re.compile(r"^\s*def\s+(?:self\.)?(\w+)"),),
    "javascript": (
        re.compile(
            r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)"
        ),
        re.compile(
            r"^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>"
        ),
        re.compile(r"^\s*(?:static\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{\s*$"),
    ),
    "go": (re.compile(r"^\s*func\s+(?:\([^)]*\)\s*)?(\w+)\s*\("),),
    "rust": (re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)"),),
    "kotlin": (
        re.compile(r"^\s*(?:[a-z]+\s+)*fun\s+(?:<[^>]*>\s*)?(?:\w+\.)?(\w+)\s*\("),
    ),
    "scala": (re.compile(r"^\s*(?:[a-z]+\s+)*def\s+(\w+)"),),
    "swift": (re.compile(r"^\s*(?:[a-z@]+\s+)*func\s+(\w+)"),),
    "php": (re.compile(r"^\s*(?:[a-z]+\s+)*function\s+(\w+)"),),
    "fsharp": (re.compile(r"^\s*let\s+(?:rec\s+|inline\s+|private\s+)*(\w+)\s+[\w(]"),),
    "c_family": (
        re.compile(
            r"^\s*(?:(?:public|private|protected|internal|static|async|override|virtual|"
            r"abstract|sealed|final|extern|inline|const|unsafe|partial|synchronized)\s+)*"
            r"[\w:<>\[\],.?*&]+\s+[*&]?(\w+)\s*\([^;{]*\)\s*(?:const\s*)?(?:\{|=>)?\s*$"
        ),
    ),
}
_FUNCTIONS["typescript"] = (
    *_FUNCTIONS["javascript"],
    re.compile(
        r"^\s*(?:public|private|protected|static|readonly|async|\s)*(\w+)\s*\([^)]*\)\s*:\s*[^=]+\{\s*$"
    ),
)

_VARIABLES: dict[str, tuple[re.Pattern[str], ...]] = {
    "python": (re.compile(r"^\s*([A-Za-z_]\w*)\s*(?::\s*[^=]+)?=(?!=)"),),
    "ruby": (re.compile(r"^\s*([a-z_]\w*)\s*=(?!=)"),),
    "javascript": (
        re.compile(
            r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=(?!\s*(?:async\s*)?\()"
        ),
    ),
    "go": (re.compile(r"^\s*(\w+)\s*:="), re.compile(r"^\s*var\s+(\w+)")),
    "rust": (re.compile(r"^\s*let\s+(?:mut\s+)?(\w+)"),),
    "kotlin": (re.compile(r"^\s*(?:val|var)\s+(\w+)"),),
    "scala": (re.compile(r"^\s*(?:val|var)\s+(\w+)"),),
    "swift": (re.compile(r"^\s*(?:let|var)\s+(\w+)"),),
    "php": (re.compile(r"^\s*\$(\w+)\s*=(?!=)"),),
    "fsharp": (re.compile(r"^\s*let\s+(?:mutable\s+)?(\w+)\s*="),),
    "c_family": (
        re.compile(
            r"^\s*(?:var|final|const|auto|let|[A-Z]\w*(?:<[^>]*>)?(?:\[\])?\??|int|long|bool|string|double|float|char)\s+(\w+)\s*=(?!=)"
        ),
    ),
}
_VARIABLES["typescript"] = _VARIABLES["javascript"]

_FR = frozenset(
    "le la les des une est pour avec dans pas que qui sur cette sont aux du ce".split()
)
_EN = frozenset("the is for with and this that not are of to it be when".split())
_COMMENT_TEXT = re.compile(r"^\s*(?:#|//+|/\*+|\*|--)\s?(.*)$")
_DOC_START = re.compile(r'^\s*(?:///|/\*\*|##|"""|\'\'\'|#\s*@|\*)')
_ASSERT = re.compile(
    r"\b(?:assert\w*|expect|Assert\.\w+|assertThat|should|require\.\w+|t\.(?:Error|Fatal)\w*|"
    r"XCTAssert\w*|Expect\(|verify)\b"
)
_TEST_FN = re.compile(
    r"^\s*(?:(?:async\s+)?def\s+test\w*|func\s+Test\w+|(?:it|test|describe)\s*\(|"
    r"@Test|\[(?:Fact|Test|TestMethod|Theory)\]|fn\s+test_\w+|#\[test\])"
)
_MOCK_FRAMEWORK = re.compile(
    r"\b(?:jest\.(?:mock|fn|spyOn)|vi\.(?:mock|fn|spyOn)|unittest\.mock|MagicMock|mock\.patch|"
    r"@patch|mocker\.|Mock<|new Mock|Substitute\.For|Mockito|mockk|gomock|mockall|sinon\.|"
    r"A\.Fake|createMock|\$this->createMock)\b"
)
_MOCK_MANUAL = re.compile(
    r"\b(?:class|struct|object)\s+(?:Fake|Stub|InMemory|Dummy)\w*"
)
_TRY = re.compile(r"^\s*(?:try\s*[:{]|try$|\}\s*catch\b|except\b|rescue\b)")
_RESULT = re.compile(
    r"\b(?:Result<|Either<|-> Result|Result\.(?:ok|err|success|failure)|Ok\(|Err\(|\.ok_or|ErrorOr<|OneOf<)"
)
_GUARD = re.compile(
    r"^\s*(?:if\b.*\b(?:return|throw|raise|continue)\b|guard\b.*\belse\b|unless\b.*\breturn\b)"
)
_RETURN_LINE = re.compile(r"^\s*(?:return|throw|raise|continue)\b")
_IF = re.compile(r"^\s*(?:\}\s*)?(?:if|elif|else if)\b")
_JS_DEFAULT = re.compile(r"^\s*import\s+[A-Za-z_$][\w$]*\s+from\s+['\"]")
_JS_NAMED = re.compile(r"^\s*import\s+(?:type\s+)?\{[^}]*\}\s+from\s+['\"]")
_PY_FROM = re.compile(r"^\s*from\s+[\w.]+\s+import\s+")
_PY_MODULE = re.compile(r"^\s*import\s+[\w.]+")


_TEST_NAME = re.compile(r"(?:^test_|_test\.|[._-](?:test|spec)s?\.|Tests?\.)", re.I)


def is_test_file(path: str) -> bool:
    """A test by its ecosystem's convention, its name or a test folder."""
    posix = PurePosixPath(path.replace("\\", "/"))
    return (
        is_test(posix)
        or bool(_TEST_NAME.search(posix.name))
        or any(is_test_dir(part) for part in posix.parts[:-1])
    )


def language_of(path: str) -> str | None:
    """The language of *path* by its suffix, or None."""
    return LANGUAGES.get(PurePosixPath(path).suffix.lower())


def _family(language: str) -> str:
    return language if language in _FUNCTIONS else "c_family"


def case_of(name: str) -> str | None:
    """camelCase, snake_case or PascalCase; None for one lower word or a constant."""
    bare = name.strip("_$")
    if len(bare) < 2 or bare.isupper() or not bare[0].isalpha():
        return None
    if "_" in bare:
        return "snake_case" if bare.islower() else None
    if bare[0].isupper():
        return "PascalCase" if any(c.islower() for c in bare) else None
    return "camelCase" if any(c.isupper() for c in bare) else None


def _comment_text(line: str, language: str) -> str | None:
    stripped = line.strip()
    if language in _HASH_COMMENT:
        if not stripped.startswith("#") or stripped.startswith("#!"):
            return None
    elif not stripped.startswith(("//", "/*", "*", "--")) or stripped.startswith("*)"):
        return None
    match = _COMMENT_TEXT.match(line)
    return match.group(1) if match else ""


def _indent(line: str) -> int:
    expanded = line.expandtabs(4)
    return len(expanded) - len(expanded.lstrip())


def _function_spans(lines: list[str], language: str) -> list[tuple[int, int, str]]:
    """Functions whose declaration and whole body are among *lines*: (start, length, name)."""
    patterns = _FUNCTIONS[_family(language)]
    spans: list[tuple[int, int, str]] = []
    for index, line in enumerate(lines):
        name = next((m.group(1) for p in patterns if (m := p.match(line))), None)
        if not name or name in _KEYWORDS:
            continue
        if language in _INDENT_BLOCKS or language == "ruby":
            base = _indent(line)
            end = index + 1
            while end < len(lines) and (
                not lines[end].strip() or _indent(lines[end]) > base
            ):
                end += 1
            if language == "ruby" and end < len(lines) and lines[end].strip() == "end":
                end += 1
            if end == len(lines) and end - index < 3:
                continue
        else:
            depth, end, opened = 0, index, False
            while end < len(lines):
                depth += lines[end].count("{") - lines[end].count("}")
                opened = opened or "{" in lines[end]
                end += 1
                if opened and depth <= 0:
                    break
                if not opened and end - index > 2:
                    break
            if not opened or depth > 0:
                continue
        spans.append((index, end - index, name))
    return spans


def _vote_naming(
    lines: list[str], language: str, spans: list[tuple[int, int, str]], votes: Counter
) -> None:
    for _, _, name in spans:
        case = case_of(name)
        if case:
            votes["naming_functions", case] += 1
    names: list[str] = []
    for line in lines:
        for pattern in _VARIABLES[_family(language)]:
            match = pattern.match(line)
            if match and match.group(1) not in _KEYWORDS:
                names.append(match.group(1))
                break
    for name in names:
        if language == "python" and name == "self":
            continue
        case = case_of(name)
        if case:
            votes["naming_variables", case] += 1
        bare = name.strip("_$")
        if 2 <= len(bare) <= 4:
            votes["name_length", "short"] += 1
        elif len(bare) >= 8:
            votes["name_length", "descriptive"] += 1


def _vote_comments(
    lines: list[str], language: str, spans: list[tuple[int, int, str]], votes: Counter
) -> None:
    code = [line for line in lines if line.strip()]
    texts = [t for line in code if (t := _comment_text(line, language)) is not None]
    if len(code) >= 10:
        ratio = len(texts) / len(code)
        votes[
            "comments",
            "none" if ratio < 0.02 else "minimal" if ratio < 0.12 else "verbose",
        ] += 1
    for text in texts:
        words = re.findall(r"[a-zà-ÿ]+", text.lower())
        if len(words) < 3:
            continue
        fr, en = sum(w in _FR for w in words), sum(w in _EN for w in words)
        if fr > en:
            votes["comment_language", "fr"] += 1
        elif en > fr:
            votes["comment_language", "en"] += 1
    for start, length, _ in spans:
        if length < 4:
            continue
        before = lines[start - 1] if start else ""
        after = lines[start + 1] if start + 1 < len(lines) else ""
        documented = bool(_DOC_START.match(before)) or (
            language == "python" and after.strip().startswith(('"""', "'''"))
        )
        votes["doc_comments", "documented" if documented else "undocumented"] += 1


def _vote_structure(
    lines: list[str], language: str, spans: list[tuple[int, int, str]], votes: Counter
) -> None:
    for _, length, _ in spans:
        votes[
            "function_length",
            "short" if length <= 20 else "medium" if length <= 50 else "long",
        ] += 1
    for index, line in enumerate(lines):
        nxt = lines[index + 1] if index + 1 < len(lines) else ""
        if _GUARD.match(line) or (
            _IF.match(line) and _RETURN_LINE.match(nxt) and _indent(nxt) > _indent(line)
        ):
            votes["guard_style", "early_return"] += 1
    floor = min((_indent(line) for line in lines if line.strip()), default=0)
    step = (
        2
        if language
        in {"javascript", "typescript", "ruby", "dart", "scala", "kotlin", "swift"}
        else 4
    )
    for line in lines:
        if _IF.match(line) and _indent(line) - floor >= 3 * step:
            votes["guard_style", "nested"] += 1
    if language != "go":
        votes["error_handling", "exceptions"] += sum(
            1 for line in lines if _TRY.match(line)
        )
        if language not in {"python", "ruby", "php", "javascript"}:
            votes["error_handling", "result_types"] += sum(
                1 for line in lines if _RESULT.search(line)
            )
    for line in lines:
        if language in {"javascript", "typescript"}:
            if _JS_NAMED.match(line):
                votes["imports", "named"] += 1
            elif _JS_DEFAULT.match(line):
                votes["imports", "default"] += 1
        elif language == "python":
            if _PY_FROM.match(line):
                votes["imports", "from_import"] += 1
            elif _PY_MODULE.match(line):
                votes["imports", "module_import"] += 1


def _vote_tests(lines: list[str], votes: Counter) -> None:
    starts = [i for i, line in enumerate(lines) if _TEST_FN.match(line)]
    for position, start in enumerate(starts):
        end = starts[position + 1] if position + 1 < len(starts) else len(lines)
        count = sum(len(_ASSERT.findall(line)) for line in lines[start + 1 : end])
        if count:
            votes["assertions", "few" if count <= 2 else "many"] += 1
    votes["mocking", "framework"] += sum(
        1 for line in lines if _MOCK_FRAMEWORK.search(line)
    )
    votes["mocking", "manual"] += sum(1 for line in lines if _MOCK_MANUAL.search(line))


def measure(path: str, lines: list[str]) -> tuple[str | None, Counter]:
    """The language of *path* and the votes the added *lines* give, ``(dimension, value) -> n``."""
    language = language_of(path)
    votes: Counter = Counter()
    if language is None or not lines:
        return language, votes
    spans = _function_spans(lines, language)
    _vote_naming(lines, language, spans, votes)
    _vote_comments(lines, language, spans, votes)
    _vote_structure(lines, language, spans, votes)
    if is_test_file(path):
        _vote_tests(lines, votes)
    return language, Counter({key: n for key, n in votes.items() if n > 0})
