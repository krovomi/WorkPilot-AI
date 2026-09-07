"""
Onboarding Tour Builder
========================

Turns a codebase into a sequenced, interactive onboarding experience:

- **Tour**: ordered steps pointing at the key files, entry points and
  directories, with a short explanation of why each matters.
- **Quiz**: multiple-choice questions generated from every part of the guide —
  stack, key files, architecture, commands, conventions — not only from the
  tour.
- **First tasks**: "good first issue"–style suggestions surfaced from existing
  TODO/FIXME markers, completed with derived suggestions (untested modules,
  undocumented entry points) so a repo with a clean comment history still gets
  somewhere to start.
- **Glossary**: domain terms extracted from file names, directories and
  top-level identifiers, each with the reason it is in the list.

The module is deterministic — it does NOT call any LLM. Upstream callers can
feed the result to an agent prompt if they want richer prose.
"""

from __future__ import annotations

import hashlib
import logging
import re
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .onboarding_engine import (
    ArchitectureNode,
    OnboardingEngine,
    OnboardingGuide,
    ProjectScan,
    scan_project,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class TourStep:
    """A single step in the guided tour."""

    order: int
    title: str
    file_path: str
    reason: str
    suggested_questions: list[str] = field(default_factory=list)
    category: str = "file"  # file | entrypoint | directory | command | doc
    snippet: str = ""


@dataclass
class QuizQuestion:
    """A multiple-choice question generated from the guide."""

    question: str
    choices: list[str]
    correct_index: int
    rationale: str = ""
    category: str = "general"  # stack | files | architecture | commands | conventions
    difficulty: str = "easy"  # easy | medium | hard


@dataclass
class FirstTask:
    """A suggested first task for the newcomer."""

    title: str
    file_path: str
    line: int
    source_comment: str
    category: str = "todo"  # todo | tests | docs | explore
    difficulty: str = "easy"
    why: str = ""


@dataclass
class GlossaryTerm:
    """A domain term detected in the codebase."""

    term: str
    occurrences: int
    sources: list[str] = field(default_factory=list)
    kind: str = "identifier"  # directory | type | module | identifier
    definition: str = ""


@dataclass
class OnboardingPackage:
    """Full onboarding bundle for a newcomer."""

    guide: OnboardingGuide
    tour: list[TourStep] = field(default_factory=list)
    quiz: list[QuizQuestion] = field(default_factory=list)
    first_tasks: list[FirstTask] = field(default_factory=list)
    glossary: list[GlossaryTerm] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "guide": {
                "project_name": self.guide.project_name,
                "tech_stack": self.guide.tech_stack,
                "key_files": [asdict(kf) for kf in self.guide.key_files],
                "entry_points": [asdict(kf) for kf in self.guide.entry_points],
                "conventions": [asdict(c) for c in self.guide.conventions],
                "commands": [asdict(c) for c in self.guide.commands],
                "architecture": [asdict(a) for a in self.guide.architecture],
                "sections": self.guide.sections,
                "stats": self.guide.stats,
                "estimated_reading_time_min": self.guide.estimated_reading_time_min,
            },
            "tour": [asdict(s) for s in self.tour],
            "quiz": [asdict(q) for q in self.quiz],
            "first_tasks": [asdict(t) for t in self.first_tasks],
            "glossary": [asdict(g) for g in self.glossary],
        }


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_TODO_PATTERN = re.compile(
    r"(?:#|//|/\*|\*|--)\s*(TODO|FIXME|XXX|HACK)[: ]+(.*)", re.IGNORECASE
)

