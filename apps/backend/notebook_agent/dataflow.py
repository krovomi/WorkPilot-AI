"""Which cell needs which: the names each cell defines and reads, every stack.

Python cells are read by ``ast`` and ``symtable``: exact. A name read by the
statements of a cell (``immediate``) must exist when the cell runs; a name
read only inside a function body (``deferred``) must exist when the function
is called. Other languages (R, Julia, C#, F#, PowerShell, Scala, Kotlin,
JavaScript/TypeScript, Go, Rust) are read by their declaration keywords
(``let``, ``val``, ``<-``, ``$x =``…) after comments and strings are blanked:
an approximation, marked ``precise: false``, whose findings say so. A cell
whose language has no variables (SQL, shell, Markdown) has none.

From the names come the dependency graph (an edge from the cell that last
defined a name to each cell that reads it), the order that runs the
notebook top to bottom, and the findings:

- ``used_before_defined``: a cell reads a name that only a later cell
  defines; the notebook only works run out of order (exact for Python);
- ``undefined_name``: a Python cell reads a name no cell defines (not a
  builtin, no ``import *`` or ``%run`` that could hide it);
- ``hidden_state``: a stored output was computed after the cell it needs
  ran later (Jupyter execution counts);
- ``implicit_global``: a Python function reads a global of another cell
  instead of a parameter;
- ``shared_mutation``: a cell changes in place a variable another cell
  created and others read, so running it again changes their results.

Pure: reads the parsed cells only.
"""

from __future__ import annotations

import ast
import builtins
import re
import symtable
from dataclasses import dataclass, field

from .model import NotebookIssue, NotebookIssueType, ParsedNotebook

__all__ = [
    "CellFlow",
    "Dataflow",
    "analyze_dataflow",
    "cell_language",
    "python_flow",
]

_BUILTINS = frozenset(dir(builtins)) | {
    "display",
    "get_ipython",
    "In",
    "Out",
    "_",
    "__",
    "___",
    "exit",
    "quit",
    "__file__",
    "__name__",
}
_TRANSPARENT_CELL_MAGICS = frozenset({"time", "timeit", "capture", "prun"})
_DYNAMIC = re.compile(r"^\s*%(run|load|store)\b|\bexec\s*\(|\bglobals\s*\(\)", re.M)
_MUTATING_METHODS = frozenset(
    {
        "append",
        "extend",
        "insert",
        "pop",
        "remove",
        "clear",
        "update",
        "sort",
        "reverse",
        "add",
        "discard",
        "setdefault",
        "popitem",
    }
)


@dataclass
class CellFlow:
    """What one code cell defines and reads."""

    index: int
    language: str
    defines: list[str] = field(default_factory=list)
    immediate: list[str] = field(default_factory=list)
    deferred: list[str] = field(default_factory=list)
    mutates: list[str] = field(default_factory=list)
    imports: dict[str, str] = field(default_factory=dict)
    """Bound name → its import statement (Python), for an extracted function."""
    globals_in_functions: dict[str, list[str]] = field(default_factory=dict)
    """Function name → the globals it reads (Python)."""
    star_import: bool = False
    parsed: bool = True
    precise: bool = True


@dataclass
class Dataflow:
    cells: list[CellFlow]
    edges: list[dict] = field(default_factory=list)
    order: list[int] | None = None
    in_order: bool = True
    precise: bool = True
    issues: list[NotebookIssue] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "edges": self.edges,
            "order": self.order,
            "inOrder": self.in_order,
            "precise": self.precise,
        }


# ── language of a cell ──────────────────────────────────────────────────────

_ALIASES = {
    "python3": "python",
    "py": "python",
    "ipython": "python",
    "ipython3": "python",
    "r": "r",
    "ir": "r",
    "julia": "julia",
    "csharp": "csharp",
    "c#": "csharp",
    ".net-csharp": "csharp",
    "fsharp": "fsharp",
    "f#": "fsharp",
    ".net-fsharp": "fsharp",
    "pwsh": "powershell",
    "powershell": "powershell",
    ".net-pwsh": "powershell",
    "scala": "scala",
    "kotlin": "kotlin",
    "javascript": "javascript",
    "js": "javascript",
    "typescript": "typescript",
    "ts": "typescript",
    "go": "go",
    "gonb": "go",
    "rust": "rust",
}


