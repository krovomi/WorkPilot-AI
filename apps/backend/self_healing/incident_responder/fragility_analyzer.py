"""
Fragility Analyzer
===================

Analyzes code fragility by combining:
- Cyclomatic complexity (via AST analysis)
- Git churn (commit frequency per file)
- Test coverage correlation

Produces per-file FragilityReport with composite risk scores.
"""

from __future__ import annotations

import ast
import json
import logging
import os
import subprocess
from pathlib import Path

from .models import FragilityReport

logger = logging.getLogger(__name__)

# Weight factors for composite risk score
WEIGHT_COMPLEXITY = 0.4
WEIGHT_CHURN = 0.3
WEIGHT_COVERAGE = 0.3

# Normalization constants
MAX_COMPLEXITY = 50  # Complexity above this maps to 100
MAX_CHURN = 30  # Commits in 30 days above this maps to 100

# Every language the heuristic complexity can read (Python gets its AST).
SOURCE_EXTENSIONS = frozenset(
    {
        ".py", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".vue", ".svelte",
        ".java", ".kt", ".kts", ".scala", ".groovy", ".go", ".rs", ".rb", ".php",
        ".cs", ".fs", ".vb", ".swift", ".m", ".mm", ".c", ".h", ".cc", ".cpp",
        ".hpp", ".dart", ".ex", ".exs", ".erl", ".lua", ".pl", ".r", ".jl",
    }
)  # fmt: skip

TEST_SUFFIXES = (
    "_test.py",
    ".test.ts",
    ".test.tsx",
    ".test.js",
    ".test.jsx",
    ".spec.ts",
    ".spec.tsx",
    ".spec.js",
    ".spec.jsx",
    "_test.go",
    "_spec.rb",
    "_test.rb",
    "_test.dart",
    "_test.exs",
)

# Default excluded directories
DEFAULT_EXCLUDED = {
    "node_modules",
    ".venv",
    "__pycache__",
    ".git",
    "dist",
    "build",
    ".workpilot",
    ".next",
    "coverage",
    ".tox",
    "egg-info",
}


