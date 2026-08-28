"""The PR review engine's module-level shape.

`ProgressCallback` carries only class-level annotations, so it depends
entirely on `@dataclass` for its constructor. A decorator separated from its
class by an inserted function is still valid Python — the module imports, and
nothing fails until something tries to build one — so `ruff format` was the
only thing that noticed. This asserts it directly.
"""

from __future__ import annotations

import dataclasses
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from runners.github.services.pr_review_engine import ProgressCallback  # noqa: E402


class TestProgressCallback:
    def test_it_is_a_dataclass(self):
        assert dataclasses.is_dataclass(ProgressCallback)

    def test_it_constructs_from_its_annotations(self):
        callback = ProgressCallback(phase="review", progress=50, message="working")
        assert callback.phase == "review"
        assert callback.progress == 50
        assert callback.message == "working"

    def test_its_optional_fields_default(self):
        callback = ProgressCallback(phase="review", progress=0, message="")
        assert callback.pr_number is None
        assert callback.extra is None
