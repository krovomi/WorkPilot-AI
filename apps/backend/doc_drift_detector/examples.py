"""Code examples in the docs that no longer match the project (#354).

The fenced blocks of a Markdown document are read, without running them:

- **Python**: the block must parse (``ast``; doctest prompts are read as
  code); an import of one of the project's own packages must name a module
  that exists and a name that module defines; a call to a function imported
  that way must pass arguments its signature accepts (count and keywords).
- **JSON**: the block must parse, unless it has comments or ``...`` (JSONC,
  an excerpt).
- **Every other stack**: an import of the project's own code must name what
  the project still has. The project's own prefix comes from its manifest:
  ``package.json`` (JS/TS), ``go.mod`` (Go), ``Cargo.toml`` (Rust),
  ``pubspec.yaml`` (Dart), ``composer.json`` PSR-4 (PHP), the namespaces and
  packages its sources declare (.NET, Java, Kotlin, Scala), ``*.gemspec``
  (Ruby). A name is missing only when no source file writes it at all.

Silent when unsure: a block with placeholders (``<your-key>``), a module of
another project, a call with ``*args``/``**kwargs`` unpacking, a function that
takes ``*args``/``**kwargs``, and any block or paragraph after a line holding
``<!-- no-drift-check -->``.
"""

from __future__ import annotations

import ast
import json
import re
import sys
import textwrap
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

__all__ = [
    "CodeBlock",
    "ExampleIssue",
    "OwnCode",
    "check_examples",
    "code_blocks",
    "ignored_lines",
]

IGNORE_MARK = "no-drift-check"
_FENCE = re.compile(r"^(?P<indent>\s{0,3})(?P<fence>`{3,}|~{3,})\s*(?P<info>[^\s`]*)")
_PLACEHOLDER = re.compile(r"<[A-Za-z][\w .-]*>|\{\{[^}]*\}\}|\$\{[A-Z_]+\}")
_PY_LANGS = {"python", "py", "python3", "pycon", "ipython"}
_JS_LANGS = {
    "js",
    "javascript",
    "jsx",
    "ts",
    "typescript",
    "tsx",
    "mjs",
    "cjs",
    "vue",
    "svelte",
}
_STDLIB = frozenset(getattr(sys, "stdlib_module_names", ()))


@dataclass
class CodeBlock:
    lang: str
    line: int
    """1-based line of the block's first code line."""
    code: str


@dataclass
class ExampleIssue:
    kind: str
    """syntax, invalid_json, unknown_module, unknown_name, wrong_arguments."""
    line: int
    symbol: str
    detail: str = ""


@dataclass
class OwnCode:
    """What the project's own code is, for every stack."""

    __test__ = False

    python_modules: dict[str, str] = field(default_factory=dict)
    """Dotted module name (every suffix of its path) → project-relative file."""
    python_packages: set[str] = field(default_factory=set)
    """Top-level names of the project's own packages."""
    code_words: set[str] = field(default_factory=set)
    js_packages: set[str] = field(default_factory=set)
    go_modules: dict[str, str] = field(default_factory=dict)
    """go.mod module path → its folder."""
    rust_crates: set[str] = field(default_factory=set)
    dart_packages: dict[str, str] = field(default_factory=dict)
    """pubspec name → its folder."""
    php_prefixes: set[str] = field(default_factory=set)
    namespaces: set[str] = field(default_factory=set)
    """.NET namespaces and JVM packages declared by the sources."""
    ruby_gems: dict[str, str] = field(default_factory=dict)
    """gem name → its folder."""
    files: set[str] = field(default_factory=set)
    read: object = None
    """``read(relative path) -> str | None``: a project file's text."""

    def text(self, rel: str) -> str | None:
        return self.read(rel) if callable(self.read) else None


# --- blocks ------------------------------------------------------------------


def ignored_lines(content: str) -> set[int] | None:
    """1-based lines a ``no-drift-check`` mark excludes; None for the whole file.

    The mark on a document's first line (after its front matter, if any)
    excludes the document; elsewhere it excludes what follows it: the next
    fenced block, or the paragraph.
    """
    lines = content.splitlines()
    first = 0
    if lines and lines[0].strip() == "---":
        end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), 0)
        first = end + 1
    head = next((line for line in lines[first:] if line.strip()), "")
    if IGNORE_MARK in head:
        return None
    out: set[int] = set()
    i = 0
    while i < len(lines):
        if IGNORE_MARK not in lines[i]:
            i += 1
            continue
        out.add(i + 1)
        j = i + 1
        while j < len(lines) and not lines[j].strip():
            j += 1
        fence = _FENCE.match(lines[j]) if j < len(lines) else None
        if fence:
            marker = fence.group("fence")
            out.add(j + 1)
            j += 1
            while j < len(lines) and not lines[j].strip().startswith(marker):
                out.add(j + 1)
                j += 1
            out.add(j + 1)
        else:
            while j < len(lines) and lines[j].strip():
                out.add(j + 1)
                j += 1
        i = j + 1
    return out