def cell_language(nb: ParsedNotebook, source: str, metadata: dict) -> str:
    """The language of a code cell: its own marker first, then the notebook's."""
    dotnet = (metadata.get("dotnet_interactive") or {}).get("language")
    if isinstance(dotnet, str):
        return _ALIASES.get(dotnet.lower(), dotnet.lower())
    poly = (metadata.get("polyglot_notebook") or {}).get("kernelName")
    if isinstance(poly, str):
        return _ALIASES.get(poly.lower(), poly.lower())
    lang = metadata.get("language")
    if isinstance(lang, str) and lang:
        return _ALIASES.get(lang.lower(), lang.lower())
    first = source.lstrip().split("\n", 1)[0].strip()
    if first.startswith("%%") and first[2:].split()[:1]:
        magic = first[2:].split()[0].lower()
        if magic not in _TRANSPARENT_CELL_MAGICS:
            return magic  # %%bash, %%sql, %%html: not the kernel's language
    for candidate in (nb.language, nb.kernel):
        name = (candidate or "").split(",")[0].strip().lower()
        if name:
            return _ALIASES.get(name, name)
    return ""


# ── Python ─────────────────────────────────────────────────────────────────


def _python_source(source: str) -> str:
    """The cell without IPython syntax (magics, shell escapes, ``?`` help)."""
    lines = source.split("\n")
    if lines and lines[0].lstrip().startswith("%%"):
        lines = ["", *lines[1:]]  # a transparent cell magic (%%time)
    out = []
    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith(("%", "!", "?")) or stripped.endswith("?"):
            out.append(line[: len(line) - len(stripped)] + "pass")
        else:
            out.append(line)
    return "\n".join(out)


def _targets(node: ast.AST) -> list[str]:
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, (ast.Tuple, ast.List)):
        return [n for elt in node.elts for n in _targets(elt)]
    if isinstance(node, ast.Starred):
        return _targets(node.value)
    return []


def _base_name(node: ast.AST) -> str | None:
    while isinstance(node, (ast.Attribute, ast.Subscript)):
        node = node.value
    return node.id if isinstance(node, ast.Name) else None


class _Immediate(ast.NodeVisitor):
    """Names read when a statement runs: function bodies excluded."""

    def __init__(self) -> None:
        self.names: list[str] = []
        self._bound: list[set[str]] = []

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Load) and not any(
            node.id in s for s in self._bound
        ):
            self.names.append(node.id)

    def _function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        for deco in node.decorator_list:
            self.visit(deco)
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self.visit(default)

    visit_FunctionDef = _function
    visit_AsyncFunctionDef = _function

    def visit_Lambda(self, node: ast.Lambda) -> None:
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self.visit(default)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        for item in [*node.decorator_list, *node.bases, *node.keywords]:
            self.visit(item)
        for stmt in node.body:
            if not isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.visit(stmt)
            else:
                self._function(stmt)

    def _comprehension(self, node: ast.AST) -> None:
        bound = {
            n for gen in getattr(node, "generators", []) for n in _targets(gen.target)
        }
        self._bound.append(bound)
        for gen in node.generators:  # type: ignore[attr-defined]
            self.visit(gen.iter)
            for cond in gen.ifs:
                self.visit(cond)
        for part in ("elt", "key", "value"):
            child = getattr(node, part, None)
            if child is not None:
                self.visit(child)
        self._bound.pop()

    visit_ListComp = _comprehension
    visit_SetComp = _comprehension
    visit_DictComp = _comprehension
    visit_GeneratorExp = _comprehension


def _defined(stmt: ast.stmt) -> list[str]:
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return [stmt.name]
    if isinstance(stmt, ast.Assign):
        return [n for t in stmt.targets for n in _targets(t)]
    if isinstance(stmt, (ast.AnnAssign, ast.AugAssign)):
        return _targets(stmt.target)
    if isinstance(stmt, (ast.For, ast.AsyncFor)):
        found = _targets(stmt.target)
    elif isinstance(stmt, (ast.With, ast.AsyncWith)):
        found = [
            n
            for item in stmt.items
            if item.optional_vars is not None
            for n in _targets(item.optional_vars)
        ]
    elif isinstance(stmt, (ast.Import, ast.ImportFrom)):
        return [(a.asname or a.name.split(".")[0]) for a in stmt.names if a.name != "*"]
    else:
        found = []
    # Names bound inside blocks (if / for / with / try bodies) and walruses.
    for child in ast.walk(stmt):
        if child is stmt:
            continue
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            continue
        if isinstance(child, ast.NamedExpr):
            found.extend(_targets(child.target))
        elif isinstance(child, ast.stmt):
            found.extend(_defined(child))
        elif isinstance(child, ast.ExceptHandler) and child.name:
            found.append(child.name)
    return found