_COMMON_STOP_WORDS = {
    "the",
    "and",
    "for",
    "with",
    "this",
    "that",
    "from",
    "into",
    "when",
    "then",
    "some",
    "have",
    "will",
    "been",
    "your",
    "more",
    "them",
    "than",
    "also",
    "just",
    "does",
    "like",
    "over",
    "main",
    "test",
    "tests",
    "index",
    "utils",
    "util",
    "helper",
    "helpers",
    "core",
    "app",
    "src",
    "lib",
    "data",
    "type",
    "types",
    "file",
    "files",
    "class",
    "func",
    "function",
    "method",
    "module",
    "package",
    "value",
    "values",
    "string",
    "number",
    "object",
    "result",
    "return",
    "import",
    "export",
    "const",
    "public",
    "private",
    "static",
    "async",
    "await",
    "default",
    "params",
    "options",
    "config",
    "props",
    "state",
    "error",
    "errors",
    "input",
    "output",
    "using",
    "namespace",
    # Language and stdlib noise: frequent everywhere, domain vocabulary nowhere.
    "false",
    "true",
    "none",
    "null",
    "undefined",
    "returns",
    "raises",
    "args",
    "kwargs",
    "exception",
    "throws",
    "boolean",
    "integer",
    "float",
    "double",
    "void",
    "interface",
    "record",
    "struct",
    "enum",
    "abstract",
    "override",
    "readonly",
    "virtual",
    "sealed",
    "partial",
    "yield",
    "lambda",
    "assert",
    "callback",
    "promise",
    "component",
    "element",
    "context",
    "provider",
    "factory",
    "builder",
    "manager",
    "handler",
    "wrapper",
    "instance",
    "request",
    "response",
    "message",
    "content",
    "payload",
    "buffer",
    "stream",
    "logger",
    "logging",
    "console",
    "window",
    "document",
    "target",
    "source",
    "sources",
    "records",
    "entry",
    "entries",
    "items",
    "length",
    "count",
    "counts",
    "indexes",
    "field",
    "fields",
    "parent",
    "child",
    "children",
    "current",
    "previous",
    "custom",
    "create",
    "created",
    "update",
    "updated",
    "delete",
    "deleted",
    "select",
    "insert",
    "default_factory",
    "self",
    "cls",
    "super",
}

_STACK_DISTRACTORS = [
    "Rust",
    "Go",
    "Ruby",
    "C++",
    "PHP",
    "Elixir",
    "Scala",
    "Perl",
    "COBOL",
    "Haskell",
    "Erlang",
    "Objective-C",
]

