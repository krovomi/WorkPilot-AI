"""Production incidents as Kanban cards (F187, issue #384).

An incident does not become a test here: it becomes a ``bug_fix`` card of the
Kanban, whose first phase writes the regression test that reproduces it and
fails, then fixes the code, in the task's worktree, on its branch, in its PR.
Nothing is written into the project from this module.

Two sources, read on each pass of the automation rule, never pushed to the
machine (no port is opened, as for the « Besoin de toi » channels):

- the project's inbox, ``<project>/.workpilot/incidents/*.json``, where any
  tool can drop an APM payload (Sentry, Datadog, CloudWatch, New Relic,
  PagerDuty, Grafana, OpsGenie, or a plain ``{"title", "stack"}``);
- Sentry's API, read with a token, for the issues first seen after the rule
  was created.

What an incident says is data (S2): every field is reduced to safe one-line
text, personal data is masked, and the message and the breadcrumbs enter the
card fenced as untrusted content. Nothing read from an incident chooses a
tool, a command, a path or a right: an event carries a fixed key and text.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .fixture_builder import redact_text
from .incident_parser import Incident, IncidentParser, IncidentSource
from .stacks import detect_framework, safe_text, sanitized

__all__ = [
    "INBOX",
    "FeedError",
    "IncidentEvent",
    "SentryTarget",
    "card_for",
    "inbox_events",
    "incident_key",
    "parse_sentry_target",
    "sentry_events",
]

INBOX = Path(".workpilot") / "incidents"
MAX_INBOX_FILES = 50
MAX_PAYLOAD_BYTES = 256 * 1024
MAX_FRAMES = 12
MAX_BREADCRUMBS = 10
SENTRY_ISSUES_PER_PASS = 25
DEFAULT_SENTRY_HOST = "sentry.io"

_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,49}$")
_HOST = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
_SENTRY_ID = re.compile(r"^\d{1,20}$")

#: What the Kanban phase must do with the incident, whatever the stack.
_DONE_WHEN = """\
## Done when

1. A regression test, in the project's own test framework ({framework}), \
reproduces this incident and **fails** on the current code. Write it first, \
next to the tests of the faulting code, and name it after the incident.
2. The fix makes that test pass, and the test stays in the suite.

Do not skip, disable or loosen a test or a check. Personal data from the \
incident (emails, tokens, identifiers, payloads) never enters the test: use \
placeholders.
"""


class FeedError(Exception):
    """A source that cannot be read, for a reason the automation panel names."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


@dataclass
class IncidentEvent:
    """An incident that may become a card. ``key`` is what dedups it."""

    key: str
    subject: str
    title: str
    description: str
    url: str | None = None


@dataclass
class FeedResult:
    events: list[IncidentEvent] = field(default_factory=list)
    #: ``(key, subject, reason)``: incidents that are not this rule's.
    ignored: list[tuple[str, str, str]] = field(default_factory=list)


@dataclass(frozen=True)
class SentryTarget:
    host: str
    org: str
    project: str

    @property
    def api(self) -> str:
        return f"https://{self.host}/api/0"


def incident_key(source: str, incident_id: str) -> str:
    return f"incident:{source}:{incident_id}"


def parse_sentry_target(raw: dict[str, Any]) -> SentryTarget | None:
    """The Sentry project of a rule's trigger, checked; ``None`` without one.

    ``host`` is a bare host name (``sentry.io``, ``de.sentry.io``, a
    self-hosted instance), never a URL: the scheme is always HTTPS.
    """
    org, project = raw.get("org"), raw.get("project")
    if not org and not project:
        return None
    if not isinstance(org, str) or not _SLUG.match(org):
        raise ValueError("The Sentry organisation is not a slug")
    if not isinstance(project, str) or not _SLUG.match(project):
        raise ValueError("The Sentry project is not a slug")
    host = raw.get("host") or DEFAULT_SENTRY_HOST
    if not isinstance(host, str) or not _HOST.match(host):
        raise ValueError("The Sentry host is not a host name")
    return SentryTarget(host=host, org=org, project=project)


def is_sentry_cloud(host: str) -> bool:
    return host == DEFAULT_SENTRY_HOST or host.endswith("." + DEFAULT_SENTRY_HOST)


# --- The card -----------------------------------------------------------------


def _line(value: Any, limit: int = 200) -> str:
    return safe_text(redact_text(str(value or "")), limit)


def _quoted(text: str, source: str) -> str:
    from security.untrusted import quote_untrusted

    return quote_untrusted(text, kind="issue_body", source=source)


