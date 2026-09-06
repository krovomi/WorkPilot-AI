"""Where a generated test file belongs on disk.

The model is asked for a test file *path*, and what it returns is a convention
it remembers — ``CalculatorTests.cs``, ``tests/test_calculator.py`` — resolved
against the project root because there was nowhere else to resolve it. On a
project whose sources live under ``src/`` that put the C# tests at the top of
the repository, next to the solution file, which is the one place nobody looks
for them.

The rule this module applies is the one a person would: unit tests go in the
``tests`` directory that sits **beside** the source root (``src``, ``source``,
``sources``). When that directory does not exist, the answer is not to guess —
it is to ask, which is what ``status == "needs_choice"`` means. The caller with
a user in front of it (the Kanban dialog) asks; the caller without one (the CLI
runner, the post-build hook) falls back to the first candidate, which is the
directory a person would have been offered first anyway.

Nothing here reads a file or calls a model: it is path arithmetic plus a few
``is_dir()`` probes, so the UI can resolve a destination before generation
starts and pay nothing for it.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

# Directory names that mark the root of a project's sources. Matched
# case-insensitively — a .NET solution writes ``Source``, a Python package
# writes ``src``, and both mean the same thing.
SOURCE_ROOT_NAMES: tuple[str, ...] = ("src", "source", "sources")

# Directory names that already hold tests. Order is preference: when a project
# has both ``tests`` and ``spec``, the first one found wins.
TEST_DIR_NAMES: tuple[str, ...] = (
    "tests",
    "test",
    "spec",
    "specs",
    "__tests__",
)

# The name proposed when no test directory exists yet, per language.
_PROPOSED_DIR_BY_LANGUAGE: dict[str, str] = {
    "ruby": "spec",
}
_DEFAULT_PROPOSED_DIR = "tests"

# Languages whose test files MUST sit next to the source they cover: Go's
# ``_test.go`` belongs to the package it tests, and moving it to ``tests/``
# does not produce a test suite, it produces a compile error. Asking the user
# where to put it would be asking them to break their build.
CO_LOCATED_LANGUAGES: frozenset[str] = frozenset({"go", "rust"})

# Markers used to locate the project root when the caller did not name one.
_PROJECT_MARKERS: tuple[str, ...] = (
    ".git",
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Cargo.toml",
    "go.mod",
)

# How many levels to walk up before giving up on finding a project root.
_MAX_WALK_UP = 8


@dataclass
class DestinationCandidate:
    """One directory the user may pick, with why it is being offered."""

    path: str
    # "existing_tests_dir" | "sibling_of_source_root" | "project_tests"
    # | "source_dir"
    kind: str
    exists: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class TestDestination:
    """The resolved answer to "where does this test file go?"."""

    directory: str
    file_name: str
    status: str  # "resolved" | "needs_choice"
    # Machine-readable justification, rendered by the UI as localised copy:
    # "explicit_directory" | "existing_test_file" | "existing_tests_dir"
    # | "co_located_convention" | "no_tests_dir" | "no_source_root"
    reason: str
    project_root: str = ""
    source_root: str | None = None
    candidates: list[DestinationCandidate] = field(default_factory=list)

    # Prevent pytest from collecting this as a test class.
    __test__ = False

    @property
    def path(self) -> str:
        """Full path of the test file, or "" when the directory is undecided."""
        if not self.directory or not self.file_name:
            return ""
        return str(Path(self.directory) / self.file_name)

    def to_dict(self) -> dict[str, Any]:
        return {
            "directory": self.directory,
            "file_name": self.file_name,
            "path": self.path,
            "status": self.status,
            "reason": self.reason,
            "project_root": self.project_root,
            "source_root": self.source_root,
            "candidates": [c.to_dict() for c in self.candidates],
        }


# ── Naming ───────────────────────────────────────────────────────────


def _language_for(source_file: str, language: str | None) -> str:
    """Resolve the language, falling back to the file extension."""
    if language and language != "unknown":
        return language
    # Imported here rather than at module import time: the map lives with the
    # analyser that owns it, and a second copy is how two answers to "what
    # language is this" start.
    from agents.test_generator import ProjectAnalyzer

    ext = Path(source_file).suffix.lower()
    return ProjectAnalyzer.EXTENSION_TO_LANGUAGE.get(ext, "unknown")


def conventional_test_file_name(source_file: str, language: str | None = None) -> str:
    """The conventional test file name for *source_file* in *language*."""
    stem = Path(source_file).stem
    suffix = Path(source_file).suffix
    lang = _language_for(source_file, language)

    if lang == "python":
        return f"test_{stem}.py"
    if lang == "typescript":
        return f"{stem}.test{suffix or '.ts'}"
    if lang == "javascript":
        return f"{stem}.test{suffix or '.js'}"
    if lang == "csharp":
        return f"{_pascal(stem)}Tests.cs"
    if lang == "java":
        return f"{_pascal(stem)}Test.java"
    if lang == "kotlin":
        return f"{_pascal(stem)}Test{suffix or '.kt'}"
    if lang == "swift":
        return f"{_pascal(stem)}Tests.swift"
    if lang == "go":
        return f"{stem}_test.go"
    if lang == "rust":
        return f"{stem}_test.rs"
    if lang == "ruby":
        return f"{stem}_spec.rb"
    if lang == "php":
        return f"{_pascal(stem)}Test.php"
    return f"test_{stem}{suffix}"


def _pascal(stem: str) -> str:
    """``user-service`` → ``UserService``; an already-Pascal stem is kept."""
    parts = [p for p in re.split(r"[^0-9A-Za-z]+", stem) if p]
    if not parts:
        return stem or "Unnamed"
    if len(parts) == 1:
        return parts[0][:1].upper() + parts[0][1:]
    return "".join(p[:1].upper() + p[1:] for p in parts)


def sanitize_file_name(raw_path: str) -> str:
    """Keep only the file name of a model-proposed path.

    The model's *directory* is what this module replaces; its *name* is worth
    keeping — it carries the extension and the framework's naming convention.
    Any path separator, drive letter or ``..`` segment is dropped, so a
    generated path can never escape the directory the user chose.
    """
    if not raw_path:
        return ""
    name = Path(raw_path.replace("\\", "/")).name.strip()
    if name in ("", ".", ".."):
        return ""
    return name


# ── Directory discovery ──────────────────────────────────────────────


def find_project_root(source_file: str) -> Path | None:
    """Walk up from *source_file* looking for a project marker."""
    current = Path(source_file).resolve().parent
    for _ in range(_MAX_WALK_UP):
        if any((current / marker).exists() for marker in _PROJECT_MARKERS):
            return current
        parent = current.parent
        if parent == current:
            break
        current = parent
    return None


def find_source_root(source_file: str, project_root: Path) -> Path | None:
    """The ``src`` / ``source`` / ``sources`` directory *source_file* lives in.

    The **outermost** match wins: in ``proj/src/vendor/src/a.ts`` the source
    root is ``proj/src``, because that is the one ``tests`` would sit beside.
    When the file is not under such a directory at all, a source root directly
    under the project root still answers the question — the generated test for
    a file outside ``src`` still belongs in the project's test directory.
    """
    try:
        current = Path(source_file).resolve().parent
        root = project_root.resolve()
    except OSError:  # pragma: no cover — resolve() on a broken mount
        return None

    match: Path | None = None
    for _ in range(_MAX_WALK_UP):
        if current.name.lower() in SOURCE_ROOT_NAMES:
            match = current
        if current == root:
            break
        parent = current.parent
        if parent == current:
            break
        current = parent
    if match is not None:
        return match

    for name in SOURCE_ROOT_NAMES:
        for child in (root / name, root / name.capitalize()):
            if child.is_dir():
                return child
    return None


def find_test_dir(anchor: Path) -> Path | None:
    """An existing test directory directly under *anchor*, if there is one.

    Recognises the conventional names and, for .NET, a sibling test *project*
    (``MyApp.Tests``): on that stack the tests are a project of their own, and
    a solution that has one already answered this question.
    """
    if not anchor.is_dir():
        return None

    try:
        children = sorted(p for p in anchor.iterdir() if p.is_dir())
    except OSError:
        return None

    by_name = {p.name.lower(): p for p in children}
    for name in TEST_DIR_NAMES:
        if name in by_name:
            return by_name[name]

    for child in children:
        lowered = child.name.lower()
        if lowered.endswith((".tests", ".test", ".specs", ".spec")):
            return child
    return None


def _proposed_dir_name(language: str) -> str:
    return _PROPOSED_DIR_BY_LANGUAGE.get(language, _DEFAULT_PROPOSED_DIR)


def _candidate(path: Path, kind: str) -> DestinationCandidate:
    return DestinationCandidate(path=str(path), kind=kind, exists=path.is_dir())


def _dedupe(candidates: list[DestinationCandidate]) -> list[DestinationCandidate]:
    seen: set[str] = set()
    unique: list[DestinationCandidate] = []
    for candidate in candidates:
        if candidate.path in seen:
            continue
        seen.add(candidate.path)
        unique.append(candidate)
    return unique


# ── The resolver ─────────────────────────────────────────────────────


def resolve_test_destination(
    source_file: str,
    project_root: str | None = None,
    language: str | None = None,
    explicit_dir: str | None = None,
    existing_test_path: str | None = None,
    proposed_path: str | None = None,
) -> TestDestination:
    """Decide where the test file for *source_file* goes.

    Args:
        source_file: The source being covered. Only its path is read.
        project_root: The project root, when the caller knows it.
        language: Detected language; inferred from the extension when omitted.
        explicit_dir: A directory the user chose. Ends the question.
        existing_test_path: An existing test file for this source. Its
            directory wins over any convention — the project already decided.
        proposed_path: The path the model returned. Only its file name is used.

    Returns:
        A :class:`TestDestination`. ``status == "needs_choice"`` means no
        directory could be justified and ``candidates`` are worth asking about;
        ``directory`` still carries the best candidate so a caller with no user
        to ask can proceed.
    """
    lang = _language_for(source_file, language)
    file_name = sanitize_file_name(proposed_path or "") or conventional_test_file_name(
        source_file, lang
    )

    root_path = Path(project_root).resolve() if project_root else None
    if root_path is None or not root_path.is_dir():
        found = find_project_root(source_file) if source_file else None
        root_path = found or (
            Path(source_file).resolve().parent if source_file else Path.cwd()
        )

    def build(
        directory: Path,
        status: str,
        reason: str,
        candidates: list[DestinationCandidate] | None = None,
        source_root: Path | None = None,
    ) -> TestDestination:
        return TestDestination(
            directory=str(directory),
            file_name=file_name,
            status=status,
            reason=reason,
            project_root=str(root_path),
            source_root=str(source_root) if source_root else None,
            candidates=_dedupe(candidates or []),
        )

    # 1. The user already answered. A relative answer is relative to the
    #    project — the dialog's own placeholder suggests one ("tests/App.Tests")
    #    and resolving it against the process's working directory would write
    #    the file into the backend installation.
    if explicit_dir:
        chosen = Path(explicit_dir)
        if not chosen.is_absolute():
            chosen = root_path / chosen
        return build(chosen, "resolved", "explicit_directory")

    # 2. Tests for this source already exist somewhere: that is the answer,
    #    whatever the conventions say.
    if existing_test_path:
        existing = Path(existing_test_path)
        if existing.is_file():
            return build(existing.parent, "resolved", "existing_test_file")

    src_root = find_source_root(source_file, root_path) if source_file else None

    # 3. Languages where a test file must compile alongside its source.
    if lang in CO_LOCATED_LANGUAGES and source_file:
        return build(
            Path(source_file).resolve().parent,
            "resolved",
            "co_located_convention",
            source_root=src_root,
        )

    # 4. A test directory that already exists, in preference order: beside the
    #    source root (the rule), then the ones a project may have chosen for
    #    itself — a ``__tests__`` next to the file, one inside the source root,
    #    or one at the project root. An existing directory is a decision
    #    somebody already made; overruling it would scatter the suite.
    anchor = src_root.parent if src_root else root_path
    probes: list[Path] = [anchor]
    if source_file:
        probes.append(Path(source_file).resolve().parent)
    if src_root is not None:
        probes.append(src_root)
    probes.append(root_path)

    existing_dir = next(
        (found for probe in dict.fromkeys(probes) if (found := find_test_dir(probe))),
        None,
    )
    if existing_dir is not None:
        return build(
            existing_dir, "resolved", "existing_tests_dir", source_root=src_root
        )

    # 5. Nothing to point at. Offer, do not decide.
    proposed = _proposed_dir_name(lang)
    candidates = [_candidate(anchor / proposed, "sibling_of_source_root")]
    if anchor != root_path:
        candidates.append(_candidate(root_path / proposed, "project_tests"))
    if source_file:
        candidates.append(_candidate(Path(source_file).resolve().parent, "source_dir"))
    candidates = _dedupe(candidates)

    return build(
        Path(candidates[0].path),
        "needs_choice",
        "no_tests_dir" if src_root else "no_source_root",
        candidates=candidates,
        source_root=src_root,
    )
