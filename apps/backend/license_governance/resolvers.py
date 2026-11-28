"""Real registry resolvers for the license scanner.

The base scanner (`license_governance.scanner`) takes an injectable
resolver: a callable `(DependencyRecord) -> str | None` that returns the
declared licence for a dep. This module ships two real resolvers that
hit the npm and PyPI registries over HTTPS, plus a small in-process
cache so we don't hammer the registries.

Both resolvers degrade silently to `None` on network failure: the
scanner then classifies the dep as `UNKNOWN` rather than crashing.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

from .scanner import DependencyRecord

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Cache


class _TtlCache:
    """Tiny thread-safe TTL cache. Process-local, no eviction beyond TTL."""

    def __init__(self, ttl_seconds: int = 24 * 3600) -> None:
        self.ttl = ttl_seconds
        self._lock = threading.Lock()
        self._store: dict[str, tuple[float, Any]] = {}

    def get(self, key: str) -> Any:
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return _MISS
            ts, value = entry
            if time.time() - ts > self.ttl:
                self._store.pop(key, None)
                return _MISS
            return value

    def put(self, key: str, value: Any) -> None:
        with self._lock:
            self._store[key] = (time.time(), value)

    def clear(self) -> None:
        with self._lock:
            self._store.clear()


_MISS = object()
_cache = _TtlCache()


# ---------------------------------------------------------------------------
# HTTP


_USER_AGENT = "WorkPilotAI-license-scanner/1.0"
_TIMEOUT = 5.0


def _http_get_json(url: str) -> dict | None:
    """Fetch + parse a JSON object. None on any failure (logged at DEBUG).

    Every registry answers an object; anything else (a list, a bare string)
    is an answer no resolver below knows how to read, so it is no answer.
    """
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": _USER_AGENT, "Accept": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:  # noqa: S310 — explicit https URLs
            if resp.status >= 400:
                return None
            payload = resp.read()
            if not payload:
                return None
            data = json.loads(payload.decode("utf-8"))
            return data if isinstance(data, dict) else None
    except (
        urllib.error.URLError,
        urllib.error.HTTPError,
        ValueError,  # JSONDecodeError, and UnicodeDecodeError for a binary body
        TimeoutError,
    ) as e:
        logger.debug("Registry fetch failed for %s: %s", url, e)
        return None
    except OSError as e:
        # Catches ConnectionResetError, gaierror, etc. on Windows.
        logger.debug("Registry network error for %s: %s", url, e)
        return None


def _strings(value: Any) -> list[str]:
    """The non-empty strings of a JSON list; a bare string is not a list of them.

    ``" OR ".join("MIT")`` is ``"M OR I OR T"``: a registry that answers one
    licence as a string instead of a one-item list must not be read letter by
    letter.
    """
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item]


def _object(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


# ---------------------------------------------------------------------------
# npm


def _normalise_license_field(value: Any) -> str | None:
    """npm `license` field can be a string, an object, or a list."""
    if value is None:
        return None
    if isinstance(value, str):
        return value or None
    if isinstance(value, dict):
        return value.get("type") or value.get("name") or None
    if isinstance(value, list):
        # Older packages: list of `{type, url}` dicts.
        names = [_normalise_license_field(v) for v in value]
        names = [n for n in names if n]
        if not names:
            return None
        # Combine with " OR " — the classifier picks the most permissive.
        return " OR ".join(names)
    return None


def npm_resolver(dep: DependencyRecord) -> str | None:
    """Look up a package's licence on the npm registry."""
    if dep.ecosystem != "npm" or not dep.name:
        return None

    cached = _cache.get(f"npm:{dep.name}")
    if cached is not _MISS:
        return cached

    # The /-/v1/ endpoints are heavier; the package root is enough for the
    # `license` field on the latest version.
    url = f"https://registry.npmjs.org/{urllib.parse.quote(dep.name, safe='@/')}"
    payload = _http_get_json(url)
    if payload is None:
        return None

    # Latest version's license is the most relevant — fall back to the
    # top-level `license` field if `dist-tags.latest` is missing.
    license_value: str | None = None
    versions = _object(payload.get("versions"))
    latest_tag = _object(payload.get("dist-tags")).get("latest")
    if isinstance(latest_tag, str) and latest_tag:
        latest_pkg = _object(versions.get(latest_tag))
        license_value = _normalise_license_field(latest_pkg.get("license"))
    if not license_value:
        license_value = _normalise_license_field(payload.get("license"))

    _cache.put(f"npm:{dep.name}", license_value)
    return license_value


# ---------------------------------------------------------------------------
# PyPI


