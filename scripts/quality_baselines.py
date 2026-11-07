#!/usr/bin/env python3
"""Per-file ceilings that can only go down: blind excepts, biome-ignore, file size.

The backend had 1 533 ``except Exception`` (or bare ``except:``), 413 of them
with a body that only passes; the frontend had 766 ``biome-ignore`` comments.
Fixing them all at once is a rewrite; letting them grow is how they got
there. The same holds for size: 20 source files were over 2 000 lines, the
largest 4 637, and the features of October kept adding to them (plan of
29 October, A2). Each file keeps its count of the day, and ``tests/test_quality_baselines.py``
fails when a file goes above it.

    python scripts/quality_baselines.py check    exit 1 if a file is above its ceiling or below it
    python scripts/quality_baselines.py update   lower the ceilings to the current counts

``update`` never raises a ceiling nor adds a file: a new blind except in a file
is refused, and raising a ceiling is a hand edit of the JSON that review sees.
"""

from __future__ import annotations

import ast
import json
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASELINES = ROOT / "tests" / "baselines"
EXCEPT_BASELINE = BASELINES / "blind-except.json"
BIOME_BASELINE = BASELINES / "biome-ignore.json"
SIZE_BASELINE = BASELINES / "file-size.json"

BLIND_TYPES = frozenset({"Exception", "BaseException"})
FRONTEND_SUFFIXES = (".ts", ".tsx", ".js", ".cjs", ".mjs")
#: A source file above this many lines has a ceiling; a new one is refused.
LARGE_FILE = 2000


def _tracked(*patterns: str) -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-z", "--", *patterns],
        cwd=ROOT,
        capture_output=True,
        check=True,
    ).stdout.decode("utf-8")
    return sorted(p for p in out.split("\0") if p)


def _is_blind(handler: ast.ExceptHandler) -> bool:
    kind = handler.type
    if kind is None:
        return True
    names = kind.elts if isinstance(kind, ast.Tuple) else [kind]
    return any(isinstance(n, ast.Name) and n.id in BLIND_TYPES for n in names)


def _is_silent(handler: ast.ExceptHandler) -> bool:
    """The body drops the error: only ``pass``, ``...``, ``continue`` or a docstring."""
    return all(
        isinstance(stmt, ast.Pass | ast.Continue)
        or (isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant))
        for stmt in handler.body
    )


def count_excepts(source: str) -> dict[str, int]:
    blind = silent = 0
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ExceptHandler) and _is_blind(node):
            blind += 1
            silent += _is_silent(node)
    return {"blind": blind, "silent": silent}


def except_counts() -> dict[str, dict[str, int]]:
    counts = {}
    for path in _tracked("apps/backend/*.py"):
        found = count_excepts((ROOT / path).read_text(encoding="utf-8"))
        if found["blind"]:
            counts[path] = found
    return counts


def biome_counts() -> dict[str, int]:
    counts = {}
    for path in _tracked("apps/frontend"):
        if path.endswith(FRONTEND_SUFFIXES):
            n = (ROOT / path).read_text(encoding="utf-8").count("biome-ignore")
            if n:
                counts[path] = n
    return counts


def size_counts() -> dict[str, int]:
    """Lines of each tracked source file above ``LARGE_FILE``."""
    counts = {}
    for path in _tracked("apps/backend/*.py", "src/*.py", "apps/frontend"):
        if path.endswith((".py", *FRONTEND_SUFFIXES)):
            with open(ROOT / path, "rb") as handle:
                lines = sum(1 for _ in handle)
            if lines > LARGE_FILE:
                counts[path] = lines
    return counts


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def _write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # One line per file: two PRs that each fix a different file do not conflict.
    lines = [
        f"  {json.dumps(path)}: {json.dumps(data[path], sort_keys=True)}"
        for path in sorted(data)
    ]
    text = "{\n" + ",\n".join(lines) + "\n}\n" if lines else "{}\n"
    path.write_text(text, encoding="utf-8", newline="\n")


def _flat(value: int | dict[str, int]) -> dict[str, int]:
    return value if isinstance(value, dict) else {"": value}


def compare(current: dict, ceiling: dict, what: str) -> tuple[list[str], list[str]]:
    """(files above their ceiling, files below it or gone)."""
    above, below = [], []
    for path in sorted(set(current) | set(ceiling)):
        now, cap = current.get(path), ceiling.get(path)
        now_parts = _flat(now) if now is not None else {}
        cap_parts = _flat(cap) if cap is not None else {}
        for key in sorted(set(now_parts) | set(cap_parts)):
            n, c = now_parts.get(key, 0), cap_parts.get(key, 0)
            label = f"{path}: {key + ' ' if key else ''}{what}"
            if n > c:
                above.append(f"{label} {n} > {c}")
            elif n < c:
                below.append(f"{label} {n} < {c}")
    return above, below


def lowered(current: dict, ceiling: dict) -> dict:
    """The ceilings moved down to the current counts, never up, no new file."""
    out = {}
    for path, cap in ceiling.items():
        if path not in current:
            continue
        now = current[path]
        if isinstance(cap, dict):
            out[path] = {k: min(now.get(k, 0), v) for k, v in cap.items()}
            if not any(out[path].values()):
                del out[path]
        elif min(now, cap):
            out[path] = min(now, cap)
    return out


CHECKS: tuple[tuple[Path, Callable[[], dict], str], ...] = (
    (EXCEPT_BASELINE, except_counts, "except"),
    (BIOME_BASELINE, biome_counts, "biome-ignore"),
    (SIZE_BASELINE, size_counts, "lines"),
)


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else "check"
    if command == "update":
        for path, counter, _ in CHECKS:
            current = counter()
            ceiling = _load(path)
            _write(path, lowered(current, ceiling) if ceiling else current)
        return 0
    if command == "check":
        failed = False
        for path, counter, what in CHECKS:
            above, below = compare(counter(), _load(path), what)
            for line in above:
                print(f"above its ceiling: {line}", file=sys.stderr)
            for line in below:
                print(f"ceiling to lower: {line}", file=sys.stderr)
            failed |= bool(above or below)
        if failed:
            print(
                "fix the new ones; for a ceiling to lower, run: "
                "python scripts/quality_baselines.py update",
                file=sys.stderr,
            )
        return 1 if failed else 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
