"""The registry packages a manifest declares, for every stack WorkPilot builds.

One parser per manifest format, each a pure function of the file's text, so
the guard can read the same file at the base branch (`git show`) and in the
worktree and compare. Only packages that come **from a public registry by
name** are returned: a path, a git URL, a workspace link or a local project
reference is not something a registry can confirm, and is left out rather
than reported missing.

| Ecosystem  | Files |
|------------|-------|
| npm        | ``package.json`` |
| pypi       | ``requirements*.txt``, ``pyproject.toml`` (PEP 621, Poetry, dependency groups) |
| cargo      | ``Cargo.toml`` |
| go         | ``go.mod`` |
| nuget      | ``*.csproj``, ``*.fsproj``, ``*.vbproj``, ``Directory.Packages.props``, ``packages.config`` |
| maven      | ``pom.xml``, ``build.gradle``, ``build.gradle.kts`` |
| packagist  | ``composer.json`` |
| pub        | ``pubspec.yaml`` |
| rubygems   | ``Gemfile`` |
"""

from __future__ import annotations

import json
import re
import tomllib
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import PurePosixPath
from xml.etree import ElementTree as ET  # noqa: S405 - types and ParseError only

from defusedxml import DefusedXmlException
from defusedxml.ElementTree import fromstring as _xml

__all__ = ["Package", "is_manifest", "parse_manifest"]


@dataclass(frozen=True, order=True)
class Package:
    """A package a manifest asks a public registry for."""

    ecosystem: str
    name: str
    manifest: str = ""

    @property
    def key(self) -> tuple[str, str]:
        """What two manifests compare on: npm and PyPI names fold case."""
        if self.ecosystem in ("pypi",):
            return self.ecosystem, re.sub(r"[-_.]+", "-", self.name).lower()
        if self.ecosystem in ("nuget", "packagist", "go"):
            return self.ecosystem, self.name.lower()
        return self.ecosystem, self.name


# --------------------------------------------------------------------------- npm

_NPM_NOT_REGISTRY = re.compile(
    r"^(?:file:|link:|workspace:|portal:|patch:|git\+|git:|github:|gitlab:|"
    r"bitbucket:|https?:|\.{0,2}/|~/)"
)
_NPM_SECTIONS = (
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
)


def _npm_target(name: str, spec: object) -> str | None:
    if not isinstance(spec, str):
        return None
    spec = spec.strip()
    if spec.startswith("npm:"):
        # An alias: `"lodash-es": "npm:lodash@^4"` installs `lodash`.
        aliased = spec[4:]
        at = aliased.rfind("@")
        return aliased[:at] if at > 0 else aliased
    if _NPM_NOT_REGISTRY.match(spec) or "/" in spec and not spec.startswith("@"):
        # `user/repo` is a GitHub shorthand.
        return None
    return name


def _parse_package_json(text: str) -> set[tuple[str, str]]:
    data = json.loads(text)
    out: set[tuple[str, str]] = set()
    if not isinstance(data, dict):
        return out
    for section in _NPM_SECTIONS:
        deps = data.get(section)
        if not isinstance(deps, dict):
            continue
        for name, spec in deps.items():
            target = _npm_target(str(name), spec)
            if target:
                out.add(("npm", target))
    return out


# -------------------------------------------------------------------------- pypi

_PEP508_NAME = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)")


def _pep508_name(requirement: str) -> str | None:
    requirement = requirement.split(";", 1)[0].strip()
    if not requirement or " @ " in requirement or "://" in requirement:
        # `name @ https://…` and URLs do not come from the index by name.
        return None
    match = _PEP508_NAME.match(requirement)
    return match.group(1) if match else None


def _parse_requirements_txt(text: str) -> set[tuple[str, str]]:
    out: set[tuple[str, str]] = set()
    for raw in text.splitlines():
        line = raw.split(" #", 1)[0].strip()
        if not line or line.startswith(("#", "-", ".", "/", "~")) or "://" in line:
            # Options (`-r`, `-e`, `--index-url`), paths and URLs.
            continue
        name = _pep508_name(line)
        if name:
            out.add(("pypi", name))
    return out


def _poetry_names(table: object) -> set[str]:
    names: set[str] = set()
    if not isinstance(table, dict):
        return names
    for name, spec in table.items():
        if str(name).lower() == "python":
            continue
        if isinstance(spec, dict) and ({"path", "git", "url"} & spec.keys()):
            continue
        names.add(str(name))
    return names