def code_blocks(content: str) -> list[CodeBlock]:
    """The fenced blocks of a Markdown document, with their language."""
    lines = content.splitlines()
    blocks: list[CodeBlock] = []
    i = 0
    while i < len(lines):
        m = _FENCE.match(lines[i])
        if not m:
            i += 1
            continue
        marker = m.group("fence")
        lang = m.group("info").strip("{}.").split(",")[0].lower()
        body: list[str] = []
        j = i + 1
        while j < len(lines) and not lines[j].strip().startswith(
            marker[0] * len(marker)
        ):
            body.append(lines[j])
            j += 1
        # A block inside a list item is indented with it: the code is not.
        code = textwrap.dedent("\n".join(body))
        blocks.append(CodeBlock(lang=lang, line=i + 2, code=code))
        i = j + 1
    return blocks


# --- Python ------------------------------------------------------------------


def _doctest(code: str) -> str:
    if not any(line.lstrip().startswith(">>>") for line in code.splitlines()):
        return code
    kept = []
    for line in code.splitlines():
        s = line.lstrip()
        if s.startswith((">>> ", "... ")) or s in {">>>", "..."}:
            kept.append(s[4:])
    return "\n".join(kept)


def _defined_names(body: list[ast.stmt], names: set[str]) -> bool:
    """Add the names ``body`` defines; False when it cannot say (``import *``)."""
    for node in body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                names.update(s.id for s in ast.walk(target) if isinstance(s, ast.Name))
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            if any(alias.name == "*" for alias in node.names):
                return False
            names.update((a.asname or a.name).split(".")[0] for a in node.names)
        elif isinstance(node, (ast.If, ast.Try, ast.With)):
            # A name defined in any branch counts: the example may take that one.
            blocks = [node.body, getattr(node, "orelse", [])]
            blocks += [getattr(node, "finalbody", [])]
            blocks += [h.body for h in getattr(node, "handlers", [])]
            if not all(_defined_names(b, names) for b in blocks):
                return False
    return True


def _module_defines(own: OwnCode, module: str) -> set[str] | None:
    """Top-level names a project module defines; None when it cannot say."""
    rel = own.python_modules.get(module)
    text = own.text(rel) if rel else None
    if text is None:
        return None
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError):
        return None
    names: set[str] = set()
    if not _defined_names(tree.body, names) or "__getattr__" in names:
        return None
    return names


def _function_def(
    own: OwnCode, module: str, name: str
) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    rel = own.python_modules.get(module)
    text = own.text(rel) if rel else None
    if text is None:
        return None
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError):
        return None
    found = [
        n
        for n in tree.body
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name
    ]
    if len(found) != 1 or found[0].decorator_list:
        return None  # overloads, decorators (wrappers change the signature)
    return found[0]


def _call_problem(
    fn: ast.FunctionDef | ast.AsyncFunctionDef, call: ast.Call
) -> str | None:
    if any(isinstance(a, ast.Starred) for a in call.args) or any(
        k.arg is None for k in call.keywords
    ):
        return None
    a = fn.args
    positional = [p.arg for p in [*a.posonlyargs, *a.args]]
    required = len(positional) - len(a.defaults)
    kwonly = [p.arg for p in a.kwonlyargs]
    kw_required = {
        p.arg for p, d in zip(a.kwonlyargs, a.kw_defaults, strict=True) if d is None
    }
    given = len(call.args)
    if not a.vararg and given > len(positional):
        return f"takes {len(positional)} positional argument(s), {given} given"
    named = {k.arg for k in call.keywords if k.arg}
    if not a.kwarg:
        unknown = sorted(
            n
            for n in named
            if n not in kwonly and n not in positional[len(a.posonlyargs) :]
        )
        if unknown:
            return f"no parameter named {', '.join(unknown)}"
    missing = [p for p in positional[given:required] if p not in named]
    missing += sorted(kw_required - named)
    if missing:
        return f"missing {', '.join(missing)}"
    return None


