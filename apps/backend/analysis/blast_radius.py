"""
Blast Radius Analyser
======================

Given a set of target files, predict everything that could break by
computing:

- **Dependents graph** — files that import/require the targets (reverse
  dependency graph), discovered via regex-based import scanning (Python,
  JS/TS, Vue, Svelte, Go, Rust, PHP, Ruby, Dart, C/C++ includes). Stacks
  that reach a type without importing its file (C#, F#, VB.NET, Java,
  Kotlin, Scala, Swift) are matched on the type names the target declares.
  Fully deterministic; no LLM calls.
- **Tests in scope** — test files that exercise the target files.
- **Feature flags referenced** — ``FEATURE_*`` / ``flag(...)`` strings found
  in the targets.
- **Score** — a categorical "low / medium / high" bucket based on fan-in.

Provider-agnostic: no network calls, no LLM usage, works on any repo
regardless of which AI provider the user is configured with.
"""

from __future__ import annotations

import logging
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_CODE_SUFFIXES = {
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".rb",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
    ".vue",
    ".svelte",
    ".kts",
    ".scala",
    ".cs",
    ".fs",
    ".vb",
    ".razor",
    ".cshtml",
    ".php",
    ".swift",
    ".dart",
    ".c",
    ".h",
    ".cc",
    ".cpp",
    ".hpp",
}
# Stacks where a file reaches a type by name (namespace or package import,
# or none at all), so the dependents are found by the type names.
_TYPE_REFERENCE_SUFFIXES = {
    ".cs",
    ".fs",
    ".vb",
    ".razor",
    ".cshtml",
    ".java",
    ".kt",
    ".kts",
    ".scala",
    ".swift",
}
_TYPE_DECLARATION = re.compile(
    r"\b(?:class|interface|record|struct|enum|object|protocol|trait|"
    r"Class|Interface|Structure|Enum|Module|type)\s+([A-Z][A-Za-z0-9_]{2,})"
)
# A test file: in a test folder, or named like one in any stack
# (test_x.py, x_test.go, x.test.ts, x.spec.js, XTests.cs, XTest.java, XSpec.swift).
_TEST_DIR = re.compile(
    r"(?:^|/)(?:tests?|__tests__|specs?|[\w.-]+\.Tests?)/", re.IGNORECASE
)
_TEST_NAME = re.compile(
    r"(?:^test_|_test\.|\.test\.|\.spec\.|[a-z0-9_](?:Tests?|Spec)\.\w+$)"
)
_IGNORED_DIRS = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    "dist",
    "build",
    "coverage",
    ".next",
    ".nuxt",
    "target",
    ".idea",
    ".vscode",
}
_IMPORT_PATTERNS = (
    re.compile(r"^\s*(?:from|import)\s+([\w.]+)", re.MULTILINE),
    re.compile(
        r"""(?:import|require)\s*\(?\s*['"]([^'"\s]+)['"]""",
        re.MULTILINE,
    ),
    re.compile(
        r"""\bfrom\s+['"]([^'"\s]+)['"]""",
        re.MULTILINE,
    ),
    re.compile(
        r"""^\s*use\s+([\w:\\]+)""",
        re.MULTILINE,
    ),
    re.compile(
        r"""^\s*#\s*include\s*[<"]([^>"]+)[>"]""",
        re.MULTILINE,
    ),
)
_FLAG_PATTERN = re.compile(
    r"""\b(FEATURE_[A-Z0-9_]{3,}|flag\s*\(\s*['"](\w[\w\-.]+)['"])""",
)


@dataclass
class DependentEdge:
    """One file depends on another."""

    source: str
    target: str
    kind: str = "import"


@dataclass
class BlastRadiusReport:
    targets: list[str]
    dependents: list[DependentEdge]
    tests: list[str]
    flags: list[str]
    score: str  # "low" | "medium" | "high"
    total_dependents: int
    explanation: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "targets": self.targets,
            "dependents": [asdict(d) for d in self.dependents],
            "tests": self.tests,
            "flags": self.flags,
            "score": self.score,
            "total_dependents": self.total_dependents,
            "explanation": self.explanation,
        }


def _iter_code_files(root: Path, *, limit: int = 3000) -> list[Path]:
    out: list[Path] = []
    for path in root.rglob("*"):
        if len(out) >= limit:
            break
        if not path.is_file():
            continue
        if path.suffix.lower() not in _CODE_SUFFIXES:
            continue
        rel_parts = set(path.relative_to(root).parts)
        if rel_parts & _IGNORED_DIRS:
            continue
        out.append(path)
    return out


