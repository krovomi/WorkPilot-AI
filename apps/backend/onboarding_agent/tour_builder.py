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

from .messages import Text, raw, text
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
    reason_i18n: Text | None = None
    suggested_questions_i18n: list[Text] = field(default_factory=list)


@dataclass
class QuizQuestion:
    """A multiple-choice question generated from the guide."""

    question: str
    choices: list[str]
    correct_index: int
    rationale: str = ""
    category: str = "general"  # stack | files | architecture | commands | conventions
    difficulty: str = "easy"  # easy | medium | hard
    question_i18n: Text | None = None
    rationale_i18n: Text | None = None
    # One descriptor per choice, in the same order: a question whose answers
    # are roles or reasons has to translate them too, or the right answer is
    # the one written in a different language.
    choices_i18n: list[Text] = field(default_factory=list)


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
    title_i18n: Text | None = None
    source_comment_i18n: Text | None = None
    why_i18n: Text | None = None


@dataclass
class GlossaryTerm:
    """A domain term detected in the codebase."""

    term: str
    occurrences: int
    sources: list[str] = field(default_factory=list)
    kind: str = "identifier"  # directory | type | module | identifier
    definition: str = ""
    definition_i18n: Text | None = None


def _as_dict(value: Text | None) -> dict[str, Any] | None:
    return value.to_dict() if value is not None else None


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
                "key_files": [_key_file_dict(kf) for kf in self.guide.key_files],
                "entry_points": [_key_file_dict(kf) for kf in self.guide.entry_points],
                "conventions": [_convention_dict(c) for c in self.guide.conventions],
                "commands": [_command_dict(c) for c in self.guide.commands],
                "architecture": [_node_dict(a) for a in self.guide.architecture],
                "sections": self.guide.sections,
                "section_lines": {
                    name: [line.to_dict() for line in lines]
                    for name, lines in self.guide.section_lines.items()
                },
                "stats": self.guide.stats,
                "estimated_reading_time_min": self.guide.estimated_reading_time_min,
            },
            "tour": [_tour_dict(s) for s in self.tour],
            "quiz": [_quiz_dict(q) for q in self.quiz],
            "first_tasks": [_task_dict(t) for t in self.first_tasks],
            "glossary": [_glossary_dict(g) for g in self.glossary],
        }


def _key_file_dict(kf: Any) -> dict[str, Any]:
    payload = asdict(kf)
    payload["reason_i18n"] = _as_dict(kf.reason_i18n)
    return payload


def _convention_dict(convention: Any) -> dict[str, Any]:
    payload = asdict(convention)
    payload["name_i18n"] = _as_dict(convention.name_i18n)
    payload["description_i18n"] = _as_dict(convention.description_i18n)
    return payload


def _command_dict(command: Any) -> dict[str, Any]:
    payload = asdict(command)
    payload["label_i18n"] = _as_dict(command.label_i18n)
    return payload


def _node_dict(node: Any) -> dict[str, Any]:
    payload = asdict(node)
    payload["role_i18n"] = _as_dict(node.role_i18n)
    return payload


def _tour_dict(step: TourStep) -> dict[str, Any]:
    payload = asdict(step)
    payload["reason_i18n"] = _as_dict(step.reason_i18n)
    payload["suggested_questions_i18n"] = [
        question.to_dict() for question in step.suggested_questions_i18n
    ]
    return payload


def _quiz_dict(question: QuizQuestion) -> dict[str, Any]:
    payload = asdict(question)
    payload["question_i18n"] = _as_dict(question.question_i18n)
    payload["rationale_i18n"] = _as_dict(question.rationale_i18n)
    payload["choices_i18n"] = [choice.to_dict() for choice in question.choices_i18n]
    return payload


def _task_dict(task: FirstTask) -> dict[str, Any]:
    payload = asdict(task)
    payload["title_i18n"] = _as_dict(task.title_i18n)
    payload["source_comment_i18n"] = _as_dict(task.source_comment_i18n)
    payload["why_i18n"] = _as_dict(task.why_i18n)
    return payload


