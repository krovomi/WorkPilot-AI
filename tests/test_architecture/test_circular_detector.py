"""
Tests for architecture/circular_detector.py — cycle detection and bounded context violations.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "apps" / "backend"))

from architecture.circular_detector import CircularDependencyDetector
from architecture.models import (
    ArchitectureConfig,
    BoundedContextConfig,
    ImportEdge,
    ImportGraph,
    RulesConfig,
)


def _make_graph(edges: list[tuple[str, str]]) -> ImportGraph:
    """Helper to create an ImportGraph from (source, target) tuples."""
    return ImportGraph(
        edges=[ImportEdge(source_file=src, target_module=tgt) for src, tgt in edges],
        files_analyzed=len(set(src for src, _ in edges)),
    )


def _make_config(
    no_circular=True, bounded_contexts=None, inferred=False
) -> ArchitectureConfig:
    """Helper to create a config."""
    return ArchitectureConfig(
        rules=RulesConfig(no_circular_dependencies=no_circular),
        bounded_contexts=bounded_contexts or [],
        inferred=inferred,
    )


class TestCycleDetection:
    """Tests for detect_cycles()."""

    def test_detects_simple_cycle(self):
        """Should detect A -> B -> A cycle."""
        graph = _make_graph(
            [
                ("a.py", "b.py"),
                ("b.py", "a.py"),
            ]
        )
        detector = CircularDependencyDetector(graph, _make_config())
        cycles = detector.detect_cycles()

        assert len(cycles) >= 1
        # The cycle should contain both a.py and b.py
        cycle_files = set()
        for cycle in cycles:
            cycle_files.update(cycle)
        assert "a.py" in cycle_files
        assert "b.py" in cycle_files

    def test_detects_three_node_cycle(self):
        """Should detect A -> B -> C -> A cycle."""
        graph = _make_graph(
            [
                ("a.py", "b.py"),
                ("b.py", "c.py"),
                ("c.py", "a.py"),
            ]
        )
        detector = CircularDependencyDetector(graph, _make_config())
        cycles = detector.detect_cycles()

        assert len(cycles) >= 1
        # At least one cycle should contain all three
        found = False
        for cycle in cycles:
            if set(cycle) == {"a.py", "b.py", "c.py"}:
                found = True
                break
        assert found, f"Expected 3-node cycle, got: {cycles}"

    def test_no_cycle_in_dag(self):
        """Should not detect cycles in a DAG."""
        graph = _make_graph(
            [
                ("a.py", "b.py"),
                ("b.py", "c.py"),
                ("a.py", "c.py"),
            ]
        )
        detector = CircularDependencyDetector(graph, _make_config())
        cycles = detector.detect_cycles()

        assert len(cycles) == 0

    def test_no_cycle_in_linear_chain(self):
        """Should not detect cycles in a linear chain."""
        graph = _make_graph(
            [
                ("a.py", "b.py"),
                ("b.py", "c.py"),
                ("c.py", "d.py"),
            ]
        )
        detector = CircularDependencyDetector(graph, _make_config())
        cycles = detector.detect_cycles()

        assert len(cycles) == 0

    def test_no_cycle_in_empty_graph(self):
        """Should handle an empty graph."""
        graph = _make_graph([])
        detector = CircularDependencyDetector(graph, _make_config())
        cycles = detector.detect_cycles()

        assert len(cycles) == 0

    def test_self_import_not_counted_as_cycle(self):
        """Self-imports should not be counted as cycles."""
        graph = _make_graph(
            [
                ("a.py", "a.py"),
            ]
        )
        detector = CircularDependencyDetector(graph, _make_config())
        cycles = detector.detect_cycles()

        # Self-imports are filtered out in adjacency building
        assert len(cycles) == 0

    def test_deduplicates_cycles(self):
        """Should not report the same cycle with different starting nodes."""
        graph = _make_graph(
            [
                ("a.py", "b.py"),
                ("b.py", "a.py"),
            ]
        )
        detector = CircularDependencyDetector(graph, _make_config())
        cycles = detector.detect_cycles()

        # Should only have 1 cycle, not 2 (a->b and b->a are the same cycle)
        assert len(cycles) == 1


class TestCycleViolations:
    """Tests for get_cycle_violations()."""

    def test_returns_violations_for_cycles(self):
        """Should return ArchitectureViolation objects for detected cycles."""
        graph = _make_graph(
            [
                ("a.py", "b.py"),
                ("b.py", "a.py"),
            ]
        )
        detector = CircularDependencyDetector(graph, _make_config())
        violations = detector.get_cycle_violations()

        assert len(violations) >= 1
        assert violations[0].type == "circular_dependency"
        assert violations[0].severity == "error"
        assert "a.py" in violations[0].description
        assert "b.py" in violations[0].description

    def test_skips_when_disabled(self):
        """Should return empty list when circular dependency check is disabled."""
        graph = _make_graph(
            [
                ("a.py", "b.py"),
                ("b.py", "a.py"),
            ]
        )
        detector = CircularDependencyDetector(graph, _make_config(no_circular=False))
        violations = detector.get_cycle_violations()

        assert len(violations) == 0

    def test_inferred_config_produces_warnings(self):
        """Inferred configs should produce warnings."""
        graph = _make_graph(
            [
                ("a.py", "b.py"),
                ("b.py", "a.py"),
            ]
        )
        detector = CircularDependencyDetector(graph, _make_config(inferred=True))
        violations = detector.get_cycle_violations()

        if violations:
            assert all(v.severity == "warning" for v in violations)


class TestBoundedContextViolations:
    """Tests for check_bounded_context_violations()."""

    def test_detects_cross_context_import(self):
        """Should detect imports crossing bounded context boundaries."""
        graph = _make_graph(
            [
                ("auth/login.py", "billing/invoice.py"),
            ]
        )
        config = _make_config(
            bounded_contexts=[
                BoundedContextConfig(
                    name="auth",
                    patterns=["auth/**"],
                    allowed_cross_context_imports=["shared"],
                ),
                BoundedContextConfig(
                    name="billing",
                    patterns=["billing/**"],
                    allowed_cross_context_imports=["shared"],
                ),
            ]
        )

        detector = CircularDependencyDetector(graph, config)
        violations = detector.check_bounded_context_violations()

        assert len(violations) >= 1
        assert violations[0].type == "bounded_context"
        assert "auth" in violations[0].description
        assert "billing" in violations[0].description

    def test_allows_shared_imports(self):
        """Should allow imports from 'shared' context."""
        graph = _make_graph(
            [
                ("auth/login.py", "shared/utils.py"),
            ]
        )
        config = _make_config(
            bounded_contexts=[
                BoundedContextConfig(
                    name="auth",
                    patterns=["auth/**"],
                    allowed_cross_context_imports=["shared"],
                ),
                BoundedContextConfig(
                    name="shared",
                    patterns=["shared/**"],
                    allowed_cross_context_imports=[],
                ),
            ]
        )

        detector = CircularDependencyDetector(graph, config)
        violations = detector.check_bounded_context_violations()

        assert len(violations) == 0

    def test_allows_same_context_imports(self):
        """Should allow imports within the same context."""
        graph = _make_graph(
            [
                ("auth/login.py", "auth/utils.py"),
            ]
        )
        config = _make_config(
            bounded_contexts=[
                BoundedContextConfig(
                    name="auth",
                    patterns=["auth/**"],
                    allowed_cross_context_imports=["shared"],
                ),
            ]
        )

        detector = CircularDependencyDetector(graph, config)
        violations = detector.check_bounded_context_violations()

        assert len(violations) == 0

    def test_no_violations_without_contexts(self):
        """Should return empty list when no bounded contexts configured."""
        graph = _make_graph(
            [
                ("auth/login.py", "billing/invoice.py"),
            ]
        )
        detector = CircularDependencyDetector(graph, _make_config())
        violations = detector.check_bounded_context_violations()

        assert len(violations) == 0


class TestImportResolution:
    """`_resolve_to_file` and the suffix index it answers from.

    The index replaced a scan over every known file, run once per candidate
    path and once per import edge — on WorkPilot itself, 21 000 edges against
    3 500 files, which is where the Architecture page spent over a minute of
    each scan. These pin the behaviour the index has to keep.
    """

    def _detector(self, files):
        graph = _make_graph([(f, "x") for f in files])
        return CircularDependencyDetector(graph, _make_config()), set(files)

    def test_exact_path_wins(self):
        det, files = self._detector(["src/core/client.py", "core/client.py"])
        assert det._resolve_to_file("core/client.py", files) == "core/client.py"

    def test_dotted_python_import_resolves_to_a_suffix(self):
        det, files = self._detector(["apps/backend/core/client.py"])
        assert (
            det._resolve_to_file("core.client", files) == "apps/backend/core/client.py"
        )

    def test_package_import_resolves_through_init(self):
        det, files = self._detector(["apps/backend/i18n_scaler/__init__.py"])
        assert det._resolve_to_file("i18n_scaler", files) == (
            "apps/backend/i18n_scaler/__init__.py"
        )

    def test_barrel_import_resolves_through_index(self):
        det, files = self._detector(["src/renderer/components/index.tsx"])
        assert det._resolve_to_file("renderer/components", files) == (
            "src/renderer/components/index.tsx"
        )

    def test_suffix_must_start_at_a_path_segment(self):
        """A string suffix is not a path suffix: `lient.py` matches nothing."""
        det, files = self._detector(["src/core/client.py"])
        assert det._resolve_to_file("lient.py", files) is None

    def test_external_package_resolves_to_nothing(self):
        det, files = self._detector(["src/core/client.py"])
        assert det._resolve_to_file("react", files) is None

    def test_ambiguous_suffix_is_resolved_deterministically(self):
        """Several files share a suffix — the shallowest path wins, every time.

        The scan this replaced returned whichever one a `set` iterated first,
        so the report could differ between two runs over identical code.
        """
        files = [
            "a/b/c/shared/utils.ts",
            "shared/utils.ts",
            "x/shared/utils.ts",
        ]
        det, known = self._detector(files)
        for _ in range(5):
            assert det._resolve_to_file("shared/utils", known) == "shared/utils.ts"

    def test_index_is_optional(self):
        """Callers that pass no index still get an answer — they just pay for it."""
        det, files = self._detector(["apps/backend/core/client.py"])
        assert det._resolve_to_file("core.client", files, None) == (
            "apps/backend/core/client.py"
        )

    def test_index_and_no_index_agree(self):
        files = [
            "apps/backend/core/client.py",
            "apps/frontend/src/main/index.ts",
            "src/shared/utils/paths.ts",
        ]
        det, known = self._detector(files)
        index = CircularDependencyDetector._build_suffix_index(known)
        for target in ["core.client", "main/index", "shared/utils/paths", "nope"]:
            assert det._resolve_to_file(target, known, index) == det._resolve_to_file(
                target, known, None
            )
