"""
Clean Architecture layers, found in any stack
==============================================

Recognises the four layers of a Clean / Onion / Hexagonal layout from the
directories a project already has, whatever its language:

* .NET solutions split into projects: ``src/Shop.Domain/Shop.Domain.csproj``,
  ``Shop.Application``, ``Shop.Infrastructure``, ``Shop.Api`` (``Core``,
  ``UseCases``, ``Persistence``, ``WebApi``, ``Web``… are read the same way);
* folders named ``domain``, ``application``, ``infrastructure``,
  ``presentation`` (and their usual synonyms) in Java, Kotlin, Go, PHP, Rust,
  Dart, Swift, Python or TypeScript code.

A folder layout counts only when one parent holds a ``domain`` layer and at
least one other layer: a lone ``api/`` or ``core/`` folder says nothing about
the architecture, and guessing from it would report violations that are not.

Each layer gets its file patterns and, per language, the module names its
code is imported by (namespace, package, Go import path, crate path, Dart
package, Swift target), so an import is attributed to a layer without
resolving it to a file. The rules are the dependency rule and nothing more:
the domain depends on no other layer, the application only on the domain,
the infrastructure not on the presentation.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from .models import ForbiddenPattern, LayerConfig

DOMAIN = "domain"
APPLICATION = "application"
INFRASTRUCTURE = "infrastructure"
PRESENTATION = "presentation"

#: Inner layers first. A layer may not depend on any layer after it.
LAYER_ORDER = (DOMAIN, APPLICATION, INFRASTRUCTURE, PRESENTATION)

#: The presentation is the composition root: it wires the infrastructure in,
#: so only the three inner layers carry a ban.
FORBIDDEN: dict[str, list[str]] = {
    DOMAIN: [APPLICATION, INFRASTRUCTURE, PRESENTATION],
    APPLICATION: [INFRASTRUCTURE, PRESENTATION],
    INFRASTRUCTURE: [PRESENTATION],
    PRESENTATION: [],
}

#: Folder names (lower case, without separators) per layer.
_FOLDER_NAMES: dict[str, set[str]] = {
    DOMAIN: {"domain", "domainmodel", "entities"},
    APPLICATION: {"application", "usecases", "usecase", "app_services"},
    INFRASTRUCTURE: {"infrastructure", "infra", "persistence", "data"},
    PRESENTATION: {"presentation", "webapi", "ui", "interfaces"},
}

#: Last dotted segment of a .NET project name (lower case) per layer. ``Core``
#: is the domain there (Ardalis, Jason Taylor templates); ``Api``, ``Web`` and
#: hosts are the presentation. Read only on folders that hold a project file.
_DOTNET_SUFFIXES: dict[str, set[str]] = {
    DOMAIN: {"domain", "core", "entities"},
    APPLICATION: {"application", "usecases", "services"},
    INFRASTRUCTURE: {"infrastructure", "infra", "persistence", "data"},
    PRESENTATION: {
        "api",
        "webapi",
        "web",
        "presentation",
        "host",
        "server",
        "mvc",
        "blazor",
        "ui",
        "grpc",
    },
}

_MSBUILD_PROJECTS = (".csproj", ".fsproj", ".vbproj")

_SKIP_DIRS = {
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".git",
    ".workpilot",
    "dist",
    "build",
    "bin",
    "obj",
    "target",
    "vendor",
    "Pods",
    ".gradle",
    ".dart_tool",
    "DerivedData",
    "coverage",
    "site-packages",
    "test",
    "tests",
}

#: How deep the walk goes. Java packages sit under src/main/java/com/acme/x.
_MAX_DEPTH = 9

#: Imports a domain layer has no business making: persistence and web
#: frameworks of each stack. Reported through ``forbidden_patterns``.
DOMAIN_FRAMEWORK_IMPORTS = (
    r"^Microsoft\.(EntityFrameworkCore|AspNetCore)"
    r"|^System\.(Data|Web|Net\.Http)\b"
    r"|^(Dapper|Npgsql|MongoDB\.Driver|StackExchange\.Redis)\b"
    r"|^(javax|jakarta)\.(persistence|servlet|ws\.rs)\b"
    r"|^org\.(springframework|hibernate)\b"
    r"|^(io\.ktor|io\.micronaut|io\.quarkus)\b"
    r"|^(gorm\.io|database/sql|github\.com/(gin-gonic|labstack/echo|gofiber|jmoiron/sqlx))"
    r"|^(Illuminate|Doctrine|Symfony\.Component\.HttpFoundation)\b"
    r"|^(diesel|sqlx|actix_web|axum|rocket|sea_orm)\b"
    r"|^package:(flutter|sqflite|drift|dio|http)/"
    r"|^(UIKit|SwiftUI|CoreData)$"
    r"|^(sqlalchemy|django|fastapi|flask|psycopg2?|pymongo|requests)\b"
    r"|^(express|@nestjs|typeorm|prisma|@prisma/client|mongoose|sequelize|axios|react)\b"
)


@dataclass
class _Layer:
    patterns: list[str] = field(default_factory=list)
    prefixes: list[str] = field(default_factory=list)

    def add(self, pattern: str, prefixes: list[str]) -> None:
        if pattern not in self.patterns:
            self.patterns.append(pattern)
        for prefix in prefixes:
            if prefix and prefix not in self.prefixes:
                self.prefixes.append(prefix)


def infer_clean_layers(project_dir: Path) -> list[LayerConfig]:
    """The Clean Architecture layers of ``project_dir``, or ``[]`` when it has none."""
    found: dict[str, _Layer] = {}
    for rel_dir, layer in _dotnet_projects(project_dir) + _layer_folders(project_dir):
        prefixes = _module_prefixes(project_dir, rel_dir)
        found.setdefault(layer, _Layer()).add(f"{rel_dir}/**", prefixes)

    return [
        LayerConfig(
            name=name,
            patterns=found[name].patterns,
            allowed_imports=[
                n
                for n in LAYER_ORDER
                if n in found and n != name and n not in FORBIDDEN[name]
            ],
            forbidden_imports=list(FORBIDDEN[name]),
            module_prefixes=found[name].prefixes,
        )
        for name in LAYER_ORDER
        if name in found
    ]


def domain_framework_rules(layers: list[LayerConfig]) -> list[ForbiddenPattern]:
    """One rule per domain folder: no persistence or web framework in there."""
    return [
        ForbiddenPattern(
            from_pattern=pattern,
            import_pattern=DOMAIN_FRAMEWORK_IMPORTS,
            description="The domain layer must not depend on a persistence or web framework",
            rule_id="domain_framework",
        )
        for layer in layers
        if layer.name == DOMAIN
        for pattern in layer.patterns
    ]


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def _walk(project_dir: Path):
    """``(relative dir, dir names, file names)`` below the root, pruned and bounded."""
    root_depth = len(project_dir.parts)
    for root, dirs, files in os.walk(project_dir):
        depth = len(Path(root).parts) - root_depth
        dirs[:] = [
            d
            for d in dirs
            if d not in _SKIP_DIRS and not d.startswith(".") and depth < _MAX_DEPTH
        ]
        rel = Path(root).relative_to(project_dir).as_posix()
        yield ("" if rel == "." else rel), dirs, files


def _dotnet_projects(project_dir: Path) -> list[tuple[str, str]]:
    """Folders holding a project file whose name ends with a layer suffix."""
    found: list[tuple[str, str]] = []
    for rel, _dirs, files in _walk(project_dir):
        if not rel or not any(f.lower().endswith(_MSBUILD_PROJECTS) for f in files):
            continue
        suffix = rel.rsplit("/", 1)[-1].rsplit(".", 1)[-1].lower()
        for layer, suffixes in _DOTNET_SUFFIXES.items():
            if suffix in suffixes and "." in rel.rsplit("/", 1)[-1]:
                found.append((rel, layer))
                break
    # A solution of one project per layer needs at least the domain and one more.
    layers = {layer for _rel, layer in found}
    return found if DOMAIN in layers and len(layers) >= 2 else []


def _folder_layer(name: str) -> str | None:
    """``domain``, ``use-cases``, ``shop-domain`` (Maven/Gradle module), ``Shop.Domain``."""
    lowered = name.lower()
    keys = [lowered, re.sub(r"[-_ ]", "", lowered), re.split(r"[-_.]", lowered)[-1]]
    for key in keys:
        for layer, names in _FOLDER_NAMES.items():
            if key in names:
                return layer
    return None


def _layer_folders(project_dir: Path) -> list[tuple[str, str]]:
    """Sibling folders named after layers, under a parent that has a domain."""
    found: list[tuple[str, str]] = []
    for rel, dirs, _files in _walk(project_dir):
        siblings = {d: _folder_layer(d) for d in dirs}
        layers = {layer for layer in siblings.values() if layer}
        if DOMAIN not in layers or len(layers) < 2:
            continue
        for name, layer in siblings.items():
            if layer:
                found.append((f"{rel}/{name}" if rel else name, layer))
    return found


# ---------------------------------------------------------------------------
# Module names per language
# ---------------------------------------------------------------------------


def _module_prefixes(project_dir: Path, rel_dir: str) -> list[str]:
    """How the code of ``rel_dir`` is named in an import, for each stack it may hold."""
    prefixes: list[str] = []
    parts = rel_dir.split("/")
    directory = project_dir / rel_dir

    # .NET: the project's RootNamespace, else its folder name.
    project_files = [
        f for f in _safe_listdir(directory) if f.lower().endswith(_MSBUILD_PROJECTS)
    ]
    if project_files:
        prefixes.append(parts[-1])
        for project_file in project_files:
            prefixes.append(project_file.rsplit(".", 1)[0])
            namespace = _root_namespace(directory / project_file)
            if namespace:
                prefixes.append(namespace)

    # .NET folder inside a project: <RootNamespace>.<folders below the project>.
    if not project_files:
        for depth in range(len(parts) - 1, 0, -1):
            ancestor = project_dir.joinpath(*parts[:depth])
            owners = [
                f
                for f in _safe_listdir(ancestor)
                if f.lower().endswith(_MSBUILD_PROJECTS)
            ]
            if owners:
                namespace = (
                    _root_namespace(ancestor / owners[0]) or owners[0].rsplit(".", 1)[0]
                )
                prefixes.append(".".join([namespace, *parts[depth:]]))
                break

    # JVM: the package below src/main/java (kotlin, scala), or any java/ root;
    # a Maven/Gradle module folder: the common package of its sources.
    jvm_package = False
    for marker in ("java", "kotlin", "scala"):
        if marker in parts[:-1]:
            index = len(parts) - 1 - parts[::-1].index(marker)
            package = parts[index + 1 :]
            if package:
                prefixes.append(".".join(package))
                jvm_package = True
    if not jvm_package:
        module_package = _jvm_module_package(directory)
        if module_package:
            prefixes.append(module_package)

    # Go: module path from the nearest go.mod, plus the folder path below it.
    go_root, go_module = _nearest_manifest_value(
        project_dir, parts, "go.mod", _go_module
    )
    if go_module is not None:
        below = parts[len(go_root) :]
        prefixes.append("/".join([go_module, *below]))

    # PHP: composer.json PSR-4 roots mapped onto the folder.
    composer_root, psr4 = _nearest_manifest_value(
        project_dir, parts, "composer.json", _psr4
    )
    if psr4:
        below = "/".join(parts[len(composer_root) :])
        for namespace, base in psr4:
            base = base.strip("/")
            if below == base or below.startswith(base + "/") or not base:
                rest = below[len(base) :].strip("/") if base else below
                name = ".".join(
                    p
                    for p in [
                        namespace.strip("\\").replace("\\", "."),
                        *rest.split("/"),
                    ]
                    if p
                )
                prefixes.append(name)

    # Rust: crate::<path below src>, and <crate>::<path> from the other crates.
    cargo_root, crate = _nearest_manifest_value(
        project_dir, parts, "Cargo.toml", _crate_name
    )
    if crate is not None:
        below = parts[len(cargo_root) :]
        if below[:1] == ["src"] and len(below) > 1:
            module = ".".join(below[1:])
            prefixes.append(f"crate.{module}")
            prefixes.append(f"{crate}.{module}")

    # Dart / Flutter: package:<name>/<path below lib>.
    pub_root, package = _nearest_manifest_value(
        project_dir, parts, "pubspec.yaml", _pub_name
    )
    if package is not None:
        below = parts[len(pub_root) :]
        if below[:1] == ["lib"] and len(below) > 1:
            prefixes.append(f"package:{package}/" + "/".join(below[1:]))

    # Swift packages: a target is a folder right below Sources/.
    if len(parts) >= 2 and parts[-2] == "Sources":
        prefixes.append(parts[-1])

    # Python: the dotted path from the first folder that is not a package.
    if any(f.endswith(".py") for f in _safe_listdir(directory)):
        start = len(parts) - 1
        while (
            start > 0
            and (project_dir.joinpath(*parts[:start]) / "__init__.py").is_file()
        ):
            start -= 1
        dotted = parts[start:]
        prefixes.append(".".join(dotted))
        # A parent package may also be a source root (``apps/backend`` with an
        # ``__init__.py``): the shorter names, down to two segments, count too.
        prefixes.extend(".".join(dotted[i:]) for i in range(1, len(dotted) - 1))

    return list(dict.fromkeys(prefixes))


_JVM_PACKAGE = re.compile(r"^\s*package\s+([\w.]+)", re.M)
_JVM_SOURCES = (".java", ".kt", ".scala")


def _jvm_module_package(directory: Path, limit: int = 40) -> str | None:
    """Common package of a module's ``src/main/{java,kotlin,scala}`` sources."""
    packages: list[list[str]] = []
    for lang in ("java", "kotlin", "scala"):
        source_root = directory / "src" / "main" / lang
        if not source_root.is_dir():
            continue
        for root, _dirs, files in os.walk(source_root):
            for name in files:
                if name.endswith(_JVM_SOURCES):
                    match = _JVM_PACKAGE.search(_read(Path(root) / name) or "")
                    if match:
                        packages.append(match.group(1).split("."))
                if len(packages) >= limit:
                    break
            if len(packages) >= limit:
                break
    if not packages:
        return None
    common = packages[0]
    for package in packages[1:]:
        size = 0
        while size < min(len(common), len(package)) and common[size] == package[size]:
            size += 1
        common = common[:size]
    return ".".join(common) or None


