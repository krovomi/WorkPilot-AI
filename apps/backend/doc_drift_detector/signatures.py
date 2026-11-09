"""Doc comments whose parameters no longer match the code (#354).

Every stack's doc comment names the parameters it describes: ``@param`` in
JSDoc, Javadoc, KDoc, Scaladoc, PHPDoc, Doxygen and YARD, ``<param name="">``
in .NET XML doc, ``- Parameter x:`` in Swift, ``* `x` -`` under ``# Arguments``
in rustdoc, and the Google, NumPy and Sphinx docstrings in Python (read with
``ast``). This module compares those names with the declaration below them:

- a documented parameter the code no longer has: **removed** (high);
- the same count with one name changed in place: **renamed** (high, fixable);
- a parameter the comment does not describe, when it describes others:
  **undocumented** (low);
- in Python, a documented type that is a plain name and differs from the
  annotation (``x (int)`` over ``x: float``): **type changed** (medium, fixable).

Silent when unsure: a comment with no parameter tag is not compared (Go, Dart
and plain prose comments describe parameters in sentences), nor a declaration
with a destructured, rest or variadic parameter, nor a Python function taking
``**kwargs`` for the removed names, nor a comment holding ``no-drift-check``.
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field

from doc_languages import extract_symbols, language_for, param_names

__all__ = [
    "SignatureDrift",
    "documented_params",
    "rename_in_doc",
    "retype_in_doc",
    "signature_drifts",
]

IGNORE_MARK = "no-drift-check"

_JS_NAME = r"[A-Za-z_$][\w$]*"
_TAGGED = {
    "jsdoc": re.compile(
        rf"@(?:param|arg|argument)\s+(?:\{{(?P<type>[^}}]*)\}}\s+)?\[?(?P<name>{_JS_NAME}(?:\.[\w$]+)*)"
    ),
    "javadoc": re.compile(r"@param\s+(?P<generic><)?(?P<name>[A-Za-z_]\w*)"),
    "kdoc": re.compile(r"@param\s+\[?(?P<name>[A-Za-z_]\w*)\]?"),
    "scaladoc": re.compile(r"@param\s+(?P<name>[A-Za-z_]\w*)"),
    "phpdoc": re.compile(r"@param\s+(?:[^\s$]+\s+)?(?:\.\.\.)?&?\$(?P<name>\w+)"),
    "doxygen": re.compile(
        r"[@\\]param(?:\[(?:in|out|in,\s*out)\])?\s+(?P<name>[A-Za-z_]\w*)"
    ),
    "yard": re.compile(r"@param\s+(?:\[[^\]]*\]\s+)?(?P<name>[A-Za-z_]\w*)"),
    "xmldoc": re.compile(r"<param\s+name\s*=\s*\"(?P<name>[A-Za-z_@]\w*)\""),
}
_SWIFT_ONE = re.compile(r"-\s*Parameter\s+(?P<name>[A-Za-z_]\w*)\s*:", re.I)
_SWIFT_LIST = re.compile(r"-\s*Parameters\s*:", re.I)
_SWIFT_ITEM = re.compile(r"^\s*(?:///|\*)?\s+-\s+(?P<name>[A-Za-z_]\w*)\s*:")
_RUST_HEADER = re.compile(r"#\s*(?:Arguments|Parameters)\b", re.I)
_RUST_ITEM = re.compile(r"^\s*(?://[/!]|\*)?\s*[*-]\s+`(?P<name>[A-Za-z_]\w*)`")

_GOOGLE_HEADER = re.compile(
    r"^\s*(?:Args|Arguments|Parameters|Params|Keyword Args|Keyword Arguments)\s*:\s*$"
)
_GOOGLE_ITEM = re.compile(
    r"^(?P<indent>\s+)\*{0,2}(?P<name>[A-Za-z_]\w*)\s*(?:\((?P<type>[^)]*)\))?\s*:"
)
_NUMPY_HEADER = re.compile(r"^\s*(?:Parameters|Other Parameters)\s*$")
_NUMPY_RULE = re.compile(r"^\s*-{3,}\s*$")
_NUMPY_ITEM = re.compile(
    r"^(?P<indent>\s*)\*{0,2}(?P<name>[A-Za-z_]\w*)\s*(?::\s*(?P<type>[^\n]*))?$"
)
_SECTION_END = re.compile(
    r"^\s*(?:Returns?|Yields?|Raises?|Examples?|Notes?|See Also|Attributes|References|Warns?|Warnings?)\s*:?\s*$"
)
_SPHINX_PARAM = re.compile(
    r":param\s+(?:(?P<type>[^:]+?)\s+)?\*{0,2}(?P<name>[A-Za-z_]\w*)\s*:"
)
_SPHINX_TYPE = re.compile(r":type\s+\*{0,2}(?P<name>[A-Za-z_]\w*)\s*:\s*(?P<type>.+)$")

_TYPE_PARAM_STYLES = frozenset({"javadoc", "kdoc", "scaladoc"})
_PLAIN_TYPE = re.compile(r"^[A-Za-z_][\w.]*$")
_TYPE_SYNONYMS = {
    "string": "str",
    "integer": "int",
    "boolean": "bool",
    "dictionary": "dict",
    "double": "float",
    "none": "None",
}


@dataclass
class SignatureDrift:
    """A doc comment and the declaration below it that disagree."""

    __test__ = False

    path: str
    line: int
    symbol: str
    language: str
    removed: list[str] = field(default_factory=list)
    added: list[str] = field(default_factory=list)
    renamed: list[tuple[str, str]] = field(default_factory=list)
    types: list[tuple[str, str, str]] = field(default_factory=list)
    """(parameter, documented type, annotated type)."""

    @property
    def severity(self) -> str:
        if self.removed or self.renamed:
            return "high"
        return "medium" if self.types else "low"


# --- what the comment documents -----------------------------------------------


def _python_params(doc: str) -> tuple[list[str], dict[str, str]]:
    names: list[str] = []
    types: dict[str, str] = {}

    def add(name: str, kind: str | None) -> None:
        if name not in names:
            names.append(name)
        if kind and kind.strip():
            types[name] = kind.split(",")[0].strip()

    lines = doc.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if _GOOGLE_HEADER.match(line):
            base = len(line) - len(line.lstrip())
            item_indent: int | None = None
            i += 1
            while i < len(lines):
                cur = lines[i]
                if not cur.strip():
                    i += 1
                    continue
                width = len(cur) - len(cur.lstrip())
                if width <= base:
                    break
                m = _GOOGLE_ITEM.match(cur)
                if m and (item_indent is None or width == item_indent):
                    item_indent = width
                    add(m.group("name"), m.group("type"))
                i += 1
            continue
        if (
            _NUMPY_HEADER.match(line)
            and i + 1 < len(lines)
            and _NUMPY_RULE.match(lines[i + 1])
        ):
            base = len(line) - len(line.lstrip())
            i += 2
            while i < len(lines):
                cur = lines[i]
                if not cur.strip():
                    i += 1
                    continue
                if _SECTION_END.match(cur) or (
                    i + 1 < len(lines) and _NUMPY_RULE.match(lines[i + 1])
                ):
                    break
                width = len(cur) - len(cur.lstrip())
                m = _NUMPY_ITEM.match(cur)
                if m and width == base:
                    add(m.group("name"), m.group("type"))
                i += 1
            continue
        for m in _SPHINX_PARAM.finditer(line):
            add(m.group("name"), m.group("type"))
        m = _SPHINX_TYPE.search(line)
        if m and m.group("name") in names:
            types[m.group("name")] = m.group("type").strip()
        i += 1
    return names, types


def documented_params(doc: str, style: str) -> tuple[list[str], dict[str, str]]:
    """The parameter names a doc comment describes, in order, and their types."""
    if style == "python":
        return _python_params(doc)
    names: list[str] = []
    types: dict[str, str] = {}
    if style == "swift":
        in_list = False
        for line in doc.splitlines():
            one = _SWIFT_ONE.search(line)
            if one:
                names.append(one.group("name"))
                in_list = False
            elif _SWIFT_LIST.search(line):
                in_list = True
            elif in_list:
                item = _SWIFT_ITEM.match(line)
                if item and item.group("name").lower() not in {"returns", "throws"}:
                    names.append(item.group("name"))
                elif line.strip("/* ").startswith("- "):
                    in_list = False
        return list(dict.fromkeys(names)), types
    if style == "rustdoc":
        in_section = False
        for line in doc.splitlines():
            if _RUST_HEADER.search(line):
                in_section = True
                continue
            if in_section and re.search(r"#\s*\w", line):
                in_section = False
            if in_section:
                item = _RUST_ITEM.match(line)
                if item:
                    names.append(item.group("name"))
        return list(dict.fromkeys(names)), types
    pattern = _TAGGED.get(style)
    if pattern is None:
        return [], types
    for m in pattern.finditer(doc):
        name = m.group("name").lstrip("@")
        if "." in name or m.groupdict().get("generic"):
            continue  # options.timeout: a property; <T>: a type parameter
        if style in _TYPE_PARAM_STYLES and name[:1].isupper():
            continue  # KDoc and Scaladoc document type parameters (T, K) with @param
        names.append(name)
        if "type" in m.groupdict() and m.group("type"):
            types[name] = m.group("type").strip()
    return list(dict.fromkeys(names)), types


# --- comparing ---------------------------------------------------------------


def _norm_type(value: str) -> str | None:
    value = value.strip().strip("`").removesuffix(", optional").strip()
    if not _PLAIN_TYPE.match(value):
        return None
    last = value.rsplit(".", 1)[-1]
    return _TYPE_SYNONYMS.get(last.lower(), last)


def _compare(
    documented: list[str], actual: list[str]
) -> tuple[list[str], list[str], list[tuple[str, str]]]:
    removed = [d for d in documented if d not in actual]
    added = [a for a in actual if a not in documented]
    renamed: list[tuple[str, str]] = []
    if removed and len(documented) == len(actual):
        # Same count, names changed in place: a rename, position by position.
        for old, new in zip(documented, actual, strict=True):
            if old != new and old in removed and new in added:
                renamed.append((old, new))
        removed = [r for r in removed if r not in {o for o, _ in renamed}]
        added = [a for a in added if a not in {n for _, n in renamed}]
    return removed, added, renamed


def _python_drifts(path: str, content: str) -> list[SignatureDrift]:
    try:
        tree = ast.parse(content)
    except (SyntaxError, ValueError):
        return []
    drifts: list[SignatureDrift] = []
    owners: dict[ast.AST, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            for child in node.body:
                owners[child] = node.name
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        doc = ast.get_docstring(node, clean=False) or ""
        if not doc or IGNORE_MARK in doc:
            continue
        documented, doc_types = _python_params(doc)
        if not documented:
            continue
        a = node.args
        positional = [*a.posonlyargs, *a.args]
        params = [*positional, *a.kwonlyargs]
        actual = [p.arg for p in params]
        if actual and actual[0] in {"self", "cls"} and node in owners:
            actual = actual[1:]
        if a.vararg:
            actual.append(a.vararg.arg)
        if a.kwarg:
            actual.append(a.kwarg.arg)
        removed, added, renamed = _compare(documented, actual)
        if a.kwarg:
            removed = []  # documented keywords may go through **kwargs
            renamed = []
        types: list[tuple[str, str, str]] = []
        for p in params:
            if p.arg not in doc_types or p.annotation is None:
                continue
            documented_type = _norm_type(doc_types[p.arg])
            annotated = _norm_type(ast.unparse(p.annotation))
            if documented_type and annotated and documented_type != annotated:
                types.append(
                    (p.arg, doc_types[p.arg].strip(), ast.unparse(p.annotation))
                )
        if removed or added or renamed or types:
            owner = owners.get(node)
            drifts.append(
                SignatureDrift(
                    path=path,
                    line=node.lineno,
                    symbol=f"{owner}.{node.name}" if owner else node.name,
                    language="python",
                    removed=removed,
                    added=added,
                    renamed=renamed,
                    types=types,
                )
            )
    return drifts


def _arg_list(
    lines: list[str],
    line: int,
    name: str,
    *,
    hash_comments: bool = False,
    quotes: str = "\"'`",
) -> str | None:
    """The text between the parentheses of the declaration at ``line`` (1-based),
    comments and strings left out; None when it cannot be read."""
    text = "\n".join(lines[line - 1 : line + 40])
    leaf = re.escape(name.rsplit(".", 1)[-1])
    m = re.search(rf"\b{leaf}\s*(?:<[^()]*?>)?\s*\(", text)
    if not m:
        return None
    out: list[str] = []
    depth, i, quote = 1, m.end(), ""
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = ""
            i += 1
            continue
        if text.startswith("//", i) or (hash_comments and ch == "#"):
            end = text.find("\n", i)
            i = len(text) if end < 0 else end
            continue
        if text.startswith("/*", i):
            end = text.find("*/", i + 2)
            if end < 0:
                return None
            i = end + 2
            continue
        if ch in quotes:
            quote = ch
            out.append("_")  # a default value: the name before it is what counts
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return "".join(out)
        if not quote:
            out.append(ch)
        i += 1
    return None


def signature_drifts(path: str, content: str) -> list[SignatureDrift]:
    """The declarations of one source file whose doc comment disagrees with them."""
    lang = language_for(path)
    if lang is None:
        return []
    if lang.id == "python":
        return _python_drifts(path, content)
    drifts: list[SignatureDrift] = []
    lines = content.splitlines()
    for symbol in extract_symbols(content, path):
        if symbol.kind == "class" or not symbol.doc or IGNORE_MARK in symbol.doc:
            continue
        documented, _ = documented_params(symbol.doc, lang.doc_style)
        if not documented:
            continue
        # The declaration's own parentheses, read again with nesting and
        # comments: ``(fn: () => void, x)`` is two parameters, not one.
        raw = _arg_list(
            lines,
            symbol.line,
            symbol.name,
            hash_comments=lang.hash_comments,
            quotes='"' if lang.id == "rust" else "\"'`",  # 'a is a lifetime
        )
        if raw is None:
            continue
        actual, complete = param_names(raw, lang.params)
        if not complete:
            continue
        removed, added, renamed = _compare(documented, actual)
        if removed or added or renamed:
            drifts.append(
                SignatureDrift(
                    path=path,
                    line=symbol.line,
                    symbol=symbol.name,
                    language=lang.id,
                    removed=removed,
                    added=added,
                    renamed=renamed,
                )
            )
    return drifts


# --- fixing ------------------------------------------------------------------


def _doc_range(lines: list[str], line: int, language: str) -> tuple[int, int]:
    """0-based [start, end) of the doc comment of the declaration at ``line``."""
    if language == "python":
        start = line  # the docstring is below the def
        end = min(len(lines), start + 200)
        quotes = 0
        for i in range(start, end):
            quotes += lines[i].count('"""') + lines[i].count("'''")
            if quotes >= 2:
                return start, i + 1
        return start, start
    end = line - 1
    start = end
    while start > 0:
        s = lines[start - 1].strip()
        if not s or not (
            s.startswith(("/", "*", "#")) or s.endswith("*/") or s.startswith("@")
        ):
            break
        start -= 1
    return start, end


