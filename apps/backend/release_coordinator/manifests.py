"""Service manifests of every stack, for the release train.

A *service* is a directory holding a manifest that names it and, when the
stack records one, its version: ``package.json`` (Node, Angular, React, Vue,
Next, Nuxt), ``pyproject.toml``, ``*.csproj`` / ``*.fsproj`` / ``*.vbproj``
(.NET, Blazor), ``Cargo.toml``, ``go.mod``, ``pom.xml``, ``build.gradle`` /
``build.gradle.kts`` (Java, Kotlin, Android), ``pubspec.yaml`` (Dart,
Flutter), ``composer.json`` (PHP), ``*.gemspec`` (Ruby), ``mix.exs``
(Elixir) and ``Package.swift`` (Swift).

A stack whose manifest carries no version (Go, Swift) starts at ``0.0.0``:
the plan still shows which commits would ship with it.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

Manifest = dict[str, Any]
Reader = Callable[[Path], Manifest | None]

# Directories that hold generated, vendored or third-party code.
_SKIPPED_DIRS = frozenset(
    {
        ".git",
        "node_modules",
        "dist",
        "build",
        "out",
        "target",
        "bin",
        "obj",
        ".venv",
        "venv",
        "__pycache__",
        "vendor",
        ".dart_tool",
        ".gradle",
        ".build",
        "Pods",
        "deps",
        "_build",
        ".next",
        ".nuxt",
    }
)


def _read_text(path: Path, encoding: str = "utf-8") -> str | None:
    try:
        return path.read_text(encoding=encoding)
    except (OSError, UnicodeDecodeError):
        return None


def _manifest(name: str, version: str = "", deps: list[str] | None = None) -> Manifest:
    return {"name": name, "version": version or "0.0.0", "dependencies": deps or []}


def read_package_json(path: Path) -> Manifest | None:
    text = _read_text(path)
    if text is None:
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict) or not data.get("name"):
        return None
    deps = data.get("dependencies") or {}
    return _manifest(
        str(data["name"]),
        str(data.get("version") or ""),
        list(deps.keys()) if isinstance(deps, dict) else [],
    )


def _toml_table_values(content: str, tables: set[str]) -> dict[str, str]:
    """``key = "value"`` pairs of the first of ``tables`` that sets them."""
    values: dict[str, str] = {}
    current = ""
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("["):
            current = stripped.strip("[]").strip()
            continue
        if current not in tables or "=" not in stripped:
            continue
        key, _, raw = stripped.partition("=")
        value = raw.split("#", 1)[0].strip().strip('"').strip("'")
        values.setdefault(key.strip(), value)
    return values


def read_pyproject(path: Path) -> Manifest | None:
    text = _read_text(path)
    if text is None:
        return None
    values = _toml_table_values(text, {"project", "tool.poetry"})
    if not values.get("name"):
        return None
    return _manifest(values["name"], values.get("version", ""))


def read_cargo_toml(path: Path) -> Manifest | None:
    text = _read_text(path)
    if text is None:
        return None
    values = _toml_table_values(text, {"package"})
    if not values.get("name"):
        return None
    return _manifest(values["name"], values.get("version", ""))


def _xml_tag(content: str, tag: str) -> str:
    match = re.search(rf"<{tag}>\s*([^<]+?)\s*</{tag}>", content, re.IGNORECASE)
    return match.group(1).strip() if match else ""


def read_dotnet_project(path: Path) -> Manifest | None:
    """A ``.csproj``, ``.fsproj`` or ``.vbproj`` (SDK-style or legacy)."""
    text = _read_text(path, "utf-8-sig")
    if text is None:
        return None
    # <Version> > <VersionPrefix> > <AssemblyVersion> (4-part; SemVer keeps 3).
    version = (
        _xml_tag(text, "Version")
        or _xml_tag(text, "VersionPrefix")
        or _xml_tag(text, "AssemblyVersion")
    )
    deps = [
        Path(ref.replace("\\", "/")).stem
        for ref in re.findall(
            r'<ProjectReference\s+Include\s*=\s*"([^"]+)"', text, re.IGNORECASE
        )
    ]
    return _manifest(_xml_tag(text, "AssemblyName") or path.stem, version, deps)


def read_pom(path: Path) -> Manifest | None:
    """A Maven ``pom.xml``: the project's own coordinates, not its parent's."""
    text = _read_text(path)
    if text is None:
        return None
    own = re.sub(r"<parent>.*?</parent>", "", text, flags=re.DOTALL)
    own = re.sub(r"<dependencies>.*?</dependencies>", "", own, flags=re.DOTALL)
    own = re.sub(r"<build>.*?</build>", "", own, flags=re.DOTALL)
    name = _xml_tag(own, "artifactId")
    if not name:
        return None
    version = _xml_tag(own, "version")
    if version.startswith("${"):
        version = ""
    return _manifest(name, version)


def read_gradle(path: Path) -> Manifest | None:
    """``build.gradle`` / ``build.gradle.kts``: ``version = "1.2.3"``."""
    text = _read_text(path)
    if text is None:
        return None
    match = re.search(r"""^\s*version\s*=?\s*["']([^"']+)["']""", text, re.MULTILINE)
    return _manifest(path.parent.name, match.group(1) if match else "")


def read_pubspec(path: Path) -> Manifest | None:
    text = _read_text(path)
    if text is None:
        return None
    name = re.search(r"^name:\s*([\w-]+)", text, re.MULTILINE)
    if not name:
        return None
    version = re.search(r"^version:\s*([^\s#]+)", text, re.MULTILINE)
    # Flutter appends a build number: 1.4.0+12 → 1.4.0.
    return _manifest(name.group(1), version.group(1).split("+")[0] if version else "")


def read_composer(path: Path) -> Manifest | None:
    manifest = read_package_json(path)
    if manifest:
        manifest["dependencies"] = []
    return manifest


def read_go_mod(path: Path) -> Manifest | None:
    text = _read_text(path)
    if text is None:
        return None
    match = re.search(r"^module\s+(\S+)", text, re.MULTILINE)
    if not match:
        return None
    return _manifest(match.group(1).rstrip("/").rsplit("/", 1)[-1])


def read_gemspec(path: Path) -> Manifest | None:
    text = _read_text(path)
    if text is None:
        return None
    name = re.search(r"""\.name\s*=\s*["']([^"']+)["']""", text)
    version = re.search(r"""\.version\s*=\s*["']([^"']+)["']""", text)
    return _manifest(
        name.group(1) if name else path.stem, version.group(1) if version else ""
    )


def read_mix(path: Path) -> Manifest | None:
    text = _read_text(path)
    if text is None:
        return None
    name = re.search(r"app:\s*:(\w+)", text)
    if not name:
        return None
    version = re.search(r"""version:\s*["']([^"']+)["']""", text)
    return _manifest(name.group(1), version.group(1) if version else "")


def read_swift_package(path: Path) -> Manifest | None:
    text = _read_text(path)
    if text is None:
        return None
    name = re.search(r"""Package\s*\(\s*name:\s*["']([^"']+)["']""", text)
    return _manifest(name.group(1) if name else path.parent.name)


def _reader_for(filename: str) -> Reader | None:
    exact: dict[str, Reader] = {
        "package.json": read_package_json,
        "pyproject.toml": read_pyproject,
        "Cargo.toml": read_cargo_toml,
        "go.mod": read_go_mod,
        "pom.xml": read_pom,
        "build.gradle": read_gradle,
        "build.gradle.kts": read_gradle,
        "pubspec.yaml": read_pubspec,
        "composer.json": read_composer,
        "mix.exs": read_mix,
        "Package.swift": read_swift_package,
    }
    if filename in exact:
        return exact[filename]
    if filename.endswith((".csproj", ".fsproj", ".vbproj")):
        return read_dotnet_project
    if filename.endswith(".gemspec"):
        return read_gemspec
    return None


def _manifest_files(project_path: Path) -> Iterator[Path]:
    for root, dirs, files in os.walk(project_path):
        dirs[:] = sorted(d for d in dirs if d not in _SKIPPED_DIRS)
        for filename in sorted(files):
            if _reader_for(filename):
                yield Path(root) / filename


def discover_services(project_path: Path) -> list[tuple[Path, Manifest]]:
    """Every service of ``project_path``, whatever its stack, named once."""
    services: list[tuple[Path, Manifest]] = []
    seen: set[str] = set()
    for path in _manifest_files(project_path):
        reader = _reader_for(path.name)
        info = reader(path) if reader else None
        if info and info["name"] not in seen:
            services.append((path.parent, info))
            seen.add(info["name"])
    return services