def _parse_pyproject_toml(text: str) -> set[tuple[str, str]]:
    data = tomllib.loads(text)
    requirements: list[str] = []
    project = data.get("project") or {}
    requirements += list(project.get("dependencies") or [])
    for group in (project.get("optional-dependencies") or {}).values():
        requirements += list(group or [])
    for group in (data.get("dependency-groups") or {}).values():
        requirements += [r for r in group or [] if isinstance(r, str)]
    names = {n for r in requirements if isinstance(r, str) and (n := _pep508_name(r))}

    poetry = (data.get("tool") or {}).get("poetry") or {}
    names |= _poetry_names(poetry.get("dependencies"))
    names |= _poetry_names(poetry.get("dev-dependencies"))
    for group in (poetry.get("group") or {}).values():
        if isinstance(group, dict):
            names |= _poetry_names(group.get("dependencies"))

    sources = ((data.get("tool") or {}).get("uv") or {}).get("sources") or {}
    # `[tool.uv.sources] pkg = { path = … }`: a workspace member, not PyPI.
    names -= {str(n) for n in sources}
    return {("pypi", n) for n in names}


# ------------------------------------------------------------------------- cargo


def _parse_cargo_toml(text: str) -> set[tuple[str, str]]:
    data = tomllib.loads(text)
    tables: list[object] = [
        data.get(section)
        for section in ("dependencies", "dev-dependencies", "build-dependencies")
    ]
    for target in (data.get("target") or {}).values():
        if isinstance(target, dict):
            tables += [target.get("dependencies"), target.get("dev-dependencies")]
    out: set[tuple[str, str]] = set()
    for table in tables:
        if not isinstance(table, dict):
            continue
        for name, spec in table.items():
            if isinstance(spec, dict):
                if {"path", "git"} & spec.keys() or spec.get("workspace"):
                    continue
                if spec.get("registry"):
                    continue  # an alternate registry, not crates.io
                name = spec.get("package", name)
            out.add(("cargo", str(name)))
    return out


# ---------------------------------------------------------------------------- go

_GO_REQUIRE = re.compile(r"^\s*([^\s()]+)\s+v[0-9]")


def _parse_go_mod(text: str) -> set[tuple[str, str]]:
    replaced = {m.group(1) for m in re.finditer(r"^\s*replace\s+(\S+)", text, re.M)}
    out: set[tuple[str, str]] = set()
    in_block = False
    for raw in text.splitlines():
        line = raw.split("//", 1)[0].rstrip()
        stripped = line.strip()
        if stripped.startswith("require ("):
            in_block = True
            continue
        if in_block and stripped == ")":
            in_block = False
            continue
        if stripped.startswith("require "):
            line = stripped[len("require ") :]
        elif not in_block:
            continue
        match = _GO_REQUIRE.match(line)
        if match and match.group(1) not in replaced:
            out.add(("go", match.group(1)))
    return out


# ------------------------------------------------------------------------- nuget


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _parse_msbuild(text: str) -> set[tuple[str, str]]:
    root = _xml(text)
    out: set[tuple[str, str]] = set()
    for element in root.iter():
        if _local(element.tag) not in ("PackageReference", "PackageVersion"):
            continue
        name = element.get("Include") or element.get("Update")
        if name and "$(" not in name:
            out.add(("nuget", name))
    return out


def _parse_packages_config(text: str) -> set[tuple[str, str]]:
    root = _xml(text)
    return {
        ("nuget", e.get("id", ""))
        for e in root.iter()
        if _local(e.tag) == "package" and e.get("id")
    }


# ------------------------------------------------------------------------- maven


def _parse_pom_xml(text: str) -> set[tuple[str, str]]:
    root = _xml(text)
    out: set[tuple[str, str]] = set()
    for dep in root.iter():
        if _local(dep.tag) != "dependency":
            continue
        fields = {_local(c.tag): (c.text or "").strip() for c in dep}
        group, artifact = fields.get("groupId", ""), fields.get("artifactId", "")
        if not group or not artifact or "${" in group + artifact:
            continue
        if fields.get("scope") == "system":
            continue
        out.add(("maven", f"{group}:{artifact}"))
    return out


_GRADLE_COORD = re.compile(
    r"""(?:implementation|api|compileOnly|runtimeOnly|testImplementation|"""
    r"""testRuntimeOnly|testCompileOnly|annotationProcessor|kapt|ksp|"""
    r"""androidTestImplementation|debugImplementation|classpath)"""
    r"""\s*\(?\s*["']([A-Za-z0-9_.\-]+):([A-Za-z0-9_.\-]+)(?::[^"']*)?["']"""
)


def _parse_gradle(text: str) -> set[tuple[str, str]]:
    return {("maven", f"{g}:{a}") for g, a in _GRADLE_COORD.findall(text)}


