"""The app is started once before it ships (plan of 29 October, T3).

1.3.1 shipped a main process that threw while loading (F114): every check was
green because nothing ever started the app. CI starts the build on each OS,
and the release starts each packaged app before anything is uploaded.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
SCRIPT = "scripts/smoke-test.cjs"


def _steps(workflow: str) -> list[str]:
    text = (WORKFLOWS / workflow).read_text(encoding="utf-8")
    return re.split(r"\n      - ", text)


def test_the_script_and_the_main_hook_exist():
    assert (ROOT / "apps" / "frontend" / SCRIPT).is_file()
    index = (ROOT / "apps" / "frontend" / "src" / "main" / "index.ts").read_text(
        encoding="utf-8"
    )
    assert "armSmokeTest(mainWindow)" in index


def test_ci_starts_the_built_app_after_building_it():
    steps = _steps("ci.yml")
    build = next(i for i, s in enumerate(steps) if "pnpm run build" in s)
    smoke = next(i for i, s in enumerate(steps) if SCRIPT in s)
    assert smoke > build
    assert "--packaged" not in steps[smoke]


def test_every_packaged_build_is_started_before_it_is_uploaded():
    steps = _steps("release.yml")
    packaging = [
        i for i, s in enumerate(steps) if re.search(r"pnpm run package:\w+", s)
    ]
    assert len(packaging) == 4, "one packaging step per platform job"
    for index in packaging:
        following = steps[index + 1 : index + 3]
        assert any(f"{SCRIPT} --packaged" in s for s in following), steps[index][:60]
