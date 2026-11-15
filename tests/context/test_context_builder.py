"""The task context builder on real project trees.

``ContextBuilder`` is what the PR review runners (GitHub, Azure DevOps) ask for
the files a task touches, the patterns around them and the dependency graph
of the project. These tests build small projects on disk, in several stacks,
and read what comes back.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import context.builder as builder_module
import context.memory_hints as memory_hints
import pytest
from context import (
    CodeSearcher,
    ContextBuilder,
    FileCategorizer,
    FileMatch,
    KeywordExtractor,
    PatternDiscoverer,
    ServiceMatcher,
    TaskContext,
    load_context,
    save_context,
    serialize_context,
)
from context.dependency_graph import (
    DependencyAnalyzer,
    DependencyGraph,
    DependencyGraphBuilder,
    DependencyGraphCache,
    DependencyNode,
)
from context.dependency_graph.analyzer import CircularDependency


def _write(root: Path, rel: str, text: str) -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


@pytest.fixture
def shop(tmp_path: Path) -> Path:
    """A two-service project: a FastAPI backend and a TypeScript frontend."""
    root = tmp_path / "shop"
    _write(
        root,
        "api/orders.py",
        "from api import models\n\ndef create_order(cart):\n"
        "    # order total of the order lines\n    order = models.Order(cart)\n"
        "    return order\n",
    )
    _write(
        root,
        "api/models.py",
        "class Order:\n    def __init__(self, cart):\n        self.cart = cart\n",
    )
    _write(root, "api/__init__.py", "")
    _write(
        root,
        "api/test_orders.py",
        "from api.orders import create_order\n"
        "def test_order():\n    assert create_order([])\n",
    )
    _write(root, "api/node_modules/lib/order.py", "order = 1\n")
    _write(
        root,
        "web/src/cart.ts",
        "import { total } from './order';\nexport const cart = total;\n",
    )
    _write(root, "web/src/order.ts", "export function total() { return 'order'; }\n")
    _write(root, "web/SERVICE_CONTEXT.md", "# Web\nThe storefront.\n")
    index = {
        "services": {
            "api": {
                "path": "api",
                "type": "backend",
                "language": "python",
                "framework": "fastapi",
                "entry_point": "orders.py",
            },
            "web": {
                "path": "web",
                "type": "frontend",
                "language": "typescript",
                "framework": None,
            },
        }
    }
    _write(root, ".workpilot/project_index.json", json.dumps(index))
    return root


@pytest.fixture(autouse=True)
def _no_vault(monkeypatch):
    """No shared brain unless a test says so."""
    monkeypatch.setattr(builder_module, "is_memory_enabled", lambda: False)
    monkeypatch.setattr(memory_hints, "is_memory_enabled", lambda: False)


# ── ContextBuilder ───────────────────────────────────────────────────


class TestBuildContext:
    def test_files_patterns_and_services_for_a_task(self, shop):
        context = ContextBuilder(shop).build_context("Add an order endpoint to the api")

        assert context.scoped_services == ["api"]
        modify = [f["path"] for f in context.files_to_modify]
        reference = [f["path"] for f in context.files_to_reference]
        assert "api/orders.py" in modify
        assert "api/test_orders.py" in reference
        assert not any("node_modules" in p for p in modify + reference)
        assert context.service_contexts["api"] == {
            "source": "generated",
            "language": "python",
            "framework": "fastapi",
            "type": "backend",
            "entry_point": "orders.py",
            "key_directories": {},
        }
        assert context.patterns_discovered["order_pattern"].startswith(
            "From api/test_orders.py:"
        )
        assert context.graph_hints == []

    def test_the_dependency_graph_enriches_the_context(self, shop):
        context = ContextBuilder(shop).build_context(
            "Fix order", services=["api"], keywords=["order"]
        )

        hints = context.dependency_hints
        assert "api/models.py" in hints["related_files"]
        assert hints["circular_dependencies"] == []
        assert hints["graph_nodes"] == 6
        assert (shop / ".workpilot" / "dependency_graph.json").exists()

    def test_a_service_context_file_is_read(self, shop):
        context = ContextBuilder(shop).build_context(
            "cart", services=["web"], keywords=["total"]
        )

        assert context.service_contexts["web"] == {
            "source": "SERVICE_CONTEXT.md",
            "content": "# Web\nThe storefront.\n",
        }
        assert [f["path"] for f in context.files_to_reference] == [
            "web/src/cart.ts",
            "web/src/order.ts",
        ] or [f["path"] for f in context.files_to_reference] == [
            "web/src/order.ts",
            "web/src/cart.ts",
        ]

    def test_unknown_services_are_skipped(self, shop):
        context = ContextBuilder(shop).build_context(
            "x", services=["ghost"], keywords=["order"]
        )

        assert context.files_to_modify == []
        assert context.service_contexts == {}
        assert context.dependency_hints == {}

    def test_an_absolute_service_path(self, shop):
        index = {"services": {"api": {"path": str(shop / "api"), "type": "backend"}}}

        context = ContextBuilder(shop, project_index=index).build_context(
            "update order", keywords=["order"]
        )

        assert context.scoped_services == ["api"]
        assert context.files_to_modify

    def test_hints_from_the_shared_brain(self, shop, monkeypatch):
        asked = []

        async def hints(task, project):
            asked.append((task, project))
            return [{"content": "orders broke once", "score": 0.9}]

        monkeypatch.setattr(builder_module, "is_memory_enabled", lambda: True)
        monkeypatch.setattr(builder_module, "fetch_graph_hints", hints)

        context = ContextBuilder(shop).build_context("order total")

        assert context.graph_hints == [{"content": "orders broke once", "score": 0.9}]
        assert asked == [("order total", str(shop.resolve()))]

    def test_a_failing_brain_is_not_fatal(self, shop, monkeypatch):
        async def broken(*_a):
            raise RuntimeError("vault locked")

        monkeypatch.setattr(builder_module, "is_memory_enabled", lambda: True)
        monkeypatch.setattr(builder_module, "fetch_graph_hints", broken)

        assert ContextBuilder(shop).build_context("order").graph_hints == []

    async def test_inside_an_event_loop_the_sync_call_skips_hints(
        self, shop, monkeypatch
    ):
        monkeypatch.setattr(builder_module, "is_memory_enabled", lambda: True)
        monkeypatch.setattr(
            builder_module,
            "fetch_graph_hints",
            lambda *_a: pytest.fail("no nested event loop"),
        )

        assert ContextBuilder(shop).build_context("order").graph_hints == []

    async def test_the_async_version_awaits_the_hints(self, shop, monkeypatch):
        async def hints(task, project):
            return [{"content": task}]

        monkeypatch.setattr(builder_module, "fetch_graph_hints", hints)

        context = await ContextBuilder(shop).build_context_async(
            "update the order total"
        )

        assert context.graph_hints == [{"content": "update the order total"}]
        # Nothing names a service: the first backend and the first frontend.
        assert context.scoped_services == ["api", "web"]
        assert "api/orders.py" in [f["path"] for f in context.files_to_modify]
        assert context.service_contexts["api"]["framework"] == "fastapi"

    async def test_the_async_version_without_hints(self, shop):
        context = await ContextBuilder(shop).build_context_async(
            "x",
            services=["ghost", "web"],
            keywords=["total"],
            include_graph_hints=False,
        )

        assert context.graph_hints == []
        assert list(context.service_contexts) == ["web"]
        assert context.service_contexts["web"]["source"] == "SERVICE_CONTEXT.md"
        abs_index = {"services": {"web": {"path": str(shop / "web")}}}
        again = await ContextBuilder(shop, abs_index).build_context_async(
            "total", include_graph_hints=False
        )
        assert again.scoped_services == ["web"]

    def test_a_broken_dependency_graph_is_not_fatal(self, shop, monkeypatch):
        builder = ContextBuilder(shop)

        def boom(**_k):
            raise OSError("disk")

        monkeypatch.setattr(builder._dep_cache, "get_or_build", boom)

        assert builder._build_dependency_hints(["api/orders.py"]) == {}

    def test_an_empty_graph_gives_no_hints(self, tmp_path):
        builder = ContextBuilder(tmp_path, project_index={"services": {}})

        assert builder._build_dependency_hints(["a.py"]) == {}


class TestProjectIndex:
    def test_a_corrupt_index_is_rebuilt(self, shop, monkeypatch):
        (shop / ".workpilot" / "project_index.json").write_text(
            "{ nope", encoding="utf-8"
        )
        import analysis.analyzer as analyzer

        monkeypatch.setattr(
            analyzer, "analyze_project", lambda project: {"services": {}, "p": 1}
        )

        assert ContextBuilder(shop).project_index == {"services": {}, "p": 1}

    def test_without_an_index_the_project_is_analysed(self, tmp_path, monkeypatch):
        import analysis.analyzer as analyzer

        seen = []
        monkeypatch.setattr(
            analyzer,
            "analyze_project",
            lambda project: seen.append(project) or {"services": {}},
        )

        ContextBuilder(tmp_path)

        assert seen == [tmp_path.resolve()]


# ── Components ───────────────────────────────────────────────────────


class TestKeywords:
    def test_stopwords_short_words_and_duplicates_go(self):
        assert KeywordExtractor.extract_keywords(
            "Add a new login_form to the Login page, then fix login"
        ) == ["login_form", "login", "page"]

    def test_the_count_is_capped(self):
        assert (
            len(
                KeywordExtractor.extract_keywords(
                    " ".join(f"word{i}" for i in range(30)), max_keywords=4
                )
            )
            == 4
        )


class TestServiceMatcher:
    def test_scores_name_type_and_framework(self):
        matcher = ServiceMatcher(
            {
                "services": {
                    "billing": {"type": "backend", "framework": "django"},
                    "jobs": {"type": "worker", "framework": None},
                    "crawler": {"type": "scraper"},
                    "app": {"type": "frontend", "framework": "React"},
                }
            }
        )

        assert matcher.suggest_services("billing api") == ["billing"]
        assert matcher.suggest_services("a background job") == ["jobs"]
        assert matcher.suggest_services("crawl the shop") == ["crawler"]
        assert matcher.suggest_services("react button") == ["app"]
        assert matcher.suggest_services("django endpoint") == ["billing"]

    def test_the_default_is_the_first_backend_and_the_first_frontend(self):
        matcher = ServiceMatcher(
            {
                "services": {
                    "api": {"type": "backend"},
                    "admin-api": {"type": "backend"},
                    "web": {"type": "frontend"},
                    "mobile": {"type": "frontend"},
                }
            }
        )

        assert matcher.suggest_services("refactor") == ["api", "web"]

    def test_without_typed_services_the_first_two(self):
        matcher = ServiceMatcher({"services": {"a": {}, "b": {}, "c": {}}})

        assert matcher.suggest_services("rewrite") == ["a", "b"]


class TestCodeSearch:
    @pytest.mark.parametrize(
        "rel",
        [
            "Api/Controllers/OrderController.cs",
            "app/src/main/java/shop/OrderService.java",
            "app/src/main/kotlin/OrderRepo.kt",
            "ios/Order.swift",
            "lib/order.dart",
            "native/order.cpp",
        ],
    )
    def test_every_stack_is_searched(self, tmp_path, rel):
        _write(tmp_path, rel, "// order handling\n")

        matches = CodeSearcher(tmp_path).search_service(tmp_path, "svc", ["order"])

        assert [m.path for m in matches] == [rel]

    def test_build_outputs_are_skipped(self, tmp_path):
        _write(tmp_path, "src/Order.cs", "class Order {}")
        _write(tmp_path, "src/obj/Debug/Order.g.cs", "class Order {}")
        _write(tmp_path, ".workpilot/specs/order.py", "order = 1")

        matches = CodeSearcher(tmp_path).search_service(tmp_path, "svc", ["order"])

        assert [m.path for m in matches] == ["src/Order.cs"]

    def test_scores_lines_and_caps(self, tmp_path):
        _write(tmp_path, "a.py", "\n".join(["order"] * 15 + ["cart"]))

        (match,) = CodeSearcher(tmp_path).search_service(
            tmp_path, "svc", ["order", "cart"]
        )

        assert match.relevance_score == 11
        assert match.reason == "Contains: order, cart"
        assert match.matching_lines == [
            (1, "order"),
            (2, "order"),
            (3, "order"),
            (16, "cart"),
        ]

    def test_a_missing_service_or_unreadable_file(self, tmp_path, monkeypatch):
        searcher = CodeSearcher(tmp_path)
        assert searcher.search_service(tmp_path / "ghost", "svc", ["x"]) == []

        _write(tmp_path, "a.py", "order")
        real = Path.read_text

        def unreadable(self, *a, **k):
            if self.name == "a.py":
                raise PermissionError("locked")
            return real(self, *a, **k)

        monkeypatch.setattr(Path, "read_text", unreadable)
        assert searcher.search_service(tmp_path, "svc", ["order"]) == []


class TestCategorizer:
    def test_tests_examples_and_configs_are_references(self):
        matches = [
            FileMatch("src/order.py", "api", "Contains: order", 8),
            FileMatch("tests/test_order.py", "api", "Contains: order", 9),
            FileMatch("examples/order.py", "api", "Contains: order", 9),
            FileMatch("config/order.py", "api", "Contains: order", 2),
            FileMatch("src/low.py", "api", "Contains: order", 1),
        ]

        modify, reference = FileCategorizer().categorize_matches(matches, "fix order")

        assert [m.path for m in modify] == ["src/order.py"]
        assert modify[0].reason == "Likely to modify: Contains: order"
        assert [m.reason.split(":")[0] for m in reference] == [
            "Reference pattern",
            "Reference pattern",
            "Reference pattern",
            "Related",
        ]

    def test_a_question_modifies_nothing(self):
        modify, reference = FileCategorizer().categorize_matches(
            [FileMatch("src/order.py", "api", "r", 8)], "explain order"
        )

        assert modify == []
        assert len(reference) == 1


class TestPatterns:
    def test_a_snippet_around_the_first_hit(self, tmp_path):
        _write(
            tmp_path,
            "a.py",
            "\n".join(f"line {i}" for i in range(10)) + "\ndef order():\n    pass\n",
        )

        patterns = PatternDiscoverer(tmp_path).discover_patterns(
            [FileMatch("a.py", "s", "r"), FileMatch("missing.py", "s", "r")],
            ["order", "absent"],
        )

        assert patterns == {
            "order_pattern": "From a.py:\nline 7\nline 8\nline 9\ndef order():\n"
            "    pass\n"
        }


class TestSerialization:
    def test_save_and_load(self, tmp_path):
        context = TaskContext(
            task_description="t",
            scoped_services=["api"],
            files_to_modify=[{"path": "a.py"}],
            files_to_reference=[],
            patterns_discovered={"k": "v"},
            service_contexts={},
            graph_hints=[{"content": "h"}],
        )
        target = tmp_path / "out" / "context.json"

        save_context(context, target)

        assert (
            load_context(target)
            == serialize_context(context)
            == {
                "task_description": "t",
                "scoped_services": ["api"],
                "files_to_modify": [{"path": "a.py"}],
                "files_to_reference": [],
                "patterns": {"k": "v"},
                "service_contexts": {},
                "graph_hints": [{"content": "h"}],
            }
        )


class TestMemoryHints:
    async def test_no_vault_no_hints(self):
        assert await memory_hints.fetch_graph_hints("q", "/p") == []

    async def test_the_vault_is_asked(self, monkeypatch):
        async def hints(query, project_id, max_results):
            return [{"content": f"{query}@{project_id}#{max_results}"}]

        monkeypatch.setattr(memory_hints, "is_memory_enabled", lambda: True)
        monkeypatch.setattr(memory_hints, "get_graph_hints", hints)

        assert await memory_hints.fetch_graph_hints("q", "/p", 3) == [
            {"content": "q@/p#3"}
        ]


# ── Dependency graph ─────────────────────────────────────────────────


@pytest.fixture
def graph_project(tmp_path: Path) -> Path:
    root = tmp_path / "build" / "app"  # the checkout's own folder is "build"
    _write(root, "pkg/__init__.py", "")
    _write(
        root,
        "pkg/a.py",
        "import pkg.b\nfrom . import c\nfrom .c import f\n"
        "import requests\n\ndef run():\n    def inner():\n        pass\n"
        "class Thing:\n    pass\n",
    )
    _write(root, "pkg/b.py", "from pkg import a\n")
    _write(root, "pkg/c.py", "def f():\n    return 1\n")
    _write(root, "pkg/broken.py", "def (:\n")
    _write(
        root,
        "web/src/index.ts",
        "import { x } from './lib/x';\n"
        "import y from '../shared/y';\nexport * from './lib';\n",
    )
    _write(root, "web/src/lib/x.ts", "export const x = 1;\nconst z = require('./z');\n")
    _write(root, "web/src/lib/z.js", "module.exports = 1;\n")
    _write(root, "web/src/lib/index.tsx", "export default function Lib() {}\n")
    _write(
        root,
        "web/shared/y.jsx",
        "import { x } from '../src/lib/x';\n"
        "import '../../../outside';\nimport 'react';\n"
        "export async function y() {}\n",
    )
    _write(root, "web/node_modules/dep/index.js", "module.exports = 1;\n")
    _write(root, "README.md", "not code\n")
    return root


class TestDependencyGraph:
    def test_python_and_js_edges(self, graph_project):
        graph = DependencyGraphBuilder(graph_project).build()

        assert graph.file_count == 10
        a = graph.get_node("pkg/a.py")
        assert a.language == "python"
        assert a.imports == ["pkg/b.py", "pkg/c.py"]
        assert a.export_symbols == ["run", "Thing"]
        assert graph.get_node("pkg/broken.py").imports == []
        index = graph.get_node("web/src/index.ts")
        assert index.language == "typescript"
        assert index.imports == [
            "web/src/lib/x.ts",
            "web/shared/y.jsx",
            "web/src/lib/index.tsx",
        ]
        assert graph.get_node("web/src/lib/x.ts").imports == ["web/src/lib/z.js"]
        y = graph.get_node("web/shared/y.jsx")
        assert (y.language, y.imports, y.export_symbols) == (
            "javascript",
            ["web/src/lib/x.ts"],
            ["y"],
        )
        assert graph.get_node("web/src/lib/x.ts").imported_by == [
            "web/shared/y.jsx",
            "web/src/index.ts",
        ] or graph.get_node("web/src/lib/x.ts").imported_by == [
            "web/src/index.ts",
            "web/shared/y.jsx",
        ]

    def test_traversal_depths(self, graph_project):
        graph = DependencyGraphBuilder(graph_project).build()

        assert sorted(graph.get_dependencies("web/src/index.ts", depth=2)) == [
            "web/shared/y.jsx",
            "web/src/lib/index.tsx",
            "web/src/lib/x.ts",
            "web/src/lib/z.js",
        ]
        assert sorted(graph.get_dependents("web/src/lib/z.js", depth=2)) == [
            "web/shared/y.jsx",
            "web/src/index.ts",
            "web/src/lib/x.ts",
        ]
        assert graph.get_dependents("nope.py") == []

    def test_round_trip(self, graph_project):
        graph = DependencyGraphBuilder(graph_project).build()

        again = DependencyGraph.from_dict(json.loads(json.dumps(graph.to_dict())))

        assert again.to_dict() == graph.to_dict()

    def test_the_file_cap(self, graph_project, monkeypatch):
        import context.dependency_graph.builder as graph_builder

        monkeypatch.setattr(graph_builder, "_MAX_FILES", 2)

        assert DependencyGraphBuilder(graph_project).build().file_count == 2

    def test_an_unreadable_js_file_keeps_its_node(self, graph_project, monkeypatch):
        real = Path.read_text

        def locked(self, *a, **k):
            if self.name == "z.js":
                raise PermissionError("locked")
            return real(self, *a, **k)

        monkeypatch.setattr(Path, "read_text", locked)

        node = (
            DependencyGraphBuilder(graph_project).build().get_node("web/src/lib/z.js")
        )
        assert node.imports == []

    def test_js_specifiers_from_the_root_and_to_nothing(self, graph_project):
        builder = DependencyGraphBuilder(graph_project)

        assert builder._resolve_js_import("./web/src/lib/x", ".") == (
            "web/src/lib/x.ts"
        )
        assert builder._resolve_js_import("./web/src/lib", "") == (
            "web/src/lib/index.tsx"
        )
        assert builder._resolve_js_import("./missing", "web") is None


class TestAnalyzer:
    def test_cycles_orphans_and_neighbours(self, graph_project):
        analyzer = DependencyAnalyzer(DependencyGraphBuilder(graph_project).build())

        insights = analyzer.analyze()

        assert [c.cycle for c in insights.circular_dependencies] == [
            ["pkg/a.py", "pkg/b.py"]
        ]
        assert str(insights.circular_dependencies[0]) == (
            "pkg/a.py → pkg/b.py → pkg/a.py"
        )
        assert insights.orphan_modules == []
        assert insights.total_nodes == 10
        assert insights.to_dict()["circular_dependencies"] == [["pkg/a.py", "pkg/b.py"]]
        related = analyzer.get_related_files(["web/src/lib/x.ts"])
        assert related[0] in {"web/src/index.ts", "web/shared/y.jsx"}
        assert "web/src/lib/z.js" in related

    def test_an_orphan_with_imports(self):
        graph = DependencyGraph()
        graph.add_node(DependencyNode("tool.py", imports=["lib.py"]))
        graph.add_node(DependencyNode("lib.py", imported_by=["tool.py"]))
        graph.add_node(DependencyNode("main.py", imports=["lib.py"]))

        assert DependencyAnalyzer(graph).detect_orphans() == ["tool.py"]

    def test_coupling_hotspots(self):
        graph = DependencyGraph()
        many = [f"m{i}.py" for i in range(20)]
        graph.add_node(DependencyNode("god.py", imports=many, imported_by=many[:15]))
        graph.add_node(DependencyNode("hub.py", imported_by=many[:15]))
        graph.add_node(DependencyNode("fan.py", imports=many))
        graph.add_node(DependencyNode("calm.py"))

        assert [
            (e["path"], e["coupling_type"])
            for e in DependencyAnalyzer(graph).detect_high_coupling()
        ] == [
            ("god.py", "god_module"),
            ("fan.py", "high_fan_out"),
            ("hub.py", "high_fan_in"),
        ]

    def test_cycle_reporting_is_capped(self):
        graph = DependencyGraph()
        for i in range(12):
            graph.add_node(DependencyNode(f"a{i}", imports=[f"b{i}", "missing"]))
            graph.add_node(DependencyNode(f"b{i}", imports=[f"a{i}"]))
        analyzer = DependencyAnalyzer(graph)
        analyzer.MAX_CYCLES_REPORTED = 3

        assert analyzer.detect_cycles() == [
            CircularDependency([f"a{i}", f"b{i}"]) for i in range(3)
        ]


class TestCache:
    def test_reused_until_a_file_changes(self, graph_project, monkeypatch):
        cache = DependencyGraphCache(graph_project)
        first = cache.get_or_build()
        assert first.file_count == 10

        import context.dependency_graph.cache as cache_module

        monkeypatch.setattr(
            cache_module.DependencyGraphBuilder,
            "build",
            lambda self: pytest.fail("the cache should answer"),
        )
        assert cache.get_or_build().to_dict() == first.to_dict()

        monkeypatch.undo()
        _write(graph_project, "pkg/d.py", "import pkg.c\n")
        assert cache.get_or_build().file_count == 11
        assert cache.get_or_build(force_rebuild=True).file_count == 11

    def test_invalidate_and_a_corrupt_cache(self, graph_project):
        cache = DependencyGraphCache(graph_project)
        cache.invalidate()  # nothing to remove yet
        cache.get_or_build()
        cache_file = graph_project / ".workpilot" / "dependency_graph.json"
        cache_file.write_text("{ nope", encoding="utf-8")

        assert cache.get_or_build().file_count == 10
        cache.invalidate()
        assert not cache_file.exists()

    def test_a_failed_write_still_returns_the_graph(self, graph_project, monkeypatch):
        import context.dependency_graph.cache as cache_module

        def readonly(*_a, **_k):
            raise PermissionError("read-only")

        monkeypatch.setattr(cache_module, "open", readonly, raising=False)

        assert DependencyGraphCache(graph_project).get_or_build().file_count == 10


def test_asyncio_is_left_without_a_running_loop():
    # build_context made its own loop and closed it: none is left running.
    with pytest.raises(RuntimeError):
        asyncio.get_running_loop()
