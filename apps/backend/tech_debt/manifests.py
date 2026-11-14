"""Dependencies that will rot, read from the manifest of every stack.

The scanner used to read the root ``package.json`` and ``requirements.txt``
only, so a .NET, JVM, Rust, Go, PHP or Flutter project scored as if its
dependencies were fine. Each reader here flags what the ecosystem itself
treats as unstable or unpinned, from the manifest alone (no registry call):

* npm (``package.json``): pre-1.0 range (``^0.``, ``~0.``), ``*``, ``latest``,
  a git or URL dependency;
* pip (``requirements*.txt``): a requirement without ``==``/``>=``/``~=``;
* NuGet (``*.csproj``, ``*.fsproj``, ``*.vbproj``, ``Directory.Packages.props``):
  a floating version (``*``, ``1.*``) or a prerelease (``-preview``, ``-beta``,
  ``-rc``, ``-alpha``);
* Maven (``pom.xml``): ``-SNAPSHOT``, ``LATEST``, ``RELEASE``, a version range;
* Gradle (``build.gradle``, ``build.gradle.kts``): a dynamic version
  (``1.+``, ``+``, ``latest.release``) or ``-SNAPSHOT``;
* Cargo (``Cargo.toml``): ``"*"``, or a git dependency without ``rev``/``tag``;
* Go (``go.mod``): a pseudo-version (a commit, not a release);
* Composer (``composer.json``): ``*``, ``dev-…``, ``@dev``;
* pub (``pubspec.yaml``): ``any``, or a git dependency.

Manifests are found anywhere in the tree (monorepos keep one per app),
outside dependency and build folders. Their content is the scanned
project's: it is parsed as data, XML through defusedxml.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

import yaml
from defusedxml import DefusedXmlException, ElementTree

MAX_MANIFEST_BYTES = 1_000_000


@dataclass(frozen=True)
class StaleDependency:
    file_path: str  # relative to the project root, with "/" separators
    line: int  # 0 when the format gives no line
    ecosystem: str  # npm | pip | nuget | maven | gradle | cargo | go | composer | pub
    name: str
    version: str
    reason: str  # pre_1_0 | unpinned | floating | prerelease | snapshot | range | vcs | pseudo_version

    @property
    def message(self) -> str:
        return f"{self.name} {self.version or '(no version)'}: {self.reason.replace('_', ' ')} ({self.ecosystem})"


def _read(path: Path) -> str | None:
    try:
        if path.stat().st_size > MAX_MANIFEST_BYTES:
            return None
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None


def _line_of(text: str, needle: str) -> int:
    for idx, line in enumerate(text.splitlines(), start=1):
        if needle in line:
            return idx
    return 0


# --- npm ---------------------------------------------------------------


def _npm(text: str) -> Iterator[tuple[int, str, str, str]]:
    try:
        data = json.loads(text)
    except ValueError:
        return
    if not isinstance(data, dict):
        return
    for section in ("dependencies", "devDependencies", "optionalDependencies"):
        deps = data.get(section)
        if not isinstance(deps, dict):
            continue
        for name, version in deps.items():
            if not isinstance(version, str):
                continue
            v = version.strip()
            reason = None
            if v in {"*", "latest", ""}:
                reason = "unpinned"
            elif v.startswith(("git", "github:", "http:", "https:")):
                reason = "vcs"
            elif v.startswith(("^0.", "~0.")):
                reason = "pre_1_0"
            if reason:
                yield _line_of(text, f'"{name}"'), name, v, reason


# --- pip ---------------------------------------------------------------

_PIP_PINNED = re.compile(r"(==|>=|~=|===|@)")


def _pip(text: str) -> Iterator[tuple[int, str, str, str]]:
    for idx, line in enumerate(text.splitlines(), start=1):
        s = line.split("#", 1)[0].strip()
        if not s or s.startswith(("-", "--")):
            continue
        if not _PIP_PINNED.search(s):
            yield idx, re.split(r"[<>!;\[ ]", s, maxsplit=1)[0], "", "unpinned"


# --- NuGet -------------------------------------------------------------

_NUGET_PRERELEASE = re.compile(r"-(alpha|beta|preview|rc|pre|dev)\b", re.IGNORECASE)


def _xml(text: str):
    try:
        return ElementTree.fromstring(text)
    except (ElementTree.ParseError, DefusedXmlException, ValueError):
        return None


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _nuget(text: str) -> Iterator[tuple[int, str, str, str]]:
    root = _xml(text)
    if root is None:
        return
    for node in root.iter():
        if _local(node.tag) not in {"PackageReference", "PackageVersion"}:
            continue
        name = node.get("Include") or node.get("Update") or ""
        version = node.get("Version") or node.get("VersionOverride") or ""
        if not version:
            for child in node:
                if _local(child.tag) == "Version" and child.text:
                    version = child.text.strip()
        if not name or not version:
            continue  # no version here: Central Package Management sets it
        reason = None
        if "*" in version:
            reason = "floating"
        elif _NUGET_PRERELEASE.search(version):
            reason = "prerelease"
        if reason:
            yield _line_of(text, f'"{name}"'), name, version, reason


# --- Maven -------------------------------------------------------------


def _maven(text: str) -> Iterator[tuple[int, str, str, str]]:
    root = _xml(text)
    if root is None:
        return
    for dep in root.iter():
        if _local(dep.tag) != "dependency":
            continue
        fields = {_local(c.tag): (c.text or "").strip() for c in dep}
        name = ":".join(
            x for x in (fields.get("groupId"), fields.get("artifactId")) if x
        )
        version = fields.get("version", "")
        if not name or not version or version.startswith("${"):
            continue
        reason = None
        if version.upper().endswith("-SNAPSHOT"):
            reason = "snapshot"
        elif version.upper() in {"LATEST", "RELEASE"}:
            reason = "floating"
        elif version[:1] in "[(":
            reason = "range"
        if reason:
            yield _line_of(text, fields.get("artifactId", name)), name, version, reason


# --- Gradle ------------------------------------------------------------

_GRADLE_DEP = re.compile(
    r"""(?:implementation|api|compileOnly|runtimeOnly|testImplementation|kapt|ksp|classpath)"""
    r"""\s*\(?\s*["']([\w.\-]+:[\w.\-]+):([^"']+)["']"""
)


def _gradle(text: str) -> Iterator[tuple[int, str, str, str]]:
    for idx, line in enumerate(text.splitlines(), start=1):
        for match in _GRADLE_DEP.finditer(line):
            name, version = match.group(1), match.group(2).strip()
            reason = None
            if version.endswith("+") or version.startswith("latest."):
                reason = "floating"
            elif version.upper().endswith("-SNAPSHOT"):
                reason = "snapshot"
            if reason:
                yield idx, name, version, reason


# --- Cargo -------------------------------------------------------------

_TOML_SECTION = re.compile(r"^\s*\[([^\]]+)\]\s*$")
_CARGO_DEP = re.compile(r"""^\s*([\w\-]+)\s*=\s*(.+?)\s*$""")


def _cargo(text: str) -> Iterator[tuple[int, str, str, str]]:
    section = ""
    for idx, line in enumerate(text.splitlines(), start=1):
        if match := _TOML_SECTION.match(line):
            section = match.group(1).strip()
            continue
        if not section.endswith("dependencies"):
            continue
        match = _CARGO_DEP.match(line.split("#", 1)[0])
        if not match:
            continue
        name, value = match.group(1), match.group(2)
        if value.strip('"') == "*" or re.search(r'version\s*=\s*"\*"', value):
            yield idx, name, "*", "unpinned"
        elif "git" in value and not re.search(r"\b(rev|tag)\s*=", value):
            yield idx, name, value[:60], "vcs"


# --- Go ----------------------------------------------------------------

_GO_REQUIRE = re.compile(r"^\s*(?:require\s+)?([\w.\-]+\.[\w.\-/]+)\s+(v\S+)")
_GO_PSEUDO = re.compile(r"-\d{14}-[0-9a-f]{12}$")


def _go(text: str) -> Iterator[tuple[int, str, str, str]]:
    for idx, line in enumerate(text.splitlines(), start=1):
        s = line.split("//", 1)[0]
        match = _GO_REQUIRE.match(s)
        if match and _GO_PSEUDO.search(match.group(2).removesuffix("+incompatible")):
            yield idx, match.group(1), match.group(2), "pseudo_version"


# --- Composer ----------------------------------------------------------


def _composer(text: str) -> Iterator[tuple[int, str, str, str]]:
    try:
        data = json.loads(text)
    except ValueError:
        return
    if not isinstance(data, dict):
        return
    for section in ("require", "require-dev"):
        deps = data.get(section)
        if not isinstance(deps, dict):
            continue
        for name, version in deps.items():
            if not isinstance(version, str) or name == "php" or name.startswith("ext-"):
                continue
            v = version.strip()
            reason = None
            if v == "*":
                reason = "unpinned"
            elif v.startswith("dev-") or "@dev" in v:
                reason = "prerelease"
            if reason:
                yield _line_of(text, f'"{name}"'), name, v, reason


# --- pub ---------------------------------------------------------------


def _pub(text: str) -> Iterator[tuple[int, str, str, str]]:
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        return
    if not isinstance(data, dict):
        return
    for section in ("dependencies", "dev_dependencies"):
        deps = data.get(section)
        if not isinstance(deps, dict):
            continue
        for name, spec in deps.items():
            if spec == "any" or spec is None:
                yield _line_of(text, f"{name}:"), str(name), "any", "unpinned"
            elif isinstance(spec, dict) and "git" in spec:
                git = spec["git"]
                if not (isinstance(git, dict) and git.get("ref")):
                    yield _line_of(text, f"{name}:"), str(name), "git", "vcs"


Reader = Callable[[str], Iterator[tuple[int, str, str, str]]]

_BY_NAME: dict[str, tuple[str, Reader]] = {
    "package.json": ("npm", _npm),
    "pom.xml": ("maven", _maven),
    "build.gradle": ("gradle", _gradle),
    "build.gradle.kts": ("gradle", _gradle),
    "Cargo.toml": ("cargo", _cargo),
    "go.mod": ("go", _go),
    "composer.json": ("composer", _composer),
    "pubspec.yaml": ("pub", _pub),
    "Directory.Packages.props": ("nuget", _nuget),
}
_BY_SUFFIX: dict[str, tuple[str, Reader]] = {
    ".csproj": ("nuget", _nuget),
    ".fsproj": ("nuget", _nuget),
    ".vbproj": ("nuget", _nuget),
}


def _reader_for(name: str) -> tuple[str, Reader] | None:
    if name in _BY_NAME:
        return _BY_NAME[name]
    if name.startswith("requirements") and name.endswith(".txt"):
        return "pip", _pip
    return _BY_SUFFIX.get(Path(name).suffix.lower())


def stale_dependencies(root: Path, skip_dirs: set[str]) -> list[StaleDependency]:
    """Every unstable or unpinned dependency of every manifest under ``root``."""
    found: list[StaleDependency] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            d for d in dirnames if d not in skip_dirs and d != "vendor"
        )
        for name in sorted(filenames):
            reader = _reader_for(name)
            if reader is None:
                continue
            ecosystem, read = reader
            path = Path(dirpath) / name
            text = _read(path)
            if text is None:
                continue
            rel = path.relative_to(root).as_posix()
            for line, dep, version, reason in read(text):
                found.append(
                    StaleDependency(rel, line, ecosystem, dep, version, reason)
                )
    return found