_FILLER_PATHS = [
    "src/legacy/deprecated.txt",
    "tools/scratch.tmp",
    "archive/old-notes.md",
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _stable_shuffle(items: list[str], seed_text: str) -> list[str]:
    """Order ``items`` deterministically from a text seed.

    A quiz whose right answer is always the first choice teaches the layout,
    not the codebase — and ``random.shuffle`` would make the same package
    different on every run, which breaks both caching and the tests.
    """
    digest = hashlib.sha256(seed_text.encode("utf-8")).hexdigest()
    return [
        item
        for _, item in sorted(
            (hashlib.sha256(f"{digest}:{item}".encode()).hexdigest(), item)
            for item in items
        )
    ]


def _make_question(
    question: str,
    correct: str,
    distractors: list[str],
    *,
    rationale: str = "",
    category: str = "general",
    difficulty: str = "easy",
    fillers: list[str] | None = None,
) -> QuizQuestion | None:
    """Build one shuffled MCQ, or ``None`` when there is nothing to ask."""
    pool: list[str] = []
    for candidate in distractors:
        if candidate and candidate != correct and candidate not in pool:
            pool.append(candidate)
    for candidate in fillers or []:
        if len(pool) >= 3:
            break
        if candidate and candidate != correct and candidate not in pool:
            pool.append(candidate)
    if len(pool) < 2:
        return None

    choices = _stable_shuffle([correct, *pool[:3]], question)
    return QuizQuestion(
        question=question,
        choices=choices,
        correct_index=choices.index(correct),
        rationale=rationale,
        category=category,
        difficulty=difficulty,
    )


_TEST_PATH_PATTERN = re.compile(
    r"(^|/)(tests?|__tests__|spec)/|(^|/)test_[^/]+\.py$|(\.|_)(test|spec)s?\.[a-z]+$|Tests\.[a-z]+$"
)


def _is_test_path(relative: str) -> bool:
    """Whether ``relative`` is a test file, whatever the stack's convention."""
    return bool(_TEST_PATH_PATTERN.search(relative))


def _iter_code_files(
    root: Path, *, limit: int = 400, scan: ProjectScan | None = None
) -> list[Path]:
    """Yield up to ``limit`` source files, skipping vendored and binary dirs."""
    scan = scan or scan_project(Path(root))
    return [Path(root) / rel for rel in scan.code_files[:limit]]


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------


def build_tour(guide: OnboardingGuide, root: Path) -> list[TourStep]:
    """Build a sequenced tour from the guide: docs, entry points, layout, code."""
    steps: list[TourStep] = []
    seen: set[str] = set()

    def push(
        *, title: str, path: str, reason: str, category: str, questions: list[str]
    ) -> None:
        if path in seen:
            return
        seen.add(path)
        steps.append(
            TourStep(
                order=len(steps) + 1,
                title=title,
                file_path=path,
                reason=reason,
                suggested_questions=questions,
                category=category,
            )
        )

    project = guide.project_name

    for kf in [k for k in guide.key_files if k.category == "docs"][:3]:
        push(
            title=kf.path,
            path=kf.path,
            reason=kf.reason,
            category="doc",
            questions=[
                f"What does {kf.path} say the project is for?",
                "Which claims in it does the code actually back up?",
            ],
        )

    for entry in guide.entry_points[:3]:
        push(
            title=entry.path,
            path=entry.path,
            reason=entry.reason,
            category="entrypoint",
            questions=[
                f"What is wired up when {entry.path} runs?",
                "Which dependencies are registered here, and where are they used?",
            ],
        )

    for node in guide.architecture[:5]:
        push(
            title=f"{node.path}/",
            path=node.path,
            reason=f"{node.role} — {node.file_count} files"
            + (f", mostly {', '.join(node.languages)}" if node.languages else ""),
            category="directory",
            questions=[
                f"What belongs in {node.path}/ and what does not?",
                f"Which layer does {node.path}/ depend on?",
            ],
        )

    for kf in [k for k in guide.key_files if k.category == "config"][:3]:
        push(
            title=kf.path,
            path=kf.path,
            reason=kf.reason,
            category="file",
            questions=[
                f"What would break if {kf.path} were wrong?",
                "Which values here differ between environments?",
            ],
        )

    for kf in [k for k in guide.key_files if k.category == "source"][:4]:
        push(
            title=kf.path,
            path=kf.path,
            reason=kf.reason,
            category="file",
            questions=[
                f"What problem does {kf.path} solve?",
                f"Which other files in {project} depend on {kf.path}?",
            ],
        )

    for kf in [k for k in guide.key_files if k.category == "ci"][:1]:
        push(
            title=kf.path,
            path=kf.path,
            reason=kf.reason,
            category="file",
            questions=[
                "Which checks must pass before a PR can merge?",
                "Can you run those same checks locally?",
            ],
        )

    return steps[:16]


def build_quiz(
    tour: list[TourStep], guide: OnboardingGuide, *, limit: int = 12
) -> list[QuizQuestion]:
    """Generate multiple-choice questions covering the whole guide."""
    quiz: list[QuizQuestion] = []
    seen_questions: set[str] = set()

    def add(question: QuizQuestion | None) -> None:
        if question is None or question.question in seen_questions:
            return
        seen_questions.add(question.question)
        quiz.append(question)

    # --- stack ------------------------------------------------------------
    if guide.tech_stack:
        primary = guide.tech_stack[0]
        add(
            _make_question(
                f"What is the primary technology of {guide.project_name}?",
                primary,
                [t for t in _STACK_DISTRACTORS if t not in guide.tech_stack],
                rationale=f"Detected from the project files: {', '.join(guide.tech_stack[:6])}",
                category="stack",
            )
        )
        absent = [t for t in _STACK_DISTRACTORS if t not in guide.tech_stack]
        if absent and len(guide.tech_stack) >= 3:
            add(
                _make_question(
                    "Which of these is NOT part of this project's stack?",
                    absent[0],
                    guide.tech_stack[:6],
                    rationale=f"The detected stack is: {', '.join(guide.tech_stack[:6])}",
                    category="stack",
                    difficulty="medium",
                )
            )

    # --- entry point ------------------------------------------------------
    if guide.entry_points:
        entry = guide.entry_points[0]
        add(
            _make_question(
                "Where does the application start executing?",
                entry.path,
                [k.path for k in guide.key_files if k.path != entry.path],
                rationale=entry.reason,
                category="files",
                fillers=_FILLER_PATHS,
            )
        )

    # --- key files, both directions --------------------------------------
    described = [k for k in guide.key_files if k.reason][:10]
    for kf in described[:4]:
        add(
            _make_question(
                f"Which file's purpose is: {kf.reason!r}?",
                kf.path,
                [other.path for other in described if other.path != kf.path],
                rationale=f"`{kf.path}` — {kf.reason}",
                category="files",
                fillers=_FILLER_PATHS,
            )
        )
    for kf in described[:3]:
        add(
            _make_question(
                f"What is the role of `{kf.path}`?",
                kf.reason,
                [other.reason for other in described if other.reason != kf.reason],
                rationale=f"`{kf.path}` — {kf.reason}",
                category="files",
                difficulty="medium",
            )
        )

    # --- architecture -----------------------------------------------------
    roles = [node.role for node in guide.architecture]
    for node in guide.architecture[:4]:
        add(
            _make_question(
                f"What does `{node.path}/` hold?",
                node.role,
                [role for role in roles if role != node.role],
                rationale=f"`{node.path}/` — {node.role} ({node.file_count} files)",
                category="architecture",
                difficulty="medium",
            )
        )

    # --- commands ---------------------------------------------------------
    commands = guide.commands
    by_category = {
        "test": "Which command runs the test suite?",
        "setup": "Which command installs the project's dependencies?",
        "build": "Which command builds the project?",
        "lint": "Which command checks formatting and lint rules?",
    }
    for category, question in by_category.items():
        matching = [c for c in commands if c.category == category]
        if not matching:
            continue
        correct = matching[0]
        add(
            _make_question(
                question,
                correct.command,
                [c.command for c in commands if c.category != category],
                rationale=f"`{correct.command}` — from {correct.source or 'the project manifest'}",
                category="commands",
            )
        )

    # --- conventions ------------------------------------------------------
    for convention in guide.conventions[:3]:
        add(
            _make_question(
                f"Which convention does {guide.project_name} follow?",
                convention.name,
                [
                    "No linter is configured",
                    "Formatting is left to each developer",
                    "Tests are written after release",
                ],
                rationale=convention.description,
                category="conventions",
                difficulty="medium",
            )
        )
        break

    test_convention = next(
        (c for c in guide.conventions if c.name.startswith("Tests live as")), None
    )
    if test_convention and test_convention.examples:
        add(
            _make_question(
                "Where does a new test file belong?",
                test_convention.name.replace("Tests live as ", ""),
                [
                    "Anywhere in the repository root",
                    "Inside the build output directory",
                    "In a personal folder outside the repository",
                ],
                rationale=test_convention.description
                + " e.g. "
                + ", ".join(f"`{e}`" for e in test_convention.examples[:2]),
                category="conventions",
                difficulty="medium",
            )
        )

    # --- tour recall ------------------------------------------------------
    directory_steps = [s for s in tour if s.category == "directory"]
    for step in directory_steps[:2]:
        add(
            _make_question(
                f"During the tour, why does `{step.file_path}` matter?",
                step.reason,
                [other.reason for other in tour if other.reason != step.reason],
                rationale=step.reason,
                category="architecture",
                difficulty="hard",
            )
        )

    return _balance(quiz, limit)


def _balance(quiz: list[QuizQuestion], limit: int) -> list[QuizQuestion]:
    """Keep every category represented before deepening any one of them.

    Truncating a difficulty-sorted list drops whole topics: the easy questions
    are mostly about files, so a 12-question cap ended the quiz before it ever
    asked about the architecture.
    """
    buckets: dict[str, list[QuizQuestion]] = {}
    for question in quiz:
        buckets.setdefault(question.category, []).append(question)

    selected: list[QuizQuestion] = []
    while len(selected) < limit and any(buckets.values()):
        for category in list(buckets):
            if len(selected) >= limit:
                break
            if buckets[category]:
                selected.append(buckets[category].pop(0))

    order = {"easy": 0, "medium": 1, "hard": 2}
    selected.sort(key=lambda q: order[q.difficulty])
    return selected


def build_first_tasks(
    root: Path,
    *,
    limit: int = 12,
    guide: OnboardingGuide | None = None,
    scan: ProjectScan | None = None,
) -> list[FirstTask]:
    """Surface TODO/FIXME comments, then derive tasks when there are too few."""
    root = Path(root)
    scan = scan or scan_project(root)
    tasks: list[FirstTask] = []

    for path in _iter_code_files(root, scan=scan, limit=600):
        if len(tasks) >= limit:
            break
        relative = str(path.relative_to(root)).replace("\\", "/")
        # A TODO inside a test fixture is a string literal, not a task.
        if _is_test_path(relative):
            continue
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for lineno, line in enumerate(lines, start=1):
            match = _TODO_PATTERN.search(line)
            if not match:
                continue
            tag, note = match.group(1).upper(), match.group(2).strip()
            if len(note) < 4:
                continue
            note = note.replace("\\n", " ").strip(" \"',;")
            if len(note) < 4:
                continue
            tasks.append(
                FirstTask(
                    title=f"{tag}: {note[:100]}",
                    file_path=relative,
                    line=lineno,
                    source_comment=line.strip()[:200],
                    category="todo",
                    difficulty="medium" if tag in {"FIXME", "HACK", "XXX"} else "easy",
                    why="Left in the code by the team — a scoped, real change.",
                )
            )
            if len(tasks) >= limit:
                break

    if guide is not None and len(tasks) < limit:
        tasks.extend(_derive_first_tasks(guide, scan, budget=limit - len(tasks)))

    return tasks[:limit]


def _derive_first_tasks(
    guide: OnboardingGuide, scan: ProjectScan, *, budget: int
) -> list[FirstTask]:
    """Suggestions for a repository with no TODO markers left to pick up.

    "No good first issue" is almost never true — it usually means nobody wrote
    the marker. Untested modules and undocumented entry points are the same
    invitation, derived rather than typed.
    """
    derived: list[FirstTask] = []

    tested_stems = {
        Path(f)
        .stem.replace("test_", "")
        .replace(".test", "")
        .replace(".spec", "")
        .replace("Tests", "")
        for f in scan.code_files
        if _is_test_path(f)
    }

    for kf in guide.key_files:
        if len(derived) >= budget:
            break
        if kf.category != "source" or kf.lines < 80:
            continue
        if Path(kf.path).stem in tested_stems:
            continue
        derived.append(
            FirstTask(
                title=f"Add a first test for {Path(kf.path).name}",
                file_path=kf.path,
                line=1,
                source_comment=f"{kf.lines} lines, no test file matching its name",
                category="tests",
                difficulty="medium",
                why="Reading a file closely enough to test it is the fastest way to learn it.",
            )
        )

    for entry in guide.entry_points:
        if len(derived) >= budget:
            break
        text = scan.read(entry.path, max_chars=4000)
        if not text or text.lstrip().startswith(("/**", '"""', "///", "//", "#")):
            continue
        derived.append(
            FirstTask(
                title=f"Document what {Path(entry.path).name} wires up",
                file_path=entry.path,
                line=1,
                source_comment="Entry point with no header comment",
                category="docs",
                difficulty="easy",
                why="Writing it down forces you to follow the startup path once.",
            )
        )

    if not guide.commands and len(derived) < budget:
        derived.append(
            FirstTask(
                title="Document how to run the project",
                file_path="README.md",
                line=1,
                source_comment="No install/run/test command could be detected",
                category="docs",
                difficulty="easy",
                why="Nothing in the repository states how to start it.",
            )
        )

    for node in guide.architecture:
        if len(derived) >= budget:
            break
        if node.file_count < 5 or node.path.startswith("."):
            continue
        derived.append(
            FirstTask(
                title=f"Map the dependencies of {node.path}/",
                file_path=node.path,
                line=1,
                source_comment=f"{node.role} — {node.file_count} files",
                category="explore",
                difficulty="easy",
                why="Draw what this directory imports and what imports it.",
            )
        )

    return derived[:budget]


_IDENT_PATTERN = re.compile(r"\b([A-Z][A-Za-z0-9]{4,}|[a-z]{5,}_[a-z]+)\b")
_TYPE_PATTERN = re.compile(
    r"\b(?:class|interface|record|struct|enum|type)\s+([A-Z][A-Za-z0-9]{3,})"
)


def build_glossary(
    root: Path,
    *,
    top_n: int = 24,
    architecture: list[ArchitectureNode] | None = None,
    scan: ProjectScan | None = None,
) -> list[GlossaryTerm]:
    """Extract domain terms from filenames, directories and declared types."""
    root = Path(root)
    scan = scan or scan_project(root)

    counter: Counter[str] = Counter()
    sources: dict[str, list[str]] = {}
    kinds: dict[str, str] = {}
    labels: dict[str, str] = {}
    declarations: dict[str, str] = {}

    directory_roles = {
        node.path.rsplit("/", 1)[-1]: node.role for node in (architecture or [])
    }

    def record(term: str, label: str, source: str, kind: str) -> None:
        key = term.lower()
        if key in _COMMON_STOP_WORDS or len(key) < 5:
            return
        counter[key] += 1
        sources.setdefault(key, []).append(source)
        labels.setdefault(key, label)
        # A declared type beats a filename token, which beats a bare identifier.
        rank = {"directory": 3, "type": 2, "module": 1, "identifier": 0}
        if rank[kind] >= rank.get(kinds.get(key, "identifier"), 0):
            kinds[key] = kind

    for name in directory_roles:
        if name.startswith("."):
            continue
        record(name, name, name, "directory")
        counter[name.lower()] += 2

    for rel in scan.code_files[:600]:
        for token in re.split(r"[_\-\s.]", Path(rel).stem):
            if len(token) >= 5:
                record(token, token, rel, "module")

        text = scan.read(rel, max_chars=8000)
        if not text:
            continue
        for match in _TYPE_PATTERN.finditer(text):
            name = match.group(1)
            record(name, name, rel, "type")
            declarations.setdefault(name.lower(), rel)
        for match in _IDENT_PATTERN.finditer(text[:4000]):
            record(match.group(1), match.group(1), rel, "identifier")

    # Domain vocabulary sits in directory names, declared types and module
    # names. Raw frequency alone puts `Exception` and `project_dir` at the top
    # of every project's glossary, which teaches nobody anything.
    kind_rank = {"directory": 0, "type": 1, "module": 2, "identifier": 3}
    ordered = sorted(
        counter.items(),
        key=lambda item: (
            kind_rank.get(kinds.get(item[0], "identifier"), 3),
            -item[1],
            item[0],
        ),
    )[:top_n]

    entries: list[GlossaryTerm] = []
    for term, count in ordered:
        kind = kinds.get(term, "identifier")
        unique_sources = list(dict.fromkeys(sources.get(term, [])))
        entries.append(
            GlossaryTerm(
                term=labels.get(term, term),
                occurrences=count,
                sources=unique_sources[:3],
                kind=kind,
                definition=_definition_for(
                    term, kind, directory_roles, declarations, unique_sources
                ),
            )
        )
    return entries


def _definition_for(
    term: str,
    kind: str,
    directory_roles: dict[str, str],
    declarations: dict[str, str],
    sources: list[str],
) -> str:
    if kind == "directory":
        for name, role in directory_roles.items():
            if name.lower() == term:
                return role
        return "Directory of the project"
    if kind == "type":
        declared = declarations.get(term)
        return (
            f"Type declared in `{declared}`"
            if declared
            else "Type declared in the codebase"
        )
    if kind == "module":
        return (
            f"Appears in the name of {len(sources)} file(s)"
            if sources
            else "File name token"
        )
    return "Recurring identifier — likely domain vocabulary"


# ---------------------------------------------------------------------------
# Facade
# ---------------------------------------------------------------------------


class OnboardingPackageBuilder:
    """High-level API — call ``build(repo_root)`` to get the full package."""

    def __init__(self, engine: OnboardingEngine | None = None) -> None:
        self.engine = engine or OnboardingEngine()

    def build(self, repo_root: Path) -> OnboardingPackage:
        root = Path(repo_root).resolve()
        scan = scan_project(root)
        guide = self.engine.generate(root, scan=scan)
        tour = build_tour(guide, root)
        quiz = build_quiz(tour, guide)
        first_tasks = build_first_tasks(root, guide=guide, scan=scan)
        glossary = build_glossary(root, architecture=guide.architecture, scan=scan)
        return OnboardingPackage(
            guide=guide,
            tour=tour,
            quiz=quiz,
            first_tasks=first_tasks,
            glossary=glossary,
        )


def render_markdown(package: OnboardingPackage) -> str:
    """Render the package as a single markdown document."""
    g = package.guide
    out: list[str] = [f"# Onboarding — {g.project_name}\n"]
    if g.tech_stack:
        out.append(f"**Tech stack:** {', '.join(g.tech_stack)}\n")
    if g.stats:
        out.append(
            "**At a glance:** "
            + ", ".join(
                f"{value} {key.replace('_', ' ')}" for key, value in g.stats.items()
            )
            + "\n"
        )
    out.append(f"**Estimated reading time:** {g.estimated_reading_time_min} min\n")

    for section in (
        "getting_started",
        "architecture",
        "testing",
        "dependencies",
        "deployment",
    ):
        body = g.sections.get(section)
        if body:
            out.append(f"\n{body}\n")

    if g.commands:
        out.append("\n## Commands\n")
        for command in g.commands:
            out.append(f"- `{command.command}` — {command.label} ({command.category})")
        out.append("")

    out.append("\n## Guided Tour\n")
    for step in package.tour:
        out.append(f"### {step.order}. {step.title}")
        out.append(f"- **Path:** `{step.file_path}`")
        out.append(f"- **Why:** {step.reason}")
        if step.suggested_questions:
            out.append("- **Ask yourself:**")
            for question in step.suggested_questions:
                out.append(f"  - {question}")
        out.append("")

    if g.conventions:
        out.append("\n## Conventions\n")
        for convention in g.conventions:
            out.append(f"- **{convention.name}** — {convention.description}")
        out.append("")

    if package.quiz:
        out.append("\n## Comprehension Check\n")
        for i, q in enumerate(package.quiz, start=1):
            out.append(f"**Q{i}. [{q.category}/{q.difficulty}] {q.question}**")
            for j, choice in enumerate(q.choices):
                out.append(f"  {chr(ord('a') + j)}) {choice}")
            out.append(
                f"  _Answer: {chr(ord('a') + q.correct_index)} — {q.rationale}_\n"
            )

    if package.first_tasks:
        out.append("\n## Good First Tasks\n")
        for t in package.first_tasks:
            out.append(f"- `{t.file_path}:{t.line}` — {t.title} _({t.category})_")
        out.append("")

    if package.glossary:
        out.append("\n## Glossary\n")
        for term in package.glossary:
            srcs = ", ".join(f"`{s}`" for s in term.sources) or "—"
            out.append(
                f"- **{term.term}** ({term.kind}, {term.occurrences}×) — "
                f"{term.definition}. Seen in {srcs}"
            )

    return "\n".join(out)
