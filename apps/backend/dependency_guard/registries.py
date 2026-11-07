"""Does a public registry know this package? Three answers, never two.

``found`` and ``not_found`` are what the registry said. ``unreachable`` is
everything else: a timeout, a 5xx, a proxy, a rate limit, or no network at all.
The licence resolvers (`license_governance.resolvers._http_get_json`) answer
``None`` for both a 404 and a network failure, which is right for a licence and
wrong here: only a 404 (or 410) may block a build, and a registry that did not
answer must never read as "this package does not exist".

Each ecosystem has one URL that answers 404 for an unknown name. The fetcher is
injected, so tests never touch the network and the caller decides whether the
network may be used at all (`offline_policy`, rule S7).
"""

from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

from .manifests import Package

logger = logging.getLogger(__name__)

__all__ = [
    "FOUND",
    "NOT_FOUND",
    "UNREACHABLE",
    "Fetch",
    "Lookup",
    "http_fetch",
    "lookup",
    "registry_url",
]

FOUND = "found"
NOT_FOUND = "not_found"
UNREACHABLE = "unreachable"

#: ``(url) -> (status, body)``; status 0 means no HTTP answer at all.
Fetch = Callable[[str], tuple[int, bytes]]

_TIMEOUT = 6.0
#: Enough for the registry document of a young package. An older one (react's
#: npm document is several megabytes) is cut, and reads as ``large``: a long
#: history, which is all the typo warning needs to know.
MAX_BODY = 512 * 1024
_USER_AGENT = (
    "WorkPilotAI-dependency-guard/1.0 (+https://github.com/krovomi/WorkPilot-AI)"
)


@dataclass(frozen=True)
class Lookup:
    presence: str
    url: str
    detail: str = ""
    created: datetime | None = None
    extra: dict = field(default_factory=dict)


def _q(text: str) -> str:
    return urllib.parse.quote(text, safe="")


def _go_escape(module: str) -> str:
    """The module proxy's case encoding: `Azure` -> `!azure`."""
    return re.sub(r"[A-Z]", lambda m: "!" + m.group(0).lower(), module)


def registry_url(package: Package) -> str | None:
    """The URL that answers 404 when ``package`` does not exist."""
    name = package.name
    match package.ecosystem:
        case "npm":
            # Scoped names keep their `@` and encode the slash.
            return "https://registry.npmjs.org/" + _q(name).replace("%40", "@", 1)
        case "pypi":
            return f"https://pypi.org/pypi/{_q(name)}/json"
        case "cargo":
            return f"https://crates.io/api/v1/crates/{_q(name)}"
        case "go":
            return f"https://proxy.golang.org/{_go_escape(name)}/@v/list"
        case "nuget":
            return (
                f"https://api.nuget.org/v3-flatcontainer/{_q(name.lower())}/index.json"
            )
        case "maven":
            group, _, artifact = name.partition(":")
            if not group or not artifact:
                return None
            path = "/".join(_q(p) for p in group.split("."))
            return f"https://repo1.maven.org/maven2/{path}/{_q(artifact)}/maven-metadata.xml"
        case "packagist":
            vendor, _, project = name.lower().partition("/")
            return f"https://repo.packagist.org/p2/{_q(vendor)}/{_q(project)}.json"
        case "pub":
            return f"https://pub.dev/api/packages/{_q(name)}"
        case "rubygems":
            return f"https://rubygems.org/api/v1/gems/{_q(name)}.json"
    return None


def http_fetch(url: str) -> tuple[int, bytes]:
    """GET ``url`` without a shell (rule S4); ``(0, b"")`` when nothing answered."""
    request = urllib.request.Request(
        url, headers={"User-Agent": _USER_AGENT, "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:  # noqa: S310 - fixed https registry URLs
            return response.status, response.read(MAX_BODY + 1)
    except urllib.error.HTTPError as exc:
        return exc.code, b""
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        logger.debug("registry unreachable for %s: %s", url, exc)
        return 0, b""


def _parse_time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _created(package: Package, body: bytes) -> datetime | None:
    """When the registry first saw the package, where it says so cheaply."""
    if not body:
        return None
    try:
        data = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    if package.ecosystem == "npm":
        return _parse_time((data.get("time") or {}).get("created"))
    if package.ecosystem == "cargo":
        return _parse_time((data.get("crate") or {}).get("created_at"))
    if package.ecosystem == "pypi":
        uploads = [
            _parse_time(f.get("upload_time_iso_8601"))
            for files in (data.get("releases") or {}).values()
            for f in files or []
            if isinstance(f, dict)
        ]
        uploads = [u for u in uploads if u]
        return min(uploads) if uploads else None
    return None


def lookup(package: Package, fetch: Fetch) -> Lookup:
    """Ask the package's public registry whether it exists."""
    url = registry_url(package)
    if url is None:
        return Lookup(UNREACHABLE, "", "no registry address for this name")
    status, body = fetch(url)
    if status in (404, 410):
        return Lookup(NOT_FOUND, url, f"the registry answered {status}")
    if 200 <= status < 300:
        if len(body) > MAX_BODY:
            return Lookup(FOUND, url, extra={"large": True})
        return Lookup(FOUND, url, created=_created(package, body))
    if status == 0:
        return Lookup(UNREACHABLE, url, "the registry did not answer")
    return Lookup(UNREACHABLE, url, f"the registry answered {status}")
