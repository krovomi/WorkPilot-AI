"""A stable fingerprint for a production error, whatever tool reported it (#372).

The same bug reaches WorkPilot through Sentry (a stack trace), Datadog (a log
line), PagerDuty (an alert), New Relic (an APM error). What they share is the
*place* and the *kind* of the failure, not their wording, their ids or their
line numbers. So the fingerprint hashes:

- the error type, normalised (``builtins.TypeError`` and ``TypeError`` are one
  type; a namespace is another tool's spelling of the same class);
- the innermost frame of the trace that is in *this* repository, file and
  function, as `docintel.stacktrace` resolves it (every stack it reads: .NET,
  Python, Node, JVM, Go, Ruby, PHP, Rust) — the line is left out, so an edit
  above the bug does not split its group;
- when no frame was found, the message with its numbers, ids, hashes, quoted
  values and addresses replaced by placeholders;
- the service and its version: the same error in two releases is two
  incidents (the fix of one is not the fix of the other).

Pure and offline: no model, no network.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

__all__ = [
    "Fingerprint",
    "fingerprint_incident",
    "normalize_error_type",
    "normalize_function",
    "normalize_message",
    "service_version",
]

_MAX_PART = 200

_UUID = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I
)
_HEX = re.compile(r"\b(?:0x[0-9a-f]+|[0-9a-f]{8,})\b", re.I)
_URL = re.compile(r"\b[a-z][a-z0-9+.-]*://\S+", re.I)
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_QUOTED = re.compile(r"(['\"`])(?:(?!\1).){0,200}\1")
_NUMBER = re.compile(r"\b\d+(?:[.,:]\d+)*\b")
_SPACES = re.compile(r"\s+")
_FUNC_SUFFIX = re.compile(r"(?:[$_.]\d+)+$|`\d+|<[^>]*>")
_TYPE_SEPARATORS = re.compile(r"::|[.\\/:$]")


def normalize_error_type(raw: str) -> str:
    """``builtins.TypeError`` → ``typeerror``; ``System.NullReferenceException`` → ``nullreferenceexception``."""
    text = (raw or "").strip()
    if not text:
        return ""
    text = text.split("(")[0].split(" ")[0]
    parts = [p for p in _TYPE_SEPARATORS.split(text) if p]
    return (parts[-1] if parts else text).lower()[:_MAX_PART]


def normalize_function(raw: str) -> str:
    """A function name without the compiler's or the runtime's numbering."""
    text = (raw or "").strip()
    previous = None
    while previous != text:
        previous, text = text, _FUNC_SUFFIX.sub("", text).strip()
    return text[:_MAX_PART]


def normalize_message(raw: str) -> str:
    """The message with what changes between occurrences replaced."""
    text = (raw or "").lower()
    text = _URL.sub("<url>", text)
    text = _EMAIL.sub("<email>", text)
    text = _UUID.sub("<id>", text)
    text = _QUOTED.sub("<value>", text)
    text = _HEX.sub("<hex>", text)
    text = _NUMBER.sub("<n>", text)
    return _SPACES.sub(" ", text).strip()[:_MAX_PART]


def _short(value: Any, limit: int = 64) -> str:
    return str(value).strip()[:limit] if value not in (None, "") else ""


def service_version(error_data: Mapping[str, Any]) -> str:
    """The release the error was seen in, under any of the tools' names for it."""
    for key in ("service_version", "release", "version", "app_version"):
        if value := _short(error_data.get(key)):
            return value
    return ""


@dataclass(frozen=True)
class Fingerprint:
    value: str
    error_type: str
    #: ``path:function`` of the innermost project frame, "" when none was found.
    frame: str
    frame_file: str
    #: The normalised message, used only when there is no frame.
    message_key: str
    service: str
    version: str

    def to_dict(self) -> dict[str, str]:
        return {
            "value": self.value,
            "error_type": self.error_type,
            "frame": self.frame,
            "frame_file": self.frame_file,
            "message_key": self.message_key,
            "service": self.service,
            "version": self.version,
        }


def _top_frame(trace: Any) -> tuple[str, str]:
    """(file, function) of the innermost frame in this repository."""
    for frame in getattr(trace, "project_frames", []) or []:
        path = str(getattr(frame, "path", "") or "").replace("\\", "/")
        if path:
            method = getattr(frame, "method", "") or getattr(frame, "symbol", "")
            return path, normalize_function(str(method))
    return "", ""


def fingerprint_incident(
    error_type: str,
    error_message: str,
    trace: Any = None,
    *,
    service: str = "",
    version: str = "",
) -> Fingerprint:
    """The fingerprint of one incident; ``trace`` is a resolved ``StackTrace``."""
    kind = normalize_error_type(error_type) or normalize_error_type(
        str(getattr(trace, "exception", "") or "")
    )
    frame_file, function = _top_frame(trace)
    message_key = "" if frame_file else normalize_message(error_message)
    service_key = _short(service).lower()
    version_key = _short(version)
    material = "\x1f".join(
        (kind, frame_file, function, message_key, service_key, version_key)
    )
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]
    return Fingerprint(
        value=digest,
        error_type=kind,
        frame=f"{frame_file}:{function}" if frame_file and function else frame_file,
        frame_file=frame_file,
        message_key=message_key,
        service=service_key,
        version=version_key,
    )


def frame_files(trace: Any, limit: int = 10) -> list[str]:
    """The repository files of the trace, innermost first, each once."""
    files: list[str] = []
    for frame in getattr(trace, "project_frames", []) or []:
        path = str(getattr(frame, "path", "") or "").replace("\\", "/")
        if path and path not in files and not Path(path).is_absolute():
            files.append(path)
        if len(files) >= limit:
            break
    return files
