"""The Performance Profiler's rules, its suggestions and its benchmark runner.

Each rule is run on a small project written to disk, in the languages the
profiler reads; the benchmark runner runs a scripted ``subprocess.run`` so the
command line it would start in the project is what is checked.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from performance import benchmark_runner as bench_module
from performance import code_blocks
from performance.benchmark_runner import BenchmarkRunner
from performance.models import (
    Bottleneck,
    BottleneckType,
    OptimizationSuggestion,
    PerformanceReport,
    Severity,
)
from performance.optimizer import PerformanceOptimizer
from performance.profiler import PerformanceProfiler


def _project(root: Path, files: dict[str, str]) -> Path:
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode("utf-8"))
    return root


def _found(bottlenecks: list[Bottleneck]) -> list[tuple[str, int, str]]:
    return [(b.file_path, b.line_start, b.description) for b in bottlenecks]


# ── Algorithm complexity ─────────────────────────────────────────────


class TestAlgorithm:
    def test_one_finding_per_nested_python_loop(self, tmp_path):
        _project(
            tmp_path,
            {
                "pkg/cart.py": (
                    "def triples(items):\n"
                    "    for a in items:\n"
                    "        for b in items:\n"
                    "            for c in items:\n"
                    "                print(a, b, c)\n"
                    "    for x in items:\n"
                    "        print(x)\n"
                    "\n"
                    "for left in range(3):\n"
                    "    pass\n"
                    "for right in range(3):\n"
                    "    pass\n"
                ),
            },
        )

        found = PerformanceProfiler(str(tmp_path)).detect_algorithm_issues()

        assert _found(found) == [
            ("pkg/cart.py", 2, "Nested loops detected — potential O(n²) complexity")
        ]
        assert found[0].line_end == 5
        assert found[0].severity is Severity.HIGH

    def test_recursion_is_judged_on_the_body_only(self, tmp_path):
        _project(
            tmp_path,
            {
                "fib.py": (
                    "import functools\n"
                    "\n"
                    "def fib(n):\n"
                    "    return n if n < 2 else fib(n - 1) + fib(n - 2)\n"
                    "\n"
                    "@functools.lru_cache(maxsize=None)\n"
                    "def cached(n):\n"
                    "    return cached(n - 1) if n else 0\n"
                    "\n"
                    "def helper(\n"
                    "    value,\n"
                    "):\n"
                    "    return value\n"
                    "\n"
                    "helper(1)\n"
                    "\n"
                    "class Tree:\n"
                    "    def walk(self, node): return self.walk(node.left)\n"
                ),
            },
        )

        found = PerformanceProfiler(str(tmp_path)).detect_algorithm_issues()

        assert [(b.line_start, b.description) for b in found] == [
            (3, "Recursive function 'fib' without memoization"),
            (18, "Recursive function 'walk' without memoization"),
        ]

    @pytest.mark.parametrize(
        ("name", "code"),
        [
            (
                "a.ts",
                "for (const a of xs) {\n  for (const b of ys) {\n    f(a, b);\n  }\n}\n",
            ),
            (
                "Orders.cs",
                "foreach (var o in orders) {\n  foreach (var l in o.Lines) { Sum(l); }\n}\n",
            ),
            (
                "main.go",
                "for _, a := range xs {\n\tfor _, b := range ys {\n\t\tf(a, b)\n\t}\n}\n",
            ),
            (
                "lib.rs",
                "for a in xs.iter() {\n    for b in ys.iter() {\n        f(a, b);\n    }\n}\n",
            ),
        ],
    )
    def test_nested_loops_in_brace_languages(self, tmp_path, name, code):
        _project(tmp_path, {name: code})

        [found] = PerformanceProfiler(str(tmp_path)).detect_algorithm_issues()

        assert (found.file_path, found.line_start, found.line_end) == (
            name,
            1,
            5 if name != "Orders.cs" else 3,
        )

    def test_sibling_loops_are_not_nested(self, tmp_path):
        _project(
            tmp_path,
            {
                "a.js": "for (let i = 0; i < 3; i++) { f(i); }\nfor (const x of y) { g(x); }\n"
            },
        )

        assert PerformanceProfiler(str(tmp_path)).detect_algorithm_issues() == []


# ── Memory and React ─────────────────────────────────────────────────


class TestMemoryAndReact:
    def test_listeners_timers_and_big_arrays(self, tmp_path):
        _project(
            tmp_path,
            {
                "leak.js": (
                    "el.addEventListener('click', f);\n"
                    "el.addEventListener('key', g);\n"
                    "el.removeEventListener('click', f);\n"
                    "setInterval(tick, 10);\n"
                    "const buf = new Array(1000000);\n"
                ),
                "clean.ts": "setInterval(t, 1);\nclearInterval(id);\n",
            },
        )

        found = PerformanceProfiler(str(tmp_path)).detect_memory_issues()

        assert _found(found) == [
            (
                "leak.js",
                1,
                "addEventListener (2x) without matching removeEventListener (1x)",
            ),
            ("leak.js", 1, "setInterval (1x) without matching clearInterval (0x)"),
            ("leak.js", 5, "Large array allocation: new Array(1,000,000)"),
        ]
        assert found[2].estimated_impact == "~7812 KB pre-allocated memory"

    def test_inline_handlers_and_missing_keys(self, tmp_path):
        _project(
            tmp_path,
            {
                "List.tsx": (
                    "export const L = () => (\n"
                    "  <ul onClick={(e) => go(e)}>\n"
                    "    {items.map((item) => <li>{item}</li>)}\n"
                    "    {items.map((item) => <li key={item.id}>{item}</li>)}\n"
                    "  </ul>\n"
                    ");\n"
                ),
            },
        )

        found = PerformanceProfiler(str(tmp_path)).detect_react_issues()

        assert [(b.line_start, b.description[:20]) for b in found] == [
            (2, "Inline arrow functio"),
            (3, ".map() rendering ele"),
        ]


# ── Queries, I/O, caching ────────────────────────────────────────────


class TestQueriesIoAndCaching:
    def test_a_query_inside_a_loop_and_not_after_it(self, tmp_path):
        _project(
            tmp_path,
            {
                "views.py": (
                    "for user in users:\n"
                    "    posts = Post.objects.filter(author=user)\n"
                    "for key in keys:\n"
                    "    value = settings.get(key)\n"
                    "rows = session.execute('SELECT * FROM users')\n"
                ),
                "Repo.cs": (
                    "foreach (var id in ids) {\n"
                    "    var u = await conn.QueryAsync<User>(sql, new { id });\n"
                    "}\n"
                ),
            },
        )

        found = PerformanceProfiler(str(tmp_path)).detect_query_issues()

        assert [(b.file_path, b.line_start, b.type) for b in found] == [
            ("Repo.cs", 1, BottleneckType.N_PLUS_ONE_QUERY),
            ("views.py", 1, BottleneckType.N_PLUS_ONE_QUERY),
            ("views.py", 5, BottleneckType.MISSING_INDEX),
        ]

    def test_blocking_io_inside_async_functions(self, tmp_path):
        _project(
            tmp_path,
            {
                "svc.py": (
                    "async def load(path):\n"
                    "    with open(path, encoding='utf-8') as f:\n"
                    "        return f.read()\n"
                    "\n"
                    "async def fine(path):\n"
                    "    async with aiofiles.open(path) as f:\n"
                    "        return await f.read()\n"
                    "\n"
                    "def sync_reader(path):\n"
                    "    return open(path).read()\n"
                ),
                "Svc.cs": (
                    "public async Task<string> Load(string p) {\n"
                    "    return File.ReadAllText(p);\n"
                    "}\n"
                    "public async Task<string> Fine(string p) {\n"
                    "    return await File.ReadAllTextAsync(p);\n"
                    "}\n"
                ),
                "fs.js": "const data = fs.readFileSync(p);\n",
                "Plain.java": "class A { void f() throws Exception { Files.readString(p); } }\n",
            },
        )

        found = PerformanceProfiler(str(tmp_path)).detect_io_issues()

        assert [(b.file_path, b.line_start, b.severity) for b in found] == [
            ("Svc.cs", 1, Severity.HIGH),
            ("fs.js", 1, Severity.MEDIUM),
            ("svc.py", 1, Severity.HIGH),
        ]

    def test_expensive_calls_repeated_in_a_loop(self, tmp_path):
        _project(
            tmp_path,
            {
                "sync.py": (
                    "for item in items:\n"
                    "    payload = json.dumps(item)\n"
                    "result = json.loads(text)\n"
                ),
                "fetch.ts": "for (const u of urls) {\n  await fetch(u);\n}\n",
            },
        )

        found = PerformanceProfiler(str(tmp_path)).detect_caching_opportunities()

        assert [(b.file_path, b.line_start) for b in found] == [
            ("fetch.ts", 1),
            ("sync.py", 1),
        ]


# ── Whole project ────────────────────────────────────────────────────


class TestProfile:
    def test_ignored_folders_are_judged_below_the_project(self, tmp_path):
        # The project itself lives under a folder named like an ignored one.
        root = _project(
            tmp_path / "build" / "shop",
            {
                "app.js": "setInterval(f, 1);\n",
                "node_modules/dep/index.js": "setInterval(f, 1);\n",
                "bin/Debug/gen.cs": "foreach (var a in b) { foreach (var c in d) { } }\n",
            },
        )

        report = PerformanceProfiler(str(root)).profile()

        assert [b.file_path for b in report.bottlenecks] == ["app.js"]
        assert report.summary["total_bottlenecks"] == 1

    def test_an_unreadable_file_is_skipped(self, tmp_path, monkeypatch):
        _project(tmp_path, {"a.js": "setInterval(f, 1);\n"})
        real = Path.read_text

        def locked(self, *args, **kwargs):
            if self.name == "a.js":
                raise PermissionError("locked")
            return real(self, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", locked)

        assert PerformanceProfiler(str(tmp_path)).profile().bottlenecks == []

    def test_each_category_is_capped(self, tmp_path):
        _project(
            tmp_path,
            {f"m{i:02}.js": "setInterval(f, 1);\n" for i in range(25)},
        )

        assert len(PerformanceProfiler(str(tmp_path)).detect_memory_issues()) == 20


class TestCodeBlocks:
    def test_an_inline_body_and_a_comment_in_the_header(self):
        content = "for x in a[1:2]: total += x  # note: here\nprint(total)\n"

        [block] = code_blocks.python_loops(content)

        assert (block.start, block.end) == (1, 1)
        assert "total += x" in block.body

    def test_an_unclosed_brace_runs_to_the_end(self):
        [block] = code_blocks.brace_loops("for (;;) {\n  spin();\n")

        assert block.body == "\n  spin();\n"
        assert block.end == 2

    def test_an_unclosed_signature_runs_to_the_end(self):
        [(name, block)] = code_blocks.python_functions("def broken(a,\n")

        assert name == "broken"
        assert block.body == ""


# ── Suggestions ──────────────────────────────────────────────────────


def _bottleneck(kind: BottleneckType, description: str = "", path: str = "a.js"):
    return Bottleneck("b1", path, 1, 1, kind, Severity.HIGH, description)


class TestOptimizer:
    @pytest.mark.parametrize(
        ("bottleneck", "title", "auto"),
        [
            (
                _bottleneck(BottleneckType.ALGORITHM_COMPLEXITY),
                "Replace nested loops with hashmap lookup",
                False,
            ),
            (
                _bottleneck(BottleneckType.MEMORY_LEAK, "addEventListener (1x)"),
                "Add removeEventListener in cleanup",
                False,
            ),
            (
                _bottleneck(BottleneckType.MEMORY_LEAK, "setInterval (1x)"),
                "Clear interval on unmount",
                True,
            ),
            (
                _bottleneck(BottleneckType.MEMORY_LEAK, "Large array"),
                "Fix memory leak pattern",
                False,
            ),
            (
                _bottleneck(
                    BottleneckType.UNNECESSARY_RENDERS, "Inline arrow function"
                ),
                "Extract handler with useCallback",
                False,
            ),
            (
                _bottleneck(BottleneckType.UNNECESSARY_RENDERS, ".map()"),
                "Add stable key prop in list rendering",
                False,
            ),
            (
                _bottleneck(BottleneckType.N_PLUS_ONE_QUERY),
                "Batch queries with eager loading",
                False,
            ),
            (
                _bottleneck(BottleneckType.MISSING_INDEX),
                "Select specific columns instead of SELECT *",
                False,
            ),
            (
                _bottleneck(BottleneckType.SYNCHRONOUS_IO, path="svc.py"),
                "Use aiofiles for async file I/O",
                False,
            ),
            (
                _bottleneck(BottleneckType.SYNCHRONOUS_IO, path="Svc.cs"),
                "Await the async file and task APIs",
                False,
            ),
            (
                _bottleneck(BottleneckType.SYNCHRONOUS_IO, path="fs.js"),
                "Replace synchronous fs operations with async alternatives",
                False,
            ),
            (
                _bottleneck(BottleneckType.MISSING_CACHE),
                "Cache expensive operations outside the loop",
                False,
            ),
            (
                _bottleneck(BottleneckType.LARGE_BUNDLE),
                "Implement code splitting with dynamic imports",
                False,
            ),
        ],
    )
    def test_each_bottleneck_gets_its_suggestion(self, bottleneck, title, auto):
        report = PerformanceReport(project_dir=".", bottlenecks=[bottleneck])

        [suggestion] = PerformanceOptimizer(".", report).generate_suggestions()

        assert (suggestion.title, suggestion.auto_implementable) == (title, auto)
        assert suggestion.bottleneck_id == "b1"

    def test_a_type_without_a_handler_gets_none(self):
        report = PerformanceReport(
            project_dir=".",
            bottlenecks=[_bottleneck(BottleneckType.BLOCKING_OPERATION)],
        )

        assert PerformanceOptimizer(".", report).generate_suggestions() == []

    def test_only_auto_implementable_suggestions_are_queued(self):
        optimizer = PerformanceOptimizer(".", PerformanceReport(project_dir="."))
        manual = OptimizationSuggestion("s1", "b1", "t", "d")
        auto = OptimizationSuggestion("s2", "b1", "t", "d", auto_implementable=True)

        assert optimizer.implement_suggestion(manual)["status"] == "skipped"
        assert optimizer.implement_suggestion(auto, dry_run=False) == {
            "status": "queued",
            "suggestion_id": "s2",
            "dry_run": False,
            "note": "Will be implemented by the coding agent in a worktree",
        }


# ── Benchmarks ───────────────────────────────────────────────────────


class FakeRun:
    """Stands in for ``subprocess.run``: records the calls, plays a script."""

    def __init__(self, outcome=None):
        self.calls: list[dict] = []
        self.outcome = outcome or subprocess.CompletedProcess([], 1, "3 passed", "warn")

    def __call__(self, cmd, **kwargs):
        self.calls.append({"cmd": cmd, **kwargs})
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome


@pytest.fixture
def which(monkeypatch):
    """Every command is installed under /bin unless listed as missing."""
    missing: set[str] = set()
    monkeypatch.setattr(
        bench_module.shutil,
        "which",
        lambda name: None if name in missing else f"/bin/{name}",
    )
    return missing


@pytest.fixture
def run(monkeypatch, which) -> FakeRun:
    fake = FakeRun()
    monkeypatch.setattr(bench_module.subprocess, "run", fake)
    return fake


class TestBenchmarks:
    @pytest.mark.parametrize(
        ("files", "framework"),
        [
            ({"package.json": '{"devDependencies": {"vitest": "1"}}'}, "vitest"),
            ({"package.json": '{"dependencies": {"jest": "1"}}'}, "jest"),
            ({"package.json": '{"devDependencies": {"mocha": "1"}}'}, "mocha"),
            ({"pyproject.toml": ""}, "pytest"),
            ({"requirements.txt": "pytest==8\n"}, "pytest"),
            ({"requirements.txt": "flask\n"}, "unknown"),
            ({"go.mod": "module x\n"}, "go"),
            ({"Cargo.toml": ""}, "cargo"),
            ({"Shop.sln": ""}, "dotnet"),
            ({"Api.csproj": "<Project/>"}, "dotnet"),
            ({"pom.xml": ""}, "maven"),
            ({"build.gradle.kts": ""}, "gradle"),
            ({"package.json": "not json"}, "unknown"),
            ({"package.json": "[1]"}, "unknown"),
            ({}, "unknown"),
        ],
    )
    def test_the_framework_comes_from_the_manifests(self, tmp_path, files, framework):
        _project(tmp_path, files)

        assert BenchmarkRunner(str(tmp_path)).detect_test_framework() == framework

    def test_the_build_is_reported_and_the_suite_timed(self, tmp_path, run):
        _project(
            tmp_path,
            {
                "package.json": (
                    '{"scripts": {"build": "vite build"}, '
                    '"devDependencies": {"vitest": "1"}}'
                )
            },
        )

        build, tests = BenchmarkRunner(str(tmp_path)).run_benchmarks(timeout_seconds=7)

        assert build.name == "build_check"
        assert build.metadata["build_command"] == "vite build"
        assert tests.name == "vitest_tests"
        assert tests.metadata == {"output_preview": "3 passed" + "warn", "exit_code": 1}
        assert tests.duration_ms >= 0
        [call] = run.calls
        assert call["cmd"] == ["/bin/npx", "vitest", "run", "--reporter=verbose"]
        assert (call["cwd"], call["timeout"]) == (str(tmp_path), 7)
        assert "shell" not in call

    def test_pytest_runs_with_the_first_python_found(self, tmp_path, run, which):
        _project(tmp_path, {"pytest.ini": ""})
        which.update({"python3", "py"})

        [result] = BenchmarkRunner(str(tmp_path)).run_benchmarks()

        assert result.name == "pytest"
        assert run.calls[0]["cmd"][1:] == ["-m", "pytest", "--tb=no", "-q"]
        assert run.calls[0]["cmd"][0] == "/bin/python"

    def test_without_any_python_the_command_is_reported_missing(
        self, tmp_path, run, which
    ):
        _project(tmp_path, {"pytest.ini": ""})
        which.update({"python3", "python", "py"})

        [result] = BenchmarkRunner(str(tmp_path)).run_benchmarks()

        assert result.metadata == {"error": "Command not found: python"}
        assert run.calls == []

    def test_a_suite_that_times_out(self, tmp_path, run):
        _project(tmp_path, {"go.mod": ""})
        run.outcome = subprocess.TimeoutExpired(["go"], 5)

        [result] = BenchmarkRunner(str(tmp_path)).run_benchmarks(timeout_seconds=5)

        assert (result.name, result.duration_ms) == ("go_tests", 5000)
        assert result.metadata == {"error": "Timed out after 5s"}

    def test_a_suite_that_cannot_start(self, tmp_path, run):
        _project(tmp_path, {"Cargo.toml": ""})
        run.outcome = PermissionError("denied")

        [result] = BenchmarkRunner(str(tmp_path)).run_benchmarks()

        assert result.metadata == {"error": "denied"}

    def test_no_build_script_and_no_suite(self, tmp_path, run):
        _project(tmp_path, {"package.json": '{"scripts": {"dev": "vite"}}'})

        assert BenchmarkRunner(str(tmp_path)).run_benchmarks() == []
        assert run.calls == []

    def test_the_metadata_reaches_the_report(self):
        report = PerformanceReport(project_dir=".")
        report.benchmarks = [bench_module.BenchmarkResult("x", 1, metadata={"a": 1})]

        assert report.to_dict()["benchmarks"][0]["metadata"] == {"a": 1}
