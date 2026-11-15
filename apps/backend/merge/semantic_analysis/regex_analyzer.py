"""
Regex-based semantic analysis for code changes.

What a task changed in a file, in terms two tasks can collide on: the imports
it added or removed, and the functions it added, removed or rewrote. A
function is rewritten when it exists before and after and a changed line falls
inside it (from its definition to the next definition).
"""

from __future__ import annotations

import difflib
import re

from ..types import ChangeType, FileAnalysis, SemanticChange

_JS_FUNCTION = (
    r"(?:function\s+(\w+)"
    r"|(?:const|let|var)\s+(\w+)\s*(?::\s*[\w<>\[\]]+)?\s*=\s*(?:async\s+)?"
    r"(?:function|\([^)]*\)\s*=>))"
)
# A C#, Java or Kotlin-style method: modifiers, a type, a name, a parenthesis.
_MODIFIERS = (
    r"(?:public|private|protected|internal|static|async|override|virtual|"
    r"abstract|sealed|final|partial|extern|unsafe|synchronized|new)"
)
_METHOD = rf"^\s*(?:{_MODIFIERS}\s+)+[\w<>\[\],.?]+\s+(\w+)\s*\("

_IMPORT_PATTERNS: dict[str, str] = {
    ".py": r"^(?:from\s+\S+\s+)?import\s+",
    ".js": r"^import\s+",
    ".mjs": r"^import\s+",
    ".cjs": r"^(?:import\s+|const\s+\w+\s*=\s*require\()",
    ".jsx": r"^import\s+",
    ".ts": r"^import\s+",
    ".tsx": r"^import\s+",
    ".vue": r"^import\s+",
    ".svelte": r"^import\s+",
    ".cs": r"^(?:global\s+)?using\s+[\w.=\s]+;",
    ".fs": r"^open\s+",
    ".vb": r"^Imports\s+",
    ".java": r"^import\s+",
    ".kt": r"^import\s+",
    ".scala": r"^import\s+",
    ".go": r'^import\s+|^"[\w./-]+"$',
    ".rs": r"^(?:pub\s+)?use\s+",
    ".swift": r"^import\s+",
    ".dart": r"^import\s+",
    ".php": r"^use\s+",
    ".rb": r"^require(?:_relative)?\s+",
    ".c": r"^#include\s+",
    ".h": r"^#include\s+",
    ".cpp": r"^#include\s+",
    ".cc": r"^#include\s+",
    ".hpp": r"^#include\s+",
}

_FUNCTION_PATTERNS: dict[str, str] = {
    ".py": r"^\s*(?:async\s+)?def\s+(\w+)\s*\(",
    ".js": _JS_FUNCTION,
    ".mjs": _JS_FUNCTION,
    ".cjs": _JS_FUNCTION,
    ".jsx": _JS_FUNCTION,
    ".ts": _JS_FUNCTION,
    ".tsx": _JS_FUNCTION,
    ".cs": _METHOD,
    ".java": _METHOD,
    ".kt": r"^\s*(?:\w+\s+)*fun\s+(?:<[^>]+>\s*)?(?:[\w.]+\.)?(\w+)\s*\(",
    ".go": r"^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(",
    ".rs": r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)",
    ".swift": r"^\s*(?:\w+\s+)*func\s+(\w+)",
    ".rb": r"^\s*def\s+(?:self\.)?(\w+[?!]?)",
    ".php": r"^\s*(?:\w+\s+)*function\s+(\w+)\s*\(",
}


def get_import_pattern(ext: str) -> re.Pattern | None:
    """The import statement pattern for a file extension, if known."""
    pattern = _IMPORT_PATTERNS.get(ext.lower())
    return re.compile(pattern) if pattern else None


def get_function_pattern(ext: str) -> re.Pattern | None:
    """The function definition pattern for a file extension, if known."""
    pattern = _FUNCTION_PATTERNS.get(ext.lower())
    return re.compile(pattern, re.MULTILINE) if pattern else None


def _definitions(
    text: str, pattern: re.Pattern, indented: bool = False
) -> list[tuple[int, int | None, str]]:
    """``(first line, last line, name)`` of each definition in ``text``.

    The last line is ``None`` (up to the next definition) except where blocks
    are indented (``indented``): there a definition ends before the first
    non-blank line indented no deeper than its own ``def``.
    """
    lines = text.split("\n")
    found = []
    for match in pattern.finditer(text):
        group = next(
            (g for g in range(1, len(match.groups()) + 1) if match.group(g)), None
        )
        if group is None:
            continue
        name = match.group(group)
        # The line of the name: a leading ``\s*`` may have crossed blank lines.
        start = text.count("\n", 0, match.start(group)) + 1
        end = None
        if indented:
            header = lines[start - 1]
            depth = len(header) - len(header.lstrip())
            end = len(lines)
            for number in range(start + 1, len(lines) + 1):
                line = lines[number - 1]
                if line.strip() and len(line) - len(line.lstrip()) <= depth:
                    end = number - 1
                    break
        found.append((start, end, name))
    return found


def _enclosing(definitions: list[tuple[int, int | None, str]], line: int) -> str | None:
    """The innermost function whose span holds ``line``."""
    name = None
    for start, end, candidate in definitions:
        if start > line:
            break
        if end is None or line <= end:
            name = candidate
    return name


def _last_lines(
    definitions: list[tuple[int, int | None, str]], total: int
) -> dict[str, int]:
    """The last line of each function's first definition, open spans closed
    by the next definition."""
    last: dict[str, int] = {}
    for index, (start, end, name) in enumerate(definitions):
        if end is None:
            following = (
                definitions[index + 1][0] if index + 1 < len(definitions) else total + 1
            )
            end = following - 1
        last.setdefault(name, max(start, end))
    return last


