"""Routes of the stacks ``RouteDetector`` reads only partly: Laravel and NestJS.

Kept apart so the detector stays readable; ``RouteDetector.detect_all_routes``
calls these with its own file filter.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path

_LARAVEL_ROUTE = re.compile(
    r"Route::(get|post|put|patch|delete|options|any)\(\s*['\"]([^'\"]*)['\"]",
    re.IGNORECASE,
)
_LARAVEL_AUTH = re.compile(r"middleware\(\s*\[?\s*['\"]auth", re.IGNORECASE)

_NEST_CONTROLLER = re.compile(r"@Controller\(\s*(?:['\"]([^'\"]*)['\"])?\s*\)")
_NEST_ROUTE = re.compile(
    r"@(Get|Post|Put|Patch|Delete|Options|Head|All)\(\s*(?:['\"]([^'\"]*)['\"])?\s*\)"
)
_NEST_AUTH = re.compile(r"@UseGuards\(")


def _join(*parts: str) -> str:
    joined = "/".join(p.strip("/") for p in parts if p and p.strip("/"))
    return f"/{joined}"


def detect_laravel_routes(root: Path, include: Callable[[Path], bool]) -> list[dict]:
    """``Route::get('/orders', …)`` in ``routes/*.php``; ``api.php`` is under /api."""
    routes: list[dict] = []
    for file_path in sorted(root.glob("**/routes/*.php")):
        if not include(file_path):
            continue
        try:
            content = file_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        prefix = "api" if file_path.name == "api.php" else ""
        for match in _LARAVEL_ROUTE.finditer(content):
            verb = match.group(1).upper()
            line_end = content.find("\n", match.end())
            line = content[match.start() : line_end if line_end != -1 else None]
            routes.append(
                {
                    "path": _join(prefix, match.group(2)),
                    "methods": ["GET", "POST", "PUT", "PATCH", "DELETE"]
                    if verb == "ANY"
                    else [verb],
                    "file": str(file_path.relative_to(root)),
                    "framework": "Laravel",
                    "requires_auth": bool(_LARAVEL_AUTH.search(line)),
                }
            )
    return routes


def detect_nestjs_routes(root: Path, include: Callable[[Path], bool]) -> list[dict]:
    """``@Controller('orders')`` + ``@Get(':id')`` in NestJS controllers."""
    routes: list[dict] = []
    for file_path in sorted(root.glob("**/*.ts")):
        if not include(file_path) or file_path.name.endswith(".d.ts"):
            continue
        try:
            content = file_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        controller = _NEST_CONTROLLER.search(content)
        if not controller:
            continue
        base = controller.group(1) or ""
        class_guarded = bool(_NEST_AUTH.search(content[: controller.start()]))
        for match in _NEST_ROUTE.finditer(content, controller.end()):
            verb = match.group(1).upper()
            ctx = content[max(0, match.start() - 200) : match.start()]
            routes.append(
                {
                    "path": _join(base, match.group(2) or ""),
                    "methods": ["GET", "POST", "PUT", "PATCH", "DELETE"]
                    if verb == "ALL"
                    else [verb],
                    "file": str(file_path.relative_to(root)),
                    "framework": "NestJS",
                    "requires_auth": class_guarded or bool(_NEST_AUTH.search(ctx)),
                }
            )
    return routes
