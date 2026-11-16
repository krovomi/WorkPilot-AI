"""The GitHub runner's modules load under the runner's own flat layout.

`runner.py` puts `apps/backend` and then its own folder first on `sys.path`,
so the orchestrator and the reviewers import their neighbours by bare name
(`models`, `providers`, `services.category_utils`...), while the backend's
API imports the same files as `runners.github.*`. Each module carries both
imports; the tests elsewhere load the package one. This one starts Python the
way the runner lays the path out and loads the bare one, in a fresh process so
the backend's own `services` package is not already taken.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[3] / "apps" / "backend"

PROGRAM = """
import sys
sys.path.insert(0, {backend!r})
sys.path.insert(0, {runner!r})

import models
import providers
from services import autofix_processor, category_utils, prompt_manager
from services import response_parsers, triage_engine

assert providers.GitHubProvider.__module__ == "providers.github_provider"
assert category_utils.map_category("logic") is models.ReviewCategory.QUALITY
assert prompt_manager.PromptManager().get_review_pass_prompt(models.ReviewPass.SECURITY)
parsed = response_parsers.ResponseParser.parse_triage_result(
    {{"number": 3}}, '```json\\n{{"category": "bug"}}\\n```', "o/r"
)
assert parsed.category is models.TriageCategory.BUG
assert triage_engine.TriageEngine.__name__ == "TriageEngine"
assert autofix_processor.AutoFixProcessor.__name__ == "AutoFixProcessor"
print("flat layout ok")
"""


def test_every_module_imports_by_bare_name_as_the_runner_does():
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONHOME")}
    env.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
    done = subprocess.run(
        [
            sys.executable,
            "-c",
            PROGRAM.format(
                backend=str(BACKEND), runner=str(BACKEND / "runners" / "github")
            ),
        ],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
    )
    assert done.returncode == 0, done.stderr
    assert "flat layout ok" in done.stdout
