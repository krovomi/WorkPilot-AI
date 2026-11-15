"""
Merge Helpers
=============

Helper utilities for merge operations.
"""

from __future__ import annotations

import re

from ..types import ChangeType, SemanticChange


class MergeHelpers:
    """Helper methods for merge operations."""

    @staticmethod
    def find_import_section_end(lines: list[str], ext: str) -> int:
        """Find where the import section ends."""
        last_import_line = 0

        for i, line in enumerate(lines):
            stripped = line.strip()
            if MergeHelpers.is_import_line(stripped, ext):
                last_import_line = i + 1
            elif (
                stripped
                and not stripped.startswith("#")
                and not stripped.startswith("//")
            ):
                # Non-empty, non-comment line after imports
                if last_import_line > 0:
                    break

        return last_import_line if last_import_line > 0 else 0

    @staticmethod
    def is_import_line(line: str, ext: str) -> bool:
        """Check if a line is an import statement."""
        if ext == ".py":
            return line.startswith("import ") or line.startswith("from ")
        elif ext in {".js", ".jsx", ".ts", ".tsx"}:
            return line.startswith("import ") or line.startswith("export ")
        return False

    @staticmethod
    def extract_hook_call(change: SemanticChange) -> str | None:
        """The hook call a change adds, with the declaration that receives it.

        ``const [count, setCount] = useState(0);`` keeps its array
        destructuring: without it the merged component calls the hook and
        drops the names the rest of the function reads.
        """
        if change.content_after:
            match = re.search(
                r"(?:(?:const|let|var)\s+(?:\{[^}]+\}|\[[^\]]+\]|\w+)\s*=\s*)?"
                r"use\w+\([^)]*\);?",
                change.content_after,
            )
            if match:
                return match.group(0)
        return None

    @staticmethod
    def extract_jsx_wrapper(change: SemanticChange) -> tuple[str, str] | None:
        """Extract JSX wrapper component and props."""
        if change.content_after:
            # Look for <ComponentName ...>
            match = re.search(r"<(\w+)([^>]*)>", change.content_after)
            if match:
                return (match.group(1), match.group(2).strip())
        return None

    @staticmethod
    def find_function_body_start(content: str, func_name: str) -> int | None:
        """Where the body of ``func_name`` starts, just after its opening brace."""
        name = re.escape(func_name)
        patterns = [
            # function Component() {
            rf"function\s+{name}\s*\([^)]*\)\s*\{{",
            # const Component = () => {
            rf"(?:const|let|var)\s+{name}\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=]+)\s*=>\s*\{{",
            # const Component = function() {
            rf"(?:const|let|var)\s+{name}\s*=\s*function\s*\([^)]*\)\s*\{{",
        ]
        for pattern in patterns:
            match = re.search(pattern, content)
            if match:
                return match.end()
        return None

    @staticmethod
    def insert_hooks_into_function(
        content: str,
        func_name: str,
        hooks: list[str],
    ) -> str:
        """Insert hooks at the start of a function."""
        insert_pos = MergeHelpers.find_function_body_start(content, func_name)
        if insert_pos is None or not hooks:
            return content
        hook_text = "\n  " + "\n  ".join(hooks)
        return content[:insert_pos] + hook_text + content[insert_pos:]

    @staticmethod
    def wrap_function_return(
        content: str,
        func_name: str,
        wrapper_name: str,
        wrapper_props: str,
    ) -> str:
        """Wrap the JSX that ``func_name`` returns in ``<wrapper_name>``.

        Both tags are written: the element is opened after ``return (`` and
        closed before the parenthesis that matches it. A function that is not
        found, or returns no parenthesized JSX, is left as it was.
        """
        body = MergeHelpers.find_function_body_start(content, func_name)
        if body is None:
            return content
        match = re.compile(r"return\s*\(\s*(?=<)").search(content, body)
        if match is None:
            return content
        depth = 0
        close = None
        for index in range(content.index("(", match.start()), len(content)):
            if content[index] == "(":
                depth += 1
            elif content[index] == ")":
                depth -= 1
                if depth == 0:
                    close = index
                    break
        if close is None:
            return content
        inner = content[match.end() : close]
        jsx = inner.rstrip()
        props = f" {wrapper_props}" if wrapper_props else ""
        wrapped = f"<{wrapper_name}{props}>\n      {jsx}\n    </{wrapper_name}>"
        return content[: match.end()] + wrapped + inner[len(jsx) :] + content[close:]

    @staticmethod
    def find_function_insert_position(content: str, ext: str) -> int | None:
        """Find the best position to insert new functions."""
        lines = content.split("\n")

        # Look for module.exports or export default at the end
        for i in range(len(lines) - 1, -1, -1):
            line = lines[i].strip()
            if line.startswith("module.exports") or line.startswith("export default"):
                return i

        return None

    @staticmethod
    def insert_methods_into_class(
        content: str,
        class_name: str,
        methods: list[str],
    ) -> str:
        """Insert methods into a class body."""
        # Find class closing brace
        class_pattern = rf"class\s+{re.escape(class_name)}\s*(?:extends\s+\w+)?\s*\{{"

        match = re.search(class_pattern, content)
        if match:
            # Find the matching closing brace
            start = match.end()
            brace_count = 1
            pos = start

            while pos < len(content) and brace_count > 0:
                if content[pos] == "{":
                    brace_count += 1
                elif content[pos] == "}":
                    brace_count -= 1
                pos += 1

            if brace_count == 0:
                # Insert before closing brace
                insert_pos = pos - 1
                method_text = "\n\n  " + "\n\n  ".join(methods)
                content = content[:insert_pos] + method_text + content[insert_pos:]

        return content

    @staticmethod
    def extract_new_props(change: SemanticChange) -> list[tuple[str, str]]:
        """Extract newly added props from a change."""
        props = []
        if change.content_after and change.content_before:
            # Simple diff - find props in after that aren't in before
            after_props = re.findall(r"(\w+)=\{([^}]+)\}", change.content_after)
            before_props = dict(re.findall(r"(\w+)=\{([^}]+)\}", change.content_before))

            for name, value in after_props:
                if name not in before_props:
                    props.append((name, value))

        return props

    @staticmethod
    def apply_content_change(
        content: str,
        old: str | None,
        new: str,
    ) -> str:
        """Apply a content change by replacing old with new."""
        if old and old in content:
            return content.replace(old, new, 1)
        return content

    @staticmethod
    def topological_sort_changes(
        snapshots: list,
    ) -> list[SemanticChange]:
        """Sort changes by their dependencies."""
        # Collect all changes
        all_changes: list[SemanticChange] = []
        for snapshot in snapshots:
            all_changes.extend(snapshot.semantic_changes)

        # Simple ordering: hooks before wraps before modifications
        priority = {
            ChangeType.ADD_IMPORT: 0,
            ChangeType.ADD_HOOK_CALL: 1,
            ChangeType.ADD_VARIABLE: 2,
            ChangeType.ADD_CONSTANT: 2,
            ChangeType.WRAP_JSX: 3,
            ChangeType.ADD_JSX_ELEMENT: 4,
            ChangeType.MODIFY_FUNCTION: 5,
            ChangeType.MODIFY_JSX_PROPS: 5,
        }

        return sorted(all_changes, key=lambda c: priority.get(c.change_type, 10))
