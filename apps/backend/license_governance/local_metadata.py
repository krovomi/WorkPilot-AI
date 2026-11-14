"""Licences read from what is already installed on this machine.

A manifest names dependencies, not their licences: ``package.json`` lists
``"react": "^19"``, never ``MIT``. The scanner used to stop there, so every
dependency came out ``unknown`` and every scan failed. The installed copy
does carry the licence, offline and for the exact version in use:

* npm — ``node_modules/<name>/package.json`` (``license``);
* PyPI — ``<venv>/…/site-packages/<name>-<version>.dist-info/METADATA``;
* NuGet — the global packages folder, ``<id>/<version>/<id>.nuspec``;
* Cargo — ``~/.cargo/registry/src/*/<name>-<version>/Cargo.toml``;
* Go — the module cache, ``<module>@<version>/LICENSE`` (text recognised);
* Maven — ``~/.m2/repository/<group>/<artifact>/<version>/*.pom``;
* pub — ``~/.pub-cache/hosted/pub.dev/<name>-<version>/LICENSE``.

Nothing here touches the network; :mod:`license_governance.resolvers` asks
the registries for what is not installed.
"""

from __future__ import annotations

import json
import logging
import os
import re
from collections.abc import Iterable
from pathlib import Path
from xml.etree.ElementTree import ParseError  # noqa: S405 - exception type only

from defusedxml import ElementTree as DefusedET

from .resolvers import _normalise_license_field
from .scanner import DependencyRecord

logger = logging.getLogger(__name__)

_MAX_READ = 256 * 1024


def _read(path: Path, limit: int = _MAX_READ) -> str:
    try:
        with path.open(encoding="utf-8", errors="ignore") as fh:
            return fh.read(limit)
    except OSError:
        return ""


# ---------------------------------------------------------------------------
# Licence text → SPDX id


def detect_license_text(text: str) -> str | None:
    """Name the licence of a ``LICENSE`` file from its wording.

    Only the licences whose text is unmistakable; anything else stays
    ``None`` (unknown) rather than guessed.
    """
    if not text:
        return None
    head = " ".join(text[:6000].split()).lower()
    if "gnu affero general public license" in head:
        return "AGPL-3.0"
    if (
        "gnu lesser general public license" in head
        or "gnu library general public" in head
    ):
        return "LGPL-3.0" if "version 3" in head else "LGPL-2.1"
    if "gnu general public license" in head:
        return "GPL-3.0" if "version 3" in head else "GPL-2.0"
    if "mozilla public license" in head:
        return "MPL-2.0"
    if "eclipse public license" in head:
        return "EPL-2.0" if "2.0" in head else "EPL-1.0"
    if "apache license" in head and "version 2.0" in head:
        return "Apache-2.0"
    if "this is free and unencumbered software released into the public domain" in head:
        return "Unlicense"
    if "permission is hereby granted, free of charge" in head:
        return "MIT"
    if "permission to use, copy, modify, and/or distribute this software" in head:
        return "ISC"
    if "redistribution and use in source and binary forms" in head:
        return "BSD-3-Clause" if "neither the name" in head else "BSD-2-Clause"
    if "boost software license" in head:
        return "BSL-1.0"
    if "creative commons" in head and "cc0" in head:
        return "CC0-1.0"
    return None


_LICENSE_FILES = (
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "LICENCE",
    "COPYING",
    "license",
)


def _license_file_in(directory: Path) -> str | None:
    for name in _LICENSE_FILES:
        candidate = directory / name
        if candidate.is_file():
            found = detect_license_text(_read(candidate, 16 * 1024))
            if found:
                return found
    return None


# ---------------------------------------------------------------------------
# Versions


def _exact_version(spec: str) -> str | None:
    """``1.2.3`` or ``v1.2.3`` as written; a range (``^1.2``, ``>=2``) is not one."""
    cleaned = (spec or "").strip().lstrip("=").strip()
    if re.fullmatch(r"v?\d+(?:\.[0-9A-Za-z\-+]+)*", cleaned):
        return cleaned
    return None


def _pick_version_dir(parent: Path, spec: str) -> Path | None:
    """The folder of the exact version, else the highest one installed."""
    if not parent.is_dir():
        return None
    exact = _exact_version(spec)
    if exact and (parent / exact).is_dir():
        return parent / exact
    try:
        versions = [p for p in parent.iterdir() if p.is_dir()]
    except OSError:
        return None
    if not versions:
        return None
    return max(versions, key=lambda p: _version_key(p.name))


