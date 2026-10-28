"""One Python floor, said the same way by every place that checks it.

The backend uses 3.12 syntax (`src/connectors/jira/work_items.py` nests
quotes inside an f-string, PEP 701), so an interpreter the detector accepts
must be one the code imports under. The Electron detector and the two Python
entry points each refuse an older interpreter; they used to say 3.10.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FLOOR = (3, 12)


def _ts_floor() -> tuple[int, int]:
    text = (ROOT / "apps/frontend/src/shared/constants/python.ts").read_text(
        encoding="utf-8"
    )
    match = re.search(r'MINIMUM_PYTHON_VERSION = "(\d+)\.(\d+)\.\d+"', text)
    assert match, "MINIMUM_PYTHON_VERSION not found"
    return int(match.group(1)), int(match.group(2))


def _py_floor(relative: str) -> tuple[int, int]:
    text = (ROOT / relative).read_text(encoding="utf-8")
    match = re.search(r"if sys\.version_info < \((\d+), (\d+)\)", text)
    assert match, f"{relative} has no version check"
    return int(match.group(1)), int(match.group(2))


def test_the_electron_detector_and_the_entry_points_agree():
    assert _ts_floor() == FLOOR
    assert _py_floor("apps/backend/run.py") == FLOOR
    assert _py_floor("apps/backend/runners/spec_runner.py") == FLOOR


def test_no_detector_keeps_its_own_literal_floor():
    main = ROOT / "apps/frontend/src/main"
    stray = [
        f"{path.relative_to(ROOT)}:{number}"
        for path in main.rglob("*.ts")
        for number, line in enumerate(path.read_text(encoding="utf-8").split("\n"), 1)
        if re.search(r'MINIMUM_VERSION = "3\.\d+', line)
    ]
    assert stray == []
