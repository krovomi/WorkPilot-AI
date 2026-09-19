"""
Circular Dependency Detector
==============================

Detects circular dependencies and bounded context violations
using graph traversal algorithms.
"""

from __future__ import annotations

import fnmatch
from collections import defaultdict

from .models import (
    ArchitectureConfig,
    ArchitectureViolation,
    BoundedContextConfig,
    ImportGraph,
)


class CircularDependencyDetector:
    """Detects circular dependencies in an import graph."""

    def __init__(self, graph: ImportGraph, config: ArchitectureConfig):
        self.graph = graph
        self.config = config

    def detect_cycles(self) -> list[list[str]]:
        """
        Detect circular dependency cycles using iterative DFS.

        Returns a list of cycles, where each cycle is a list of
        file/module paths forming a loop (e.g., [A, B, C] means A->B->C->A).

        Only reports cycles involving actual project files (not external packages).
        """
        adjacency = self._build_file_adjacency()
        if not adjacency:
            return []

        visited: set[str] = set()
        on_stack: set[str] = set()
        cycles: list[list[str]] = []
        # Limit to prevent pathological cases
        max_cycles = 50

        for start_node in adjacency:
            if start_node in visited or len(cycles) >= max_cycles:
                continue
            self._dfs_find_cycles(
                start_node, adjacency, visited, on_stack, [], cycles, max_cycles
            )

        return self._deduplicate_cycles(cycles)

    def check_bounded_context_violations(self) -> list[ArchitectureViolation]:
        """
        Check for imports that cross bounded context boundaries
        without going through allowed shared modules.
        """
        if not self.config.bounded_contexts:
            return []

        violations = []
        context_map = self._build_context_map()

        for edge in self.graph.edges:
            source_ctx = self._get_context_for_file(edge.source_file, context_map)
            if not source_ctx:
                continue

            # Try to determine the target's context
            target_ctx = self._get_context_for_import(
                edge.target_module, edge.source_file, context_map
            )
            if not target_ctx:
                continue

            # Same context is always OK
            if source_ctx.name == target_ctx.name:
                continue

            # Check if the target context is in the allowed list
            if target_ctx.name in source_ctx.allowed_cross_context_imports:
                continue

            # Check if the target matches any "shared" pattern
            if self._is_shared_import(edge.target_module, source_ctx):
                continue

            severity = "warning" if self.config.inferred else "error"
            violations.append(
                ArchitectureViolation(
                    type="bounded_context",
                    severity=severity,
                    file=edge.source_file,
                    line=edge.line,
                    import_target=edge.target_module,
                    rule=(
                        f"Context '{source_ctx.name}' cannot import from "
                        f"context '{target_ctx.name}'"
                    ),
                    description=(
                        f"File '{edge.source_file}' in context '{source_ctx.name}' "
                        f"imports '{edge.target_module}' from context '{target_ctx.name}'. "
                        f"Cross-context imports are restricted."
                    ),
                    suggestion=(
                        f"Use an interface, event, or shared module to communicate "
                        f"between '{source_ctx.name}' and '{target_ctx.name}' contexts"
                    ),
                )
            )

        return violations

    def get_cycle_violations(self) -> list[ArchitectureViolation]:
        """
        Detect circular dependencies and return as ArchitectureViolation objects.
        """
        if not self.config.rules.no_circular_dependencies:
            return []

        cycles = self.detect_cycles()
        violations = []
        severity = "warning" if self.config.inferred else "error"

        for cycle in cycles:
            cycle_str = " -> ".join(cycle) + f" -> {cycle[0]}"
            violations.append(
                ArchitectureViolation(
                    type="circular_dependency",
                    severity=severity,
                    file=cycle[0],
                    line=None,
                    import_target=cycle[1] if len(cycle) > 1 else cycle[0],
                    rule="No circular dependencies allowed",
                    description=f"Circular dependency detected: {cycle_str}",
                    suggestion=(
                        "Break this cycle by extracting a shared interface or "
                        "using dependency inversion (depend on abstractions, not concretions)"
                    ),
                )
            )

        return violations

    # ---------------------------------------------------------------------------
    # DFS cycle detection
    # ---------------------------------------------------------------------------

    def _dfs_find_cycles(
        self,
        node: str,
        adjacency: dict[str, set[str]],
        visited: set[str],
        on_stack: set[str],
        path: list[str],
        cycles: list[list[str]],
        max_cycles: int,
    ) -> None:
        """Iterative DFS to find cycles."""
        # Use an explicit stack to avoid recursion depth issues
        stack: list[tuple[str, list[str], bool]] = [(node, [], False)]

        while stack and len(cycles) < max_cycles:
            current, current_path, is_backtrack = stack.pop()

            if is_backtrack:
                on_stack.discard(current)
                continue

            if current in on_stack:
                # Found a cycle — extract it
                try:
                    cycle_start = current_path.index(current)
                    cycle = current_path[cycle_start:]
                    if len(cycle) >= 2:
                        cycles.append(cycle)
                except ValueError:
                    pass
                continue

            if current in visited:
                continue

            visited.add(current)
            on_stack.add(current)
            new_path = current_path + [current]

            # Push backtrack marker
            stack.append((current, new_path, True))

            # Push neighbors
            for neighbor in adjacency.get(current, set()):
                if neighbor in on_stack:
                    # Cycle found
                    try:
                        cycle_start = new_path.index(neighbor)
                        cycle = new_path[cycle_start:]
                        if len(cycle) >= 2:
                            cycles.append(cycle)
                    except ValueError:
                        pass
                elif neighbor not in visited:
                    stack.append((neighbor, new_path, False))

    def _build_file_adjacency(self) -> dict[str, set[str]]:
        """
        Build file-level adjacency from the import graph.

        Only includes edges where both source and target are project files
        (resolves import modules to file paths where possible).
        """
        all_files = self.graph.get_all_sources()
        suffix_index = self._build_suffix_index(all_files)
        adjacency: dict[str, set[str]] = defaultdict(set)

        for edge in self.graph.edges:
            # Try to match the import target to a known source file
            target_file = self._resolve_to_file(
                edge.target_module, all_files, suffix_index
            )
            if target_file and target_file != edge.source_file:
                adjacency[edge.source_file].add(target_file)

        return dict(adjacency)

    @staticmethod
    def _build_suffix_index(known_files: set[str]) -> dict[str, str]:
        """Every path suffix of every known file, mapped to that file.

        `_resolve_to_file` answers "does some known file end with this path?",
        and used to answer it by scanning all of them — per candidate, per
        edge. On this repository that is ~50 000 edges × 14 candidates × ~7 000
        files, and the Architecture page spent over a minute per scan inside
        that loop. The same question against a prepared index is a dict
        lookup, and the index costs one pass over the files: a path has a
        handful of segments, so it contributes a handful of suffixes.

        Where several files share a suffix, the shortest path wins, then
        alphabetical order. The scan it replaces returned whichever one a set
        happened to iterate first, so this is also the point where the answer
        stops depending on hash order.
        """
        index: dict[str, str] = {}
        for known in sorted(known_files, key=lambda k: (k.count("/"), k)):
            index.setdefault(known, known)
            # "a/b/c.ts" is reachable as "b/c.ts" and "c.ts" — the suffixes the
            # old `known.endswith("/" + candidate)` test accepted, and only those.
            start = known.find("/")
            while start != -1:
                index.setdefault(known[start + 1 :], known)
                start = known.find("/", start + 1)
        return index

    def _resolve_to_file(
        self,
        import_target: str,
        known_files: set[str],
        suffix_index: dict[str, str] | None = None,
    ) -> str | None:
        """
        Try to resolve an import target to one of the known source files.

        Uses heuristic matching: convert dots to slashes, check with common extensions.

        `suffix_index` is `_build_suffix_index(known_files)`, built once by the
        caller. Omitting it is supported and builds one per call, which is the
        cost this argument exists to avoid.
        """
        # Direct match
        if import_target in known_files:
            return import_target

        if suffix_index is None:
            suffix_index = self._build_suffix_index(known_files)

        # Convert Python dotted path to file path
        as_path = import_target.replace(".", "/")

        candidates = [
            as_path,
            f"{as_path}.py",
            f"{as_path}.ts",
            f"{as_path}.tsx",
            f"{as_path}.js",
            f"{as_path}.jsx",
            f"{as_path}/index.ts",
            f"{as_path}/index.tsx",
            f"{as_path}/index.js",
            f"{as_path}/__init__.py",
        ]

        # Also handle relative JS imports that were stored as-is
        if import_target.startswith("./") or import_target.startswith("../"):
            candidates.append(import_target)
            base = import_target
            for ext in [".ts", ".tsx", ".js", ".jsx"]:
                candidates.append(base + ext)

        for candidate in candidates:
            normalized = candidate.replace("\\", "/")
            if normalized in known_files:
                return normalized
            # Partial match: a known file ending with this candidate.
            match = suffix_index.get(normalized)
            if match is not None:
                return match

        return None

    def _deduplicate_cycles(self, cycles: list[list[str]]) -> list[list[str]]:
        """
        Remove duplicate cycles (same nodes, different starting points).

        A cycle [A, B, C] is the same as [B, C, A] and [C, A, B].
        """
        seen: set[frozenset[str]] = set()
        unique: list[list[str]] = []

        for cycle in cycles:
            key = frozenset(cycle)
            if key not in seen:
                seen.add(key)
                unique.append(cycle)

        return unique

    # ---------------------------------------------------------------------------
    # Bounded context matching
    # ---------------------------------------------------------------------------

    def _build_context_map(self) -> dict[str, BoundedContextConfig]:
        """Build a mapping of context name -> BoundedContextConfig."""
        return {ctx.name: ctx for ctx in self.config.bounded_contexts}

    def _get_context_for_file(
        self, file_path: str, context_map: dict[str, BoundedContextConfig]
    ) -> BoundedContextConfig | None:
        """Determine which bounded context a file belongs to."""
        for ctx in self.config.bounded_contexts:
            for pattern in ctx.patterns:
                if fnmatch.fnmatch(file_path, pattern):
                    return ctx
        return None

    def _get_context_for_import(
        self,
        import_target: str,
        source_file: str,
        context_map: dict[str, BoundedContextConfig],
    ) -> BoundedContextConfig | None:
        """Try to determine which context an import target belongs to."""
        # Convert import to potential file paths
        as_path = import_target.replace(".", "/")
        candidates = [
            as_path,
            f"{as_path}.py",
            f"{as_path}.ts",
            f"{as_path}.tsx",
            f"{as_path}.js",
        ]

        for candidate in candidates:
            ctx = self._get_context_for_file(candidate, context_map)
            if ctx:
                return ctx

        # Check by path segments
        parts = import_target.replace(".", "/").replace("\\", "/").split("/")
        for part in parts:
            if part in context_map:
                return context_map[part]

        return None

    def _is_shared_import(
        self, import_target: str, source_ctx: BoundedContextConfig
    ) -> bool:
        """Check if an import target matches any allowed shared module."""
        allowed = source_ctx.allowed_cross_context_imports
        parts = import_target.replace(".", "/").replace("\\", "/").split("/")
        for part in parts:
            if part in allowed:
                return True
        return False