def _breadcrumbs(incident: Incident) -> list[str]:
    lines = []
    for crumb in incident.breadcrumbs[-MAX_BREADCRUMBS:]:
        if not isinstance(crumb, dict):
            continue
        what = " ".join(
            _line(crumb.get(part), 120)
            for part in ("category", "message")
            if crumb.get(part)
        )
        if what:
            lines.append(f"- {what}")
    return lines


def card_for(
    incident: Incident, project_root: Path, url: str | None = None
) -> IncidentEvent:
    """The card of one incident: what failed, where, and what « done » means."""
    safe = sanitized(incident)
    kind = safe.exception_type or "Error"
    message = _line(incident.exception_message or incident.title, 160)
    title = _line(
        f"Regression: {kind}: {message}" if message else f"Regression: {kind}"
    )
    source = incident.source.value
    subject = f"{source} {safe.id}"[:120]

    facts = [f"- **Incident:** {source} `{safe.id}`" + (f" ({url})" if url else "")]
    for label, value in (
        ("Service", incident.service),
        ("Environment", incident.environment),
        ("Release", incident.version),
        ("Severity", incident.severity.value),
    ):
        if value:
            facts.append(f"- **{label}:** {_line(value, 120)}")

    frames = [
        f"- `{frame.file}:{frame.line}`"
        + (f" in `{frame.function}`" if frame.function else "")
        for frame in safe.stack_frames[:MAX_FRAMES]
        if frame.file
    ]
    framework = detect_framework(project_root, incident.faulting_file).value
    details = "\n".join(
        part
        for part in (
            _line(incident.title, 300),
            _line(incident.exception_message, 1000),
            "\n".join(_breadcrumbs(incident)),
        )
        if part
    )
    description = "\n".join(
        [
            f"# {title}",
            "",
            *facts,
            "",
            "## Where it failed",
            "",
            *(
                frames
                or [
                    "The incident has no stack trace: reproduce it at the entry point it names (route, job, handler)."
                ]
            ),
            "",
            "## What the incident says",
            "",
            _quoted(details or "No message.", f"{source} incident"),
            "",
            _DONE_WHEN.format(framework=framework),
        ]
    )
    return IncidentEvent(
        key=incident_key(source, safe.id),
        subject=subject,
        title=title,
        description=description,
        url=url,
    )


# --- The project's inbox ------------------------------------------------------


def _inbox(project_root: Path) -> Path | None:
    root = project_root.resolve()
    inbox = (root / INBOX).resolve()
    if not inbox.is_relative_to(root) or not inbox.is_dir():
        return None
    return inbox


def _incident_id(incident: Incident, path: Path, payload: bytes) -> str:
    known = safe_text(incident.id, 80)
    if known and known != "unknown":
        return known
    # A payload without an id is named by its content: the same file read
    # twice is the same incident, a new one is another.
    return f"{safe_text(path.stem, 40)}-{hashlib.sha256(payload).hexdigest()[:12]}"


#: What a payload of an unknown shape raises in the parsers.
_PARSE_ERRORS = (AttributeError, IndexError, KeyError, TypeError, ValueError)


def _read_payload(path: Path, parser: IncidentParser) -> tuple[float, Incident] | str:
    """The file's time and incident, or why it cannot be one."""
    try:
        stat = path.stat()
        if stat.st_size > MAX_PAYLOAD_BYTES:
            return "incident_too_large"
        raw = path.read_bytes()
        payload = json.loads(raw)
    except (OSError, ValueError):
        return "incident_unreadable"
    if not isinstance(payload, dict):
        return "incident_unreadable"
    try:
        incident = parser.parse(payload, parser.detect_source(payload))
    except _PARSE_ERRORS:
        return "incident_unreadable"
    incident.id = _incident_id(incident, path, raw)
    return stat.st_mtime, incident


