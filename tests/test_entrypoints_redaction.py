"""Every backend process the app launches masks secrets in its logs.

`provider_api.py` installed the redacting filter; `run.py` and the runners
Electron spawns did not, so a token logged by a runner reached its stderr,
which the app writes to its own log. Each entry module now installs it at
the top of its `__main__` block.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"

# Modules with a `__main__` block that is a demo, not something the app runs.
NOT_ENTRY_POINTS = {"runners/github/rate_limiter.py"}


def _entry_points() -> list[Path]:
    found = [BACKEND / "run.py"]
    for path in sorted((BACKEND / "runners").rglob("*.py")):
        rel = path.relative_to(BACKEND).as_posix()
        if "__pycache__" in path.parts or rel in NOT_ENTRY_POINTS:
            continue
        if 'if __name__ == "__main__":' in path.read_text(encoding="utf-8"):
            found.append(path)
    return found


def _main_block(tree: ast.Module) -> ast.If | None:
    for node in tree.body:
        if (
            isinstance(node, ast.If)
            and isinstance(node.test, ast.Compare)
            and isinstance(node.test.left, ast.Name)
            and node.test.left.id == "__name__"
        ):
            return node
    return None


@pytest.mark.parametrize(
    "path", _entry_points(), ids=lambda p: p.relative_to(BACKEND).as_posix()
)
def test_the_main_block_installs_redaction_first(path: Path):
    block = _main_block(ast.parse(path.read_text(encoding="utf-8")))
    assert block is not None
    calls = [
        n.func.id
        for n in ast.walk(ast.Module(body=block.body[:4], type_ignores=[]))
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
    ]
    assert "install_global_redaction" in calls
