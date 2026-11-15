"""Performance Profiler - Scans codebase to detect bottlenecks and performance issues.

Each rule is a text heuristic. A rule that pairs two patterns ("a query inside a
loop") looks for the second one inside the block of the first (see
``code_blocks``), never further down the file.

Loops, caching and queries are read in Python and in the brace languages
(JS/TS, C#, Java, Kotlin, Go, Rust, C/C++, Swift, PHP, Dart, Scala); memory
leaks and renders are JavaScript/React rules.
"""

import re
import uuid
from pathlib import Path

from . import code_blocks
from .models import (
    Bottleneck,
    BottleneckType,
    PerformanceReport,
    Severity,
)

IGNORE_PATTERNS = {
    "node_modules",
    ".git",
    "__pycache__",
    "dist",
    "build",
    ".venv",
    "venv",
    ".next",
    "out",
    "coverage",
    "bin",
    "obj",
    "target",
    "vendor",
}

PYTHON_EXTENSIONS = {".py"}
JS_EXTENSIONS = {".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"}
BRACE_EXTENSIONS = JS_EXTENSIONS | {
    ".cs",
    ".java",
    ".kt",
    ".go",
    ".rs",
    ".c",
    ".cc",
    ".cpp",
    ".h",
    ".hpp",
    ".swift",
    ".php",
    ".dart",
    ".scala",
}
ALL_EXTENSIONS = PYTHON_EXTENSIONS | BRACE_EXTENSIONS

NESTED_PYTHON_FOR = re.compile(
    r"^[ \t]+(?:async[ \t]+)?for[ \t]+\S.*[ \t]in[ \t]", re.M
)
NESTED_BRACE_FOR = re.compile(r"\b(?:for|foreach)\b[ \t]*[(\w$]")
MEMOIZED = re.compile(r"cache|memo", re.IGNORECASE)
# Database calls across ORMs and drivers; ``dict.get`` and ``Array.find`` are not.
QUERY_CALL = re.compile(
    r"\.query\b|\.objects\.|\.execute(?:Async)?\(|\.Query(?:Async)?(?:<[^>\n]*>)?\(|"
    r"\.filter_by\(|\.fetch(?:one|all|many)\(|\bsession\.get\(|"
    r"\.ExecuteReader\(|\.executeQuery\(|\.FromSql\w*\("
)
SELECT_STAR = re.compile(r"SELECT\s+\*\s+FROM", re.IGNORECASE)
EXPENSIVE_CALL = re.compile(
    r"\bjson\.(?:loads|dumps|Marshal|Unmarshal)\(|\bJSON\.(?:parse|stringify)\(|"
    r"\bhashlib\.|\bbase64\.|\bsubprocess\.|\brequests\.\w+\(|(?<![\w.])fetch\(|"
    r"\baxios\.|\bhttp\.(?:Get|Post)\(|\.(?:GetAsync|PostAsync|SendAsync)\(|"
    r"\bJsonSerializer\.|\bnew\s+ObjectMapper\b"
)
PYTHON_BLOCKING_IO = re.compile(r"(?<![\w.])open\(|\btime\.sleep\(")
DOTNET_BLOCKING_IO = re.compile(
    r"\bFile\.(?:Read|Write|Append)All(?:Text|Lines|Bytes)\(|\.Result\b|\.Wait\(\)"
)
SYNC_FS_JS = re.compile(r"(?:readFileSync|writeFileSync|existsSync|readdirSync)\s*\(")


