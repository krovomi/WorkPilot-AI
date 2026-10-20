"""Select and redact evidence, never recursively export a repository."""

from __future__ import annotations

import json
import re
import shlex
from pathlib import PurePosixPath

from .models import BypassReason

MAX_STATE_BYTES = 64 * 1024
_ASSIGNMENT = re.compile(
    r"""(?im)(\b(?:[a-z0-9_]*(?:api[_-]?key|password|passwd|secret|token)[a-z0-9_]*)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)"""
)
_BEARER = re.compile(r"(?i)\bBearer\s+[a-z0-9._~+/-]+=*")
_PRIVATE = re.compile(
    r"-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----", re.S
)


class JevContextError(Exception):
    def __init__(self, reason: BypassReason) -> None:
        self.reason = reason
        super().__init__(reason)


def sensitive_path(value: str) -> bool:
    path = PurePosixPath(value.replace("\\", "/").lower())
    return any(
        part == ".env"
        or part.startswith(".env.")
        or "credential" in part
        or "secret" in part
        or part in ("id_rsa", "id_ed25519")
        for part in path.parts
    ) or path.suffix in (".pem", ".key", ".p12", ".pfx")


def redact(value: str, sensitive_values: tuple[str, ...] = ()) -> str:
    for secret in sorted(set(sensitive_values), key=len, reverse=True):
        if secret:
            value = value.replace(secret, "[redacted]")
    value = _PRIVATE.sub("[redacted private key]", value)
    value = _ASSIGNMENT.sub(r"\1[redacted]", value)
    return _BEARER.sub("Bearer [redacted]", value)


def _safe_diff(diff: str) -> str:
    if not diff.strip():
        return ""
    if diff.startswith("--- a/"):
        # GitHub follow-up and Azure DevOps provide unified diffs without git headers.
        diff = re.sub(
            r"(?m)^--- (a/[^\r\n]+)\n\+\+\+ (b/[^\r\n]+)\n",
            lambda match: (
                f"diff --git {shlex.quote(match[1])} {shlex.quote(match[2])}\n"
                + match[0]
            ),
            diff,
        )
    if not diff.startswith("diff --git "):
        raise JevContextError("missing_context")
    kept = []
    for block in re.split(r"(?m)(?=^diff --git )", diff):
        if not block:
            continue
        try:
            header = shlex.split(block.splitlines()[0])
        except ValueError:
            raise JevContextError("missing_context") from None
        if len(header) != 4 or header[:2] != ["diff", "--git"]:
            raise JevContextError("missing_context")
        if any(sensitive_path(path) for path in header[2:]):
            continue
        # Rename metadata can identify a secret even in unusual diff producers.
        if any(
            sensitive_path(line.split(" ", 2)[-1])
            for line in block.splitlines()
            if line.startswith(("rename from ", "rename to "))
        ):
            continue
        kept.append(block)
    return "".join(kept)


def select_state(
    *,
    request: str,
    acceptance: str,
    files: list[str],
    diff: str = "",
    validations: str = "",
    sensitive_values: tuple[str, ...] = (),
) -> dict:
    state = {
        "request": redact(request, sensitive_values),
        "acceptance": redact(acceptance, sensitive_values),
        "files": [
            redact(path, sensitive_values) for path in files if not sensitive_path(path)
        ],
        "diff": redact(_safe_diff(diff), sensitive_values),
        "validations": redact(validations, sensitive_values),
    }
    if (
        len(json.dumps(state, ensure_ascii=False, allow_nan=False).encode("utf-8"))
        > MAX_STATE_BYTES
    ):
        raise JevContextError("context_too_large")
    return state