def _rename_patterns(old: str, new: str) -> list[tuple[re.Pattern[str], str]]:
    o = re.escape(old)
    return [
        (re.compile(rf"(<param\s+name\s*=\s*\"){o}(\")"), rf"\g<1>{new}\g<2>"),
        (
            re.compile(
                rf"([@\\](?:param|arg|argument)(?:\[[^\]]*\])?(?:\s+\{{[^}}]*\}})?(?:\s+[^\s$\[]+)??\s+\[?&?\$?){o}\b"
            ),
            rf"\g<1>{new}",
        ),
        (re.compile(rf"(-\s*Parameter\s+){o}(\s*:)", re.I), rf"\g<1>{new}\g<2>"),
        (re.compile(rf"^(\s*(?:///|\*)?\s+-\s+){o}(\s*:)"), rf"\g<1>{new}\g<2>"),
        (re.compile(rf"([*-]\s+`){o}(`)"), rf"\g<1>{new}\g<2>"),
        (re.compile(rf"(:param\s+(?:[^:]+?\s+)?){o}(\s*:)"), rf"\g<1>{new}\g<2>"),
        (re.compile(rf"(:type\s+){o}(\s*:)"), rf"\g<1>{new}\g<2>"),
        (
            re.compile(rf"^(\s+\*{{0,2}}){o}(\s*(?:\([^)]*\))?\s*:)"),
            rf"\g<1>{new}\g<2>",
        ),
    ]