def _python_issues(block: CodeBlock, own: OwnCode) -> list[ExampleIssue]:
    code = _doctest(block.code)
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        if _PLACEHOLDER.search(code) or "..." in code or "…" in code:
            return []
        line = block.line + max(0, (exc.lineno or 1) - 1)
        return [
            ExampleIssue("syntax", line, (exc.text or "").strip()[:120], exc.msg or "")
        ]
    except ValueError:
        return []
    issues: list[ExampleIssue] = []
    imported: dict[str, tuple[str, str]] = {}  # local name -> (module, name)
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and not node.level:
            top = node.module.split(".")[0]
            if top not in own.python_packages or top in _STDLIB:
                continue
            line = block.line + node.lineno - 1
            if node.module not in own.python_modules:
                issues.append(ExampleIssue("unknown_module", line, node.module))
                continue
            defined = _module_defines(own, node.module)
            for alias in node.names:
                if alias.name == "*":
                    continue
                sub = f"{node.module}.{alias.name}"
                if (
                    defined is not None
                    and alias.name not in defined
                    and sub not in own.python_modules
                ):
                    issues.append(ExampleIssue("unknown_name", line, sub))
                    continue
                imported[alias.asname or alias.name] = (node.module, alias.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                if (
                    top in own.python_packages
                    and top not in _STDLIB
                    and alias.name not in own.python_modules
                ):
                    issues.append(
                        ExampleIssue(
                            "unknown_module", block.line + node.lineno - 1, alias.name
                        )
                    )
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)):
            continue
        target = imported.get(node.func.id)
        if not target:
            continue
        fn = _function_def(own, *target)
        problem = _call_problem(fn, node) if fn else None
        if problem:
            issues.append(
                ExampleIssue(
                    "wrong_arguments",
                    block.line + node.lineno - 1,
                    f"{target[0]}.{target[1]}",
                    problem,
                )
            )
    return issues


# --- other stacks ------------------------------------------------------------

_JS_IMPORT = re.compile(
    r"""import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{(?P<names>[^}]*)\}\s*from\s*['"](?P<mod>[^'"]+)['"]"""
)
_JS_REQUIRE = re.compile(
    r"""(?:const|let|var)\s*\{(?P<names>[^}]*)\}\s*=\s*require\(\s*['"](?P<mod>[^'"]+)['"]\s*\)"""
)
_GO_IMPORT = re.compile(r'"(?P<path>[\w.\-]+(?:/[\w.\-]+)+)"')
_RUST_USE = re.compile(r"\buse\s+(?P<path>[\w:]+(?:::\{[^}]*\})?)\s*;")
_DART_IMPORT = re.compile(r"""import\s+['"]package:(?P<pkg>\w+)/(?P<path>[^'"]+)['"]""")
_PHP_USE = re.compile(r"^\s*use\s+(?P<cls>[\w\\]+)(?:\s+as\s+\w+)?\s*;", re.M)
_CS_USING = re.compile(
    r"^\s*using\s+(?:static\s+)?(?P<ns>[A-Z]\w*(?:\.\w+)+)\s*;", re.M
)
_JVM_IMPORT = re.compile(
    r"^\s*import\s+(?:static\s+)?(?P<path>[a-z]\w*(?:\.\w+)+)\s*;?\s*$", re.M
)
_RUBY_REQUIRE = re.compile(r"""\brequire\s*\(?\s*['"](?P<path>[\w/.-]+)['"]""")


def _js_names(raw: str) -> list[str]:
    names = []
    for part in raw.split(","):
        part = part.strip().removeprefix("type ").strip()
        name = re.split(r"\s+as\s+|\s*:\s*", part)[0].strip()
        if re.fullmatch(r"[A-Za-z_$][\w$]*", name):
            names.append(name)
    return names


def _own_js(mod: str, own: OwnCode) -> bool:
    return any(mod == p or mod.startswith(p + "/") for p in own.js_packages)


