"""What ran in production lately, read from the project's APM inbox (#364).

The inbox is the one Regression Guardian reads, ``.workpilot/incidents/*.json``:
any monitoring tool (Sentry, Datadog, CloudWatch, New Relic, PagerDuty,
Grafana, OpsGenie, or a plain ``{"title", "stack"}``) drops its payloads
there. An incident of the last 30 days says that the files of its stack ran
in production; its frames under ``node_modules/``, ``site-packages/`` and
the like name the dependencies that ran.

A payload is data (S2): it is parsed by the shared parser, and its paths are
only compared with the project's own file list, never opened. The inbox is
read only inside the project, without following a link, bounded in files and
bytes.
"""

from __future__ import annotations

import json
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

from regression_guardian.feed import INBOX, MAX_INBOX_FILES, MAX_PAYLOAD_BYTES
from regression_guardian.incident_parser import IncidentParser

from .dependencies import normalize

__all__ = ["WINDOW_DAYS", "RuntimeEvidence", "read_runtime"]

WINDOW_DAYS = 30
_PARSE_ERRORS = (AttributeError, IndexError, KeyError, TypeError, ValueError)
_PACKAGE_DIR = re.compile(
    r"/(?:node_modules|site-packages|dist-packages|vendor|gems|packages)/"
    r"(@[\w.-]+/[\w.-]+|[\w.-]+)"
)
_GEM_VERSION = re.compile(r"-\d[\w.]*$")
_USER_KEYS = (
    "userCount",
    "user_count",
    "affected_users",
    "users_affected",
    "usersAffected",
)
_MAX_USERS = 1_000_000_000
_MAX_SUFFIX_PARTS = 12


@dataclass
class RuntimeEvidence:
    #: At least one recent incident was read.
    available: bool = False
    incidents: int = 0
    file_hits: Counter[str] = field(default_factory=Counter)
    file_users: dict[str, int] = field(default_factory=dict)
    package_hits: Counter[str] = field(default_factory=Counter)
    package_users: dict[str, int] = field(default_factory=dict)


def _inbox(project_dir: Path) -> Path | None:
    root = project_dir.resolve()
    inbox = project_dir / INBOX
    if inbox.is_symlink() or not inbox.is_dir():
        return None
    if not inbox.resolve().is_relative_to(root):
        return None
    return inbox


def _users(payload: Any) -> int:
    """The users an incident affected, when the tool says so."""
    best = 0
    scopes = [payload]
    if isinstance(payload, dict):
        for key in ("data", "issue", "event"):
            scopes.append(payload.get(key))
        data = payload.get("data")
        if isinstance(data, dict):
            scopes.append(data.get("issue"))
    for scope in scopes:
        if not isinstance(scope, dict):
            continue
        for key in _USER_KEYS:
            value = scope.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and value > 0:
                best = max(best, min(value, _MAX_USERS))
    return best


def _project_file(frame: str, files: set[str]) -> str | None:
    """The project file a frame's path ends with (``/app/src/x.py`` → ``src/x.py``)."""
    parts = PurePosixPath(frame.replace("\\", "/")).parts
    for start in range(max(0, len(parts) - _MAX_SUFFIX_PARTS), len(parts)):
        candidate = "/".join(parts[start:])
        if candidate in files:
            return candidate
    return None


def _package(frame: str) -> str | None:
    match = _PACKAGE_DIR.search("/" + frame.replace("\\", "/"))
    if not match:
        return None
    return normalize(_GEM_VERSION.sub("", match.group(1)))


def _payloads(inbox: Path, since: float) -> list[dict[str, Any]]:
    payloads = []
    files = sorted(
        p for p in inbox.glob("*.json") if p.is_file() and not p.is_symlink()
    )
    for path in files[:MAX_INBOX_FILES]:
        try:
            stat = path.stat()
            if stat.st_size > MAX_PAYLOAD_BYTES or stat.st_mtime < since:
                continue
            payload = json.loads(path.read_bytes())
        except (OSError, ValueError):
            continue
        if isinstance(payload, dict):
            payloads.append(payload)
    return payloads


def read_runtime(
    project_dir: Path, files: set[str], now: float | None = None
) -> RuntimeEvidence:
    evidence = RuntimeEvidence()
    inbox = _inbox(Path(project_dir))
    if inbox is None:
        return evidence
    since = (time.time() if now is None else now) - WINDOW_DAYS * 86_400
    parser = IncidentParser()
    for payload in _payloads(inbox, since):
        try:
            incident = parser.parse(payload, parser.detect_source(payload))
        except _PARSE_ERRORS:
            continue
        evidence.incidents += 1
        users = _users(payload)
        touched: set[str] = set()
        packages: set[str] = set()
        for frame in incident.stack_frames:
            if not frame.file:
                continue
            rel = _project_file(frame.file, files)
            if rel:
                touched.add(rel)
            package = _package(frame.file)
            if package:
                packages.add(package)
        for rel in touched:
            evidence.file_hits[rel] += 1
            evidence.file_users[rel] = max(evidence.file_users.get(rel, 0), users)
        for package in packages:
            evidence.package_hits[package] += 1
            evidence.package_users[package] = max(
                evidence.package_users.get(package, 0), users
            )
    evidence.available = evidence.incidents > 0
    return evidence
