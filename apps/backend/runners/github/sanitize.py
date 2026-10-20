"""GitHub content sanitisation — moved to `security.content_sanitizer`.

The module lived here and was imported by nothing, which is part of why it was
never called: reaching it meant importing `runners`, whose `__init__` pulls in
every runner in the product and, through them, `claude_agent_sdk`. A pure-text
utility that a low-level guard wants to call cannot sit behind that, and
`security/` depending on `runners/` is the layering upside down.

It is `security.content_sanitizer` now, beside the other things that decide
what an agent may be handed. This module re-exports it so an existing import
keeps working.
"""

from security.content_sanitizer import (
    MAX_COMMENT_CHARS,
    MAX_DIFF_CHARS,
    MAX_FILE_CONTENT_CHARS,
    MAX_ISSUE_BODY_CHARS,
    MAX_PR_BODY_CHARS,
    ContentSanitizer,
    SanitizeResult,
    get_sanitizer,
)

__all__ = [
    "MAX_COMMENT_CHARS",
    "MAX_DIFF_CHARS",
    "MAX_FILE_CONTENT_CHARS",
    "MAX_ISSUE_BODY_CHARS",
    "MAX_PR_BODY_CHARS",
    "ContentSanitizer",
    "SanitizeResult",
    "get_sanitizer",
]