class FragilityAnalyzer:
    """Analyzes code fragility across multiple dimensions."""

    def __init__(
        self,
        project_dir: str | Path,
        churn_days: int = 30,
        excluded_dirs: set[str] | None = None,
    ):
        self.project_dir = Path(project_dir)
        self.churn_days = churn_days
        self.excluded_dirs = excluded_dirs or DEFAULT_EXCLUDED

    async def analyze(
        self,
        max_files: int = 100,
        risk_threshold: float = 30.0,
    ) -> list[FragilityReport]:
        """Run full fragility analysis on the project.

        Args:
            max_files: Maximum number of files to analyze.
            risk_threshold: Only return files above this risk score.

        Returns:
            List of FragilityReport sorted by risk_score descending.
        """
        source_files = self._find_source_files(max_files)
        if not source_files:
            logger.warning("No source files found for fragility analysis")
            return []

        churn_map = self._compute_git_churn(source_files)
        coverage_map = self._load_coverage_data()

        reports: list[FragilityReport] = []
        for file_path in source_files:
            relative = file_path.relative_to(self.project_dir)
            # git names files with "/" on every OS; the history keys on it too.
            rel_path = relative.as_posix()
            complexity = self._compute_cyclomatic_complexity(file_path)
            churn = churn_map.get(rel_path, 0)
            coverage = coverage_map.get(rel_path, 0.0)

            # Normalize to 0-100
            norm_complexity = min(complexity / MAX_COMPLEXITY * 100, 100)
            norm_churn = min(churn / MAX_CHURN * 100, 100)
            uncovered = 100 - coverage

            risk_score = (
                WEIGHT_COMPLEXITY * norm_complexity
                + WEIGHT_CHURN * norm_churn
                + WEIGHT_COVERAGE * uncovered
            )
            risk_score = round(min(risk_score, 100), 1)

            if risk_score >= risk_threshold:
                reports.append(
                    FragilityReport(
                        file_path=rel_path,
                        risk_score=risk_score,
                        cyclomatic_complexity=round(complexity, 1),
                        git_churn_count=churn,
                        test_coverage_percent=round(coverage, 1),
                    )
                )

        reports.sort(key=lambda r: r.risk_score, reverse=True)
        return reports

    def _find_source_files(self, max_files: int) -> list[Path]:
        """Find analyzable source files in the project, in a stable order.

        Sorted, so that two scans of the same tree measure the same files: the
        risk history (#370) compares a file with itself from one scan to the
        next, and a set's iteration order changes with every process.
        """
        files: list[Path] = []
        # os.walk, pruned: a dependency folder is never walked at all.
        for root, dirs, names in os.walk(self.project_dir):
            dirs[:] = sorted(d for d in dirs if not self._excluded(d))
            for name in sorted(names):
                if Path(name).suffix.lower() not in SOURCE_EXTENSIONS:
                    continue
                # Skip test files for fragility analysis
                name_lower = name.lower()
                if name_lower.startswith("test_") or name_lower.endswith(TEST_SUFFIXES):
                    continue
                files.append(Path(root) / name)
                if len(files) >= max_files:
                    return files
        return files

    def _excluded(self, name: str) -> bool:
        # A package's metadata folder is named after it: `mypkg.egg-info`.
        return name in self.excluded_dirs or (
            "egg-info" in self.excluded_dirs and name.endswith(".egg-info")
        )

    def _compute_cyclomatic_complexity(self, file_path: Path) -> float:
        """Compute cyclomatic complexity for a Python file via AST.

        For non-Python files, returns a heuristic based on control flow keywords.
        """
        if file_path.suffix == ".py":
            return self._python_complexity(file_path)
        return self._heuristic_complexity(file_path)

    def _python_complexity(self, file_path: Path) -> float:
        """Compute cyclomatic complexity for Python files using AST."""
        try:
            source = file_path.read_text(encoding="utf-8", errors="replace")
            tree = ast.parse(source, filename=str(file_path))
        except (OSError, SyntaxError, ValueError):
            # Unreadable (gone since the walk) or not Python this version parses.
            return 0.0

        complexity = 0
        for node in ast.walk(tree):
            if isinstance(node, (ast.If, ast.While, ast.For, ast.ExceptHandler)):
                complexity += 1
            elif isinstance(node, ast.BoolOp):
                # Each and/or adds a decision point
                complexity += len(node.values) - 1
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                complexity += 1  # Base complexity per function
            elif isinstance(node, ast.Assert):
                complexity += 1

        return float(complexity)

    def _heuristic_complexity(self, file_path: Path) -> float:
        """Heuristic complexity for non-Python files based on keyword counting."""
        control_keywords = {
            "if",
            "else",
            "elif",
            "for",
            "while",
            "switch",
            "case",
            "catch",
            "try",
            "throw",
            "&&",
            "||",
            "?",
        }
        try:
            content = file_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return 0.0

        complexity = 0
        for line in content.splitlines():
            stripped = line.strip()
            for kw in control_keywords:
                if kw in stripped:
                    complexity += 1
                    break  # Count once per line

        return float(complexity)

    def _compute_git_churn(self, files: list[Path]) -> dict[str, int]:
        """Compute git commit count per file in the last N days."""
        churn: dict[str, int] = {}

        try:
            result = subprocess.run(
                [
                    "git",
                    "log",
                    f"--since={self.churn_days} days ago",
                    "--format=",
                    "--name-only",
                    "--diff-filter=ACMR",
                    # Paths relative to the project, which may be a folder of
                    # a larger repository, and only the files under it.
                    "--relative",
                ],
                cwd=str(self.project_dir),
                capture_output=True,
                text=True,
                timeout=30,
            )
            if result.returncode == 0:
                for line in result.stdout.splitlines():
                    line = line.strip()
                    if line:
                        churn[line] = churn.get(line, 0) + 1
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
            logger.warning(f"Git churn analysis failed: {e}")

        return churn

    def _load_coverage_data(self) -> dict[str, float]:
        """Line coverage per file, keyed by its path from the project with "/".

        Read from coverage.py's ``coverage.json`` and Istanbul's
        ``coverage/coverage-summary.json`` or ``coverage/coverage-final.json``
        (Jest, Vitest, nyc, c8).
        """
        coverage: dict[str, float] = {}

        data = self._read_json(self.project_dir / "coverage.json")
        files = data.get("files") if isinstance(data, dict) else None
        for file_path, file_data in (files or {}).items():
            summary = file_data.get("summary") if isinstance(file_data, dict) else None
            if isinstance(summary, dict):
                coverage[self._coverage_key(file_path)] = float(
                    summary.get("percent_covered", 0.0)
                )

        for name in ("coverage-summary.json", "coverage-final.json"):
            data = self._read_json(self.project_dir / "coverage" / name)
            for file_path, file_data in (data or {}).items():
                percent = _istanbul_percent(file_data)
                if file_path != "total" and percent is not None:
                    coverage[self._coverage_key(file_path)] = percent

        return coverage

    @staticmethod
    def _read_json(path: Path) -> dict | None:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return data if isinstance(data, dict) else None

    def _coverage_key(self, file_path: str) -> str:
        """A report's path as the project-relative, "/" path the scan uses."""
        path = Path(file_path)
        if path.is_absolute():
            for root in (self.project_dir, self.project_dir.resolve()):
                try:
                    return path.relative_to(root).as_posix()
                except ValueError:
                    continue
        return file_path.replace("\\", "/")


def _istanbul_percent(file_data: object) -> float | None:
    """The line percentage of one Istanbul entry, summary or final format."""
    if not isinstance(file_data, dict):
        return None
    lines = file_data.get("lines")
    if isinstance(lines, dict) and "pct" in lines:
        pct = lines["pct"]
        # Istanbul writes "Unknown" for a file without a line.
        return float(pct) if isinstance(pct, (int, float)) else None
    hits = file_data.get("s")
    if isinstance(hits, dict) and hits:
        covered = sum(1 for count in hits.values() if count)
        return round(covered / len(hits) * 100, 1)
    return None
