"""
Imports of the languages that are neither Python nor JavaScript
================================================================

One small reader per language, all returning the same thing: the module a
line depends on, as the language writes it, and the line number. The import
analyzer turns those into graph edges; layers recognise a target by the
module prefixes they declare (``MyApp.Domain``, ``com.acme.domain``,
``github.com/acme/shop/internal/domain``, ``App\\Domain``…).

Separators that only mean "this module inside that one" are written as dots,
so prefixes compare the same way across languages: ``App\\Domain\\User`` and
``crate::domain::user`` become ``App.Domain.User`` and ``crate.domain.user``.
Go and Dart keep their slashes: there the path *is* the module name.

Comments and strings are not parsed. A commented-out ``using`` can only make
a layer rule stricter, never hide a dependency the code really has, and each
reader anchors on the start of a line to keep that rare.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator

# A found dependency: (module as written, 1-based line, statement text).
FoundImport = tuple[str, int, str]

_CSHARP_USING = re.compile(
    r"^\s*(?:global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?([A-Za-z_][\w.]*)\s*;"
)
_FSHARP_OPEN = re.compile(r"^\s*open\s+(?:type\s+)?([A-Za-z_][\w.]*)")
_VB_IMPORTS = re.compile(r"^\s*Imports\s+(?:\w+\s*=\s*)?([A-Za-z_][\w.]*)", re.I)
_JVM_IMPORT = re.compile(r"^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]*)(?:\.\*)?")
_SCALA_IMPORT = re.compile(r"^\s*import\s+([A-Za-z_][\w.]*)")
_GO_SINGLE = re.compile(r'^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"')
_GO_BLOCK_START = re.compile(r"^\s*import\s*\(")
_GO_BLOCK_LINE = re.compile(r'^\s*(?:[\w.]+\s+)?"([^"]+)"')
_PHP_USE = re.compile(r"^\s*use\s+(?:function\s+|const\s+)?\\?([A-Za-z_][\w\\]*)")
_PHP_GROUP_USE = re.compile(r"^\s*use\s+\\?([A-Za-z_][\w\\]*)\\\{")
_RUST_USE = re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+(?:::)?([A-Za-z_][\w:]*)")
_RUST_EXTERN = re.compile(r"^\s*extern\s+crate\s+(\w+)")
_DART_IMPORT = re.compile(r"""^\s*(?:import|export|part)\s+['"]([^'"]+)['"]""")
_SWIFT_IMPORT = re.compile(
    r"^\s*(?:@[\w]+(?:\([^)]*\))?\s+)*import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?([A-Za-z_][\w.]*)"
)


def _lines(content: str) -> Iterator[tuple[int, str]]:
    yield from enumerate(content.splitlines(), 1)


def _by_pattern(
    pattern: re.Pattern[str], normalize: Callable[[str], str] | None = None
) -> Callable[[str], list[FoundImport]]:
    def parse(content: str) -> list[FoundImport]:
        found: list[FoundImport] = []
        for number, line in _lines(content):
            match = pattern.match(line)
            if match:
                target = match.group(1)
                if normalize:
                    target = normalize(target)
                if target:
                    found.append((target, number, line.strip()))
        return found

    return parse


def _strip_trailing_dot(target: str) -> str:
    return target.rstrip(".")


def parse_go(content: str) -> list[FoundImport]:
    """``import "a/b"``, aliased imports and ``import ( … )`` blocks."""
    found: list[FoundImport] = []
    in_block = False
    for number, line in _lines(content):
        if in_block:
            if line.strip().startswith(")"):
                in_block = False
                continue
            match = _GO_BLOCK_LINE.match(line)
            if match:
                found.append((match.group(1), number, line.strip()))
            continue
        if _GO_BLOCK_START.match(line):
            in_block = True
            continue
        match = _GO_SINGLE.match(line)
        if match:
            found.append((match.group(1), number, line.strip()))
    return found


def parse_php(content: str) -> list[FoundImport]:
    """``use A\\B\\C;``, ``use A\\{B, C};`` (kept as ``A``), function/const uses."""
    found: list[FoundImport] = []
    for number, line in _lines(content):
        group = _PHP_GROUP_USE.match(line)
        match = group or _PHP_USE.match(line)
        if not match:
            continue
        target = match.group(1).strip("\\").replace("\\", ".")
        if target:
            found.append((target, number, line.strip()))
    return found


def parse_rust(content: str) -> list[FoundImport]:
    """``use crate::a::b``, ``use super::x``, ``extern crate y``."""
    found: list[FoundImport] = []
    for number, line in _lines(content):
        match = _RUST_USE.match(line) or _RUST_EXTERN.match(line)
        if not match:
            continue
        target = match.group(1).strip(":").replace("::", ".")
        if target:
            found.append((target, number, line.strip()))
    return found


parse_csharp = _by_pattern(_CSHARP_USING)
parse_fsharp = _by_pattern(_FSHARP_OPEN)
parse_vb = _by_pattern(_VB_IMPORTS)
parse_jvm = _by_pattern(_JVM_IMPORT, _strip_trailing_dot)
parse_scala = _by_pattern(_SCALA_IMPORT, _strip_trailing_dot)
parse_dart = _by_pattern(_DART_IMPORT)
parse_swift = _by_pattern(_SWIFT_IMPORT)


#: Extension → reader. Kotlin script and Groovy read like Java.
PARSERS: dict[str, Callable[[str], list[FoundImport]]] = {
    ".cs": parse_csharp,
    ".fs": parse_fsharp,
    ".fsx": parse_fsharp,
    ".vb": parse_vb,
    ".java": parse_jvm,
    ".kt": parse_jvm,
    ".kts": parse_jvm,
    ".groovy": parse_jvm,
    ".scala": parse_scala,
    ".go": parse_go,
    ".php": parse_php,
    ".rs": parse_rust,
    ".dart": parse_dart,
    ".swift": parse_swift,
}

#: MSBuild project files: their ``ProjectReference`` items are the
#: project-to-project dependencies, read by :func:`parse_msbuild_references`.
MSBUILD_PROJECT_EXTENSIONS = {".csproj", ".fsproj", ".vbproj"}

_PROJECT_REFERENCE = re.compile(
    r"""<ProjectReference\b[^>]*\bInclude\s*=\s*["']([^"']+)["']""", re.I
)


def parse_msbuild_references(content: str) -> list[FoundImport]:
    """Every ``<ProjectReference Include="..\\X\\X.csproj" />``, as project name ``X``.

    The name is the referenced file's stem, which is also the default root
    namespace of that project: a layer that declares ``MyApp.Infrastructure``
    as a module prefix recognises both its namespaces and its project.
    """
    found: list[FoundImport] = []
    for number, line in _lines(content):
        for match in _PROJECT_REFERENCE.finditer(line):
            include = match.group(1).replace("\\", "/")
            stem = include.rsplit("/", 1)[-1]
            for ext in MSBUILD_PROJECT_EXTENSIONS:
                if stem.lower().endswith(ext):
                    stem = stem[: -len(ext)]
                    break
            if stem:
                found.append((stem, number, line.strip()))
    return found