def rename_in_doc(
    content: str, line: int, language: str, old: str, new: str
) -> str | None:
    """``content`` with ``old`` renamed ``new`` in the doc comment of line ``line``."""
    lines = content.split("\n")
    start, end = _doc_range(lines, line, language)
    changed = False
    for i in range(start, end):
        for pattern, repl in _rename_patterns(old, new):
            updated = pattern.sub(repl, lines[i], count=1)
            if updated != lines[i]:
                lines[i] = updated
                changed = True
                break
    return "\n".join(lines) if changed else None


def retype_in_doc(
    content: str, line: int, name: str, documented: str, annotated: str
) -> str | None:
    """A Python docstring's type for ``name`` replaced by the annotation's."""
    lines = content.split("\n")
    start, end = _doc_range(lines, line, "python")
    n, d = re.escape(name), re.escape(documented)
    patterns = [
        re.compile(rf"^(\s+\*{{0,2}}{n}\s*\(){d}(\))"),
        re.compile(rf"^(\s*\*{{0,2}}{n}\s*:\s*){d}(\s*(?:,.*)?)$"),
        re.compile(rf"(:type\s+{n}\s*:\s*){d}(\s*)$"),
        re.compile(rf"(:param\s+){d}(\s+{n}\s*:)"),
    ]
    for i in range(start, end):
        for pattern in patterns:
            updated = pattern.sub(rf"\g<1>{annotated}\g<2>", lines[i], count=1)
            if updated != lines[i]:
                lines[i] = updated
                return "\n".join(lines)
    return None