def inbox_events(
    project_root: Path, since: float, seen: Callable[[str], bool]
) -> FeedResult:
    """The payloads dropped in the inbox after ``since``, not yet seen.

    A file older than the rule is ignored, and remembered as such: turning
    the rule on is not a request to import the backlog.
    """
    result = FeedResult()
    inbox = _inbox(project_root)
    if inbox is None:
        return result
    parser = IncidentParser()
    files = sorted(
        p for p in inbox.glob("*.json") if p.is_file() and not p.is_symlink()
    )[:MAX_INBOX_FILES]
    for path in files:
        subject = f"inbox {path.name}"[:120]
        read = _read_payload(path, parser)
        if isinstance(read, str):
            # A file that cannot be read is named by its own name, noted once.
            unread = f"incident:inbox:{safe_text(path.name, 120)}"
            if not seen(unread):
                result.ignored.append((unread, subject, read))
            continue
        mtime, incident = read
        key = incident_key(incident.source.value, incident.id)
        if seen(key):
            continue
        if mtime < since:
            result.ignored.append((key, subject, "incident_predates_rule"))
            continue
        result.events.append(card_for(incident, project_root))
    return result


# --- Sentry -------------------------------------------------------------------

#: ``get(url, params)``: the decoded JSON of one GET, raising ``FeedError``.
SentryGet = Callable[[str, dict[str, str] | None], Awaitable[Any]]


def _sentry_payload(event: dict[str, Any], issue: dict[str, Any]) -> dict[str, Any]:
    """The latest event of an issue, in the shape of Sentry's webhook payload."""
    exception: dict[str, Any] = {"values": []}
    breadcrumbs: dict[str, Any] = {"values": []}
    for entry in event.get("entries") or []:
        if not isinstance(entry, dict):
            continue
        raw = entry.get("data")
        data: dict[str, Any] = raw if isinstance(raw, dict) else {}
        if entry.get("type") == "exception":
            exception = {"values": data.get("values") or []}
        elif entry.get("type") == "breadcrumbs":
            breadcrumbs = {"values": data.get("values") or []}
    tags = [
        (t.get("key"), t.get("value"))
        for t in event.get("tags") or []
        if isinstance(t, dict)
    ]
    environment = next((v for k, v in tags if k == "environment"), "")
    return {
        "event": {
            "event_id": str(issue.get("id", "")),
            "title": issue.get("title") or event.get("title", ""),
            "level": issue.get("level") or "error",
            "exception": exception,
            "breadcrumbs": breadcrumbs,
            "tags": [list(t) for t in tags if all(isinstance(x, str) for x in t)],
            "environment": environment,
            "release": (event.get("release") or {}).get("version", "")
            if isinstance(event.get("release"), dict)
            else "",
            "project": (issue.get("project") or {}).get("slug", "")
            if isinstance(issue.get("project"), dict)
            else "",
        }
    }


def _permalink(issue: dict[str, Any], target: SentryTarget) -> str | None:
    link = issue.get("permalink")
    if isinstance(link, str) and link.startswith(f"https://{target.host}/"):
        return link
    if target.host == DEFAULT_SENTRY_HOST and isinstance(link, str):
        # sentry.io answers with the organisation's subdomain.
        if re.match(rf"^https://{re.escape(target.org)}\.sentry\.io/", link):
            return link
    return None


async def sentry_events(
    get: SentryGet,
    target: SentryTarget,
    since_iso: str,
    seen: Callable[[str], bool],
    project_root: Path,
) -> FeedResult:
    """The unresolved issues first seen after the rule, oldest first.

    Every URL is built here from the rule's checked target and fixed paths,
    never from what Sentry answered.
    """
    issues = await get(
        f"{target.api}/projects/{target.org}/{target.project}/issues/",
        {
            "query": f"is:unresolved firstSeen:>={since_iso}",
            "statsPeriod": "14d",
            "limit": str(SENTRY_ISSUES_PER_PASS),
            "sort": "new",
        },
    )
    if not isinstance(issues, list):
        raise FeedError(
            "source_failed",
            "Sentry answered the issue list with something else than a list",
        )
    result = FeedResult()
    parser = IncidentParser()
    for issue in reversed(issues):
        if not isinstance(issue, dict):
            continue
        issue_id = str(issue.get("id", ""))
        if not _SENTRY_ID.match(issue_id):
            continue
        key = incident_key(IncidentSource.SENTRY.value, issue_id)
        if seen(key):
            continue
        event = await get(f"{target.api}/issues/{issue_id}/events/latest/", None)
        try:
            incident = parser.parse(
                _sentry_payload(event if isinstance(event, dict) else {}, issue),
                IncidentSource.SENTRY,
            )
        except _PARSE_ERRORS:
            # An event of a shape we do not know: the issue's title still says what failed.
            incident = parser.parse(
                {"event": {"title": str(issue.get("title", ""))}}, IncidentSource.SENTRY
            )
        incident.id = issue_id
        result.events.append(
            card_for(incident, project_root, _permalink(issue, target))
        )
    return result
