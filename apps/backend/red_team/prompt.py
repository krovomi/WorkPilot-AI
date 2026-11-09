"""The red team session's prompt: the role, the attack surface, the catalog, the test conventions."""

from __future__ import annotations

from pathlib import Path

from mutation_gate.scope import is_test_path

from .payloads import render_catalog
from .surface import Surface

__all__ = ["build_prompt"]

PROMPT_FILE = Path(__file__).resolve().parent.parent / "prompts" / "red_team.md"
MAX_EXAMPLES = 8
_SKIPPED = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "vendor",
    "bin",
    "obj",
    "target",
    "dist",
}


def _existing_tests(root: Path) -> list[str]:
    """A few test files of the project, so the attacks follow its conventions."""
    found: list[str] = []

    def walk(directory: Path, depth: int) -> None:
        if depth > 5 or len(found) >= MAX_EXAMPLES:
            return
        try:
            entries = sorted(directory.iterdir())
        except OSError:
            return
        for entry in entries:
            if (
                entry.name in _SKIPPED
                or entry.name.startswith(".")
                or entry.is_symlink()
            ):
                continue
            if entry.is_dir():
                walk(entry, depth + 1)
            elif is_test_path(entry.relative_to(root).as_posix()):
                found.append(entry.relative_to(root).as_posix())
            if len(found) >= MAX_EXAMPLES:
                return

    walk(root, 0)
    return found


def _role() -> str:
    try:
        return PROMPT_FILE.read_text(encoding="utf-8")
    except OSError:
        return (
            "## YOUR ROLE - RED TEAM AGENT\n\nWrite attack tests for the code below.\n"
        )


def build_prompt(surface: Surface, copy: Path) -> str:
    lines = [_role().rstrip(), "", "## Attack surface", ""]
    for target in surface.targets:
        traits = [target.language]
        if target.endpoint:
            traits.append("serves HTTP routes")
        if target.llm:
            traits.append("hands text to a language model: try the injection mode")
        functions = ", ".join(f"`{f}`" for f in target.functions) or "(read the file)"
        lines.append(f"- `{target.path}` ({'; '.join(traits)}): {functions}")
    if surface.warnings:
        lines += ["", "## Warnings found without a model (concurrency mode)", ""]
        lines += [
            f"- `{w['path']}:{w['line']}`: {w['message']}"
            for w in surface.warnings[:10]
        ]
    examples = _existing_tests(copy)
    lines += ["", "## Existing tests to imitate", ""]
    lines += [f"- `{e}`" for e in examples] or [
        "- none found: use the stack's standard test framework and layout"
    ]
    lines += ["", "## Catalog of inputs", "", render_catalog(), ""]
    return "\n".join(lines)