def pypi_resolver(dep: DependencyRecord) -> str | None:
    """Look up a package's licence on the PyPI registry."""
    if dep.ecosystem != "pypi" or not dep.name:
        return None

    cached = _cache.get(f"pypi:{dep.name}")
    if cached is not _MISS:
        return cached

    url = f"https://pypi.org/pypi/{urllib.parse.quote(dep.name, safe='')}/json"
    payload = _http_get_json(url)
    if payload is None:
        return None

    info = _object(payload.get("info"))
    # PyPI fills `license` with the SPDX name OR the full text. Many newer
    # packages prefer classifiers like "License :: OSI Approved :: MIT License".
    raw_license = info.get("license")
    license_value: str | None = raw_license if isinstance(raw_license, str) else None
    license_value = license_value or None

    if not license_value:
        for classifier in _strings(info.get("classifiers")):
            if classifier.startswith("License :: "):
                # Take the leaf — the part after the last "::".
                license_value = classifier.split("::")[-1].strip()
                if license_value:
                    break

    # Some packages ship a 2 KB licence text instead of an SPDX id. We
    # only forward short values to the classifier — anything > 200 chars
    # is almost certainly a full licence text and won't classify cleanly.
    # An empty classifier leaf ("License :: OSI Approved :: ") is no licence.
    if not license_value or len(license_value) > 200:
        license_value = None

    _cache.put(f"pypi:{dep.name}", license_value)
    return license_value


# ---------------------------------------------------------------------------
# deps.dev (Go, Maven, Cargo, NuGet — and npm / PyPI as a second source)

# deps.dev names its systems in upper case; the scanner's ecosystems map 1:1.
_DEPS_DEV_SYSTEMS = {
    "npm": "NPM",
    "pypi": "PYPI",
    "go": "GO",
    "maven": "MAVEN",
    "cargo": "CARGO",
    "nuget": "NUGET",
}


def _exact(version: str) -> str | None:
    cleaned = (version or "").strip().lstrip("=").strip()
    if re.fullmatch(r"v?\d+(?:\.[0-9A-Za-z\-+]+)*", cleaned):
        return cleaned
    return None


def deps_dev_resolver(dep: DependencyRecord) -> str | None:
    """Look a package up on deps.dev (Google's Open Source Insights).

    One API answers for six ecosystems. A range (``^1.2``) is not a version:
    the package's default version stands in for it, since a licence rarely
    changes between releases.
    """
    system = _DEPS_DEV_SYSTEMS.get(dep.ecosystem)
    if system is None or not dep.name:
        return None
    key = f"depsdev:{system}:{dep.name}:{dep.version}"
    cached = _cache.get(key)
    if cached is not _MISS:
        return cached
    name = urllib.parse.quote(dep.name, safe="")
    base = f"https://api.deps.dev/v3/systems/{system}/packages/{name}"
    version = _exact(dep.version)
    if version and system == "GO" and not version.startswith("v"):
        version = f"v{version}"
    if version is None:
        package = _http_get_json(base)
        if package is None:
            return None
        versions = [v for v in package.get("versions") or [] if isinstance(v, dict)]
        default = next(
            (v for v in versions if v.get("isDefault")),
            versions[-1] if versions else None,
        )
        version = _object(_object(default).get("versionKey")).get("version")
        if not isinstance(version, str) or not version:
            _cache.put(key, None)
            return None
    payload = _http_get_json(f"{base}/versions/{urllib.parse.quote(version, safe='')}")
    if payload is None:
        return None
    licenses = _strings(payload.get("licenses"))
    value = (
        " OR ".join(lic for lic in licenses if lic.lower() != "non-standard") or None
    )
    _cache.put(key, value)
    return value


# ---------------------------------------------------------------------------
# Packagist (PHP), RubyGems, pub.dev (Dart)


def packagist_resolver(dep: DependencyRecord) -> str | None:
    if dep.ecosystem != "composer" or "/" not in dep.name:
        return None
    key = f"packagist:{dep.name}"
    cached = _cache.get(key)
    if cached is not _MISS:
        return cached
    name = dep.name.lower()
    payload = _http_get_json(
        f"https://repo.packagist.org/p2/{urllib.parse.quote(name, safe='/')}.json"
    )
    if payload is None:
        return None
    releases = _object(payload.get("packages")).get(name)
    latest = _object(releases[0]) if isinstance(releases, list) and releases else {}
    value = " OR ".join(_strings(latest.get("license"))) or None
    _cache.put(key, value)
    return value


def rubygems_resolver(dep: DependencyRecord) -> str | None:
    if dep.ecosystem != "rubygems" or not dep.name:
        return None
    key = f"rubygems:{dep.name}"
    cached = _cache.get(key)
    if cached is not _MISS:
        return cached
    payload = _http_get_json(
        f"https://rubygems.org/api/v1/gems/{urllib.parse.quote(dep.name, safe='')}.json"
    )
    if payload is None:
        return None
    value = " OR ".join(_strings(payload.get("licenses"))) or None
    _cache.put(key, value)
    return value