def _other_issues(block: CodeBlock, own: OwnCode) -> list[ExampleIssue]:
    issues: list[ExampleIssue] = []

    def at(offset: int) -> int:
        return block.line + block.code.count("\n", 0, offset)

    if block.lang in _JS_LANGS:
        for pattern in (_JS_IMPORT, _JS_REQUIRE):
            for m in pattern.finditer(block.code):
                if not _own_js(m.group("mod"), own):
                    continue
                for name in _js_names(m.group("names")):
                    if name not in own.code_words:
                        issues.append(
                            ExampleIssue(
                                "unknown_name",
                                at(m.start()),
                                f"{m.group('mod')}:{name}",
                            )
                        )
    elif block.lang in {"go", "golang"}:
        for m in _GO_IMPORT.finditer(block.code):
            path = m.group("path")
            for module, folder in own.go_modules.items():
                if path == module or not path.startswith(module + "/"):
                    continue
                sub = str(PurePosixPath(folder) / path[len(module) + 1 :]).lstrip("./")
                if not any(f.startswith(sub.rstrip("/") + "/") for f in own.files):
                    issues.append(ExampleIssue("unknown_module", at(m.start()), path))
    elif block.lang in {"rust", "rs"}:
        for m in _RUST_USE.finditer(block.code):
            path = m.group("path")
            crate = path.split("::")[0]
            if crate not in own.rust_crates:
                continue
            tail = path.split("::", 1)[1] if "::" in path else ""
            names = re.findall(r"[A-Za-z_]\w*", tail.split("::")[-1]) if tail else []
            for name in names:
                if (
                    name not in {"self", "super", "crate"}
                    and name not in own.code_words
                ):
                    issues.append(
                        ExampleIssue("unknown_name", at(m.start()), f"{crate}::{name}")
                    )
    elif block.lang == "dart":
        for m in _DART_IMPORT.finditer(block.code):
            folder = own.dart_packages.get(m.group("pkg"))
            if folder is None:
                continue
            rel = str(PurePosixPath(folder) / "lib" / m.group("path")).lstrip("./")
            if rel not in own.files:
                issues.append(
                    ExampleIssue(
                        "unknown_module",
                        at(m.start()),
                        f"package:{m.group('pkg')}/{m.group('path')}",
                    )
                )
    elif block.lang == "php":
        for m in _PHP_USE.finditer(block.code):
            cls = m.group("cls").lstrip("\\")
            if not any(cls.startswith(p) for p in own.php_prefixes):
                continue
            name = cls.rsplit("\\", 1)[-1]
            if name not in own.code_words:
                issues.append(ExampleIssue("unknown_name", at(m.start()), cls))
    elif block.lang in {"cs", "csharp", "c#", "fsharp", "vb"}:
        roots = {ns.split(".")[0] for ns in own.namespaces}
        for m in _CS_USING.finditer(block.code):
            ns = m.group("ns")
            if ns.split(".")[0] not in roots:
                continue
            if not any(d == ns or d.startswith(ns + ".") for d in own.namespaces):
                issues.append(ExampleIssue("unknown_module", at(m.start()), ns))
    elif block.lang in {"java", "kotlin", "kt", "scala", "groovy"}:
        prefixes = {".".join(ns.split(".")[:2]) for ns in own.namespaces if "." in ns}
        for m in _JVM_IMPORT.finditer(block.code):
            path = m.group("path")
            if ".".join(path.split(".")[:2]) not in prefixes or path.endswith(".*"):
                continue
            name = path.rsplit(".", 1)[-1]
            if name[:1].isupper() and name not in own.code_words:
                issues.append(ExampleIssue("unknown_name", at(m.start()), path))
    elif block.lang in {"ruby", "rb"}:
        for m in _RUBY_REQUIRE.finditer(block.code):
            path = m.group("path")
            gem = path.split("/")[0]
            folder = own.ruby_gems.get(gem)
            if folder is None or "/" not in path:
                continue
            rel = str(PurePosixPath(folder) / "lib" / f"{path}.rb").lstrip("./")
            if rel not in own.files:
                issues.append(ExampleIssue("unknown_module", at(m.start()), path))
    return issues


def _json_issue(block: CodeBlock) -> list[ExampleIssue]:
    code = block.code.strip()
    # Only a whole document: `"key": {...}` is an excerpt of one.
    if (
        not code.startswith(("{", "["))
        or "//" in code
        or "/*" in code
        or "..." in code
        or "…" in code
    ):
        return []
    if _PLACEHOLDER.search(code):
        return []
    try:
        json.loads(code)
    except json.JSONDecodeError as exc:
        if exc.msg == "Extra data":
            return []  # JSON Lines, or several documents one after the other
        lines = code.splitlines()
        text = lines[exc.lineno - 1].strip()[:120] if exc.lineno <= len(lines) else ""
        offset = len(block.code) - len(block.code.lstrip("\n"))
        line = block.line + block.code.count("\n", 0, offset) + exc.lineno - 1
        return [ExampleIssue("invalid_json", line, text, exc.msg)]
    return []