def _mutated(stmt: ast.stmt) -> list[str]:
    found: list[str] = []
    for node in ast.walk(stmt):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            continue
        targets: list[ast.AST] = []
        if isinstance(node, ast.Assign):
            targets = list(node.targets)
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
            targets = [node.target]
        elif isinstance(node, ast.Delete):
            targets = list(node.targets)
        for target in targets:
            if isinstance(target, (ast.Attribute, ast.Subscript)):
                name = _base_name(target)
                if name:
                    found.append(name)
            elif isinstance(node, ast.AugAssign) and isinstance(target, ast.Name):
                found.append(target.id)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            receiver = node.func.value
            inplace = any(
                k.arg == "inplace"
                and isinstance(k.value, ast.Constant)
                and k.value.value is True
                for k in node.keywords
            )
            if isinstance(receiver, ast.Name) and (
                inplace or node.func.attr in _MUTATING_METHODS
            ):
                found.append(receiver.id)
    return found


def _deferred(code: str) -> tuple[list[str], dict[str, list[str]]]:
    """Globals read inside function bodies, overall and per top-level function."""
    try:
        table = symtable.symtable(code, "<cell>", "exec")
    except (SyntaxError, ValueError):
        return [], {}
    names: list[str] = []
    per_function: dict[str, list[str]] = {}

    def walk(t: symtable.SymbolTable, owner: str | None) -> None:
        for child in t.get_children():
            kind = child.get_type()
            kind_name = getattr(kind, "value", kind)
            is_function = kind_name == "function" and child.get_name() not in {
                "listcomp",
                "setcomp",
                "dictcomp",
                "genexpr",
            }
            top = owner or (child.get_name() if is_function else None)
            if is_function:
                for sym in child.get_symbols():
                    if (
                        sym.is_global()
                        and sym.is_referenced()
                        and not sym.is_assigned()
                    ):
                        names.append(sym.get_name())
                        if top:
                            per_function.setdefault(top, []).append(sym.get_name())
            walk(child, top)

    walk(table, None)
    return names, per_function


def python_flow(index: int, source: str) -> CellFlow:
    flow = CellFlow(index=index, language="python")
    code = _python_source(source)
    try:
        tree = ast.parse(code)
    except SyntaxError:
        flow.parsed = False
        return flow
    defined_here: set[str] = set()
    for stmt in tree.body:
        reader = _Immediate()
        reader.visit(stmt)
        for name in reader.names:
            if name not in defined_here and name not in flow.immediate:
                flow.immediate.append(name)
        for name in _mutated(stmt):
            if name not in defined_here and name not in flow.mutates:
                flow.mutates.append(name)
        if isinstance(stmt, (ast.Import, ast.ImportFrom)):
            if any(a.name == "*" for a in stmt.names):
                flow.star_import = True
            for name in _defined(stmt):
                flow.imports[name] = ast.unparse(stmt)
        for name in _defined(stmt):
            defined_here.add(name)
            if name not in flow.defines:
                flow.defines.append(name)
    deferred, per_function = _deferred(code)
    flow.deferred = [n for n in dict.fromkeys(deferred) if n not in flow.immediate]
    flow.globals_in_functions = {
        fn: list(dict.fromkeys(names)) for fn, names in per_function.items()
    }
    return flow


# ── other languages: declarations ─────────────────────────────────────────