class PerformanceProfiler:
    """Analyzes codebase for performance bottlenecks."""

    def __init__(self, project_dir: str):
        self.project_dir = Path(project_dir)
        self._sources: dict[Path, str] | None = None

    def profile(self) -> PerformanceReport:
        """Run all profiling analyses and combine into a report."""
        print("🔍 Detecting algorithm complexity issues...")
        algo_bottlenecks = self.detect_algorithm_issues()

        print("💾 Detecting memory issues...")
        memory_bottlenecks = self.detect_memory_issues()

        print("⚛️  Detecting React performance issues...")
        react_bottlenecks = self.detect_react_issues()

        print("🗄️  Detecting query issues...")
        query_bottlenecks = self.detect_query_issues()

        print("📁 Detecting synchronous I/O issues...")
        io_bottlenecks = self.detect_io_issues()

        print("🔄 Detecting caching opportunities...")
        cache_bottlenecks = self.detect_caching_opportunities()

        report = PerformanceReport(
            project_dir=str(self.project_dir),
            bottlenecks=algo_bottlenecks
            + memory_bottlenecks
            + react_bottlenecks
            + query_bottlenecks
            + io_bottlenecks
            + cache_bottlenecks,
        )
        report.compute_summary()
        return report

    # ── Rules ────────────────────────────────────────────────────────

    def detect_algorithm_issues(self) -> list[Bottleneck]:
        """Detect nested loops (O(n²)) and recursion without memoization."""
        bottlenecks = []
        for rel_path, suffix, content in self._files(ALL_EXTENSIONS):
            if suffix == ".py":
                for block in self._loops(suffix, content):
                    if NESTED_PYTHON_FOR.search(block.body):
                        bottlenecks.append(
                            self._found(
                                rel_path,
                                block,
                                BottleneckType.ALGORITHM_COMPLEXITY,
                                Severity.HIGH,
                                "Nested loops detected — potential O(n²) complexity",
                                "Up to 10x slower for large datasets",
                            )
                        )
                for name, block in code_blocks.python_functions(content):
                    calls_itself = re.search(
                        rf"(?<![\w.]){re.escape(name)}\s*\(|\bself\.{re.escape(name)}\s*\(",
                        block.body,
                    )
                    memoized = any(
                        MEMOIZED.search(d)
                        for d in code_blocks.decorators_above(content, block.start)
                    )
                    if calls_itself and not memoized:
                        bottlenecks.append(
                            self._found(
                                rel_path,
                                block,
                                BottleneckType.ALGORITHM_COMPLEXITY,
                                Severity.MEDIUM,
                                f"Recursive function '{name}' without memoization",
                                "Exponential time complexity for recursive calls",
                            )
                        )
            else:
                for block in self._loops(suffix, content):
                    if NESTED_BRACE_FOR.search(block.body):
                        bottlenecks.append(
                            self._found(
                                rel_path,
                                block,
                                BottleneckType.ALGORITHM_COMPLEXITY,
                                Severity.HIGH,
                                "Nested for loops detected — potential O(n²) complexity",
                                "Significant slowdown with large arrays",
                            )
                        )
        return bottlenecks[:20]  # Cap per category

    def detect_memory_issues(self) -> list[Bottleneck]:
        """Detect potential memory leak patterns in JavaScript and TypeScript."""
        bottlenecks = []
        add_listener = re.compile(r"addEventListener\s*\(")
        remove_listener = re.compile(r"removeEventListener\s*\(")
        large_array = re.compile(r"new\s+Array\s*\(\s*(\d{6,})\s*\)")
        set_interval = re.compile(r"setInterval\s*\(")
        clear_interval = re.compile(r"clearInterval\s*\(")

        for rel_path, _suffix, content in self._files(JS_EXTENSIONS):
            add_count = len(add_listener.findall(content))
            remove_count = len(remove_listener.findall(content))
            if add_count > remove_count:
                bottlenecks.append(
                    self._at(
                        rel_path,
                        1,
                        BottleneckType.MEMORY_LEAK,
                        Severity.HIGH,
                        f"addEventListener ({add_count}x) without matching removeEventListener ({remove_count}x)",
                        "Memory leak — event listeners accumulate on each render",
                    )
                )

            set_count = len(set_interval.findall(content))
            clear_count = len(clear_interval.findall(content))
            if set_count > clear_count:
                bottlenecks.append(
                    self._at(
                        rel_path,
                        1,
                        BottleneckType.MEMORY_LEAK,
                        Severity.MEDIUM,
                        f"setInterval ({set_count}x) without matching clearInterval ({clear_count}x)",
                        "Timer leak — intervals continue running after component unmount",
                    )
                )

            for m in large_array.finditer(content):
                size = int(m.group(1))
                bottlenecks.append(
                    self._at(
                        rel_path,
                        _line(content, m.start()),
                        BottleneckType.MEMORY_LEAK,
                        Severity.MEDIUM,
                        f"Large array allocation: new Array({size:,})",
                        f"~{size * 8 // 1024} KB pre-allocated memory",
                        m.group(0),
                    )
                )

        return bottlenecks[:20]

    def detect_react_issues(self) -> list[Bottleneck]:
        """Detect React-specific performance issues."""
        bottlenecks = []
        inline_func_in_jsx = re.compile(r"on\w+=\{(?:\s*)\((?:[^)]*)\)\s*=>")
        missing_key = re.compile(r"\.map\s*\([^)]+\)\s*=>\s*(?:<\w+|(?:\(\s*<\w+))")
        has_key = re.compile(r'key\s*=\s*\{|key\s*=\s*"')

        for rel_path, _suffix, content in self._files({".tsx", ".jsx"}):
            for m in inline_func_in_jsx.finditer(content):
                bottlenecks.append(
                    self._at(
                        rel_path,
                        _line(content, m.start()),
                        BottleneckType.UNNECESSARY_RENDERS,
                        Severity.MEDIUM,
                        "Inline arrow function in JSX prop — new function created on every render",
                        "Unnecessary re-renders of child components",
                        m.group(0)[:100],
                    )
                )

            for m in missing_key.finditer(content):
                # The key belongs on the mapped element's opening tag.
                tag_end = re.compile(r"(?<!=)>").search(content, m.end())
                opening = content[m.start() : tag_end.end() if tag_end else None]
                surrounding = content[m.start() : m.start() + 200]
                if not has_key.search(opening):
                    bottlenecks.append(
                        self._at(
                            rel_path,
                            _line(content, m.start()),
                            BottleneckType.UNNECESSARY_RENDERS,
                            Severity.MEDIUM,
                            ".map() rendering elements without 'key' prop",
                            "React cannot optimize re-renders without stable keys",
                            surrounding[:100],
                        )
                    )

        return bottlenecks[:20]

    def detect_query_issues(self) -> list[Bottleneck]:
        """Detect database calls inside loops (N+1) and ``SELECT *``."""
        bottlenecks = []
        for rel_path, suffix, content in self._files(ALL_EXTENSIONS):
            for block in self._loops(suffix, content):
                if QUERY_CALL.search(block.body):
                    bottlenecks.append(
                        self._found(
                            rel_path,
                            block,
                            BottleneckType.N_PLUS_ONE_QUERY,
                            Severity.CRITICAL,
                            "Database query inside a loop — classic N+1 problem",
                            "N database queries instead of 1 — can be 100x slower",
                        )
                    )

            for m in SELECT_STAR.finditer(content):
                bottlenecks.append(
                    self._at(
                        rel_path,
                        _line(content, m.start()),
                        BottleneckType.MISSING_INDEX,
                        Severity.LOW,
                        "SELECT * fetches all columns — use explicit column names",
                        "Fetches unnecessary data, increases memory and network usage",
                        m.group(0),
                    )
                )

        return bottlenecks[:20]

    def detect_io_issues(self) -> list[Bottleneck]:
        """Detect blocking I/O inside async functions, and sync fs calls in Node."""
        bottlenecks = []
        for rel_path, suffix, content in self._files(ALL_EXTENSIONS):
            if suffix == ".py":
                async_blocks = list(code_blocks.python_async_functions(content))
                blocking = PYTHON_BLOCKING_IO
            elif suffix == ".cs":
                async_blocks = list(code_blocks.brace_async_functions(content))
                blocking = DOTNET_BLOCKING_IO
            else:
                async_blocks = []
                blocking = None

            for block in async_blocks:
                if blocking is not None and blocking.search(block.body):
                    bottlenecks.append(
                        self._found(
                            rel_path,
                            block,
                            BottleneckType.SYNCHRONOUS_IO,
                            Severity.HIGH,
                            "Blocking I/O inside an async function blocks the event loop",
                            "Blocks all other async operations during I/O",
                        )
                    )

            if suffix in JS_EXTENSIONS:
                for m in SYNC_FS_JS.finditer(content):
                    bottlenecks.append(
                        self._at(
                            rel_path,
                            _line(content, m.start()),
                            BottleneckType.SYNCHRONOUS_IO,
                            Severity.MEDIUM,
                            f"Synchronous filesystem operation: {m.group(0)[:50]}",
                            "Blocks Node.js event loop — use async alternatives",
                            m.group(0),
                        )
                    )

        return bottlenecks[:20]

    def detect_caching_opportunities(self) -> list[Bottleneck]:
        """Detect network calls and serialization repeated inside a loop."""
        bottlenecks = []
        for rel_path, suffix, content in self._files(ALL_EXTENSIONS):
            for block in self._loops(suffix, content):
                if EXPENSIVE_CALL.search(block.body):
                    bottlenecks.append(
                        self._found(
                            rel_path,
                            block,
                            BottleneckType.MISSING_CACHE,
                            Severity.HIGH,
                            "Expensive operation (network/serialization) repeated in a loop",
                            "Cache results to avoid repeated computation/network calls",
                        )
                    )
        return bottlenecks[:10]

    # ── Helpers ──────────────────────────────────────────────────────

    @staticmethod
    def _loops(suffix: str, content: str) -> list[code_blocks.Block]:
        """The outermost loops of a file: one finding per loop nest."""
        found = (
            code_blocks.python_loops(content)
            if suffix == ".py"
            else code_blocks.brace_loops(content)
        )
        return list(code_blocks.outermost(found))

    @staticmethod
    def _found(
        rel_path: str,
        block: code_blocks.Block,
        kind: BottleneckType,
        severity: Severity,
        description: str,
        impact: str,
    ) -> Bottleneck:
        return Bottleneck(
            bottleneck_id=str(uuid.uuid4())[:8],
            file_path=rel_path,
            line_start=block.start,
            line_end=block.end,
            type=kind,
            severity=severity,
            description=description,
            estimated_impact=impact,
            code_snippet=f"{block.header}\n{block.body}"[:200],
        )

    @staticmethod
    def _at(
        rel_path: str,
        line: int,
        kind: BottleneckType,
        severity: Severity,
        description: str,
        impact: str,
        snippet: str = "",
    ) -> Bottleneck:
        return Bottleneck(
            bottleneck_id=str(uuid.uuid4())[:8],
            file_path=rel_path,
            line_start=line,
            line_end=line,
            type=kind,
            severity=severity,
            description=description,
            estimated_impact=impact,
            code_snippet=snippet,
        )

    def _files(self, extensions: set[str]) -> list[tuple[str, str, str]]:
        """(relative POSIX path, suffix, content) of the readable source files."""
        if self._sources is None:
            self._sources = {
                path: self._read_file_safe(path)
                for path in self._get_source_files(sorted(ALL_EXTENSIONS))
            }
        return [
            (path.relative_to(self.project_dir).as_posix(), path.suffix, content)
            for path, content in self._sources.items()
            if path.suffix in extensions and content
        ]

    def _read_file_safe(self, path: Path) -> str:
        """Read a file safely, returning empty string on error."""
        try:
            return path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return ""

    def _is_ignoreable_path(self, path: Path) -> bool:
        """Check if path should be skipped (judged below the project root)."""
        relative = path.relative_to(self.project_dir)
        return any(part in IGNORE_PATTERNS for part in relative.parts)

    def _get_source_files(self, extensions: list[str]) -> list[Path]:
        """Return source files matching extensions, excluding ignored paths."""
        ext_set = set(extensions)
        return sorted(
            (
                file_path
                for file_path in self.project_dir.rglob("*")
                if file_path.suffix in ext_set
                and file_path.is_file()
                and not self._is_ignoreable_path(file_path)
            ),
            key=lambda path: path.as_posix(),
        )


def _line(content: str, offset: int) -> int:
    return content.count("\n", 0, offset) + 1
