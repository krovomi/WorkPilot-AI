"""The error line of the runners whose view decodes it.

Each prints ``<PREFIX>_ERROR:`` then the message as a JSON string, which keeps
a message with a newline on one line. Their handlers in the app decode it
(``apps/frontend/src/main/utils/runner-error.ts``,
``ipc-handlers/__tests__/runner-error-lines.test.ts``): a runner that changed
to plain text would still read right, one that changed to another JSON shape
would show its braces.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"


@pytest.mark.parametrize(
    ("runner", "prefix"),
    [
        ("doc_drift_runner.py", "DOC_DRIFT_ERROR:"),
        ("notebook_agent_runner.py", "NOTEBOOK_ERROR:"),
        ("i18n_runner.py", "I18N_ERROR:"),
        ("api_watcher_runner.py", "API_WATCHER_ERROR:"),
        ("consensus_arbiter_runner.py", "CONSENSUS_ARBITER_ERROR:"),
        ("injection_guard_runner.py", "INJECTION_GUARD_ERROR:"),
        ("onboarding_agent_runner.py", "ONBOARDING_ERROR:"),
        ("regression_guardian_runner.py", "REGRESSION_GUARDIAN_ERROR:"),
        ("compliance_runner.py", "COMPLIANCE_ERROR:"),
    ],
)
def test_a_missing_project_is_one_json_string_line(
    tmp_path: Path, runner: str, prefix: str
) -> None:
    done = subprocess.run(
        [
            sys.executable,
            str(BACKEND / "runners" / runner),
            "--project-path",
            str(tmp_path / "gone"),
        ],
        cwd=BACKEND,
        # As the app starts a runner (pythonRunnerEnv): UTF-8 whatever the code page.
        env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )

    assert done.returncode == 1, done.stdout + done.stderr
    [line] = [x for x in done.stdout.splitlines() if x.startswith(prefix)]
    message = json.loads(line[len(prefix) :])
    assert isinstance(message, str)
    assert message.startswith("Project path does not exist")