_IDENT = r"[A-Za-z_][\w]*"
_DECLARATIONS: dict[str, list[re.Pattern[str]]] = {
    "r": [
        re.compile(r"^\s*([A-Za-z.][\w.]*)\s*(?:<<?-|=(?!=))", re.M),
        re.compile(r"->>?\s*([A-Za-z.][\w.]*)"),
    ],
    "julia": [
        re.compile(
            r"^\s*(?:const\s+|global\s+|local\s+)?([A-Za-z_][\w!]*)\s*(?:::[^=\n]+)?=(?![=>])",
            re.M,
        ),
        re.compile(r"\b(?:function|macro|struct|module)\s+([A-Za-z_][\w!]*)"),
        re.compile(r"^\s*([A-Za-z_][\w!]*)\([^)\n]*\)\s*=(?!=)", re.M),
    ],
    "csharp": [
        re.compile(rf"\bvar\s+({_IDENT})\s*="),
        re.compile(
            rf"^\s*(?!return\b|await\b|new\b)[A-Za-z_][\w.]*(?:<[^>\n]*>)?(?:\[\])?\??\s+({_IDENT})\s*=(?!=)",
            re.M,
        ),
        re.compile(rf"\b(?:class|record|struct|interface|enum)\s+({_IDENT})"),
        re.compile(
            rf"^\s*(?:static\s+|async\s+|public\s+|private\s+)*[A-Za-z_][\w.<>,\[\]?]*\s+({_IDENT})\s*\([^)\n]*\)\s*(?:\{{|=>)",
            re.M,
        ),
    ],
    "fsharp": [
        re.compile(rf"\blet\s+(?:mutable\s+|rec\s+|inline\s+)?({_IDENT})"),
        re.compile(rf"\btype\s+({_IDENT})"),
    ],
    "powershell": [
        re.compile(r"\$(\w+)\s*(?:=(?!=)|\+=|-=)"),
        re.compile(r"\bfunction\s+([\w-]+)", re.I),
    ],
    "scala": [
        re.compile(
            rf"\b(?:val|var|def|class|object|trait|case class|lazy val|given)\s+({_IDENT})"
        )
    ],
    "kotlin": [
        re.compile(
            rf"\b(?:val|var|fun|class|object|interface|data class|enum class)\s+({_IDENT})"
        )
    ],
    "javascript": [re.compile(rf"\b(?:const|let|var|function\*?|class)\s+({_IDENT})")],
    "go": [
        re.compile(rf"({_IDENT})\s*(?:,\s*{_IDENT}\s*)*:="),
        re.compile(rf"\b(?:var|const|type)\s+({_IDENT})"),
        re.compile(rf"\bfunc\s+({_IDENT})"),
    ],
    "rust": [
        re.compile(rf"\blet\s+(?:mut\s+)?({_IDENT})"),
        re.compile(rf"\b(?:fn|struct|enum|trait|type|const|static)\s+({_IDENT})"),
    ],
}
_DECLARATIONS["typescript"] = _DECLARATIONS["javascript"]