def _glossary_dict(term: GlossaryTerm) -> dict[str, Any]:
    payload = asdict(term)
    payload["definition_i18n"] = _as_dict(term.definition_i18n)
    return payload


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
    question: Text,
    correct: Text,
    distractors: list[Text],
    *,
    rationale: Text | None = None,
    category: str = "general",
    difficulty: str = "easy",
    fillers: list[Text] | None = None,
) -> QuizQuestion | None:
    """Build one shuffled MCQ, or ``None`` when there is nothing to ask.

    Everything in and out is a :class:`Text`: the question, every choice and
    the rationale. Shuffling and de-duplication key on the English fallback, so
    the same project always produces the same quiz whatever the UI language.
    """
    pool: list[Text] = []
    seen = {correct.fallback}
    for candidate in [*distractors, *(fillers or [])]:
        if len(pool) >= 3:
            break
        if candidate.fallback and candidate.fallback not in seen:
            seen.add(candidate.fallback)
            pool.append(candidate)
    if len(pool) < 2:
        return None

    by_fallback = {choice.fallback: choice for choice in [correct, *pool[:3]]}
    ordered = _stable_shuffle(list(by_fallback), question.fallback)
    return QuizQuestion(
        question=question.fallback,
        question_i18n=question,
        choices=ordered,
        choices_i18n=[by_fallback[value] for value in ordered],
        correct_index=ordered.index(correct.fallback),
        rationale=rationale.fallback if rationale else "",
        rationale_i18n=rationale,
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
        *, title: str, path: str, reason: Text, category: str, questions: list[Text]
    ) -> None:
        if path in seen:
            return
        seen.add(path)
        steps.append(
            TourStep(
                order=len(steps) + 1,
                title=title,
                file_path=path,
                reason=reason.fallback,
                reason_i18n=reason,
                suggested_questions=[q.fallback for q in questions],
                suggested_questions_i18n=questions,
                category=category,
            )
        )

    project = guide.project_name

    def reason_of(kf: Any) -> Text:
        return kf.reason_i18n or raw(kf.reason)

    for kf in [k for k in guide.key_files if k.category == "docs"][:3]:
        push(
            title=kf.path,
            path=kf.path,
            reason=reason_of(kf),
            category="doc",
            questions=[
                text("tour.question.docPurpose", path=kf.path),
                text("tour.question.docClaims"),
            ],
        )

    for entry in guide.entry_points[:3]:
        push(
            title=entry.path,
            path=entry.path,
            reason=reason_of(entry),
            category="entrypoint",
            questions=[
                text("tour.question.entryWiring", path=entry.path),
                text("tour.question.entryDependencies"),
            ],
        )

    for node in guide.architecture[:5]:
        role = node.role_i18n or raw(node.role)
        reason = (
            text(
                "tour.reason.directoryLanguages",
                role=role,
                count=node.file_count,
                languages=", ".join(node.languages),
            )
            if node.languages
            else text("tour.reason.directory", role=role, count=node.file_count)
        )
        push(
            title=f"{node.path}/",
            path=node.path,
            reason=reason,
            category="directory",
            questions=[
                text("tour.question.directoryBelongs", path=node.path),
                text("tour.question.directoryLayer", path=node.path),
            ],
        )

    for kf in [k for k in guide.key_files if k.category == "config"][:3]:
        push(
            title=kf.path,
            path=kf.path,
            reason=reason_of(kf),
            category="file",
            questions=[
                text("tour.question.configBreakage", path=kf.path),
                text("tour.question.configEnvironments"),
            ],
        )

    for kf in [k for k in guide.key_files if k.category == "source"][:4]:
        push(
            title=kf.path,
            path=kf.path,
            reason=reason_of(kf),
            category="file",
            questions=[
                text("tour.question.sourceProblem", path=kf.path),
                text("tour.question.sourceDependents", project=project, path=kf.path),
            ],
        )

    for kf in [k for k in guide.key_files if k.category == "ci"][:1]:
        push(
            title=kf.path,
            path=kf.path,
            reason=reason_of(kf),
            category="file",
            questions=[
                text("tour.question.ciChecks"),
                text("tour.question.ciLocal"),
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

    def reason_of(item: Any) -> Text:
        return item.reason_i18n or raw(item.reason)

    # --- stack ------------------------------------------------------------
    # Technology names, paths and commands are values, not prose: they go
    # through `raw` and read the same in every language.
    if guide.tech_stack:
        stack_label = ", ".join(guide.tech_stack[:6])
        absent = [t for t in _STACK_DISTRACTORS if t not in guide.tech_stack]
        add(
            _make_question(
                text("quiz.primaryTech.question", project=guide.project_name),
                raw(guide.tech_stack[0]),
                [raw(t) for t in absent],
                rationale=text("quiz.primaryTech.rationale", stack=stack_label),
                category="stack",
            )
        )
        if absent and len(guide.tech_stack) >= 3:
            add(
                _make_question(
                    text("quiz.notInStack.question"),
                    raw(absent[0]),
                    [raw(t) for t in guide.tech_stack[:6]],
                    rationale=text("quiz.notInStack.rationale", stack=stack_label),
                    category="stack",
                    difficulty="medium",
                )
            )

    fillers = [raw(path) for path in _FILLER_PATHS]

    # --- entry point ------------------------------------------------------
    if guide.entry_points:
        entry = guide.entry_points[0]
        add(
            _make_question(
                text("quiz.entryPoint.question"),
                raw(entry.path),
                [raw(k.path) for k in guide.key_files if k.path != entry.path],
                rationale=reason_of(entry),
                category="files",
                fillers=fillers,
            )
        )

    # --- key files, both directions --------------------------------------
    described = [k for k in guide.key_files if k.reason][:10]
    for kf in described[:4]:
        add(
            _make_question(
                text("quiz.filePurpose.question", reason=reason_of(kf)),
                raw(kf.path),
                [raw(other.path) for other in described if other.path != kf.path],
                rationale=text(
                    "quiz.filePurpose.rationale", path=kf.path, reason=reason_of(kf)
                ),
                category="files",
                fillers=fillers,
            )
        )
    for kf in described[:3]:
        add(
            _make_question(
                text("quiz.fileRole.question", path=kf.path),
                reason_of(kf),
                [reason_of(other) for other in described if other.reason != kf.reason],
                rationale=text(
                    "quiz.filePurpose.rationale", path=kf.path, reason=reason_of(kf)
                ),
                category="files",
                difficulty="medium",
            )
        )

    # --- architecture -----------------------------------------------------
    def role_of(node: Any) -> Text:
        return node.role_i18n or raw(node.role)

    for node in guide.architecture[:4]:
        add(
            _make_question(
                text("quiz.directoryHolds.question", path=node.path),
                role_of(node),
                [
                    role_of(other)
                    for other in guide.architecture
                    if other.role != node.role
                ],
                rationale=text(
                    "quiz.directoryHolds.rationale",
                    path=node.path,
                    role=role_of(node),
                    count=node.file_count,
                ),
                category="architecture",
                difficulty="medium",
            )
        )

    # --- commands ---------------------------------------------------------
    commands = guide.commands
    for category in ("test", "setup", "build", "lint"):
        matching = [c for c in commands if c.category == category]
        if not matching:
            continue
        correct = matching[0]
        add(
            _make_question(
                text(f"quiz.command.{category}"),
                raw(correct.command),
                [raw(c.command) for c in commands if c.category != category],
                rationale=text(
                    "quiz.command.rationale",
                    command=correct.command,
                    source=correct.source or text("quiz.command.unknownSource"),
                ),
                category="commands",
            )
        )

    # --- conventions ------------------------------------------------------
    def convention_name(convention: Any) -> Text:
        return convention.name_i18n or raw(convention.name)

    for convention in guide.conventions[:1]:
        add(
            _make_question(
                text("quiz.convention.question", project=guide.project_name),
                convention_name(convention),
                [
                    text("quiz.convention.noLinter"),
                    text("quiz.convention.perDeveloper"),
                    text("quiz.convention.afterRelease"),
                ],
                rationale=convention.description_i18n or raw(convention.description),
                category="conventions",
                difficulty="medium",
            )
        )

    test_convention = next(
        (c for c in guide.conventions if c.name.startswith("Tests live as")), None
    )
    if test_convention and test_convention.examples:
        # The pattern is a parameter of the convention's own message, so the
        # answer reads exactly as the Conventions list does.
        pattern = (
            test_convention.name_i18n.params.get("pattern")
            if test_convention.name_i18n
            else None
        )
        add(
            _make_question(
                text("quiz.testLocation.question"),
                pattern or raw(test_convention.name.replace("Tests live as ", "")),
                [
                    text("quiz.testLocation.root"),
                    text("quiz.testLocation.buildOutput"),
                    text("quiz.testLocation.personalFolder"),
                ],
                rationale=text(
                    "quiz.testLocation.rationale",
                    description=test_convention.description_i18n
                    or raw(test_convention.description),
                    examples=", ".join(f"`{e}`" for e in test_convention.examples[:2]),
                ),
                category="conventions",
                difficulty="medium",
            )
        )

    # --- tour recall ------------------------------------------------------
    def step_reason(step: TourStep) -> Text:
        return step.reason_i18n or raw(step.reason)

    directory_steps = [s for s in tour if s.category == "directory"]
    for step in directory_steps[:2]:
        add(
            _make_question(
                text("quiz.tourRecall.question", path=step.file_path),
                step_reason(step),
                [step_reason(other) for other in tour if other.reason != step.reason],
                rationale=step_reason(step),
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
            # The marker and the note are the team's own words: kept verbatim,
            # only the surrounding sentence is translated.
            title = text("firstTask.todo.title", tag=tag, note=note[:100])
            why = text("firstTask.todo.why")
            tasks.append(
                FirstTask(
                    title=title.fallback,
                    title_i18n=title,
                    file_path=relative,
                    line=lineno,
                    source_comment=line.strip()[:200],
                    category="todo",
                    difficulty="medium" if tag in {"FIXME", "HACK", "XXX"} else "easy",
                    why=why.fallback,
                    why_i18n=why,
                )
            )
            if len(tasks) >= limit:
                break

    if guide is not None and len(tasks) < limit:
        tasks.extend(_derive_first_tasks(guide, scan, budget=limit - len(tasks)))

    return tasks[:limit]


def _derived_task(
    *,
    title: Text,
    comment: Text,
    why: Text,
    file_path: str,
    category: str,
    difficulty: str,
) -> FirstTask:
    """A task whose every sentence is generated, so every one is translated."""
    return FirstTask(
        title=title.fallback,
        title_i18n=title,
        file_path=file_path,
        line=1,
        source_comment=comment.fallback,
        source_comment_i18n=comment,
        category=category,
        difficulty=difficulty,
        why=why.fallback,
        why_i18n=why,
    )


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
            _derived_task(
                title=text("firstTask.tests.title", file=Path(kf.path).name),
                comment=text("firstTask.tests.comment", lines=kf.lines),
                why=text("firstTask.tests.why"),
                file_path=kf.path,
                category="tests",
                difficulty="medium",
            )
        )

    for entry in guide.entry_points:
        if len(derived) >= budget:
            break
        content = scan.read(entry.path, max_chars=4000)
        if not content or content.lstrip().startswith(("/**", '"""', "///", "//", "#")):
            continue
        derived.append(
            _derived_task(
                title=text("firstTask.docs.title", file=Path(entry.path).name),
                comment=text("firstTask.docs.comment"),
                why=text("firstTask.docs.why"),
                file_path=entry.path,
                category="docs",
                difficulty="easy",
            )
        )

    if not guide.commands and len(derived) < budget:
        derived.append(
            _derived_task(
                title=text("firstTask.readme.title"),
                comment=text("firstTask.readme.comment"),
                why=text("firstTask.readme.why"),
                file_path="README.md",
                category="docs",
                difficulty="easy",
            )
        )

    for node in guide.architecture:
        if len(derived) >= budget:
            break
        if node.file_count < 5 or node.path.startswith("."):
            continue
        derived.append(
            _derived_task(
                title=text("firstTask.explore.title", path=node.path),
                comment=text(
                    "firstTask.explore.comment",
                    role=node.role_i18n or raw(node.role),
                    count=node.file_count,
                ),
                why=text("firstTask.explore.why"),
                file_path=node.path,
                category="explore",
                difficulty="easy",
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

    directory_roles: dict[str, Text] = {
        node.path.rsplit("/", 1)[-1]: (node.role_i18n or raw(node.role))
        for node in (architecture or [])
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
        definition = _definition_for(
            term, kind, directory_roles, declarations, unique_sources
        )
        entries.append(
            GlossaryTerm(
                term=labels.get(term, term),
                occurrences=count,
                sources=unique_sources[:3],
                kind=kind,
                definition=definition.fallback,
                definition_i18n=definition,
            )
        )
    return entries


def _definition_for(
    term: str,
    kind: str,
    directory_roles: dict[str, Text],
    declarations: dict[str, str],
    sources: list[str],
) -> Text:
    """A term's definition — the directory's own role when there is one."""
    if kind == "directory":
        for name, role in directory_roles.items():
            if name.lower() == term:
                return role
        return text("glossary.directory")
    if kind == "type":
        declared = declarations.get(term)
        return (
            text("glossary.type", path=declared)
            if declared
            else text("glossary.typeGeneric")
        )
    if kind == "module":
        return (
            text("glossary.module", count=len(sources))
            if sources
            else text("glossary.moduleGeneric")
        )
    return text("glossary.identifier")


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