def _version_key(text: str) -> tuple:
    return tuple(
        int(n) if n.isdigit() else -1 for n in re.split(r"[.\-+]", text.lstrip("v"))
    )


def _home() -> Path:
    return Path(os.environ.get("USERPROFILE") or os.environ.get("HOME") or Path.home())


# ---------------------------------------------------------------------------
# Per-ecosystem readers


def _npm_roots(project_dir: Path) -> list[Path]:
    """``node_modules`` at the root and in workspace packages (two levels down)."""
    roots = [project_dir / "node_modules"]
    for pattern in ("*/node_modules", "*/*/node_modules"):
        roots.extend(p for p in project_dir.glob(pattern) if p.is_dir())
    return [r for r in roots if r.is_dir()]


def _npm_license(roots: Iterable[Path], name: str) -> str | None:
    for root in roots:
        manifest = root / name / "package.json"
        if not manifest.is_file():
            continue
        try:
            data = json.loads(_read(manifest))
        except json.JSONDecodeError:
            continue
        value = data.get("license") or data.get("licenses")
        found = _normalise_license_field(value)
        if found:
            return found
        found = _license_file_in(manifest.parent)
        if found:
            return found
    return None


def _normalise_dist(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _site_packages(project_dir: Path) -> list[Path]:
    found: list[Path] = []
    for venv in (".venv", "venv", "env", ".env"):
        for base in (project_dir, *project_dir.glob("*"), *project_dir.glob("*/*")):
            root = base / venv
            if not root.is_dir():
                continue
            found.extend(root.glob("lib/python*/site-packages"))
            found.extend(root.glob("Lib/site-packages"))
    return [p for p in found if p.is_dir()]


def _pypi_index(site_dirs: Iterable[Path]) -> dict[str, Path]:
    index: dict[str, Path] = {}
    for site in site_dirs:
        for dist in site.glob("*.dist-info"):
            name = dist.name[: -len(".dist-info")].rsplit("-", 1)[0]
            index.setdefault(_normalise_dist(name), dist)
    return index


def _pypi_license(dist_info: Path) -> str | None:
    metadata = _read(dist_info / "METADATA", 64 * 1024)
    expression = classifier = plain = None
    for line in metadata.splitlines():
        if not line.strip():
            break  # headers end at the first blank line; the body follows
        if line.startswith("License-Expression:"):
            expression = line.split(":", 1)[1].strip()
        elif line.startswith("License:") and plain is None:
            value = line.split(":", 1)[1].strip()
            plain = value if 0 < len(value) <= 200 else None
        elif line.startswith("Classifier: License ::") and classifier is None:
            classifier = line.rsplit("::", 1)[1].strip()
    found = expression or plain or classifier
    if found and found.upper() not in ("UNKNOWN", "OSI APPROVED"):
        return found
    for candidate in (dist_info / "licenses", dist_info):
        if candidate.is_dir():
            text = _license_file_in(candidate)
            if text:
                return text
    return None


def _nuget_root() -> Path:
    return Path(os.environ.get("NUGET_PACKAGES") or _home() / ".nuget" / "packages")


_LICENSE_URLS = (
    ("opensource.org/licenses/mit", "MIT"),
    ("apache.org/licenses/license-2.0", "Apache-2.0"),
    ("opensource.org/licenses/apache-2.0", "Apache-2.0"),
    ("opensource.org/licenses/bsd-3-clause", "BSD-3-Clause"),
    ("opensource.org/licenses/bsd-2-clause", "BSD-2-Clause"),
    ("gnu.org/licenses/gpl-3.0", "GPL-3.0"),
    ("gnu.org/licenses/lgpl", "LGPL-3.0"),
    ("mozilla.org/mpl/2.0", "MPL-2.0"),
)


def license_from_url(url: str | None) -> str | None:
    lowered = (url or "").lower()
    for marker, spdx in _LICENSE_URLS:
        if marker in lowered:
            return spdx
    return None


def _nuget_license(name: str, version: str) -> str | None:
    folder = _pick_version_dir(_nuget_root() / name.lower(), version)
    if folder is None:
        return None
    nuspec = next(folder.glob("*.nuspec"), None)
    if nuspec is not None:
        try:
            root = DefusedET.fromstring(_read(nuspec))
        except (ParseError, ValueError):
            root = None
        if root is not None:
            for el in root.iter():
                tag = el.tag.rsplit("}", 1)[-1]
                if tag == "license" and el.get("type") == "expression" and el.text:
                    return el.text.strip()
                if tag == "license" and el.get("type") == "file" and el.text:
                    found = detect_license_text(_read(folder / el.text.strip()))
                    if found:
                        return found
                if tag == "licenseUrl":
                    found = license_from_url(el.text)
                    if found:
                        return found
    return _license_file_in(folder)


def _cargo_license(name: str, version: str) -> str | None:
    home = Path(os.environ.get("CARGO_HOME") or _home() / ".cargo")
    exact = _exact_version(version)
    candidates: list[Path] = []
    for index in (home / "registry" / "src").glob("*"):
        if exact and (index / f"{name}-{exact}").is_dir():
            candidates.insert(0, index / f"{name}-{exact}")
        candidates.extend(
            p
            for p in index.glob(f"{name}-*")
            if re.fullmatch(rf"{re.escape(name)}-\d.*", p.name)
        )
    for crate in candidates:
        match = re.search(
            r'^\s*license\s*=\s*"([^"]+)"', _read(crate / "Cargo.toml"), re.M
        )
        if match:
            return match.group(1)
        found = _license_file_in(crate)
        if found:
            return found
    return None


def _go_escape(path: str) -> str:
    """Module cache paths spell an upper-case letter as ``!`` + lower case."""
    return "".join(f"!{c.lower()}" if c.isupper() else c for c in path)


def _go_license(name: str, version: str) -> str | None:
    gopath = os.environ.get("GOPATH") or str(_home() / "go")
    cache = Path(os.environ.get("GOMODCACHE") or Path(gopath) / "pkg" / "mod")
    escaped = _go_escape(name)
    exact = cache / f"{escaped}@{version}"
    candidates = [exact] if exact.is_dir() else []
    parent, _, leaf = escaped.rpartition("/")
    if (cache / parent).is_dir():
        candidates.extend(sorted((cache / parent).glob(f"{leaf}@*"), reverse=True))
    for module in candidates:
        found = _license_file_in(module)
        if found:
            return found
    return None


def _maven_license(name: str, version: str) -> str | None:
    if ":" not in name:
        return None
    group, artifact = name.split(":", 1)
    base = _home() / ".m2" / "repository" / Path(*group.split(".")) / artifact
    folder = _pick_version_dir(base, version)
    if folder is None:
        return None
    pom = next(folder.glob("*.pom"), None)
    if pom is None:
        return None
    try:
        root = DefusedET.fromstring(_read(pom))
    except (ParseError, ValueError):
        return None
    for el in root.iter():
        if el.tag.rsplit("}", 1)[-1] != "license":
            continue
        fields = {c.tag.rsplit("}", 1)[-1]: (c.text or "").strip() for c in el}
        if fields.get("name"):
            return fields["name"]
        found = license_from_url(fields.get("url"))
        if found:
            return found
    return None


def _pub_license(name: str, version: str) -> str | None:
    cache = Path(os.environ.get("PUB_CACHE") or _home() / ".pub-cache")
    hosted = cache / "hosted" / "pub.dev"
    exact = _exact_version(version)
    candidates = [hosted / f"{name}-{exact}"] if exact else []
    candidates.extend(sorted(hosted.glob(f"{name}-*"), reverse=True))
    for package in candidates:
        if package.is_dir():
            found = _license_file_in(package)
            if found:
                return found
    return None


class LocalLicenseResolver:
    """Resolve a dependency's licence from its installed copy, offline."""

    def __init__(self, project_dir: Path | str) -> None:
        self.project_dir = Path(project_dir)
        self._npm_roots: list[Path] | None = None
        self._pypi: dict[str, Path] | None = None

    def __call__(self, dep: DependencyRecord) -> str | None:
        try:
            return self._resolve(dep)
        except OSError as exc:
            logger.debug("local licence lookup failed for %s: %s", dep.name, exc)
            return None

    def _resolve(self, dep: DependencyRecord) -> str | None:
        eco = dep.ecosystem
        if eco == "npm":
            if self._npm_roots is None:
                self._npm_roots = _npm_roots(self.project_dir)
            return _npm_license(self._npm_roots, dep.name)
        if eco == "pypi":
            if self._pypi is None:
                self._pypi = _pypi_index(_site_packages(self.project_dir))
            dist = self._pypi.get(_normalise_dist(dep.name))
            return _pypi_license(dist) if dist else None
        if eco == "nuget":
            return _nuget_license(dep.name, dep.version)
        if eco == "cargo":
            return _cargo_license(dep.name, dep.version)
        if eco == "go":
            return _go_license(dep.name, dep.version)
        if eco == "maven":
            return _maven_license(dep.name, dep.version)
        if eco == "pub":
            return _pub_license(dep.name, dep.version)
        return None
