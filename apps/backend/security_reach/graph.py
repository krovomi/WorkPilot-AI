"""Which source files the project's entry points reach (issue #364).

A file-level graph, for any language, read from text: an edge goes from a file
to each file its import lines name (``import``, ``from``, ``require``,
``use``, ``using``, ``include``…), by file name or folder name. In the
languages where a type is used without being imported (Java, Kotlin, C#,
Swift, Scala, Go's package), a file also reaches the files named after the
types it mentions, and the other files of its folder.

The graph errs toward reaching: an edge too many keeps a finding where it
was, an edge too few would push it down. Entry points are the files that
start something (``main``, a route, a handler, a command), the files named
like one, and the files a manifest runs. When the project loads code by name
(``importlib``, ``eval``, reflection), an unreached file may still run, and
says so.
"""

from __future__ import annotations

import re
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import PurePosixPath

from .sources import Sources, is_test_path

__all__ = ["ReachGraph", "build_graph"]

_ENTRY_STEMS = frozenset(
    {
        "main",
        "__main__",
        "app",
        "application",
        "server",
        "index",
        "manage",
        "wsgi",
        "asgi",
        "cli",
        "program",
        "startup",
        "handler",
        "handlers",
        "lambda_function",
        "routes",
        "urls",
        "worker",
    }
)
#: One pattern each, starting with a literal: the engine then skips ahead to
#: it, which neither an alternation of all of them nor a leading ``\b`` allows.
_ENTRY_PATTERNS = tuple(
    re.compile(pattern, re.MULTILINE)
    for pattern in (
        # Python
        r"@(?:app|router|bp|blueprint|api|api_router)\.(?:get|post|put|patch|delete|route|websocket)\b",
        r"if\s+__name__\s*==\s*['\"]__main__['\"]",
        r"@(?:click\.(?:command|group)|app\.task|shared_task|celery\.task)\b",
        r"typer\.Typer\(|argparse\.ArgumentParser\(",
        # JavaScript, TypeScript
        r"(?:app|router|server|fastify)\.(?:get|post|put|patch|delete|all|route|use)\s*\(",
        r"export\s+(?:default\s+)?(?:async\s+)?function\s+(?:handler|GET|POST|PUT|PATCH|DELETE|loader|action)\b",
        r"exports\.handler\s*=",
        # Go
        r"func\s+main\s*\(",
        r"http\.HandleFunc\(",
        # Java, Kotlin, Scala
        r"@(?:RestController|Controller|GetMapping|PostMapping|PutMapping|DeleteMapping|RequestMapping|SpringBootApplication|Path)\b",
        r"public\s+static\s+void\s+main\s*\(",
        r"fun\s+main\s*\(",
        # C#, F#
        r"\[(?:ApiController|Http(?:Get|Post|Put|Patch|Delete)|Route|Function)\b",
        r"\.Map(?:Get|Post|Put|Patch|Delete|Controllers|Hub)\s*[<(]",
        r"static\s+(?:async\s+)?[\w<>]+\s+Main\s*\(",
        # Rust
        r"fn\s+main\s*\(",
        r"#\[(?:get|post|put|delete|route|tokio::main|actix_web::main)\b",
        # Ruby, PHP, Elixir, Dart, Swift
        r"^\s*(?:get|post|put|patch|delete)\s+['\"]/",
        r"<\s*(?:ApplicationController|ActionController::Base|Sinatra::Base)\b",
        r"Route::(?:get|post|put|patch|delete|any|match)\s*\(",
        r"void\s+main\s*\(",
        r"@main\b",
    )
)
#: Anchored at the start of a line, so a long file is read in one pass.
_IMPORT_LINE = re.compile(
    r"^(?:[ \t]*(?:import|from|export[ \t][^\n]*\bfrom|using|use|require|require_relative|"
    r"include|#[ \t]*include|load|mod|alias)\b|[^\n]*\b(?:require|import)[ \t]*\()[^\n]*$",
    re.MULTILINE,
)
_TOKEN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_TYPE_NAME = re.compile(r"\b[A-Z][A-Za-z0-9_]{2,}\b")
#: A path in a manifest that names a source file, or a Python ``pkg.mod:func``.
_MANIFEST_FILE = re.compile(r"[\w./-]+\.(?:py|[cm]?js|ts|go|rb|php|dll)\b")
_MANIFEST_MODULE = re.compile(r"\b([A-Za-z_][\w.]*):[A-Za-z_]\w*")
_TYPE_LANGUAGES = frozenset(
    {".java", ".kt", ".kts", ".cs", ".fs", ".vb", ".swift", ".scala", ".groovy"}
)
_PACKAGE_LANGUAGES = frozenset(
    {".go", ".java", ".kt", ".kts", ".cs", ".fs", ".vb", ".scala", ".swift", ".groovy"}
)
_DYNAMIC = tuple(
    re.compile(pattern)
    for pattern in (
        r"importlib\.import_module\(",
        r"__import__\(",
        r"require\(\s*[^'\"`\s)]",
        r"import\(\s*[^'\"`\s)]",
        r"Class\.forName\(",
        r"Activator\.CreateInstance",
        r"Assembly\.Load",
        r"Type\.GetType\(",
        r"reflect\.ValueOf\(",
        r"constantize\b",
        r"call_user_func",
        r"ServiceLoader\b",
    )
)


