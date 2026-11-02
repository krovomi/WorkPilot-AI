"""Backend paths the Electron main process builds from its own location.

The main bundle runs from ``apps/frontend/out/main``. A handler that walks up
from ``import.meta.dirname`` with one ``..`` too many leaves the repository:
the "Traduction inter-langages" page and the CI/CD triggers looked for their
runner in ``<parent of the repo>/apps/backend/runners`` and every run failed
with "can't open file". This test resolves each such literal path from
``out/main`` and checks that it lands on something that exists.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAIN_SRC = ROOT / "apps" / "frontend" / "src" / "main"
BUNDLE_DIR = ROOT / "apps" / "frontend" / "out" / "main"

# path.join(import.meta.dirname, "..", "backend", ...) / join(...) / resolve(...)
# The arguments are captured as one span without parentheses and split
# afterwards: a pattern repeating "optional spaces, literal, optional comma"
# backtracks exponentially (CodeQL py/redos).
CALL = re.compile(
    r"(?:path\.)?(?:join|resolve)\(\s*import\.meta\.dirname\s*,([^()]*)\)",
    re.MULTILINE,
)
LITERAL = re.compile(r'"([^"]*)"')


def _literal_parts(args: str) -> list[str] | None:
    """The string literals of an argument list, or None if any is not one."""
    parts = []
    for raw in args.split(","):
        item = raw.strip()
        if not item:
            continue
        match = LITERAL.fullmatch(item)
        if match is None:
            return None
        parts.append(match.group(1))
    return parts


def _backend_paths():
    for file in sorted(MAIN_SRC.rglob("*.ts")):
        if "__tests__" in file.parts or file.name.endswith(".test.ts"):
            continue
        text = file.read_text(encoding="utf-8")
        for match in CALL.finditer(text):
            parts = _literal_parts(match.group(1))
            if not parts or "backend" not in parts:
                continue
            line = text.count("\n", 0, match.start()) + 1
            yield file.relative_to(ROOT), line, parts


def test_some_paths_are_checked():
    # The pattern must keep matching the handlers' way of writing it.
    assert len(list(_backend_paths())) >= 3


def test_backend_paths_from_the_bundle_stay_in_the_repository():
    wrong = []
    for rel, line, parts in _backend_paths():
        resolved = BUNDLE_DIR.joinpath(*parts).resolve()
        if ROOT not in resolved.parents or not resolved.exists():
            wrong.append(f"{rel}:{line} -> {resolved}")
    assert not wrong, (
        "These paths, resolved from apps/frontend/out/main, do not exist. "
        "Prefer app.isPackaged ? resourcesPath/backend : "
        "app.getAppPath()/../backend:\n" + "\n".join(wrong)
    )
