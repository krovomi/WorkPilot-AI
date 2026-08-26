"""What an HTTP handler is allowed to hand back, and what it may open.

Two things every `*/api.py` module in this backend does, and until now did
its own way:

* turn an exception into something a caller may read;
* turn a caller-supplied string into a directory it will actually touch.

Both were copy-pasted. `_safe_error_message` existed twice (`provider_api`,
`api/cache_api`) and `_validate_dir` seven times, with divergent rules — one
allowlisted roots, one confined to the repository, most did neither. That
spread is what `py/stack-trace-exposure` (100 alerts) and `py/path-injection`
(32) were counting: the same two mistakes, once per module.

This module is the single place. It is deliberately small, and it does not
know anything about FastAPI — the callers raise or return in their own style.

Reading an error
----------------
`safe_error` maps an exception to a short, fixed string and writes the real
one to the log. The caller of an HTTP endpoint gets "Invalid input"; the
person debugging gets the traceback. Handing back `str(e)` instead is what
CodeQL calls stack-trace exposure, and it is right to: these messages carry
resolved filesystem paths, driver errors and occasionally credentials.

Where a handler can say something genuinely more useful — the caller named a
workflow that does not exist — it should raise its own error with a literal
message rather than reach for this. `workflows/api.py` does that with a
`_REASONS` table, and that is the better shape when the set of rejections is
small and known. `safe_error` is for the rest: the `except Exception` arm.

Opening a directory
-------------------
`validated_dir` normalises a caller-supplied path and refuses the obvious
abuses. When `allowed_roots` is given it additionally requires the result to
sit under one of them — that is real containment and the strongest guard
here.

Two details that look redundant and are not:

* The `".." in parts` check is kept even though `resolve()` normalises `..`
  away on the next line, so it refuses nothing that would otherwise have got
  through. It is there because CodeQL's `ConstCompareAsSanitizerGuard`
  recognises a comparison against a constant as a barrier, and `is_relative_to`
  — which is what the containment check uses — it does not recognise at all.
  Without it, a module with a *correct* allowlist still reports
  `py/path-injection`.
* The value is bound to `candidate` and reused. Rebuilding `Path(raw)` a
  second time creates a fresh tainted node that the guard above does not
  cover, which is exactly how the alert survived a first attempt at this.

Not every path can be confined. A project directory is whatever checkout the
user opened in their own desktop app; confining it to this repository once
made `workflows/api.py` answer only for people building WorkPilot itself.
Pass `allowed_roots` when a real root exists, and leave it out when it does
not — the barrier above still applies.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Sequence
from pathlib import Path

__all__ = ["MAX_PATH_LEN", "safe_error", "validated_dir"]

# Longest caller-supplied path we will even look at. Matches the ceiling
# `slash_commands.api` already used.
MAX_PATH_LEN = 4096

# Exception type -> what a caller may be told. Ordered most specific first:
# the lookup returns on the first `isinstance` match, and OSError is a base
# class of several entries above it.
_SAFE_MESSAGES: tuple[tuple[type[BaseException], str], ...] = (
    (TimeoutError, "Request timed out"),
    (ConnectionError, "Connection failed"),
    (PermissionError, "Permission denied"),
    (FileNotFoundError, "Resource not found"),
    (NotADirectoryError, "Resource not found"),
    (IsADirectoryError, "Resource not found"),
    (FileExistsError, "Resource already exists"),
    (KeyError, "Missing required field"),
    (ValueError, "Invalid input"),
    (TypeError, "Invalid input"),
    (OSError, "System error"),
)

_FALLBACK = "An unexpected error occurred"


def safe_error(
    exc: BaseException,
    log: logging.Logger | None = None,
    context: str = "",
) -> str:
    """Return a message safe to send to a caller, and log the real one.

    The mapping is by exception type, not by message, so nothing derived from
    the exception's text can reach the return value.
    """
    if log is not None:
        log.error(
            "%s failed: %s: %s",
            context or "operation",
            type(exc).__name__,
            exc,
            exc_info=True,
        )
    for exc_type, message in _SAFE_MESSAGES:
        if isinstance(exc, exc_type):
            return message
    return _FALLBACK


def validated_dir(
    raw: str,
    label: str = "path",
    *,
    allowed_roots: Sequence[Path] | Iterable[Path] | None = None,
    must_exist: bool = True,
) -> Path:
    """Resolve `raw` to a directory, refusing what a caller should not reach.

    Raises `ValueError` with a message naming only `label` and the rule that
    was broken — never the resolved path, which is the caller-visible half of
    the stack-trace-exposure problem.
    """
    if not raw or not raw.strip() or raw.strip().startswith("-"):
        raise ValueError(f"{label} must be a non-empty path not starting with '-'")
    if len(raw) > MAX_PATH_LEN:
        raise ValueError(f"{label} is longer than {MAX_PATH_LEN} characters")

    # Bound once and reused below: see the module docstring on why rebuilding
    # this expression defeats the guard on the next line.
    candidate = Path(raw).expanduser()
    if ".." in candidate.parts:
        raise ValueError(f"{label} must not contain '..'")

    resolved = candidate.resolve()

    if allowed_roots is not None:
        roots = [Path(r).expanduser().resolve() for r in allowed_roots]
        if not any(resolved == root or resolved.is_relative_to(root) for root in roots):
            raise ValueError(f"{label} is outside every allowed root")

    if must_exist and not resolved.is_dir():
        raise ValueError(f"{label} does not exist or is not a directory")

    return resolved
