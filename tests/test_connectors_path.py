"""`src.connectors` is importable wherever the backend runs (F173).

The installed app ships `src` inside the backend; the repository (dev mode) and
the server image keep it at the root. Runners started by the app only had the
backend on their path, and the server image did not copy `src` at all, so a
Mistral, DeepSeek or Grok one-shot call, Jira and Azure DevOps all failed with
"No module named 'src'" outside the installed app.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from foundation import connectors_path
from foundation.connectors_path import connectors_root, ensure_connectors_on_path

REPO = Path(__file__).resolve().parents[1]
BACKEND = REPO / "apps" / "backend"


def _child_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    env["PYTHONPATH"] = str(BACKEND)
    return env


def _run(code: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    # -P: the working directory is not put on the path, as for a runner the
    # app starts with only the backend on PYTHONPATH.
    return subprocess.run(
        [sys.executable, "-P", "-c", code],
        cwd=cwd,
        env=_child_env(),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )


def test_a_runner_with_only_the_backend_on_its_path_imports_the_connectors(tmp_path):
    result = _run(
        "import core\nfrom src.connectors.llm_config import load_provider_config\nprint('ok')",
        tmp_path,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip().endswith("ok")


def test_without_the_core_import_the_connectors_were_out_of_reach(tmp_path):
    # What every runner saw before: the test above means something.
    result = _run("import src.connectors", tmp_path)
    assert result.returncode != 0
    assert "No module named 'src'" in result.stderr


def _layout(base: Path, *parts: str) -> Path:
    package = base.joinpath(*parts, "src", "connectors")
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    return base.joinpath(*parts)


def test_the_installed_layout_wins_over_the_repository_root(tmp_path):
    backend = _layout(tmp_path, "apps", "backend")
    _layout(tmp_path)
    assert connectors_root(backend) == backend


def test_the_repository_root_is_found_two_levels_above_the_backend(tmp_path):
    backend = tmp_path / "apps" / "backend"
    backend.mkdir(parents=True)
    root = _layout(tmp_path)
    assert connectors_root(backend) == root


def test_no_connectors_anywhere_changes_nothing(tmp_path, monkeypatch):
    backend = tmp_path / "apps" / "backend"
    backend.mkdir(parents=True)
    monkeypatch.setattr(connectors_path.sys, "path", ["/somewhere"])
    assert ensure_connectors_on_path(backend) is None
    assert connectors_path.sys.path == ["/somewhere"]


def test_the_root_is_appended_once_and_never_shadows_the_backend(tmp_path, monkeypatch):
    backend = tmp_path / "apps" / "backend"
    backend.mkdir(parents=True)
    root = _layout(tmp_path)
    monkeypatch.setattr(connectors_path.sys, "path", [str(backend)])
    ensure_connectors_on_path(backend)
    ensure_connectors_on_path(backend)
    assert connectors_path.sys.path == [str(backend), str(root)]


def test_the_server_image_ships_the_connectors_where_the_backend_looks():
    dockerfile = (REPO / "deploy" / "Dockerfile.server").read_text(encoding="utf-8")
    lines = [line.strip() for line in dockerfile.splitlines()]
    assert "COPY src /app/src" in lines
    # The backend runs from /app/apps/backend: two levels up is /app.
    assert "WORKDIR /app/apps/backend" in lines
    ignore = (REPO / ".dockerignore").read_text(encoding="utf-8").splitlines()
    assert "!src/" in ignore