_HASH = re.compile(r"#[^\n]*")
_SLASH = re.compile(r"//[^\n]*|/\*.*?\*/", re.S)
_STRINGS = re.compile(r'"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'|`(?:\\.|[^`\\])*`')
_COMMENTS = {
    "r": [_HASH],
    "julia": [re.compile(r"#=.*?=#", re.S), _HASH],
    "powershell": [re.compile(r"<#.*?#>", re.S), _HASH],
    "fsharp": [re.compile(r"\(\*.*?\*\)", re.S), _SLASH],
}
_CONTROL = re.compile(
    r"\b(if|else|for|foreach|while|switch|catch|using|lock|fixed|when|match|try|do|loop|unsafe)\s*(\([^()]*\))?\s*$"
)
_FUNCTION_HEAD = re.compile(
    r"(\bfunction\b[^{]*|=>\s*|\b(fn|func|fun|def)\b[^{]*|\w+\s*\([^()]*\)\s*(:\s*[\w<>\[\], ?]+)?\s*)$"
)


_JULIA_BLOCK = re.compile(
    r"\b(function|macro|do|if|for|while|begin|let|struct|module|try|quote|end)\b"
)


def _blank(text: str, pattern: re.Pattern[str]) -> str:
    return pattern.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)


def _strip(language: str, source: str) -> str:
    text = source
    for pattern in _COMMENTS.get(language, [_SLASH]):
        text = _blank(text, pattern)
    text = _blank(text, _STRINGS)
    return text


def _deferred_mask(language: str, text: str) -> list[bool]:
    """For each character: is it inside a function body (read when called)?"""
    mask = [False] * len(text)
    if language == "julia":
        depth: list[bool] = []
        last = 0
        for match in _JULIA_BLOCK.finditer(text):
            inside = any(depth)
            for i in range(last, match.start()):
                mask[i] = inside
            word = match.group(1)
            if word == "end":
                if depth:
                    depth.pop()
            else:
                depth.append(word in {"function", "macro", "do"})
            last = match.end()
        for i in range(last, len(text)):
            mask[i] = any(depth)
        return mask
    if language == "fsharp":
        offset = 0
        body_indent: int | None = None
        for line in text.split("\n"):
            indent = len(line) - len(line.lstrip())
            if body_indent is not None and line.strip() and indent <= body_indent:
                body_indent = None
            inside = body_indent is not None and bool(line.strip())
            for i in range(offset, offset + len(line)):
                mask[i] = inside
            if body_indent is None and re.match(
                rf"\s*let\s+(?:rec\s+|inline\s+)?{_IDENT}\s+[\w(]", line
            ):
                body_indent = indent
            offset += len(line) + 1
        return mask
    stack2: list[bool] = []
    segment_start = 0
    for i, char in enumerate(text):
        if char == "{":
            head = text[segment_start:i].split("\n")[-1].strip()
            is_fn = bool(_FUNCTION_HEAD.search(head)) and not _CONTROL.search(head)
            stack2.append(is_fn)
            segment_start = i + 1
        elif char == "}":
            if stack2:
                stack2.pop()
            segment_start = i + 1
        elif char in ";\n":
            segment_start = i + 1
        mask[i] = any(stack2)
    return mask


def text_flow(index: int, language: str, source: str) -> CellFlow:
    """A cell of a language read by its declarations (approximate)."""
    flow = CellFlow(index=index, language=language, precise=False)
    patterns = _DECLARATIONS.get(language)
    if not patterns:
        return flow
    text = _strip(language, source)
    spans: list[tuple[int, int]] = []
    for pattern in patterns:
        for match in pattern.finditer(text):
            name = match.group(1)
            if name not in flow.defines:
                flow.defines.append(name)
            spans.append(match.span(1))
    mask = _deferred_mask(language, text)
    defined_at: dict[str, int] = {}
    for start, end in spans:
        defined_at.setdefault(text[start:end], start)
    taken = {i for start, end in spans for i in range(start, end)}
    token = re.compile(r"\$(\w+)" if language == "powershell" else r"[A-Za-z_.][\w.!]*")
    for match in token.finditer(text):
        if match.start() in taken:
            continue
        if language == "r" and match.start() > 0 and text[match.start() - 1] in "$@":
            continue  # df$column, obj@slot: a member, not a variable
        name = match.group(1) if language == "powershell" else match.group(0)
        if language != "r":
            name = name.split(".")[0]
        if not name:
            continue
        before_own = name not in defined_at or match.start() < defined_at[name]
        if mask[match.start()] if match.start() < len(mask) else False:
            if name not in flow.deferred:
                flow.deferred.append(name)
        elif before_own and name not in flow.immediate:
            flow.immediate.append(name)
    return flow


# ── the notebook ───────────────────────────────────────────────────────────


def _cell_flows(nb: ParsedNotebook) -> list[CellFlow]:
    flows = []
    for cell in nb.code_cells:
        language = cell_language(nb, cell.source, cell.metadata)
        if language == "python":
            flows.append(python_flow(cell.index, cell.source))
        else:
            flows.append(text_flow(cell.index, language, cell.source))
    return flows


def _issue(
    kind: NotebookIssueType, cell: int, message: str, severity: str, suggestion: str
) -> NotebookIssue:
    return NotebookIssue(
        issue_type=kind,
        cell_index=cell,
        message=message,
        severity=severity,
        suggestion=suggestion,
    )


def _names(names: list[str]) -> str:
    shown = ", ".join(f"`{n}`" for n in names[:5])
    return shown + (f" (+{len(names) - 5})" if len(names) > 5 else "")


def analyze_dataflow(nb: ParsedNotebook) -> Dataflow:
    flows = _cell_flows(nb)
    flow = Dataflow(cells=flows, precise=all(f.precise for f in flows))
    known = {name for f in flows for name in f.defines}
    dynamic = any(_DYNAMIC.search(c.source) for c in nb.code_cells) or any(
        f.star_import for f in flows
    )
    counts = {c.index: c.execution_count for c in nb.code_cells}
    edges: dict[tuple[int, int], list[str]] = {}
    readers: dict[str, list[int]] = {}

    for position, cell in enumerate(flows):
        if not cell.parsed:
            continue
        earlier = flows[:position]
        later = flows[position + 1 :]
        for name, immediate in [(n, True) for n in cell.immediate] + [
            (n, False) for n in cell.deferred
        ]:
            if name in cell.defines and not immediate:
                continue
            source = next((f for f in reversed(earlier) if name in f.defines), None)
            if source is not None:
                edges.setdefault((source.index, cell.index), []).append(name)
                readers.setdefault(name, []).append(cell.index)
                count, needed = counts.get(cell.index), counts.get(source.index)
                if (
                    immediate
                    and count is not None
                    and (needed is None or needed > count)
                ):
                    flow.issues.append(
                        _issue(
                            NotebookIssueType.HIDDEN_STATE,
                            cell.index,
                            f"Cell {cell.index} reads {_names([name])} from cell {source.index}, "
                            f"which ran after it (execution {needed if needed is not None else 'never'} > {count}): "
                            "its stored output comes from a state the notebook does not rebuild",
                            "warning",
                            "Restart the kernel and run all cells in order",
                        )
                    )
                continue
            if not immediate or name in _BUILTINS:
                continue
            definer = next((f for f in later if name in f.defines), None)
            if definer is not None:
                edges.setdefault((definer.index, cell.index), []).append(name)
                note = "" if cell.precise else " (approximate reading of this language)"
                flow.issues.append(
                    _issue(
                        NotebookIssueType.USED_BEFORE_DEFINED,
                        cell.index,
                        f"Cell {cell.index} reads {_names([name])}, defined only by the later cell "
                        f"{definer.index}: the notebook only runs out of order{note}",
                        "error" if cell.precise else "warning",
                        f"Move cell {definer.index} above cell {cell.index}",
                    )
                )
            elif cell.precise and not dynamic and name not in known:
                flow.issues.append(
                    _issue(
                        NotebookIssueType.UNDEFINED_NAME,
                        cell.index,
                        f"Cell {cell.index} reads {_names([name])}, which no cell defines: "
                        "it existed only in a kernel session",
                        "error",
                        "Define or import it in the notebook",
                    )
                )

    for position, cell in enumerate(flows):
        for fn, names in cell.globals_in_functions.items():
            outside = [
                n
                for n in names
                if n not in _BUILTINS
                and n not in cell.imports
                and any(
                    n in f.defines and not f.imports.get(n)
                    for f in flows
                    if f is not cell
                )
            ]
            if outside:
                flow.issues.append(
                    _issue(
                        NotebookIssueType.IMPLICIT_GLOBAL,
                        cell.index,
                        f"Function `{fn}` reads the global {_names(outside)} of another cell",
                        "info",
                        "Pass it as a parameter so the function does not depend on the notebook's state",
                    )
                )
        for name in cell.mutates:
            creator = next(
                (f for f in reversed(flows[:position]) if name in f.defines), None
            )
            others = [
                r
                for r in readers.get(name, [])
                if r != cell.index and (creator is None or r != creator.index)
            ]
            if creator is not None and others and name not in cell.defines:
                flow.issues.append(
                    _issue(
                        NotebookIssueType.SHARED_MUTATION,
                        cell.index,
                        f"Cell {cell.index} changes {_names([name])} in place, created by cell "
                        f"{creator.index} and read by cells {', '.join(map(str, sorted(set(others))[:6]))}: "
                        "running it twice or out of order changes their results",
                        "info",
                        "Work on a copy, or assign the result to a new name",
                    )
                )

    flow.edges = [
        {"from": a, "to": b, "names": sorted(set(names))}
        for (a, b), names in sorted(edges.items())
    ]
    flow.order = _topological([f.index for f in flows], flow.edges)
    flow.in_order = flow.order == [f.index for f in flows]
    return flow


def _topological(cells: list[int], edges: list[dict]) -> list[int] | None:
    """The order closest to the notebook's that satisfies every edge; None on a cycle."""
    incoming = dict.fromkeys(cells, 0)
    targets: dict[int, list[int]] = {c: [] for c in cells}
    for edge in edges:
        if edge["from"] == edge["to"]:
            continue
        incoming[edge["to"]] = incoming.get(edge["to"], 0) + 1
        targets.setdefault(edge["from"], []).append(edge["to"])
    ready = [c for c in cells if incoming[c] == 0]
    order: list[int] = []
    while ready:
        ready.sort()
        current = ready.pop(0)
        order.append(current)
        for target in targets.get(current, []):
            incoming[target] -= 1
            if incoming[target] == 0:
                ready.append(target)
    return order if len(order) == len(cells) else None
