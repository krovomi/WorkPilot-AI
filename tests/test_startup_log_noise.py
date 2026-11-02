"""Startup must not print noise: the streaming server's `python -m cli.main`
raised a runpy RuntimeWarning, and the analytics database announced itself
once per entry point."""

import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "apps" / "backend"


def test_importing_the_cli_package_does_not_load_cli_main():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, cli; assert 'cli.main' not in sys.modules; "
            + "from cli import main; assert callable(main)",
        ],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
    )
    assert result.returncode == 0, result.stderr


def test_streaming_server_entry_point_runs_without_runpy_warning():
    result = subprocess.run(
        [sys.executable, "-W", "error::RuntimeWarning", "-m", "cli.main", "--help"],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    assert "RuntimeWarning" not in result.stderr


def test_analytics_database_initializes_once_and_quietly(monkeypatch, capsys):
    from analytics import database

    calls = []
    monkeypatch.setattr(database, "_initialized", False)
    monkeypatch.setattr(database, "create_tables", lambda: calls.append(1))

    database.init_database()
    database.init_database()

    assert calls == [1]
    assert capsys.readouterr().out == ""
