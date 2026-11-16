"""Is a vulnerable dependency declared by the project, and imported by its code?

The scanners name a dependency as ``name==version`` (pip-audit) or
``name@range`` (npm audit). A dependency the project's manifests do not
declare came in through another one: it is tagged transitive, and still
reported, since it can be exploited through its parent.
"""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import PurePosixPath
from typing import Any

__all__ = ["declared_packages", "dependency_name", "is_imported", "normalize"]

_REQUIREMENT = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)")
_GO_REQUIRE = re.compile(r"^\s*(?:require\s+)?([\w.-]+\.[\w./-]+)\s+v\d", re.MULTILINE)
_GEM = re.compile(r"^\s*gem\s+['\"]([^'\"]+)['\"]", re.MULTILINE)
_PACKAGE_REFERENCE = re.compile(
    r"<PackageReference\s+Include=\"([^\"]+)\"", re.IGNORECASE
)
_ARTIFACT = re.compile(r"<artifactId>([^<]+)</artifactId>")
_GRADLE = re.compile(r"['\"][\w.-]+:([\w.-]+):[^'\"]*['\"]")
_JSON_SECTIONS = (
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "require",
    "require-dev",
)


def normalize(name: str) -> str:
    """PEP 503 style: case and ``-``/``_``/``.`` runs do not tell names apart."""
    return re.sub(r"[-_.]+", "-", name.strip().lower())


def dependency_name(dependency: str | None) -> str:
    """``requests==2.0`` → ``requests``; ``@scope/pkg@^1`` → ``@scope/pkg``."""
    raw = (dependency or "").strip()
    if not raw:
        return ""
    if "==" in raw:
        return raw.split("==", 1)[0]
    head, at, _ = raw[1:].partition("@")
    return raw[0] + head if at else raw


def _from_json(text: str) -> set[str]:
    try:
        data = json.loads(text)
    except ValueError:
        return set()
    names: set[str] = set()
    if isinstance(data, dict):
        for section in _JSON_SECTIONS:
            block = data.get(section)
            if isinstance(block, dict):
                names.update(str(key) for key in block)
    return names


def _requirement_names(items: Any) -> set[str]:
    names = set()
    for item in items if isinstance(items, list) else []:
        match = _REQUIREMENT.match(str(item))
        if match:
            names.add(match.group(1))
    return names


def _from_toml(text: str) -> set[str]:
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        return set()
    names: set[str] = set()
    project = data.get("project", {})
    if isinstance(project, dict):
        names |= _requirement_names(project.get("dependencies"))
        optional = project.get("optional-dependencies", {})
        for group in optional.values() if isinstance(optional, dict) else []:
            names |= _requirement_names(group)
    groups = data.get("dependency-groups", {})
    for group in groups.values() if isinstance(groups, dict) else []:
        names |= _requirement_names(group)
    poetry = (
        data.get("tool", {}).get("poetry", {})
        if isinstance(data.get("tool"), dict)
        else {}
    )
    for key in ("dependencies", "dev-dependencies"):
        block = poetry.get(key) if isinstance(poetry, dict) else None
        if isinstance(block, dict):
            names.update(str(name) for name in block)
    for key in ("dependencies", "dev-dependencies", "build-dependencies"):
        block = data.get(key)
        if isinstance(block, dict):
            names.update(str(name) for name in block)
    return names


def declared_packages(manifests: dict[str, str]) -> set[str]:
    """Every dependency a manifest of the project declares, normalized."""
    names: set[str] = set()
    for rel, text in manifests.items():
        name = PurePosixPath(rel).name
        if name.endswith(".json"):
            names |= _from_json(text)
        elif name.endswith(".toml"):
            names |= _from_toml(text)
        elif name.endswith(".txt"):
            names |= _requirement_names(text.splitlines())
        elif name == "go.mod":
            names.update(_GO_REQUIRE.findall(text))
        elif name == "Gemfile":
            names.update(_GEM.findall(text))
        elif name.endswith(".csproj"):
            names.update(_PACKAGE_REFERENCE.findall(text))
        elif name == "pom.xml":
            names.update(_ARTIFACT.findall(text))
        elif name.startswith("build.gradle"):
            names.update(_GRADLE.findall(text))
    return {normalize(n) for n in names if n}


def is_imported(name: str, import_text: str) -> bool:
    """The import lines name the package (``import yaml`` does not name PyYAML)."""
    wanted = re.escape(normalize(name)).replace("\\-", "[-_.]")
    pattern = rf"(?<![\w@./-]){wanted}(?![\w-])"
    return re.search(pattern, import_text, re.IGNORECASE) is not None