def _module_candidates(root: Path, target: Path) -> list[str]:
    """Generate name variants a target file might be imported as."""
    rel = target.relative_to(root)
    stem = target.stem
    parts = list(rel.with_suffix("").parts)
    dotted = ".".join(parts)
    slashed_no_ext = "/".join(parts)
    rel_no_ext = str(rel.with_suffix("")).replace("\\", "/")

    return list(
        dict.fromkeys(
            [
                stem,
                dotted,
                slashed_no_ext,
                rel_no_ext,
                f"./{slashed_no_ext}",
                f"../{slashed_no_ext}",
            ],
        ),
    )


def _extract_imports(text: str) -> list[str]:
    out: list[str] = []
    for pat in _IMPORT_PATTERNS:
        for m in pat.finditer(text):
            out.append(m.group(1))
    return out


def _declared_types(target: Path) -> set[str]:
    """The type names a type-reference target declares (C#, Java, Swift...)."""
    if target.suffix.lower() not in _TYPE_REFERENCE_SUFFIXES:
        return set()
    try:
        text = target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return set()
    return set(_TYPE_DECLARATION.findall(text))


def _is_test_file(rel_path: str) -> bool:
    name = rel_path.rsplit("/", 1)[-1]
    return bool(_TEST_DIR.search(rel_path) or _TEST_NAME.search(name))


def analyze_blast_radius(
    project_root: Path,
    targets: list[str],
) -> BlastRadiusReport:
    """Compute a blast radius report for the given targets.

    ``targets`` are relative paths inside ``project_root``.
    """
    project_root = Path(project_root)
    resolved_targets: list[Path] = []
    for t in targets:
        p = (project_root / t).resolve()
        if p.exists() and p.is_file():
            resolved_targets.append(p)

    if not resolved_targets:
        # ``targets`` lists the files analysed: none of the requested paths is one.
        return BlastRadiusReport(
            targets=[],
            dependents=[],
            tests=[],
            flags=[],
            score="low",
            total_dependents=0,
            explanation=["no valid target files"],
        )

    candidates_by_target: dict[Path, list[str]] = {
        t: _module_candidates(project_root, t) for t in resolved_targets
    }
    types_by_target: dict[Path, re.Pattern[str]] = {}
    for t in resolved_targets:
        names = _declared_types(t)
        if names:
            types_by_target[t] = re.compile(
                r"\b(?:" + "|".join(map(re.escape, sorted(names))) + r")\b"
            )

    dependents: list[DependentEdge] = []
    tests: set[str] = set()
    seen_dependents: set[str] = set()

    for path in _iter_code_files(project_root):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        imports = _extract_imports(text)
        by_type = path.suffix.lower() in _TYPE_REFERENCE_SUFFIXES
        if not imports and not by_type:
            continue

        rel_source = str(path.relative_to(project_root)).replace("\\", "/")
        for target, variants in candidates_by_target.items():
            if path == target:
                continue
            hit = any(any(v and v in imp for v in variants) for imp in imports)
            if not hit and by_type and target in types_by_target:
                hit = bool(types_by_target[target].search(text))
            if not hit:
                continue
            rel_target = str(target.relative_to(project_root)).replace("\\", "/")
            key = f"{rel_source}→{rel_target}"
            if key in seen_dependents:
                continue
            seen_dependents.add(key)
            dependents.append(
                DependentEdge(source=rel_source, target=rel_target, kind="import"),
            )
            if _is_test_file(rel_source):
                tests.add(rel_source)

    flags: set[str] = set()
    for t in resolved_targets:
        try:
            text = t.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for match in _FLAG_PATTERN.finditer(text):
            flag = match.group(2) or match.group(1)
            if flag:
                flags.add(flag)

    fan_in = len({edge.source for edge in dependents})
    if fan_in >= 15:
        score = "high"
    elif fan_in >= 5:
        score = "medium"
    else:
        score = "low"

    explanation = [
        f"{len(resolved_targets)} target file(s) analyzed",
        f"{fan_in} direct dependent file(s) found",
        f"{len(tests)} test file(s) touch this scope",
    ]
    if flags:
        explanation.append(f"{len(flags)} feature flag(s) referenced")

    return BlastRadiusReport(
        targets=[
            str(t.relative_to(project_root)).replace("\\", "/")
            for t in resolved_targets
        ],
        dependents=dependents,
        tests=sorted(tests),
        flags=sorted(flags),
        score=score,
        total_dependents=fan_in,
        explanation=explanation,
    )
