#!/usr/bin/env python3
"""Write the workflow's ``&ui_surface`` anchor from ``uiux.surface.UI_GLOBS``.

``UI_GLOBS`` is the source: relevance, the coder's prompt section and the
preflight all read it at runtime, in builds where the repository's
``workflows/`` directory does not ship. The engine reads the anchor from
``workflow.yaml``. This script is how the second copy follows the first;
``tests/test_uiux.py`` fails when someone edits one and not the other.

    python3 scripts/sync_surface_globs.py          # rewrite the anchor
    python3 scripts/sync_surface_globs.py --check  # exit 1 on drift
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = REPO_ROOT / "workflows" / "feature-build" / "workflow.yaml"

sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from uiux.surface import UI_GLOBS  # noqa: E402

_ANCHOR = re.compile(r'(&ui_surface touches\(")([^"]*)("\))')


def render(text: str) -> str:
    if not _ANCHOR.search(text):
        raise SystemExit(f"{WORKFLOW}: no &ui_surface anchor to rewrite")
    return _ANCHOR.sub(lambda m: m.group(1) + ",".join(UI_GLOBS) + m.group(3), text)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail on drift")
    args = parser.parse_args()

    text = WORKFLOW.read_text(encoding="utf-8")
    wanted = render(text)
    if wanted == text:
        return 0
    if args.check:
        print(f"{WORKFLOW.relative_to(REPO_ROOT)}: &ui_surface differs from UI_GLOBS")
        return 1
    WORKFLOW.write_text(wanted, encoding="utf-8")
    print(f"rewrote &ui_surface in {WORKFLOW.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
