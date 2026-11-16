"""Architecture Analyzer - Scans codebase and extracts architectural structure.

Only the module dependency graph is built: it is the evidence `archify` authors
the architecture map from (`archify/evidence.py`).
"""

import ast
import hashlib
import os
import re
from pathlib import Path

from .models import (
    ArchitectureDiagram,
    DependencyEdge,
    DiagramType,
    EdgeType,
    ModuleNode,
    NodeType,
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
    ".cache",
}

PYTHON_EXTENSIONS = {".py"}
JS_EXTENSIONS = {".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"}
ALL_EXTENSIONS = PYTHON_EXTENSIONS | JS_EXTENSIONS

_JS_IMPORTS = (
    re.compile(r"""import\s+.*?\s+from\s+['"]([^'"]+)['"]"""),
    re.compile(r"""require\s*\(\s*['"]([^'"]+)['"]\s*\)"""),
    re.compile(r"""import\s*\(\s*['"]([^'"]+)['"]\s*\)"""),
)
#: How a JS/TS import names a file: as written, with an extension, or a folder's index.
_JS_SUFFIXES = (
    "",
    *sorted(JS_EXTENSIONS),
    *(f"/index{e}" for e in sorted(JS_EXTENSIONS)),
)


class ArchitectureAnalyzer:
    """Analyzes a project codebase to extract its architecture."""

    def __init__(self, project_dir: str):
        self.project_dir = Path(project_dir)

    def analyze_module_dependencies(self) -> ArchitectureDiagram:
        """Build module dependency graph from imports."""
        nodes: dict[str, ModuleNode] = {}
        edges: list[DependencyEdge] = []
        seen_edges: set[tuple[str, str]] = set()

        source_files = self._get_source_files(list(ALL_EXTENSIONS))

        for file_path in source_files:
            rel_path = file_path.relative_to(self.project_dir).as_posix()
            node_id = self._path_to_id(rel_path)
            lang = "python" if file_path.suffix == ".py" else "javascript"

            try:
                content = file_path.read_text(encoding="utf-8", errors="ignore")
                lines = content.count("\n") + 1
            except OSError:
                lines = 0

            # Determine top-level package
            parts = rel_path.split("/")
            top_package = parts[0] if len(parts) > 1 else rel_path

            nodes[node_id] = ModuleNode(  # one file, one node
                id=node_id,
                name=file_path.stem,
                path=rel_path,
                type=NodeType.MODULE,
                language=lang,
                size_lines=lines,
                description=f"{top_package} module",
            )

            # Extract imports
            if file_path.suffix == ".py":
                imports = self._extract_python_imports(file_path)
            else:
                imports = self._extract_js_imports(file_path)

            for imp in imports:
                target_id = self._import_to_id(imp, file_path)
                if target_id and target_id != node_id:
                    edge_key = (node_id, target_id)
                    if edge_key not in seen_edges:
                        seen_edges.add(edge_key)
                        edges.append(
                            DependencyEdge(
                                source_id=node_id,
                                target_id=target_id,
                                edge_type=EdgeType.IMPORT,
                                label=imp[:40],
                            )
                        )

        # Only keep nodes that have at least one edge
        connected_ids = {e.source_id for e in edges} | {e.target_id for e in edges}
        filtered_nodes = {k: v for k, v in nodes.items() if k in connected_ids}

        # Limit to top 50 most connected nodes
        if len(filtered_nodes) > 50:
            counts: dict[str, int] = {}
            for e in edges:
                counts[e.source_id] = counts.get(e.source_id, 0) + 1
                counts[e.target_id] = counts.get(e.target_id, 0) + 1
            top_ids = set(
                sorted(counts.keys(), key=lambda x: counts[x], reverse=True)[:50]
            )
            filtered_nodes = {k: v for k, v in filtered_nodes.items() if k in top_ids}
            edges = [
                e for e in edges if e.source_id in top_ids and e.target_id in top_ids
            ]

        diagram = ArchitectureDiagram(
            diagram_type=DiagramType.MODULE_DEPENDENCIES,
            title="Module Dependencies",
            nodes=list(filtered_nodes.values()),
            edges=edges,
            metadata={"total_files": len(source_files)},
        )
        return diagram

    def _get_source_files(self, extensions: list[str]) -> list[Path]:
        """Source files with these extensions, outside the ignored folders.

        Only the folders below the project count: a project kept under a
        `build/` or `out/` folder of its own is still read. Ignored folders
        are not entered at all, so a large `node_modules` costs nothing.
        """
        files = []
        ext_set = set(extensions)
        for folder, subdirs, names in os.walk(self.project_dir):
            subdirs[:] = sorted(d for d in subdirs if d not in IGNORE_PATTERNS)
            for name in sorted(names):
                file_path = Path(folder) / name
                if file_path.suffix in ext_set and file_path.is_file():
                    files.append(file_path)
        return files

    def _extract_python_imports(self, file_path: Path) -> list[str]:
        """Imported module names, relative ones with their leading dots."""
        try:
            tree = ast.parse(file_path.read_text(encoding="utf-8", errors="ignore"))
        except (OSError, SyntaxError, ValueError, RecursionError):
            return []
        imports = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                # `from a import b` may name the module `a.b` or a name in `a`:
                # `a.b` is tried first, `a` after (`_import_to_id`).
                prefix = "." * node.level + (f"{node.module}." if node.module else "")
                imports.extend(
                    prefix + alias.name if alias.name != "*" else prefix.rstrip(".")
                    for alias in node.names
                    if alias.name != "*" or node.module
                )
        return imports

    def _extract_js_imports(self, file_path: Path) -> list[str]:
        """Extract import/require paths from JS/TS files."""
        try:
            content = file_path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return []
        return [
            m.group(1) for pattern in _JS_IMPORTS for m in pattern.finditer(content)
        ]

    def _path_to_id(self, rel_path: str) -> str:
        """Convert a relative path to a stable node ID."""
        return hashlib.md5(rel_path.encode(), usedforsecurity=False).hexdigest()[:12]

    def _id_of(self, candidates) -> str:
        """The node id of the first candidate file inside the project, or ""."""
        root = self.project_dir.resolve()
        for candidate in candidates:
            if not candidate.is_file():
                continue
            try:
                rel = candidate.resolve().relative_to(root)
            except ValueError:  # outside the project: not a module of it
                continue
            return self._path_to_id(rel.as_posix())
        return ""

    def _import_to_id(self, import_str: str, from_file: Path) -> str:
        """The node id of the project file an import names, or "" (no edge)."""
        if from_file.suffix in JS_EXTENSIONS:
            # `./x` and `../x` from the file; anything else from the project
            # root (a `baseUrl` import), which a package name never matches.
            base = from_file.parent if import_str.startswith(".") else self.project_dir
            target = os.path.normpath(base / import_str)
            return self._id_of(Path(target + suffix) for suffix in _JS_SUFFIXES)

        # Python: `.a.b` is relative to the file's package, one level up per
        # extra dot; `a.b` is looked up from the project root, longest first.
        level = len(import_str) - len(import_str.lstrip("."))
        parts = [p for p in import_str[level:].split(".") if p]
        root = self.project_dir
        if level:
            root = from_file.parent
            for _ in range(level - 1):
                root = root.parent
        bases = [root / Path(*parts[:i]) for i in range(len(parts), 0, -1)]
        return self._id_of(
            candidate
            for base in bases
            for candidate in (base.with_name(base.name + ".py"), base / "__init__.py")
        )