def check_examples(content: str, own: OwnCode) -> list[ExampleIssue]:
    """The problems of a document's code examples."""
    ignored = ignored_lines(content)
    if ignored is None:
        return []
    issues: list[ExampleIssue] = []
    for block in code_blocks(content):
        if block.line - 1 in ignored or block.line in ignored:
            continue
        if block.lang in _PY_LANGS:
            issues.extend(_python_issues(block, own))
        elif block.lang == "json":
            issues.extend(_json_issue(block))
        else:
            issues.extend(_other_issues(block, own))
    return issues


def python_index(files: set[str]) -> tuple[dict[str, str], set[str]]:
    """Every dotted name a project's Python files are imported by, and its packages.

    ``apps/backend/core/client.py`` is ``apps.backend.core.client``,
    ``backend.core.client`` and ``core.client``: the folder a project runs
    from is not known, so every suffix is a candidate. A package is a folder
    with an ``__init__.py`` whose parent has none, or a ``src/`` layout's
    top folder.
    """
    modules: dict[str, str] = {}
    inits = {
        str(PurePosixPath(f).parent)
        for f in files
        if f.endswith("/__init__.py") or f == "__init__.py"
    }
    packages: set[str] = set()
    for rel in files:
        if not rel.endswith(".py"):
            continue
        parts = list(PurePosixPath(rel).with_suffix("").parts)
        if parts[-1] == "__init__":
            parts = parts[:-1]
        for start in range(len(parts)):
            dotted = ".".join(parts[start:])
            if dotted:
                modules.setdefault(dotted, rel)
    for folder in inits:
        p = PurePosixPath(folder)
        if str(p.parent) not in inits and p.name:
            packages.add(p.name)
    return modules, packages


def own_code_from_manifests(root: Path, files: set[str]) -> dict[str, object]:
    """The project's own package names, from each stack's manifest."""
    found: dict[str, object] = {
        "js_packages": set(),
        "go_modules": {},
        "rust_crates": set(),
        "dart_packages": {},
        "php_prefixes": set(),
        "ruby_gems": {},
    }

    def read(rel: str) -> str:
        try:
            path = root / rel
            if path.is_symlink() or path.stat().st_size > 400_000:
                return ""
            return path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return ""

    for rel in sorted(files):
        name = PurePosixPath(rel).name
        folder = str(PurePosixPath(rel).parent)
        folder = "" if folder == "." else folder
        if name == "package.json":
            try:
                pkg = json.loads(read(rel) or "{}").get("name")
            except (json.JSONDecodeError, AttributeError):
                pkg = None
            if isinstance(pkg, str) and pkg and not pkg.startswith("."):
                found["js_packages"].add(pkg)  # type: ignore[union-attr]
        elif name == "go.mod":
            m = re.search(r"^module\s+(\S+)", read(rel), re.M)
            if m:
                found["go_modules"][m.group(1)] = folder  # type: ignore[index]
        elif name == "Cargo.toml":
            m = re.search(
                r'^\[package\][^\[]*?^name\s*=\s*"([^"]+)"', read(rel), re.M | re.S
            )
            if m:
                found["rust_crates"].add(m.group(1).replace("-", "_"))  # type: ignore[union-attr]
        elif name == "pubspec.yaml":
            m = re.search(r"^name:\s*([\w]+)", read(rel), re.M)
            if m:
                found["dart_packages"][m.group(1)] = folder  # type: ignore[index]
        elif name == "composer.json":
            try:
                data = json.loads(read(rel) or "{}")
            except json.JSONDecodeError:
                data = {}
            for section in ("autoload", "autoload-dev"):
                psr4 = (
                    (data.get(section) or {}).get("psr-4")
                    if isinstance(data, dict)
                    else None
                )
                if isinstance(psr4, dict):
                    found["php_prefixes"].update(
                        k.lstrip("\\")
                        for k in psr4
                        if isinstance(k, str) and k.strip("\\")
                    )  # type: ignore[union-attr]
        elif name.endswith(".gemspec"):
            found["ruby_gems"][name.removesuffix(".gemspec")] = folder  # type: ignore[index]
    return found