def _safe_listdir(directory: Path) -> list[str]:
    try:
        return os.listdir(directory)
    except OSError:
        return []


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


_ROOT_NAMESPACE = re.compile(r"<RootNamespace>\s*([\w.]+)\s*</RootNamespace>")


def _root_namespace(project_file: Path) -> str | None:
    content = _read(project_file)
    match = _ROOT_NAMESPACE.search(content or "")
    return match.group(1) if match else None


def _nearest_manifest_value(project_dir: Path, parts: list[str], manifest: str, reader):
    """``(parts of the manifest's folder, reader(content))`` for the closest ancestor."""
    for depth in range(len(parts), -1, -1):
        candidate = project_dir.joinpath(*parts[:depth]) / manifest
        if candidate.is_file():
            content = _read(candidate)
            return parts[:depth], (reader(content) if content is not None else None)
    return [], None


_GO_MODULE = re.compile(r"^\s*module\s+(\S+)", re.M)


def _go_module(content: str) -> str | None:
    match = _GO_MODULE.search(content)
    return match.group(1) if match else None


def _psr4(content: str) -> list[tuple[str, str]]:
    try:
        data = json.loads(content)
    except ValueError:
        return []
    roots: list[tuple[str, str]] = []
    for section in ("autoload", "autoload-dev"):
        mapping = (data.get(section) or {}).get("psr-4") or {}
        if not isinstance(mapping, dict):
            continue
        for namespace, bases in mapping.items():
            for base in bases if isinstance(bases, list) else [bases]:
                if isinstance(base, str):
                    roots.append((namespace, base))
    return roots


_CARGO_NAME = re.compile(r'^\s*\[package\][^\[]*?^\s*name\s*=\s*"([^"]+)"', re.M | re.S)


def _crate_name(content: str) -> str | None:
    match = _CARGO_NAME.search(content)
    return match.group(1).replace("-", "_") if match else None


_PUB_NAME = re.compile(r"^name:\s*['\"]?([\w]+)", re.M)


def _pub_name(content: str) -> str | None:
    match = _PUB_NAME.search(content)
    return match.group(1) if match else None
