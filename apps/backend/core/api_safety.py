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

The `".." in parts` check refuses nothing that `resolve()` would not have
normalised away a line later. It is kept because rejecting a traversal
attempt explicitly, before any filesystem call, is easier to read and to test
than inferring it from a containment failure further down — not for any
effect on static analysis. An earlier version of this docstring claimed it
acted as a CodeQL barrier (`ConstCompareAsSanitizerGuard`); that was wrong,
and a full scan says so. Do not restore that claim.

Not every path can be confined. A project directory is whatever checkout the
user opened in their own desktop app; confining it to this repository once
made `workflows/api.py` answer only for people building WorkPilot itself.
Pass `allowed_roots` when a real root exists, and leave it out when it does
not.

On the `py/path-injection` alert this function carries
--------------------------------------------------------
It is expected, and it is a false positive that belongs here rather than in
twenty-one modules. When `allowed_roots` is None the argument really is an
unconstrained caller-supplied path, and CodeQL is right that no sanitiser
stands between it and the filesystem — because that is the feature. WorkPilot
builds other people's projects; the directory is outside this repository by
definition, and the backend reading it runs as the same local user who chose
it in their own desktop app. There is no privilege boundary to cross.

The point of centralising here is that this judgement is now made **once**, in
a place a reviewer can read, instead of being repeated as twenty-one separate
dismissals. Dismiss the alert on this function with that reason; do not
"fix" it by confining the path.
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


def server_mode_roots() -> list[Path] | None:
    """The only directories a request may reach in multi-user server mode.

    ``None`` in local mode, where there is no privilege boundary to draw: the
    backend runs as the person who chose the directory in their own desktop app.

    In server mode there very much is one. Every project the server knows about
    is cloned under ``REPOS_ROOT``, so confining resolution to that subtree
    turns "read any path on the host" into "read a checkout", and the per-tenant
    half of the check is done by ``server.authz.scope`` on top.

    Import-guarded so ``core`` keeps no hard dependency on ``server``: the
    desktop app ships without a database, and this must not change that.
    """
    try:
        from server.config import get_settings
    except ImportError:  # pragma: no cover - local mode without server extras
        return None

    try:
        settings = get_settings()
    except Exception:  # pragma: no cover - misconfiguration surfaces at boot
        return None

    if not settings.server_mode:
        return None
    return [Path(settings.repos_root)]


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

    **In server mode the confinement is not optional.** When no ``allowed_roots``
    is supplied the repository root is imposed, so the ~60 call sites written
    for the single-user desktop app cannot resolve a path outside the server's
    own checkouts — including the ones that read ``project_dir`` out of a JSON
    body, which the middleware's query-string check never sees. A caller that
    genuinely needs a different root passes one explicitly.
    """
    if not raw or not raw.strip() or raw.strip().startswith("-"):
        raise ValueError(f"{label} must be a non-empty path not starting with '-'")
    if len(raw) > MAX_PATH_LEN:
        raise ValueError(f"{label} is longer than {MAX_PATH_LEN} characters")

    candidate = Path(raw).expanduser()
    if ".." in candidate.parts:
        raise ValueError(f"{label} must not contain '..'")

    resolved = candidate.resolve()

    if allowed_roots is None:
        allowed_roots = server_mode_roots()

    if allowed_roots is not None:
        roots = [Path(r).expanduser().resolve() for r in allowed_roots]
        if not any(resolved == root or resolved.is_relative_to(root) for root in roots):
            raise ValueError(f"{label} is outside every allowed root")

    if must_exist and not resolved.is_dir():
        raise ValueError(f"{label} does not exist or is not a directory")

    return resolved
