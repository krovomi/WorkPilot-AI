"""A bounded, read-only brief of a project, for a one-shot completion.

Two dialogs ask a model something about the user's project and wait on the
answer: the prompt optimizer and the context-aware snippet generator. Both need
the same thing first — what the project is, how it is laid out, and the rules it
wrote down for itself — and both need it in the time it takes to open a dialog.
It lived in ``runners/prompt_optimizer_runner.py``; a second runner importing it
from there would have executed ``runners/__init__.py``, which imports the spec,
roadmap, ideation and insights runners eagerly. So it lives here, and the
optimizer re-exports it.

What is read, and nothing more:

- the stack the security profile already cached (``.workpilot-security.json``),
  else the manifests at the project root;
- the top-level layout;
- the head of the files that carry the project's own rules (``AGENTS.md``,
  ``CLAUDE.md``, ``.github/copilot-instructions.md``) and of its README.

No recursive walk, no model, no network, no write.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

# Total budget for the brief handed to the model. The user's request is the
# subject; the brief is there to make the answer specific, not to drown it.
CONTEXT_BUDGET = 6000
DOC_EXCERPT = 1800
MAX_TOP_LEVEL_ENTRIES = 40

# Files whose head carries the project's own conventions, in reading order.
CONVENTION_FILES = ("AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md")
README_FILES = ("README.md", "README.rst", "README.txt", "README")

# Root-level manifests → the stack they reveal. Read at the root only: a
# recursive glob on a monorepo with node_modules costs seconds the dialog is
# spending on a spinner.
MANIFEST_HINTS: dict[str, str] = {
    "package.json": "JavaScript/TypeScript (npm)",
    "tsconfig.json": "TypeScript",
    "pyproject.toml": "Python",
    "requirements.txt": "Python",
    "setup.py": "Python",
    "go.mod": "Go",
    "Cargo.toml": "Rust",
    "pom.xml": "Java (Maven)",
    "build.gradle": "JVM (Gradle)",
    "build.gradle.kts": "Kotlin (Gradle)",
    "Gemfile": "Ruby",
    "composer.json": "PHP",
    "pubspec.yaml": "Dart/Flutter",
    "Package.swift": "Swift",
    "global.json": ".NET",
    "Directory.Build.props": ".NET",
}
MANIFEST_SUFFIXES: dict[str, str] = {
    ".sln": ".NET (solution)",
    ".slnx": ".NET (solution)",
    ".csproj": "C# (.NET)",
    ".fsproj": "F# (.NET)",
}

IGNORED_TOP_LEVEL = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    "dist",
    "build",
    "out",
    "bin",
    "obj",
    ".idea",
    ".vs",
    ".vscode",
    ".next",
    ".turbo",
    "coverage",
}


@dataclass
class ProjectBrief:
    """The brief as text, and what it was built from.

    ``stack`` and ``files`` are what was actually read — a caller that reports
    "context used" reports these, not what a model says it looked at.
    """

    text: str
    stack: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)


def read_head(path: Path, limit: int) -> str:
    """The first ``limit`` characters of a text file, ending on a line boundary."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    text = text.strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    # End on a line boundary so the excerpt does not stop mid-sentence.
    newline = cut.rfind("\n")
    if newline > limit // 2:
        cut = cut[:newline]
    return cut.rstrip() + "\n[…]"


def _cached_stack(project_dir: Path) -> list[str]:
    """The stack the security profile already detected, if it is on disk.

    Read-only on purpose: ``get_or_create_profile`` would analyse the whole
    tree and write the profile into the user's project, which is not what
    opening a dialog should do.
    """
    try:
        from project.analyzer import ProjectAnalyzer

        profile = ProjectAnalyzer(project_dir).load_profile()
    except Exception:  # noqa: BLE001 — context is best-effort
        return []
    if profile is None:
        return []
    stack = profile.detected_stack
    items: list[str] = []
    for group in (stack.languages, stack.frameworks, stack.databases):
        for item in group:
            if item not in items:
                items.append(item)
    return items


def _manifest_stack(project_dir: Path) -> list[str]:
    found: list[str] = []
    try:
        entries = list(project_dir.iterdir())
    except OSError:
        return found
    for entry in entries:
        if not entry.is_file():
            continue
        hint = MANIFEST_HINTS.get(entry.name) or MANIFEST_SUFFIXES.get(entry.suffix)
        if hint and hint not in found:
            found.append(hint)
    return found


def _top_level_layout(project_dir: Path) -> list[str]:
    try:
        entries = sorted(project_dir.iterdir(), key=lambda p: p.name.lower())
    except OSError:
        return []
    layout: list[str] = []
    for entry in entries:
        if entry.name in IGNORED_TOP_LEVEL:
            continue
        if entry.name.startswith(".") and entry.name not in (".github", ".workpilot"):
            continue
        layout.append(entry.name + ("/" if entry.is_dir() else ""))
        if len(layout) >= MAX_TOP_LEVEL_ENTRIES:
            layout.append("…")
            break
    return layout


def build_project_brief(project_dir: Path) -> ProjectBrief:
    """Everything the model is told about the project, and its sources."""
    sections: list[str] = [f"Project name: {project_dir.name}"]
    files: list[str] = []

    stack = _cached_stack(project_dir) or _manifest_stack(project_dir)
    if stack:
        sections.append("Detected stack: " + ", ".join(stack))

    layout = _top_level_layout(project_dir)
    if layout:
        sections.append("Top-level layout: " + ", ".join(layout))

    for name in CONVENTION_FILES:
        path = project_dir / name
        if path.is_file():
            excerpt = read_head(path, DOC_EXCERPT)
            if excerpt:
                sections.append(f"Excerpt of {name} (project conventions):\n{excerpt}")
                files.append(name)

    for name in README_FILES:
        path = project_dir / name
        if path.is_file():
            excerpt = read_head(path, DOC_EXCERPT)
            if excerpt:
                sections.append(f"Excerpt of {name}:\n{excerpt}")
                files.append(name)
            break

    text = "\n\n".join(sections)
    if len(text) > CONTEXT_BUDGET:
        text = text[:CONTEXT_BUDGET].rstrip() + "\n[…]"
    return ProjectBrief(text=text, stack=stack, files=files)


def gather_project_context(project_dir: Path) -> str:
    """The brief as one bounded block of text."""
    return build_project_brief(project_dir).text