# --------------------------------------------------------------------- packagist


def _parse_composer_json(text: str) -> set[tuple[str, str]]:
    data = json.loads(text)
    out: set[tuple[str, str]] = set()
    if not isinstance(data, dict):
        return out
    local = {
        r.get("package", {}).get("name")
        for r in data.get("repositories") or []
        if isinstance(r, dict) and isinstance(r.get("package"), dict)
    }
    for section in ("require", "require-dev"):
        for name in data.get(section) or {}:
            name = str(name)
            if "/" not in name or name in local:
                # `php`, `ext-json`, `lib-icu` are platform packages.
                continue
            out.add(("packagist", name))
    return out


# --------------------------------------------------------------------------- pub


def _parse_pubspec_yaml(text: str) -> set[tuple[str, str]]:
    import yaml

    try:
        data = yaml.safe_load(text) or {}
    except yaml.YAMLError as exc:
        raise ValueError(str(exc)) from exc
    out: set[tuple[str, str]] = set()
    if not isinstance(data, dict):
        return out
    for section in ("dependencies", "dev_dependencies"):
        deps = data.get(section)
        if not isinstance(deps, dict):
            continue
        for name, spec in deps.items():
            if isinstance(spec, dict) and (
                {"sdk", "path", "git"} & spec.keys() or "hosted" in spec
            ):
                continue
            out.add(("pub", str(name)))
    return out


# ---------------------------------------------------------------------- rubygems

_GEM = re.compile(r"""^\s*gem\s+["']([A-Za-z0-9_.\-]+)["'](.*)$""")


def _parse_gemfile(text: str) -> set[tuple[str, str]]:
    out: set[tuple[str, str]] = set()
    in_foreign_source = 0
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].rstrip()
        stripped = line.strip()
        if re.match(r"^source\s+.*\bdo\b", stripped):
            in_foreign_source += 1
            continue
        if in_foreign_source and stripped == "end":
            in_foreign_source -= 1
            continue
        match = _GEM.match(line)
        if not match or in_foreign_source:
            continue
        if re.search(r"\b(?:path|git|github|source)\s*:", match.group(2)):
            continue
        out.add(("rubygems", match.group(1)))
    return out


# ----------------------------------------------------------------------- routing

_BY_NAME: dict[str, Callable[[str], set[tuple[str, str]]]] = {
    "package.json": _parse_package_json,
    "pyproject.toml": _parse_pyproject_toml,
    "cargo.toml": _parse_cargo_toml,
    "go.mod": _parse_go_mod,
    "directory.packages.props": _parse_msbuild,
    "packages.config": _parse_packages_config,
    "pom.xml": _parse_pom_xml,
    "build.gradle": _parse_gradle,
    "build.gradle.kts": _parse_gradle,
    "composer.json": _parse_composer_json,
    "pubspec.yaml": _parse_pubspec_yaml,
    "gemfile": _parse_gemfile,
}
_BY_SUFFIX: dict[str, Callable[[str], set[tuple[str, str]]]] = {
    ".csproj": _parse_msbuild,
    ".fsproj": _parse_msbuild,
    ".vbproj": _parse_msbuild,
}
_REQUIREMENTS = re.compile(r"^requirements[\w.-]*\.(?:txt|in)$")
_SKIPPED_DIRS = frozenset({"node_modules", "vendor", ".venv", "venv", "bin", "obj"})


def _parser_for(path: str) -> Callable[[str], set[tuple[str, str]]] | None:
    pure = PurePosixPath(path.replace("\\", "/"))
    if _SKIPPED_DIRS & {p.lower() for p in pure.parts[:-1]}:
        return None
    name = pure.name.lower()
    if name in _BY_NAME:
        return _BY_NAME[name]
    if _REQUIREMENTS.match(name):
        return _parse_requirements_txt
    return _BY_SUFFIX.get(pure.suffix.lower())


def is_manifest(path: str) -> bool:
    """Whether ``path`` is a manifest this module reads."""
    return _parser_for(path) is not None


def parse_manifest(path: str, text: str) -> set[Package]:
    """The registry packages ``text`` (the content of ``path``) declares.

    Raises ``ValueError`` when the file cannot be parsed: the caller says the
    manifest is unreadable instead of treating it as empty.
    """
    parser = _parser_for(path)
    if parser is None:
        return set()
    try:
        found = parser(text)
    except (
        ValueError,
        TypeError,
        ET.ParseError,
        DefusedXmlException,
        tomllib.TOMLDecodeError,
    ) as exc:
        raise ValueError(f"{path}: {exc}") from exc
    return {Package(eco, name, path) for eco, name in found if name}
