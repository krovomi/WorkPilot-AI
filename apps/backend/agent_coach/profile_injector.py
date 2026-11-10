"""The profile as a prompt section, and a task's diff checked against it.

``profile_block`` is what the coder and the QA fixer read, on every provider
(the prompts are built in Python for all of them). It is written from fixed
phrases chosen by closed-list values, never from text in the profile file.
The task's own instructions win: a person who asks for a functional style in
one task gets it, whatever the profile says.

``deviations`` compares what a task added with the profile: the page shows
"the task used snake_case, your profile says camelCase" before the review.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

from .profile_store import effective, load_preferences, load_profile
from .style_dimensions import measure

__all__ = ["PHRASES", "deviations", "main_project", "profile_block"]

MAX_LANGUAGES = 12
PHRASES: dict[tuple[str, str], str] = {
    ("naming_functions", "camelCase"): "functions in camelCase",
    ("naming_functions", "snake_case"): "functions in snake_case",
    ("naming_functions", "PascalCase"): "functions in PascalCase",
    ("naming_variables", "camelCase"): "variables in camelCase",
    ("naming_variables", "snake_case"): "variables in snake_case",
    ("naming_variables", "PascalCase"): "variables in PascalCase",
    ("name_length", "short"): "short names are fine",
    ("name_length", "descriptive"): "descriptive names, no abbreviations",
    ("comments", "none"): "almost no comments",
    ("comments", "minimal"): "few comments, only where the code is not obvious",
    ("comments", "verbose"): "generous comments",
    ("doc_comments", "documented"): "a doc comment on each function",
    ("doc_comments", "undocumented"): "no doc comment unless asked",
    ("comment_language", "en"): "comments in English",
    ("comment_language", "fr"): "comments in French",
    ("function_length", "short"): "short functions (about 20 lines at most)",
    ("function_length", "medium"): "functions up to about 50 lines",
    ("function_length", "long"): "long functions are acceptable",
    ("imports", "named"): "named imports (`import { x } from`)",
    ("imports", "default"): "default imports",
    ("imports", "from_import"): "`from module import name`",
    ("imports", "module_import"): "`import module`",
    ("error_handling", "exceptions"): "errors as exceptions (try/catch)",
    ("error_handling", "result_types"): "errors as result types rather than exceptions",
    ("guard_style", "early_return"): "early returns rather than nested conditions",
    ("guard_style", "nested"): "nested conditions are fine",
    ("assertions", "few"): "tests with one or two assertions",
    ("assertions", "many"): "tests that check several things at once",
    ("mocking", "framework"): "mocks from the test framework",
    ("mocking", "manual"): "hand-written fakes rather than mocking libraries",
}
_LANGUAGE_NAMES = {
    "python": "Python",
    "javascript": "JavaScript",
    "typescript": "TypeScript",
    "csharp": "C#",
    "java": "Java",
    "kotlin": "Kotlin",
    "go": "Go",
    "rust": "Rust",
    "ruby": "Ruby",
    "php": "PHP",
    "swift": "Swift",
    "dart": "Dart",
    "scala": "Scala",
    "cpp": "C++",
    "c": "C",
    "fsharp": "F#",
}


def main_project(path: str | Path) -> Path:
    """A task worktree's own project (``<project>/.workpilot/worktrees/…``), else *path*."""
    parts = Path(path).resolve().parts
    for index, part in enumerate(parts):
        if part == ".workpilot" and index:
            return Path(*parts[:index])
    return Path(path)


def profile_block(project_dir: str | Path) -> str:
    """The style section for an agent prompt, or "" when the coach is off or knows nothing. Never raises.

    *project_dir* may be the task's worktree: the profile is read in its project.
    """
    try:
        root = main_project(project_dir)
        preferences = load_preferences(root)
        if not preferences["enabled"]:
            return ""
        styles = effective(load_profile(root), preferences)
    except (OSError, ValueError, TypeError):
        return ""
    lines = []
    for language in sorted(styles)[:MAX_LANGUAGES]:
        phrases = [
            PHRASES[dim, value]
            for dim, value in sorted(styles[language].items())
            if (dim, value) in PHRASES
        ]
        if phrases:
            lines.append(
                f"- {_LANGUAGE_NAMES.get(language, language)}: {'; '.join(phrases)}."
            )
    if not lines:
        return ""
    return (
        "## The developer's personal style (coach profile)\n\n"
        "Measured from this developer's own commits in this project, or set by them. Follow it where "
        "the task leaves the choice open. The task, the spec and the project's AGENTS.md come first; "
        "when you depart from this style, say why in your summary.\n\n"
        + "\n".join(lines)
        + "\n"
    )


def deviations(
    styles: dict[str, dict[str, str]], files: dict[str, list[str]]
) -> list[dict]:
    """Where the added lines lean to another value than the profile, at least twice."""
    votes: dict[str, Counter] = {}
    for path, lines in files.items():
        language, counted = measure(path, lines)
        if language:
            votes.setdefault(language, Counter()).update(counted)
    found = []
    for language, counted in sorted(votes.items()):
        for dim, expected in sorted(styles.get(language, {}).items()):
            options = {value: n for (d, value), n in counted.items() if d == dim}
            if not options:
                continue
            value, n = max(options.items(), key=lambda item: item[1])
            if value != expected and n >= 2 and n > options.get(expected, 0):
                found.append(
                    {
                        "language": language,
                        "dimension": dim,
                        "expected": expected,
                        "found": value,
                        "count": n,
                    }
                )
    return found