def pub_resolver(dep: DependencyRecord) -> str | None:
    """pub.dev tags each package's analysed licence as ``license:<spdx>``."""
    if dep.ecosystem != "pub" or not dep.name:
        return None
    key = f"pub:{dep.name}"
    cached = _cache.get(key)
    if cached is not _MISS:
        return cached
    payload = _http_get_json(
        f"https://pub.dev/api/packages/{urllib.parse.quote(dep.name, safe='')}/score"
    )
    if payload is None:
        return None
    tags = _strings(payload.get("tags"))
    spdx = [
        t.split(":", 1)[1]
        for t in tags
        if t.startswith("license:") and t != "license:fsf-libre"
    ]
    spdx = [s for s in spdx if s not in ("osi-approved", "unknown")]
    value = " OR ".join(s.upper() if s in ("mit", "isc") else s for s in spdx) or None
    _cache.put(key, value)
    return value


_REGISTRY_BY_ECOSYSTEM: dict[
    str, tuple[Callable[[DependencyRecord], str | None], ...]
] = {
    "npm": (npm_resolver, deps_dev_resolver),
    "pypi": (pypi_resolver, deps_dev_resolver),
    "go": (deps_dev_resolver,),
    "maven": (deps_dev_resolver,),
    "cargo": (deps_dev_resolver,),
    "nuget": (deps_dev_resolver,),
    "composer": (packagist_resolver,),
    "rubygems": (rubygems_resolver,),
    "pub": (pub_resolver,),
}


def registry_lookup(dep: DependencyRecord) -> str | None:
    """Ask the registries that know this ecosystem, first answer wins."""
    for resolver in _REGISTRY_BY_ECOSYSTEM.get(dep.ecosystem, ()):
        value = resolver(dep)
        if value:
            return value
    return None


class LicenseResolution:
    """Manifest, then installed copy, then registry; remembers which answered.

    ``source_of(dep)`` says where a licence came from (``manifest``,
    ``installed``, ``registry`` or ``override``) so the report can show it,
    and an unresolved one is told apart from a lookup that was never made
    (``online`` false under a strict offline policy).
    """

    def __init__(
        self,
        *,
        local: Callable[[DependencyRecord], str | None] | None = None,
        online: bool = True,
        overrides: dict[str, str | None] | None = None,
        registry: Callable[[DependencyRecord], str | None] = registry_lookup,
    ) -> None:
        self.local = local
        self.online = online
        self.overrides = overrides or {}
        self.registry = registry
        self._sources: dict[tuple[str, str, str], str] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _key(dep: DependencyRecord) -> tuple[str, str, str]:
        return (dep.ecosystem, dep.name, dep.version)

    def source_of(self, dep: DependencyRecord) -> str:
        with self._lock:
            return self._sources.get(self._key(dep), "")

    def _found(self, dep: DependencyRecord, source: str, value: str) -> str:
        with self._lock:
            self._sources[self._key(dep)] = source
        return value

    def __call__(self, dep: DependencyRecord) -> str | None:
        override = self.overrides.get(dep.name)
        if override:
            return self._found(dep, "override", override)
        if dep.declared_license:
            return self._found(dep, "manifest", dep.declared_license)
        if self.local is not None:
            value = self.local(dep)
            if value:
                return self._found(dep, "installed", value)
        if self.online:
            value = self.registry(dep)
            if value:
                return self._found(dep, "registry", value)
        return None


# ---------------------------------------------------------------------------
# Composition


def make_registry_resolver(
    *,
    enable_npm: bool = True,
    enable_pypi: bool = True,
    fallback: Callable[[DependencyRecord], str | None] | None = None,
) -> Callable[[DependencyRecord], str | None]:
    """Build a resolver that picks the right registry based on `ecosystem`.

    Args:
        enable_npm: route `npm` deps to the npm registry.
        enable_pypi: route `pypi` deps to PyPI.
        fallback: called for anything we can't resolve (cargo / go / unknown
            ecosystems). Defaults to `dep.declared_license` (the manifest value).
    """
    if fallback is None:
        fallback = lambda dep: dep.declared_license  # noqa: E731

    def _resolve(dep: DependencyRecord) -> str | None:
        if enable_npm and dep.ecosystem == "npm":
            value = npm_resolver(dep)
            if value:
                return value
        if enable_pypi and dep.ecosystem == "pypi":
            value = pypi_resolver(dep)
            if value:
                return value
        return fallback(dep)

    return _resolve


def reset_cache_for_tests() -> None:
    _cache.clear()
