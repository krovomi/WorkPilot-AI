"""Dependency manifests beyond npm / PyPI / Cargo / Go.

The scanner first read only ``package.json``, ``requirements.txt``,
``pyproject.toml``, ``Cargo.toml`` and ``go.mod``: a .NET, Java, PHP, Ruby or
Dart project scanned as "0 dependencies, compliant". Each parser here reads
one more ecosystem's manifest into :class:`DependencyRecord` rows, the same
shape the scanner already classifies.

Where the lock file itself records the licence (``composer.lock``), the row
carries it as ``declared_license`` and no lookup is needed.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from xml.etree.ElementTree import ParseError  # noqa: S405 - exception type only

from defusedxml import ElementTree as DefusedET

from .scanner import DependencyRecord


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def _local(tag: str) -> str:
    """``{namespace}Name`` → ``Name``; MSBuild and Maven files are namespaced."""
    return tag.rsplit("}", 1)[-1]


def _xml_root(path: Path):
    try:
        return DefusedET.fromstring(_read(path))
    except (ParseError, ValueError):
        return None


# ---------------------------------------------------------------------------
# .NET (NuGet)


def parse_msbuild_project(path: Path) -> list[DependencyRecord]:
    """``*.csproj`` / ``*.fsproj`` / ``*.vbproj`` / ``Directory.Packages.props``.

    Reads ``<PackageReference Include="X" Version="1.2.3" />`` and the central
    package management form ``<PackageVersion Include="X" Version="…" />``.
    A reference without a version (central management) still counts.
    """
    root = _xml_root(path)
    if root is None:
        return []
    deps: list[DependencyRecord] = []
    for el in root.iter():
        name = _local(el.tag)
        if name not in ("PackageReference", "PackageVersion"):
            continue
        package = el.get("Include") or el.get("Update")
        if not package:
            continue
        version = el.get("Version") or ""
        if not version:
            for child in el:
                if _local(child.tag) == "Version" and child.text:
                    version = child.text.strip()
        private = (el.get("PrivateAssets") or "").lower() == "all"
        deps.append(
            DependencyRecord(
                name=package,
                version=version,
                ecosystem="nuget",
                is_direct=not private,
            )
        )
    return deps


def parse_packages_config(path: Path) -> list[DependencyRecord]:
    """Legacy .NET Framework ``packages.config``."""
    root = _xml_root(path)
    if root is None:
        return []
    return [
        DependencyRecord(
            name=el.get("id") or "",
            version=el.get("version") or "",
            ecosystem="nuget",
            is_direct=(el.get("developmentDependency") or "").lower() != "true",
        )
        for el in root.iter()
        if _local(el.tag) == "package" and el.get("id")
    ]


# ---------------------------------------------------------------------------
# Java / Kotlin (Maven coordinates)


def parse_pom(path: Path) -> list[DependencyRecord]:
    """``pom.xml`` ``<dependency>`` blocks; ``${…}`` versions stay as written."""
    root = _xml_root(path)
    if root is None:
        return []
    deps: list[DependencyRecord] = []
    for el in root.iter():
        if _local(el.tag) != "dependency":
            continue
        fields = {_local(c.tag): (c.text or "").strip() for c in el}
        group, artifact = fields.get("groupId"), fields.get("artifactId")
        if not group or not artifact:
            continue
        deps.append(
            DependencyRecord(
                name=f"{group}:{artifact}",
                version=fields.get("version", ""),
                ecosystem="maven",
                is_direct=fields.get("scope", "") not in ("test", "provided"),
            )
        )
    return deps


# `implementation("g:a:v")`, `api 'g:a:v'`, `testImplementation "g:a:v"`…
_GRADLE_DEP_RE = re.compile(
    r"\b(\w*(?:[Ii]mplementation|[Aa]pi|[Cc]ompileOnly|[Rr]untimeOnly|kapt|ksp))"
    r"\s*\(?\s*['\"]([\w.\-]+):([\w.\-]+):([\w.\-+\[\],() ]+)['\"]"
)


def parse_gradle(path: Path) -> list[DependencyRecord]:
    """``build.gradle`` / ``build.gradle.kts`` string-notation dependencies."""
    deps: list[DependencyRecord] = []
    for config, group, artifact, version in _GRADLE_DEP_RE.findall(_read(path)):
        deps.append(
            DependencyRecord(
                name=f"{group}:{artifact}",
                version=version.strip(),
                ecosystem="maven",
                is_direct=not config.lower().startswith("test"),
            )
        )
    return deps


# ---------------------------------------------------------------------------
# PHP (Composer)


def _composer_license(value: object) -> str | None:
    if isinstance(value, list):
        names = [v for v in value if isinstance(v, str) and v]
        return " OR ".join(names) or None
    if isinstance(value, str):
        return value or None
    return None


def parse_composer_lock(path: Path) -> list[DependencyRecord]:
    """``composer.lock`` records every package's licence: no lookup needed."""
    try:
        data = json.loads(_read(path) or "{}")
    except json.JSONDecodeError:
        return []
    deps: list[DependencyRecord] = []
    for is_direct, key in ((True, "packages"), (False, "packages-dev")):
        for pkg in data.get(key) or []:
            if not isinstance(pkg, dict) or not pkg.get("name"):
                continue
            deps.append(
                DependencyRecord(
                    name=pkg["name"],
                    version=str(pkg.get("version") or ""),
                    ecosystem="composer",
                    declared_license=_composer_license(pkg.get("license")),
                    is_direct=is_direct,
                )
            )
    return deps


