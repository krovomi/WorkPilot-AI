"""The tests of the files a change touched, found by naming convention.

The targeted QA tier (`foundation.change_scope`) runs only the tests of the
source files a task changed, instead of every suite of the repository. That is
safe only if every changed source file has at least one test the convention
points to: a file without one sends the change to the full review, so a
change is never approved without its tests having run.

Python and TypeScript/JavaScript conventions live here; every other
ecosystem (.NET and Blazor, Java/Kotlin/Scala, Go, Rust, PHP, Swift,
Dart/Flutter, Ruby, Elixir, C/C++) is in `foundation.test_conventions`.

- Python: ``test_<stem>.py`` or ``<stem>_test.py``, next to the source or in a
  ``tests/`` (or ``test/``) directory at the source's level or above it, at
  any depth below that directory (``tests/test_x.py``,
  ``tests/unit/pkg/test_x.py``).
- TypeScript/JavaScript: ``<stem>.test.<ext>`` or ``<stem>.spec.<ext>`` next
  to the source, or inside a ``__tests__/``, ``tests/`` or ``test/``
  directory at the source's level or above it (where ``<stem>.<ext>`` alone
  also counts inside ``__tests__/``). Single-file components (``.vue``,
  ``.svelte``, ``.astro``) map the same way (``Foo.vue`` → ``Foo.spec.ts``),
  and so do an Angular component's template and styles
  (``foo.component.html`` → ``foo.component.spec.ts``).

A changed file that is itself a test maps to itself, and so does a source
file the caller saw holding its own tests (Rust's ``#[cfg(test)]`` module). The candidates are taken
from the repository's own file list, so nothing here touches the disk.
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import PurePosixPath

from . import test_conventions

PYTHON_EXTENSIONS = frozenset({".py"})
SCRIPT_EXTENSIONS = frozenset(
    {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"}
)
#: Single-file components, tested by a script test of the same stem.
COMPONENT_EXTENSIONS = frozenset({".vue", ".svelte", ".astro"})
#: An Angular component's template and styles (``x.component.html``).
_ANGULAR_ASSET_EXTENSIONS = frozenset({".html", ".css", ".scss", ".sass", ".less"})
_ANGULAR_INNER = frozenset({".component"})
#: The source languages the targeted tier knows how to map to their tests
#: (plus Angular component templates and styles, see `is_mappable`).
MAPPABLE_EXTENSIONS = (
    PYTHON_EXTENSIONS
    | SCRIPT_EXTENSIONS
    | COMPONENT_EXTENSIONS
    | test_conventions.SOURCE_EXTENSIONS
)

_PY_TEST_DIRS = frozenset({"tests", "test"})
_SCRIPT_TEST_DIRS = frozenset({"__tests__", "tests", "test"})


def _parts(path: str) -> PurePosixPath:
    return PurePosixPath(path.replace("\\", "/"))


def _angular_asset(p: PurePosixPath) -> bool:
    return (
        p.suffix.lower() in _ANGULAR_ASSET_EXTENSIONS
        and PurePosixPath(p.stem).suffix.lower() in _ANGULAR_INNER
    )


def is_mappable(path: str) -> bool:
    """True when the targeted tier knows the test convention of ``path``."""
    p = _parts(path)
    return p.suffix.lower() in MAPPABLE_EXTENSIONS or _angular_asset(p)


def is_test_file(path: str) -> bool:
    """True when ``path`` is a test by its language's naming convention."""
    p = _parts(path)
    name = p.name
    suffix = p.suffix.lower()
    if suffix in PYTHON_EXTENSIONS:
        if name == "conftest.py":
            return False
        return name.startswith("test_") or p.stem.endswith("_test")
    if suffix in SCRIPT_EXTENSIONS:
        inner = PurePosixPath(p.stem).suffix.lower()
        return inner in (".test", ".spec") or "__tests__" in p.parts[:-1]
    return test_conventions.is_test(p)


def _within_test_dir(test: PurePosixPath, source_dir: PurePosixPath, dirs) -> bool:
    """True when ``test`` lies in a test directory at ``source_dir`` or above.

    ``a/b/c.py`` is matched by ``a/b/tests/...``, ``a/tests/...`` and
    ``tests/...``, but not by ``x/tests/...``.
    """
    parts = test.parts[:-1]
    for i, part in enumerate(parts):
        if part not in dirs:
            continue
        anchor = parts[:i]
        if tuple(source_dir.parts[: len(anchor)]) == tuple(anchor):
            return True
    return False


def _python_matches(source: PurePosixPath, test: PurePosixPath) -> bool:
    if test.suffix.lower() not in PYTHON_EXTENSIONS:
        return False
    if test.name not in (f"test_{source.stem}.py", f"{source.stem}_test.py"):
        return False
    return test.parent == source.parent or _within_test_dir(
        test, source.parent, _PY_TEST_DIRS
    )


def _script_matches(source: PurePosixPath, test: PurePosixPath) -> bool:
    if test.suffix.lower() not in SCRIPT_EXTENSIONS:
        return False
    stem = PurePosixPath(test.stem)
    named = stem.stem == source.stem and stem.suffix.lower() in (".test", ".spec")
    in_tests_dir = "__tests__" in test.parts[:-1]
    if not named and not (in_tests_dir and test.stem == source.stem):
        return False
    if named and test.parent == source.parent:
        return True
    return _within_test_dir(test, source.parent, _SCRIPT_TEST_DIRS)


def _matcher(src: PurePosixPath):
    suffix = src.suffix.lower()
    if suffix in PYTHON_EXTENSIONS:
        return _python_matches
    if suffix in SCRIPT_EXTENSIONS | COMPONENT_EXTENSIONS or _angular_asset(src):
        return _script_matches
    return test_conventions.matches


def tests_for(
    source: str, repo_files: Iterable[str], inline: Iterable[str] = ()
) -> tuple[str, ...]:
    """The repository's tests for the changed file ``source``, sorted.

    A test maps to itself, and so does a source listed in ``inline`` (it
    holds its own tests). Empty when the language is not one this module
    maps, or when no test follows the conventions.
    """
    src = _parts(source)
    if not is_mappable(source):
        return ()
    if is_test_file(source):
        return (str(src),)
    match = _matcher(src)
    found = {
        str(_parts(f))
        for f in repo_files
        if f and is_test_file(f) and match(src, _parts(f))
    }
    if str(src) in {str(_parts(i)) for i in inline}:
        found.add(str(src))
    return tuple(sorted(found))


def map_tests(
    sources: Iterable[str], repo_files: Iterable[str], inline: Iterable[str] = ()
) -> tuple[dict[str, tuple[str, ...]], list[str]]:
    """Each changed file's tests, and the changed files that have none.

    ``inline``: the sources the caller saw holding their own tests.
    """
    files = list(repo_files)
    inline = tuple(inline)
    mapping: dict[str, tuple[str, ...]] = {}
    unmapped: list[str] = []
    for source in sources:
        tests = tests_for(source, files, inline)
        if tests:
            mapping[source] = tests
        else:
            unmapped.append(source)
    return mapping, unmapped
