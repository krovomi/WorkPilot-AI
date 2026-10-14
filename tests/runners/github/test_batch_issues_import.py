"""`runners.github.batch_issues` imports as a package module.

`batch_issues.py` once read `from ..phase_config import resolve_model_id` in
its relative block. From `runners.github.batch_issues` that names
`runners.phase_config`, which does not exist, so the whole block failed and
fell back to bare sibling imports (`from batch_validator import ...`) that only
resolve when `runners/github` is itself on `sys.path`.

Inside the test session that directory *is* on `sys.path`: the `conftest.py`
next to this file appends it. So the failure only showed when
`tests/test_security_untrusted.py` ran on its own. This test imports the module
in a fresh interpreter whose path holds the backend root and nothing else,
which is how `provider_api.py` reaches `runners.github`.
"""

import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[3] / "apps" / "backend"


def test_batch_issues_imports_with_only_the_backend_root_on_the_path(tmp_path):
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in ("PYTHONPATH", "PYTHONHOME")
    }
    env["PYTHONPATH"] = str(BACKEND)
    code = "import runners.github.batch_issues as m\nprint(m.BatchValidator.__module__)"

    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "runners.github.batch_validator"
