"""The uvicorn --reload arguments of ``pnpm dev`` against uvicorn itself.

``apps/backend/dev-reload-args.mjs`` builds them. uvicorn only accepts an
absolute ``--reload-exclude`` that names an existing directory: anything else
goes to ``Path.cwd().glob()``, which raises "Non-relative patterns are
unsupported", and the dev backend dies before serving. A checkout whose venv
sits at the repo root has no ``apps/backend/.venv``.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from uvicorn.config import Config
from uvicorn.supervisors.watchfilesreload import FileFilter

REPO_ROOT = Path(__file__).resolve().parent.parent
HELPER = REPO_ROOT / "apps" / "backend" / "dev-reload-args.mjs"
DEV_SERVER = REPO_ROOT / "apps" / "backend" / "dev-server.mjs"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="node runs the dev launcher"
)


def _dev_reload_args(backend_dir: Path) -> list[str]:
    script = (
        f"import {{ devReloadArgs }} from {json.dumps(HELPER.as_uri())};"
        "console.log(JSON.stringify(devReloadArgs(process.argv[1])));"
    )
    node = shutil.which("node")
    assert node is not None
    out = subprocess.run(
        [node, "--input-type=module", "-e", script, str(backend_dir)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
        timeout=60,
    )
    return json.loads(out.stdout)


def _uvicorn_config(args: list[str], backend_dir: Path) -> Config:
    """What ``python -m uvicorn provider_api:app <args>`` hands to Config."""
    assert args[0] == "--reload"
    dirs: list[str] = []
    excludes: list[str] = []
    pairs = iter(args[1:])
    for flag, value in zip(pairs, pairs, strict=True):
        {"--reload-dir": dirs, "--reload-exclude": excludes}[flag].append(value)
    return Config(
        "provider_api:app", reload=True, reload_dirs=dirs, reload_excludes=excludes
    )


def test_dev_server_takes_its_reload_args_from_the_helper() -> None:
    source = DEV_SERVER.read_text(encoding="utf-8")
    assert "...devReloadArgs(__dirname)" in source
    assert '"--reload-exclude"' not in source


def test_backend_without_its_own_venv_starts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    args = _dev_reload_args(tmp_path)

    assert "--reload-exclude" not in args
    config = _uvicorn_config(args, tmp_path)
    assert config.reload_dirs == [tmp_path.resolve()]


def test_backend_venv_is_excluded_from_the_watcher(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    venv = tmp_path / ".venv"
    (venv / "lib").mkdir(parents=True)
    monkeypatch.chdir(tmp_path)
    args = _dev_reload_args(tmp_path)

    exclude = Path(args[args.index("--reload-exclude") + 1])
    assert exclude.is_absolute()
    assert exclude.is_dir()
    assert not any(c in arg for arg in args for c in "*?[")

    watched = FileFilter(_uvicorn_config(args, tmp_path))
    assert watched(tmp_path / "provider_api.py")
    assert not watched(venv.resolve() / "lib" / "installed.py")
