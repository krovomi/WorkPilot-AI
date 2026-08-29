"""One file, one module object.

The backend is importable under two names — `core.client` when `apps/backend`
is on `sys.path`, `apps.backend.core.client` when the repo root is. Python
treats those as different modules, so a file reached both ways is *executed
twice* and gets two sets of module-level globals.

For `models_registry`, which is static catalogues, that costs memory and
nothing else. It stops being harmless the moment the pattern reaches a module
holding mutable state: `HookService._instance`, the hook scheduler's
`_scheduler`, `agents.subagents._STACK_CACHE` and `core.client`'s project cache
are all module-level singletons, and two of any of them is a bug that presents
as "the thing I registered isn't there" with no traceback to follow.

None of those are dual-imported today. This test is what keeps it that way:
the codebase already has a correct pattern for the ambiguity — prefer the bare
path, fall back to the packaged one — and the rule below is simply that
production code uses it rather than reaching for the packaged path directly.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "apps" / "backend"

# Modules whose module-level state must never exist twice. Listed so the
# reason this rule exists stays visible next to the rule.
STATEFUL_SINGLETONS = (
    "services.hooks.hook_service",
    "services.hooks.scheduler",
    "agents.subagents",
    "core.client",
)


# Directories that live under apps/backend but are not this repo's source.
# CI installs the virtualenv there, so an unfiltered rglob walks thousands of
# third-party files — one of which is not even valid Python 3 and blew up the
# parser rather than failing an assertion.
_NOT_OURS = frozenset({".venv", "venv", "site-packages", "node_modules", "__pycache__"})


def _production_files() -> list[Path]:
    return [
        p
        for p in sorted(BACKEND.rglob("*.py"))
        if "test" not in p.name
        # Relative to BACKEND, never absolute: this checkout lives under
        # `.claude/worktrees/`, so an absolute dot-check excludes every file
        # and leaves a test that scans nothing while reporting success.
        and not _NOT_OURS.intersection(p.relative_to(BACKEND).parts)
        and not any(part.startswith(".") for part in p.relative_to(BACKEND).parts)
    ]


def _packaged_imports(tree: ast.AST) -> list[tuple[str, int]]:
    """Every `from apps.backend... import ...`, with its line number."""
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and (node.module or "").startswith(
            "apps.backend"
        ):
            found.append((node.module, node.lineno))
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.startswith("apps.backend"):
                    found.append((alias.name, node.lineno))
    return found


def _guarded_lines(tree: ast.AST) -> set[int]:
    """Line numbers of imports sitting inside a `try:` that catches ImportError."""
    guarded: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Try):
            continue
        catches_import = any(
            handler.type is not None
            and "ImportError" in ast.dump(handler.type)
            or handler.type is None
            for handler in node.handlers
        )
        if not catches_import:
            continue
        for handler in node.handlers:
            for child in ast.walk(handler):
                if isinstance(child, (ast.Import, ast.ImportFrom)):
                    guarded.add(child.lineno)
    return guarded


@pytest.mark.parametrize(
    "path", _production_files(), ids=lambda p: str(p.relative_to(BACKEND))
)
def test_the_packaged_path_is_only_ever_a_fallback(path: Path):
    """`from apps.backend.X import Y` must sit in an ImportError fallback.

    Reached directly, it loads a second copy of X even when X is already in
    sys.modules under its bare name. The repo's own pattern is:

        try:
            from X import Y
        except ImportError:
            from apps.backend.X import Y
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    guarded = _guarded_lines(tree)
    unguarded = [
        f"{module} (line {line})"
        for module, line in _packaged_imports(tree)
        if line not in guarded
    ]
    assert not unguarded, (
        f"{path.relative_to(BACKEND)} imports the packaged path directly, which "
        f"loads a second copy of the module: {unguarded}. Wrap it in a "
        "try/except ImportError that prefers the bare path."
    )


@pytest.mark.parametrize("module", STATEFUL_SINGLETONS)
def test_no_stateful_module_is_reachable_under_two_names(module: str):
    """The case where duplication stops being cosmetic and becomes a bug."""
    needle = f"apps.backend.{module}"
    offenders = []
    for path in _production_files():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        # Parsed rather than grepped: `client.py` names this module inside a
        # deprecation *message*, which a substring search reads as an import.
        if any(
            m == needle or m.startswith(f"{needle}.")
            for m, _ in _packaged_imports(tree)
        ):
            offenders.append(str(path.relative_to(BACKEND)))
    assert not offenders, (
        f"{module} holds module-level state and is imported as {needle} in "
        f"{offenders}; two copies means two singletons"
    )