def analyze_with_regex(
    file_path: str,
    before: str,
    after: str,
    ext: str,
) -> FileAnalysis:
    """
    Analyze code changes using regex patterns.

    Args:
        file_path: Path to the file being analyzed
        before: Content before changes
        after: Content after changes
        ext: File extension

    Returns:
        FileAnalysis with changes detected via regex patterns
    """
    changes: list[SemanticChange] = []

    # Normalize line endings to LF for consistent cross-platform behavior
    before_normalized = before.replace("\r\n", "\n").replace("\r", "\n")
    after_normalized = after.replace("\r\n", "\n").replace("\r", "\n")

    diff = difflib.unified_diff(
        before_normalized.splitlines(keepends=True),
        after_normalized.splitlines(keepends=True),
        lineterm="",
    )

    # Added lines are numbered in the new version, removed ones in the old,
    # with the line of the new version where each was removed.
    added_lines: list[tuple[int, str]] = []
    removed_lines: list[tuple[int, str]] = []
    removed_at: dict[int, int] = {}
    old_line = new_line = 0
    in_hunk = False
    for line in diff:
        if line.startswith("@@"):
            match = re.match(r"@@ -(\d+)(?:,\d+)? \+(\d+)", line)
            if match:
                in_hunk = True
                old_line, new_line = int(match.group(1)), int(match.group(2))
        elif not in_hunk:
            continue  # the ``---`` and ``+++`` file headers
        elif line.startswith("+"):
            added_lines.append((new_line, line[1:]))
            new_line += 1
        elif line.startswith("-"):
            removed_lines.append((old_line, line[1:]))
            removed_at[old_line] = new_line
            old_line += 1
        else:
            old_line += 1
            new_line += 1

    import_pattern = get_import_pattern(ext)
    import_lines: set[tuple[str, int]] = set()
    if import_pattern:
        for line_num, line in added_lines:
            if import_pattern.match(line.strip()):
                import_lines.add(("+", line_num))
                changes.append(
                    SemanticChange(
                        change_type=ChangeType.ADD_IMPORT,
                        target=line.strip(),
                        location="file_top",
                        line_start=line_num,
                        line_end=line_num,
                        content_after=line,
                    )
                )
        for line_num, line in removed_lines:
            if import_pattern.match(line.strip()):
                import_lines.add(("-", line_num))
                changes.append(
                    SemanticChange(
                        change_type=ChangeType.REMOVE_IMPORT,
                        target=line.strip(),
                        location="file_top",
                        line_start=line_num,
                        line_end=line_num,
                        content_before=line,
                    )
                )

    func_pattern = get_function_pattern(ext)
    if func_pattern:
        indented = ext.lower() == ".py"
        defs_before = _definitions(before_normalized, func_pattern, indented)
        defs_after = _definitions(after_normalized, func_pattern, indented)
        funcs_before = {name for _, _, name in defs_before}
        funcs_after = {name for _, _, name in defs_after}
        first_line = {name: start for start, _, name in reversed(defs_after)}
        last_line = _last_lines(defs_after, after_normalized.count("\n") + 1)
        first_line_before = {name: start for start, _, name in reversed(defs_before)}

        for func in sorted(funcs_after - funcs_before):
            line = first_line[func]
            changes.append(
                SemanticChange(
                    change_type=ChangeType.ADD_FUNCTION,
                    target=func,
                    location=f"function:{func}",
                    line_start=line,
                    line_end=line,
                )
            )

        for func in sorted(funcs_before - funcs_after):
            line = first_line_before[func]
            changes.append(
                SemanticChange(
                    change_type=ChangeType.REMOVE_FUNCTION,
                    target=func,
                    location=f"function:{func}",
                    line_start=line,
                    line_end=line,
                )
            )

        # A function in both versions with a changed line inside it, in
        # either version, was rewritten. Its range is in the new version.
        touched: dict[str, list[int]] = {}
        for line_num, _ in added_lines:
            if ("+", line_num) not in import_lines:
                name = _enclosing(defs_after, line_num)
                if name:
                    touched.setdefault(name, []).append(line_num)
        for line_num, _ in removed_lines:
            if ("-", line_num) not in import_lines:
                name = _enclosing(defs_before, line_num)
                if name:
                    # Placed where it was removed, inside the function's new span
                    at = removed_at[line_num]
                    if name in first_line:
                        at = min(max(at, first_line[name]), last_line[name])
                    touched.setdefault(name, []).append(at)
        for func in sorted(set(touched) & funcs_before & funcs_after):
            lines = touched[func]
            changes.append(
                SemanticChange(
                    change_type=ChangeType.MODIFY_FUNCTION,
                    target=func,
                    location=f"function:{func}",
                    line_start=min(lines),
                    line_end=max(lines),
                )
            )

    analysis = FileAnalysis(file_path=file_path, changes=changes)
    for change in changes:
        if change.change_type == ChangeType.ADD_IMPORT:
            analysis.imports_added.add(change.target)
        elif change.change_type == ChangeType.REMOVE_IMPORT:
            analysis.imports_removed.add(change.target)
        elif change.change_type == ChangeType.ADD_FUNCTION:
            analysis.functions_added.add(change.target)
        elif change.change_type == ChangeType.MODIFY_FUNCTION:
            analysis.functions_modified.add(change.target)

    analysis.total_lines_changed = len(added_lines) + len(removed_lines)
    return analysis
