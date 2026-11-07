"""Symbols and doc comments for every source language WorkPilot supports.

A line-based reader, not a parser: each language has a few declaration
patterns (types, functions, methods). A declaration whose parameters span
several lines is joined first. The doc comment is the comment block right
above the declaration, after any attribute, annotation or decorator line;
a plain ``//`` comment only counts where it is the language's convention
(Go, C/C++).

The reader errs on the side of missing a symbol rather than inventing one:
a symbol it does not see is a symbol the coverage does not count, while a
symbol it invents would be reported as undocumented when nothing is wrong.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import PurePath

_ID = r"[A-Za-z_]\w*"
_JS_ID = r"[A-Za-z_$][\w$]*"

# Words a "name(" pattern can catch that are statements, not declarations.
_KEYWORDS = frozenset(
    {
        "if", "for", "foreach", "while", "switch", "catch", "using", "lock",
        "return", "throw", "sizeof", "typeof", "nameof", "await",
        "else", "do", "try", "when", "match", "case", "defer", "go", "select",
        "function", "constructor", "super", "this", "delete", "elif", "until",
    }
)  # fmt: skip

_VOID_RETURNS = frozenset(
    {"", "void", "unit", "()", "none", "task", "never", "nothing"}
)


@dataclass(frozen=True)
class Language:
    """One source language: files, declarations and doc comment style."""

    id: str
    label: str
    extensions: tuple[str, ...]
    doc_style: str
    params: str
    patterns: tuple[tuple[str, re.Pattern[str]], ...]
    plain_line_comment_is_doc: bool = False
    hash_comments: bool = False


@dataclass
class SourceSymbol:
    """A declaration found in a source file."""

    name: str
    kind: str
    line: int
    language: str
    indent: str = ""
    args: list[str] = field(default_factory=list)
    returns: bool = False
    doc: str = ""


def _p(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern)


_CS_MODS = r"(?:(?:public|private|protected|internal|static|async|virtual|override|abstract|sealed|extern|unsafe|new|partial|readonly)\s+)"
_JAVA_MODS = r"(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)"

LANGUAGES: tuple[Language, ...] = (
    Language(
        id="python",
        label="Python",
        extensions=(".py", ".pyi"),
        doc_style="python",
        params="name_colon",
        hash_comments=True,
        patterns=(
            ("class", _p(rf"^\s*class\s+(?P<name>{_ID})")),
            (
                "function",
                _p(
                    rf"^\s*(?:async\s+)?def\s+(?P<name>{_ID})\s*\((?P<args>[^)]*)\)(?P<tail>[^:]*)"
                ),
            ),
        ),
    ),
    Language(
        id="typescript",
        label="TypeScript / JavaScript",
        extensions=(
            ".ts",
            ".tsx",
            ".mts",
            ".cts",
            ".js",
            ".jsx",
            ".mjs",
            ".cjs",
            ".vue",
            ".svelte",
            ".astro",
        ),
        doc_style="jsdoc",
        params="name_colon",
        patterns=(
            (
                "class",
                _p(
                    rf"^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface|enum)\s+(?P<name>{_JS_ID})"
                ),
            ),
            (
                "type",
                _p(
                    rf"^\s*(?:export\s+)?(?:declare\s+)?type\s+(?P<name>{_JS_ID})\s*(?:<[^>]*>)?\s*="
                ),
            ),
            (
                "function",
                _p(
                    rf"^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*(?P<name>{_JS_ID})\s*(?:<[^>]*>)?\s*\((?P<args>[^)]*)\)(?P<tail>[^{{;]*)"
                ),
            ),
            (
                "function",
                _p(
                    rf"^\s*(?:export\s+)?(?:const|let)\s+(?P<name>{_JS_ID})\s*(?::[^=]+)?=\s*(?:async\s+)?\((?P<args>[^)]*)\)(?P<tail>[^=]*)=>"
                ),
            ),
            (
                "method",
                _p(
                    rf"^\s+(?:(?:public|private|protected|static|async|override|readonly|abstract|get|set)\s+)*(?P<name>{_JS_ID})\s*(?:<[^>]*>)?\s*\((?P<args>[^)]*)\)(?P<tail>\s*(?::\s*[^{{;=]+)?)\{{\s*$"
                ),
            ),
        ),
    ),
    Language(
        id="csharp",
        label="C# / .NET",
        extensions=(".cs",),
        doc_style="xmldoc",
        params="type_first",
        patterns=(
            (
                "class",
                _p(
                    rf"^\s*{_CS_MODS}*(?:class|interface|struct|enum|record(?:\s+(?:class|struct))?)\s+(?P<name>{_ID})"
                ),
            ),
            (
                "method",
                _p(
                    rf"^\s*{_CS_MODS}+(?P<ret>[\w<>\[\],.?()]+(?:\s*<[^>]*>)?)\s+(?P<name>{_ID})\s*(?:<[^>]*>)?\s*\((?P<args>[^)]*)\)"
                ),
            ),
        ),
    ),
    Language(
        id="java",
        label="Java",
        extensions=(".java",),
        doc_style="javadoc",
        params="type_first",
        patterns=(
            (
                "class",
                _p(
                    rf"^\s*{_JAVA_MODS}*(?:sealed\s+|non-sealed\s+)?(?:class|interface|enum|record|@interface)\s+(?P<name>{_ID})"
                ),
            ),
            (
                "method",
                _p(
                    rf"^\s*{_JAVA_MODS}+(?:<[^>]*>\s+)?(?P<ret>[\w<>\[\],.?]+)\s+(?P<name>{_ID})\s*\((?P<args>[^)]*)\)"
                ),
            ),
        ),
    ),
    Language(
        id="kotlin",
        label="Kotlin",
        extensions=(".kt", ".kts"),
        doc_style="kdoc",
        params="name_colon",
        patterns=(
            (
                "class",
                _p(
                    rf"^\s*(?:(?:public|private|internal|protected|data|sealed|open|abstract|enum|inner|value|annotation)\s+)*(?:class|interface|object)\s+(?P<name>{_ID})"
                ),
            ),
            (
                "function",
                _p(
                    rf"^\s*(?:(?:public|private|protected|internal|override|open|suspend|inline|operator|infix|tailrec|abstract|final)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(?P<name>{_ID})\s*\((?P<args>[^)]*)\)(?P<tail>[^{{=]*)"
                ),
            ),
        ),
    ),
    Language(
        id="scala",
        label="Scala",
        extensions=(".scala", ".sc"),
        doc_style="scaladoc",
        params="name_colon",
        patterns=(
            (
                "class",
                _p(
                    rf"^\s*(?:(?:case|abstract|sealed|final|implicit)\s+)*(?:class|object|trait)\s+(?P<name>{_ID})"
                ),
            ),
            (
                "function",
                _p(
                    rf"^\s*(?:(?:override|private|protected|final|implicit)\s+)*def\s+(?P<name>{_ID})\s*(?:\[[^\]]*\])?\s*\((?P<args>[^)]*)\)(?P<tail>[^=]*)"
                ),
            ),
        ),
    ),
    Language(
        id="swift",
        label="Swift",
        extensions=(".swift",),
        doc_style="swift",
        params="name_colon",
        patterns=(
            (
                "class",
                _p(
                    rf"^\s*(?:(?:public|private|internal|open|fileprivate|final)\s+)*(?:class|struct|enum|protocol|actor)\s+(?P<name>{_ID})"
                ),
            ),
            (
                "owner",
                _p(
                    rf"^\s*(?:(?:public|private|internal|fileprivate)\s+)?extension\s+(?P<name>{_ID})"
                ),
            ),
            (
                "function",
                _p(
                    rf"^\s*(?:(?:public|private|internal|open|fileprivate|static|class|override|mutating|final|@\w+)\s+)*func\s+(?P<name>{_ID})\s*(?:<[^>]*>)?\s*\((?P<args>[^)]*)\)(?P<tail>[^{{]*)"
                ),
            ),
        ),
    ),
    Language(
        id="go",
        label="Go",
        extensions=(".go",),
        doc_style="godoc",
        params="go",
        plain_line_comment_is_doc=True,
        patterns=(
            ("class", _p(rf"^type\s+(?P<name>{_ID})\s+(?:struct|interface)\b")),
            (
                "function",
                _p(
                    rf"^func\s+(?:\((?P<recv>[^)]*)\)\s*)?(?P<name>{_ID})\s*(?:\[[^\]]*\])?\((?P<args>[^)]*)\)(?P<tail>[^{{]*)"
                ),
            ),
        ),
    ),
    Language(
        id="rust",
        label="Rust",
        extensions=(".rs",),
        doc_style="rustdoc",
        params="name_colon",
        patterns=(
            (
                "class",
                _p(
                    rf"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+(?P<name>{_ID})"
                ),
            ),
            (
                "owner",
                _p(
                    rf"^\s*(?:unsafe\s+)?impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?(?P<name>{_ID})"
                ),
            ),
            (
                "function",
                _p(
                    rf"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:(?:const|async|unsafe)\s+|extern\s+\"[^\"]*\"\s+)*fn\s+(?P<name>{_ID})\s*(?:<[^>]*>)?\s*\((?P<args>[^)]*)\)(?P<tail>[^{{;]*)"
                ),
            ),
        ),
    ),
    Language(
        id="php",
        label="PHP",
        extensions=(".php",),
        doc_style="phpdoc",
        params="php",
        patterns=(
            (
                "class",
                _p(
                    rf"^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+(?P<name>{_ID})"
                ),
            ),
            (
                "function",
                _p(
                    rf"^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?(?P<name>{_ID})\s*\((?P<args>[^)]*)\)(?P<tail>[^{{;]*)"
                ),
            ),
        ),
    ),
    Language(
        id="ruby",
        label="Ruby",
        extensions=(".rb", ".rake"),
        doc_style="yard",
        params="ruby",
        hash_comments=True,
        plain_line_comment_is_doc=True,
        patterns=(
            ("class", _p(r"^\s*(?:class|module)\s+(?P<name>[A-Z]\w*(?:::\w+)*)")),
            (
                "function",
                _p(
                    r"^\s*def\s+(?:self\.)?(?P<name>[A-Za-z_]\w*[?!=]?)\s*(?:\((?P<args>[^)]*)\))?"
                ),
            ),
        ),
    ),
    Language(
        id="dart",
        label="Dart / Flutter",
        extensions=(".dart",),
        doc_style="dartdoc",
        params="type_first",
        patterns=(
            (
                "class",
                _p(
                    rf"^\s*(?:(?:abstract|sealed|base|final|interface)\s+)*(?:class|mixin|enum|extension)\s+(?P<name>{_ID})"
                ),
            ),
            (
                "method",
                _p(
                    r"^\s*(?:(?:static|external|@override)\s+)*(?P<ret>(?:Future|Stream|FutureOr)<[^>]*>|[A-Za-z_][\w<>?,]*)\s+(?P<name>[a-z_]\w*)\s*\((?P<args>[^)]*)\)\s*(?:async\*?\s*)?(?:\{|=>)"
                ),
            ),
        ),
    ),
    Language(
        id="cpp",
        label="C / C++",
        extensions=(".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".m", ".mm"),
        doc_style="doxygen",
        params="type_first",
        plain_line_comment_is_doc=True,
        patterns=(
            (
                "class",
                _p(
                    rf"^\s*(?:typedef\s+)?(?:class|struct|union|enum(?:\s+class)?)\s+(?P<name>{_ID})\s*(?:final\s*)?[{{:]"
                ),
            ),
            (
                "function",
                _p(
                    r"^(?P<ret>(?:[\w:*&<>,]+\s+)+)\**&?(?P<name>[A-Za-z_][\w:~]*)\s*\((?P<args>[^;)]*)\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?\{?\s*$"
                ),
            ),
        ),
    ),
)

_BY_EXTENSION: dict[str, Language] = {
    ext: lang for lang in LANGUAGES for ext in lang.extensions
}

_ATTRIBUTE_LINE = re.compile(r"^\s*(?:\[[^\]]*\]\s*$|@\w|#\[)")

PARAM_TAGS: dict[str, tuple[str, ...]] = {
    "jsdoc": ("@param",),
    "javadoc": ("@param",),
    "kdoc": ("@param",),
    "scaladoc": ("@param",),
    "phpdoc": ("@param",),
    "xmldoc": ("<param",),
    "swift": ("- parameter", "- parameters"),
    "doxygen": ("@param", "\\param"),
}


def language_for(path: str) -> Language | None:
    """The language of a file, by extension; None when it is not source code."""
    return _BY_EXTENSION.get(PurePath(path).suffix.lower())


# ---------------------------------------------------------------------------
# Reading declarations
# ---------------------------------------------------------------------------


def _logical(lines: list[str], index: int) -> str:
    """The declaration starting at ``index``, joined while its parens are open."""
    text = lines[index]
    end = index
    while (
        text.count("(") > text.count(")") and end < len(lines) - 1 and end - index < 12
    ):
        end += 1
        text += "\n" + lines[end]
    return text


def _split_top_level(args: str) -> list[str]:
    parts: list[str] = []
    depth = 0
    current: list[str] = []
    for ch in args:
        if ch in "<([{":
            depth += 1
        elif ch in ">)]}":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    parts.append("".join(current))
    return [p.strip() for p in parts if p.strip()]


_SKIP_PARAMS = frozenset({"self", "cls", "this", "_"})
_MODIFIER_WORDS = re.compile(
    r"\b(?:this|params|ref|out|in|final|required|const|mut|readonly|scoped|vararg|noinline|crossinline|inout|override|val|var)\b"
)


def _param_name(param: str, style: str) -> str | None:
    p = re.sub(r"@\w+(?:\([^)]*\))?", "", param)  # annotations
    p = re.sub(r"\[[^\]]*\]", "", p) if style == "type_first" else p  # C# attributes
    p = p.split("=", 1)[0].strip()
    if not p or p[0] in "{[" or p.startswith("..."):
        return None
    if style == "php":
        m = re.search(r"\$(\w+)", p)
        return m.group(1) if m else None
    if style == "go":
        words = p.split()
        return words[0] if words else None
    if style in ("name_colon", "ruby"):
        p = p.split(":", 1)[0]
    p = _MODIFIER_WORDS.sub(" ", p)
    names = re.findall(r"[A-Za-z_]\w*", p.replace("&", " ").replace("*", " "))
    if not names:
        return None
    return names[-1]


def _params(args: str | None, style: str) -> list[str]:
    if not args:
        return []
    out: list[str] = []
    for part in _split_top_level(args):
        name = _param_name(part, style)
        if name and name not in _SKIP_PARAMS:
            out.append(name)
    return out


def _has_return(match: re.Match[str], lang: Language) -> bool:
    groups = match.groupdict()
    ret = (groups.get("ret") or "").strip()
    if ret:
        last = ret.split()[-1].strip("*&").lower()
        return last not in _VOID_RETURNS
    tail = (groups.get("tail") or "").strip()
    m = re.search(r"->\s*([^{]+)", tail) or re.search(r"^\)?\s*:\s*([^{=]+)", tail)
    if m:
        return m.group(1).strip().rstrip("{").strip().lower() not in _VOID_RETURNS
    if lang.id == "go":
        return bool(tail) and tail.strip().lower() not in _VOID_RETURNS
    return False


# ---------------------------------------------------------------------------
# Doc comments
# ---------------------------------------------------------------------------


def _doc_above(lines: list[str], index: int, lang: Language) -> str:
    """The doc comment right above line ``index`` (attribute lines skipped)."""
    i = index - 1
    while i >= 0:
        s = lines[i].strip()
        if s.startswith("#[") and lang.id == "rust":
            i -= 1
        elif s.startswith("@") or (
            not lang.hash_comments and _ATTRIBUTE_LINE.match(lines[i])
        ):
            i -= 1
        else:
            break
    if i < 0:
        return ""
    stripped = lines[i].strip()

    if stripped.endswith("*/"):
        block: list[str] = []
        j = i
        while j >= 0:
            block.insert(0, lines[j].strip())
            if "/*" in lines[j]:
                break
            j -= 1
        opener = block[0] if block else ""
        is_doc = (
            opener.startswith("/**")
            or opener.startswith("/*!")
            or lang.plain_line_comment_is_doc
        )
        return "\n".join(block) if is_doc else ""

    prefixes: tuple[str, ...]
    if lang.hash_comments:
        prefixes = ("#",)
    elif lang.plain_line_comment_is_doc:
        prefixes = ("//",)
    else:
        prefixes = ("///",)
    collected: list[str] = []
    j = i
    while j >= 0:
        s = lines[j].strip()
        if s.startswith(prefixes) and not s.startswith("#!") and not s.startswith("#["):
            collected.insert(0, s)
            j -= 1
            continue
        break
    if lang.id == "python":
        return ""  # Python docstrings live below the def: the AST reads them.
    return "\n".join(collected)


def doc_status(symbol: SourceSymbol, lang: Language) -> str:
    """documented, partial (parameters not described) or missing."""
    if not symbol.doc.strip():
        return "missing"
    tags = PARAM_TAGS.get(lang.doc_style)
    if symbol.args and tags and not any(t in symbol.doc.lower() for t in tags):
        return "partial"
    return "documented"


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


def extract_symbols(content: str, path: str) -> list[SourceSymbol]:
    """The declarations of a source file, each with its doc comment."""
    lang = language_for(path)
    if lang is None:
        return []
    lines = content.splitlines()
    symbols: list[SourceSymbol] = []
    owners: list[tuple[int, str]] = []  # (indent width, type name)
    in_block_comment = False

    for index, raw in enumerate(lines):
        stripped = raw.strip()
        if in_block_comment:
            if "*/" in stripped:
                in_block_comment = False
            continue
        if stripped.startswith("/*") and "*/" not in stripped:
            in_block_comment = True
            continue
        if (
            not stripped
            or stripped.startswith(("//", "*", "#"))
            and not stripped.startswith("#[")
        ):
            continue

        width = len(raw) - len(raw.lstrip())
        if stripped.startswith("{"):
            continue  # an Allman brace opens the block, it does not close it
        while owners and width <= owners[-1][0]:
            owners.pop()

        text = _logical(lines, index)
        for kind, pattern in lang.patterns:
            match = pattern.match(text)
            if not match:
                continue
            name = match.group("name")
            if name in _KEYWORDS:
                continue
            groups = match.groupdict()
            if kind == "owner":
                # impl / extension blocks: their functions are methods of the
                # type, the block itself is not a symbol.
                owners.append((width, name))
                break
            is_type = kind in ("class", "type")
            owner = owners[-1][1] if owners and not is_type else None
            recv = groups.get("recv")
            if recv:
                recv_type = re.findall(r"[A-Za-z_]\w*", recv)
                owner = recv_type[-1] if recv_type else owner
            qualified = f"{owner}.{name}" if owner else name
            sym_kind = kind if is_type else ("method" if owner else "function")
            symbol = SourceSymbol(
                name=qualified,
                kind="class" if is_type else sym_kind,
                line=index + 1,
                language=lang.id,
                indent=raw[:width],
                args=[] if is_type else _params(groups.get("args"), lang.params),
                returns=False if is_type else _has_return(match, lang),
                doc=_doc_above(lines, index, lang),
            )
            symbols.append(symbol)
            if is_type:
                owners.append((width, name))
            break
    return symbols


def symbol_names(content: str, path: str) -> set[str]:
    """Every name a document may cite: bare names and Owner.member forms."""
    names: set[str] = set()
    for symbol in extract_symbols(content, path):
        names.add(symbol.name)
        names.add(symbol.name.split(".")[-1])
    return names


# ---------------------------------------------------------------------------
# Doc comment templates
# ---------------------------------------------------------------------------


def describe(name: str) -> str:
    """A first sentence guessed from a symbol name ("getUserName" → "Get user name.")."""
    base = name.split(".")[-1].split("::")[-1].strip("_$?!=")
    words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", base).replace("_", " ").split()
    if len(words) > 1 and words[-1].lower() == "async":
        words = words[:-1]  # GetOrderAsync documents "Get order", not "async"
    if not words:
        return ""
    sentence = " ".join(w.lower() if i else w.capitalize() for i, w in enumerate(words))
    return sentence + "."


def doc_comment_template(symbol: SourceSymbol) -> str:
    """A doc comment in the language's own convention, indented like the symbol."""
    lang = next((lang for lang in LANGUAGES if lang.id == symbol.language), None)
    style = lang.doc_style if lang else "jsdoc"
    desc = describe(symbol.name)
    pad = symbol.indent
    args = symbol.args
    lines: list[str]

    if style == "xmldoc":
        lines = ["/// <summary>", f"/// {desc}", "/// </summary>"]
        lines += [f'/// <param name="{a}"></param>' for a in args]
        if symbol.returns:
            lines.append("/// <returns></returns>")
    elif style == "godoc":
        short = symbol.name.split(".")[-1]
        rest = desc[:1].lower() + desc[1:] if desc else ""
        if rest.rstrip(".").replace(" ", "") == short.lower():
            rest = ""
        lines = [f"// {short} {rest}"]
    elif style == "rustdoc":
        lines = [f"/// {desc}"]
        if args:
            lines += ["///", "/// # Arguments", "///"] + [
                f"/// * `{a}` - " for a in args
            ]
        if symbol.returns:
            lines += ["///", "/// # Returns", "///", "/// "]
    elif style == "swift":
        lines = [f"/// {desc}"]
        if len(args) == 1:
            lines.append(f"/// - Parameter {args[0]}: ")
        elif args:
            lines.append("/// - Parameters:")
            lines += [f"///   - {a}: " for a in args]
        if symbol.returns:
            lines.append("/// - Returns: ")
    elif style == "dartdoc":
        lines = [f"/// {desc}"]
    elif style == "yard":
        lines = [f"# {desc}"] + [f"# @param {a} " for a in args]
        if symbol.returns:
            lines.append("# @return ")
    else:
        # jsdoc, javadoc, kdoc, scaladoc, phpdoc, doxygen: one block comment.
        returns_tag = "@returns" if style == "jsdoc" else "@return"
        lines = ["/**"]
        lines.append(f" * @brief {desc}" if style == "doxygen" else f" * {desc}")
        if args or symbol.returns:
            lines.append(" *")
        prefix = "$" if style == "phpdoc" else ""
        lines += [f" * @param {prefix}{a} " for a in args]
        if symbol.returns:
            lines.append(f" * {returns_tag} ")
        lines.append(" */")

    return "\n".join(
        pad + line.rstrip() if line.strip() else pad + line for line in lines
    )
