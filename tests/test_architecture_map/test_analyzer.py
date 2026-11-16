"""The module graph the architecture map is authored from (`architecture_visualizer.analyzer`).

Each test writes a small real project, then reads the graph back by path.
"""

from __future__ import annotations

from pathlib import Path

from architecture_visualizer.analyzer import ArchitectureAnalyzer


def _write(root: Path, files: dict[str, str]) -> Path:
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return root


def _edges(root: Path) -> set[tuple[str, str]]:
    graph = ArchitectureAnalyzer(str(root)).analyze_module_dependencies()
    by_id = {node.id: node.path for node in graph.nodes}
    return {(by_id[e.source_id], by_id[e.target_id]) for e in graph.edges}


def test_python_imports_absolute_and_relative(tmp_path):
    _write(
        tmp_path,
        {
            "shop/__init__.py": "",
            "shop/models.py": "class Cart: ...\n",
            "shop/pricing/__init__.py": "",
            "shop/pricing/rules.py": "from ..models import Cart\nfrom . import tax\n",
            "shop/pricing/tax.py": "",
            "shop/api.py": "import shop.models\nfrom shop.pricing import rules\nimport os\n",
        },
    )

    assert _edges(tmp_path) == {
        ("shop/pricing/rules.py", "shop/models.py"),
        ("shop/pricing/rules.py", "shop/pricing/tax.py"),
        ("shop/api.py", "shop/models.py"),
        ("shop/api.py", "shop/pricing/rules.py"),
    }


def test_a_from_import_points_at_the_module_or_the_package_it_names(tmp_path):
    _write(
        tmp_path,
        {
            "pkg/__init__.py": "",
            "pkg/a.py": "from .. import pkg\nfrom . import *\nfrom .b import helper\n",
            "pkg/b.py": "",
            "pkg/c.py": "from pkg.b import *\nfrom pkg import nothing_here\n",
        },
    )

    assert _edges(tmp_path) == {
        ("pkg/a.py", "pkg/__init__.py"),
        ("pkg/a.py", "pkg/b.py"),
        ("pkg/c.py", "pkg/b.py"),
        ("pkg/c.py", "pkg/__init__.py"),
    }


def test_javascript_imports_by_path_extension_and_index(tmp_path):
    _write(
        tmp_path,
        {
            "src/app.ts": (
                "import { cart } from './cart.service'\n"
                "import api from '../lib/api'\n"
                "const ui = require('./ui')\n"
                "const lazy = import('./lazy.js')\n"
                "import React from 'react'\n"
                "import shared from 'src/shared'\n"
            ),
            "src/cart.service.ts": "",
            "lib/api.js": "",
            "src/ui/index.tsx": "",
            "src/lazy.js": "",
            "src/shared.ts": "",
        },
    )

    assert _edges(tmp_path) == {
        ("src/app.ts", "src/cart.service.ts"),
        ("src/app.ts", "lib/api.js"),
        ("src/app.ts", "src/ui/index.tsx"),
        ("src/app.ts", "src/lazy.js"),
        ("src/app.ts", "src/shared.ts"),
    }


def test_an_import_leading_outside_the_project_is_not_an_edge(tmp_path):
    outside = tmp_path / "elsewhere.js"
    outside.write_text("", encoding="utf-8")
    project = _write(
        tmp_path / "app", {"src/a.js": "import x from '../../elsewhere'\n"}
    )

    assert _edges(project) == set()


def test_ignored_folders_are_not_read_but_a_project_inside_one_is(tmp_path):
    project = _write(
        tmp_path / "build" / "shop",
        {
            "main.py": "import util\n",
            "README.md": "not a module",
            "util.py": "",
            "node_modules/dep/index.js": "require('../../main')\n",
            ".venv/lib/x.py": "import util\n",
        },
    )

    graph = ArchitectureAnalyzer(str(project)).analyze_module_dependencies()

    assert _edges(project) == {("main.py", "util.py")}
    assert graph.metadata == {"total_files": 2}


def test_a_module_records_its_language_size_and_package(tmp_path):
    _write(
        tmp_path, {"web/a.ts": "import b from './b'\n\n", "web/b.ts": "", "top.py": ""}
    )

    graph = ArchitectureAnalyzer(str(tmp_path)).analyze_module_dependencies()
    nodes = {node.path: node for node in graph.nodes}

    assert set(nodes) == {"web/a.ts", "web/b.ts"}  # an unconnected module is left out
    assert (nodes["web/a.ts"].language, nodes["web/a.ts"].size_lines) == (
        "javascript",
        3,
    )
    assert nodes["web/a.ts"].description == "web module"


def test_a_repeated_import_is_one_edge_and_a_self_import_none(tmp_path):
    _write(
        tmp_path,
        {
            "a.py": "import b\nimport b\nfrom b import x\nimport a\n",
            "b.py": "",
        },
    )

    graph = ArchitectureAnalyzer(str(tmp_path)).analyze_module_dependencies()

    assert len(graph.edges) == 1
    assert graph.edges[0].label == "b"


def test_unparsable_or_unreadable_files_have_no_imports(tmp_path):
    _write(tmp_path, {"broken.py": "def (:\n", "ok.py": "import broken\n"})
    analyzer = ArchitectureAnalyzer(str(tmp_path))

    assert analyzer._extract_python_imports(tmp_path / "broken.py") == []
    assert analyzer._extract_python_imports(tmp_path / "absent.py") == []
    assert analyzer._extract_js_imports(tmp_path / "absent.js") == []
    assert _edges(tmp_path) == {("ok.py", "broken.py")}


def test_a_large_graph_keeps_the_fifty_most_connected_modules(tmp_path):
    files = {"hub.py": "".join(f"import m{i}\n" for i in range(60))}
    files.update({f"m{i}.py": "import core\n" if i < 10 else "" for i in range(60)})
    files["core.py"] = ""
    _write(tmp_path, files)

    graph = ArchitectureAnalyzer(str(tmp_path)).analyze_module_dependencies()
    paths = {node.path for node in graph.nodes}

    assert len(paths) == 50
    assert {"hub.py", "core.py"} <= paths
    assert {f"m{i}.py" for i in range(10)} <= paths
    kept = {node.id for node in graph.nodes}
    assert all(e.source_id in kept and e.target_id in kept for e in graph.edges)


def test_a_module_that_cannot_be_read_still_counts_with_no_lines(tmp_path, monkeypatch):
    _write(tmp_path, {"a.py": "import b\n", "b.py": "x = 1\n"})
    real = Path.read_text

    def read_text(self, *args, **kwargs):
        if self.name == "b.py":
            raise PermissionError("denied")
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text)

    graph = ArchitectureAnalyzer(str(tmp_path)).analyze_module_dependencies()

    assert {n.path: n.size_lines for n in graph.nodes} == {"a.py": 2, "b.py": 0}