def parse_composer_json(path: Path) -> list[DependencyRecord]:
    """``composer.json`` when no lock file sits beside it."""
    if (path.parent / "composer.lock").exists():
        return []
    try:
        data = json.loads(_read(path) or "{}")
    except json.JSONDecodeError:
        return []
    deps: list[DependencyRecord] = []
    for is_direct, key in ((True, "require"), (False, "require-dev")):
        for name, version in (data.get(key) or {}).items():
            # `php` and `ext-*` are platform requirements, not packages.
            if name == "php" or name.startswith(("ext-", "lib-")) or "/" not in name:
                continue
            deps.append(
                DependencyRecord(
                    name=name,
                    version=str(version),
                    ecosystem="composer",
                    is_direct=is_direct,
                )
            )
    return deps


# ---------------------------------------------------------------------------
# Ruby (Bundler)

_GEMFILE_LOCK_SPEC_RE = re.compile(r"^ {4}([A-Za-z0-9_.\-]+) \(([^)]+)\)$")


def parse_gemfile_lock(path: Path) -> list[DependencyRecord]:
    """``Gemfile.lock`` resolved gems (the ``specs:`` entries, 4-space indent)."""
    deps: list[DependencyRecord] = []
    for line in _read(path).splitlines():
        m = _GEMFILE_LOCK_SPEC_RE.match(line)
        if m:
            deps.append(
                DependencyRecord(
                    name=m.group(1),
                    version=m.group(2),
                    ecosystem="rubygems",
                    is_direct=True,
                )
            )
    return deps


# ---------------------------------------------------------------------------
# Dart / Flutter (pub)


def parse_pubspec_lock(path: Path) -> list[DependencyRecord]:
    """``pubspec.lock``: hosted packages only (sdk and path packages are local)."""
    deps: list[DependencyRecord] = []
    name: str | None = None
    is_direct = True
    source = ""
    version = ""

    def flush() -> None:
        if name and source == "hosted":
            deps.append(
                DependencyRecord(
                    name=name, version=version, ecosystem="pub", is_direct=is_direct
                )
            )

    for raw in _read(path).splitlines():
        if re.match(r"^  [A-Za-z0-9_]+:\s*$", raw):
            flush()
            name, source, version, is_direct = raw.strip()[:-1], "", "", True
            continue
        stripped = raw.strip()
        if stripped.startswith("dependency:"):
            is_direct = "direct main" in stripped
        elif stripped.startswith("source:"):
            source = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("version:"):
            version = stripped.split(":", 1)[1].strip().strip('"')
    flush()
    return deps


# Manifest file name (or glob) → parser. Read by the scanner after its own.
EXTRA_PARSERS = [
    ("*.csproj", parse_msbuild_project),
    ("*.fsproj", parse_msbuild_project),
    ("*.vbproj", parse_msbuild_project),
    ("Directory.Packages.props", parse_msbuild_project),
    ("packages.config", parse_packages_config),
    ("pom.xml", parse_pom),
    ("build.gradle", parse_gradle),
    ("build.gradle.kts", parse_gradle),
    ("composer.lock", parse_composer_lock),
    ("composer.json", parse_composer_json),
    ("Gemfile.lock", parse_gemfile_lock),
    ("pubspec.lock", parse_pubspec_lock),
]
