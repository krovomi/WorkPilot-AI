"""`libdocs` — the documentation an agent would otherwise write from memory.

    from libdocs import run_preflight, format_docs_for_prompt

    result = run_preflight(working_dir, spec_dir, cache_dir=project_dir)
    prompt += "\n\n" + format_docs_for_prompt(result, subtask=subtask)

One question, asked before every build: *is there a library in this task that
the repository shows no example of?* When there is, its current documentation
is downloaded from Context7 and staged next to the spec, and the coder is told
to read it. When the repository already uses the library twenty times, nothing
is downloaded — the codebase is the better teacher, house conventions included.

`detect.py` decides what is missing, `context7.py` fetches it, `cache.py` keeps
it for the next task, `preflight.py` runs the three and renders the prompt
section. The Context7 MCP tools stay declared for the agents throughout: this
covers the case where the model does not know it should ask.
"""

from __future__ import annotations

from .cache import CACHE_DIRNAME, DEFAULT_TTL_DAYS, CachedDoc, DocsCache
from .context7 import (
    Context7Client,
    Context7Error,
    Context7RateLimited,
    Library,
    api_key_from_env,
)
from .detect import (
    DEFAULT_LIMIT,
    THIN_USAGE,
    Dependency,
    LibraryNeed,
    detect_needs,
    read_manifests,
)
from .preflight import (
    DOCS_DIRNAME,
    RESULT_FILENAME,
    DocEntry,
    PreflightResult,
    format_docs_for_prompt,
    is_enabled,
    load_result,
    read_task_text,
    run_preflight,
)

__all__ = [
    "CACHE_DIRNAME",
    "DEFAULT_LIMIT",
    "DEFAULT_TTL_DAYS",
    "DOCS_DIRNAME",
    "RESULT_FILENAME",
    "THIN_USAGE",
    "CachedDoc",
    "Context7Client",
    "Context7Error",
    "Context7RateLimited",
    "Dependency",
    "DocEntry",
    "DocsCache",
    "Library",
    "LibraryNeed",
    "PreflightResult",
    "api_key_from_env",
    "detect_needs",
    "format_docs_for_prompt",
    "is_enabled",
    "load_result",
    "read_manifests",
    "read_task_text",
    "run_preflight",
]