#: ``eval(`` and ``exec(`` as calls of their own, not ``retrieval(``; checked
#: by hand, since a look-behind would read every position of the file.
_EVAL = re.compile(r"(?:eval|exec)\(")


def _loads_by_name(text: str) -> bool:
    if any(p.search(text) for p in _DYNAMIC):
        return True
    for match in _EVAL.finditer(text):
        before = text[match.start() - 1] if match.start() else " "
        if not (before.isalnum() or before in "_."):
            return True
    return False


@dataclass
class ReachGraph:
    entries: set[str] = field(default_factory=set)
    reached: set[str] = field(default_factory=set)
    tests: set[str] = field(default_factory=set)
    #: A reached file loads code by name.
    dynamic: bool = False
    #: Per file, its import lines, for the dependency analysis.
    import_text: dict[str, str] = field(default_factory=dict)

    def is_reached(self, rel: str) -> bool:
        return rel in self.reached


def _index(files: list[str]) -> tuple[dict[str, set[str]], dict[str, set[str]]]:
    by_stem: dict[str, set[str]] = defaultdict(set)
    by_dir: dict[str, set[str]] = defaultdict(set)
    for rel in files:
        path = PurePosixPath(rel)
        by_stem[path.stem.split(".")[0]].add(rel)
        if len(path.parts) > 1:
            by_dir[path.parts[-2]].add(rel)
    return by_stem, by_dir


def _manifest_entries(sources: Sources, files: set[str]) -> set[str]:
    by_module = {
        PurePosixPath(rel).with_suffix("").as_posix().replace("/", "."): rel
        for rel in files
        if rel.endswith(".py")
    }
    by_name: dict[str, set[str]] = defaultdict(set)
    for rel in files:
        by_name[PurePosixPath(rel).name].add(rel)
    found: set[str] = set()
    for text in sources.manifests.values():
        for match in _MANIFEST_FILE.finditer(text):
            named = match.group(0).lstrip("./")
            found.update(
                rel
                for rel in by_name.get(PurePosixPath(named).name, set())
                if rel == named or rel.endswith("/" + named)
            )
        for match in _MANIFEST_MODULE.finditer(text):
            module = match.group(1)
            for candidate in (module, module + ".__main__", module + ".__init__"):
                for dotted, rel in by_module.items():
                    if dotted == candidate or dotted.endswith("." + candidate):
                        found.add(rel)
    return found


def build_graph(sources: Sources) -> ReachGraph:
    graph = ReachGraph()
    files = sorted(sources.files)
    by_stem, by_dir = _index(files)
    edges: dict[str, set[str]] = {}
    for rel in files:
        text = sources.files[rel]
        suffix = PurePosixPath(rel).suffix.lower()
        lines = "\n".join(m.group(0) for m in _IMPORT_LINE.finditer(text))
        graph.import_text[rel] = lines
        targets: set[str] = set()
        for token in set(_TOKEN.findall(lines)):
            targets |= by_stem.get(token, set()) | by_dir.get(token, set())
        if suffix in _TYPE_LANGUAGES:
            for name in set(_TYPE_NAME.findall(text)):
                targets |= by_stem.get(name, set())
        if suffix in _PACKAGE_LANGUAGES:
            parent = PurePosixPath(rel).parent
            targets |= {
                f
                for f in by_dir.get(parent.name, set())
                if PurePosixPath(f).parent == parent
            }
        targets.discard(rel)
        edges[rel] = targets
        if is_test_path(rel):
            graph.tests.add(rel)
            continue
        stem = PurePosixPath(rel).stem.split(".")[0].lower()
        if stem in _ENTRY_STEMS or any(p.search(text) for p in _ENTRY_PATTERNS):
            graph.entries.add(rel)
    graph.entries |= _manifest_entries(sources, set(files)) - graph.tests

    queue = deque(sorted(graph.entries))
    graph.reached = set(graph.entries)
    while queue:
        current = queue.popleft()
        if _loads_by_name(sources.files[current]):
            graph.dynamic = True
        for target in sorted(edges[current] - graph.reached - graph.tests):
            graph.reached.add(target)
            queue.append(target)
    return graph
