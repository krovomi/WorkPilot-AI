"""Which files of a repository are API contracts, whatever the stack (#389).

OpenAPI and Swagger (ASP.NET Core, Spring, FastAPI, NestJS, Go, Laravel…),
GraphQL SDL (Apollo, Hot Chocolate, Spring GraphQL ``.graphqls``, gqlgen) and
protobuf are parsed; RAML, WSDL and Thrift are recognised but only compared
as text, with a warning.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable, Iterable
from pathlib import Path

SPEC_NAMES = frozenset(
    {
        "openapi.yaml",
        "openapi.yml",
        "openapi.json",
        "swagger.yaml",
        "swagger.yml",
        "swagger.json",
        "schema.graphql",
    }
)
SPEC_SUFFIXES = frozenset({".graphql", ".graphqls", ".gql", ".proto"})
SPEC_NAME_SUFFIXES = (
    ".openapi.yaml",
    ".openapi.yml",
    ".openapi.json",
    ".swagger.yaml",
    ".swagger.yml",
    ".swagger.json",
)
# Folders where an OpenAPI document often has a free name (api/v1.yaml,
# contracts/orders.yml); their YAML/JSON files are read to check.
SPEC_FOLDERS = frozenset(
    {"api", "apis", "openapi", "swagger", "spec", "specs", "contracts", "contract"}
)
UNSUPPORTED_SUFFIXES = frozenset({".raml", ".wsdl", ".thrift"})
_OPENAPI_HEAD = re.compile(r"""^\s*["']?(openapi|swagger)["']?\s*:""", re.MULTILINE)

EXCLUDED_DIRS = frozenset(
    {
        "node_modules",
        ".git",
        "dist",
        "build",
        "venv",
        ".venv",
        "__pycache__",
        "target",
        "bin",
        "obj",
        "vendor",
        "Pods",
        ".dart_tool",
        ".gradle",
        ".next",
        ".nuxt",
        "coverage",
        ".workpilot",
    }
)

#: The bytes read to decide whether a free-named YAML/JSON is OpenAPI.
HEAD_BYTES = 4096


def is_unsupported(path: str) -> bool:
    return Path(path).suffix.lower() in UNSUPPORTED_SUFFIXES


def is_contract(path: str, head: Callable[[], str] | None = None) -> bool:
    """Whether ``path`` (relative, ``/``-separated) names a contract file.

    ``head`` returns the first bytes of the file; it is only called for a
    YAML or JSON file in one of `SPEC_FOLDERS`, whose name says nothing.
    """
    parts = path.replace("\\", "/").split("/")
    if any(part in EXCLUDED_DIRS for part in parts[:-1]):
        return False
    name = parts[-1].lower()
    suffix = Path(name).suffix
    if name in SPEC_NAMES or suffix in SPEC_SUFFIXES or suffix in UNSUPPORTED_SUFFIXES:
        return True
    if name.endswith(SPEC_NAME_SUFFIXES):
        return True
    if (
        len(parts) > 1
        and parts[-2].lower() in SPEC_FOLDERS
        and suffix in {".yaml", ".yml", ".json"}
    ):
        return bool(head and _OPENAPI_HEAD.search(head()))
    return False


def _head(path: Path) -> str:
    try:
        with path.open(encoding="utf-8", errors="replace") as handle:
            return handle.read(HEAD_BYTES)
    except OSError:
        return ""


def discover(root: Path) -> list[str]:
    """Every contract file under ``root``, relative and ``/``-separated,
    dependency and build folders pruned on the way. Links are not followed."""
    root = Path(root)
    found: set[str] = set()
    for current, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS]
        for name in files:
            path = Path(current) / name
            if path.is_symlink():
                continue
            rel = path.relative_to(root).as_posix()
            if is_contract(rel, lambda p=path: _head(p)):
                found.add(rel)
    return sorted(found)


def contracts_among(paths: Iterable[str], head: Callable[[str], str]) -> list[str]:
    """The contract files among ``paths`` (a change set, a git tree listing)."""
    return sorted({p for p in paths if is_contract(p, lambda p=p: head(p))})
