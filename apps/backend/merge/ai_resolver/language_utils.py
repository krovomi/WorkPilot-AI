"""
Language Utilities
==================

The language a file is written in, and which code locations meet.
"""

from __future__ import annotations

from pathlib import PurePosixPath

# The name a code fence uses for each extension. A file that is not here is
# "text": the model still answers, in the block the prompt asks for.
_LANGUAGES = {
    ".py": "python",
    ".pyi": "python",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".tsx": "tsx",
    ".jsx": "jsx",
    ".vue": "vue",
    ".svelte": "svelte",
    ".cs": "csharp",
    ".razor": "razor",
    ".cshtml": "razor",
    ".fs": "fsharp",
    ".vb": "vbnet",
    ".java": "java",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".scala": "scala",
    ".groovy": "groovy",
    ".go": "go",
    ".rs": "rust",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
    ".m": "objectivec",
    ".swift": "swift",
    ".dart": "dart",
    ".rb": "ruby",
    ".php": "php",
    ".pl": "perl",
    ".lua": "lua",
    ".r": "r",
    ".ex": "elixir",
    ".exs": "elixir",
    ".erl": "erlang",
    ".hs": "haskell",
    ".clj": "clojure",
    ".sql": "sql",
    ".sh": "bash",
    ".bash": "bash",
    ".ps1": "powershell",
    ".css": "css",
    ".scss": "scss",
    ".less": "less",
    ".html": "html",
    ".xml": "xml",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".md": "markdown",
}


def infer_language(file_path: str) -> str:
    """The fence name for ``file_path``'s extension, whatever its case."""
    suffix = PurePosixPath(file_path.replace("\\", "/")).suffix.lower()
    return _LANGUAGES.get(suffix, "text")


def locations_overlap(loc1: str, loc2: str) -> bool:
    """The same location, or one a member of the other (``class:A`` and ``class:A.b``).

    A name that merely starts like another (``function:get`` and
    ``function:getUser``) is a different location.
    """
    return loc1 == loc2 or loc1.startswith(loc2 + ".") or loc2.startswith(loc1 + ".")
