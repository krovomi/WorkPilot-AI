"""`cli.utils`: environment loading, spec lookup, the project directory."""

from __future__ import annotations

import builtins
import sys

import pytest
from cli import utils


def test_without_python_dotenv_the_cli_says_how_to_install_it(monkeypatch):
    real_import = builtins.__import__

    def no_dotenv(name, *args, **kwargs):
        if name == "dotenv":
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_dotenv)
    with pytest.raises(SystemExit) as stop:
        utils.import_dotenv()
    assert "pip install python-dotenv" in str(stop.value.code)


@pytest.fixture
def fake_checkout(tmp_path, monkeypatch):
    """`cli/utils.py` as if it lived in `tmp_path/apps/backend/cli/`."""
    module = tmp_path / "apps" / "backend" / "cli" / "utils.py"
    module.parent.mkdir(parents=True)
    loaded = []
    monkeypatch.setattr(utils, "__file__", str(module))
    monkeypatch.setattr(utils, "load_dotenv", loaded.append)
    monkeypatch.setattr(sys, "path", list(sys.path))
    return tmp_path, loaded


@pytest.mark.parametrize("which", ["central", "dev", None])
def test_setup_environment_loads_the_first_env_file(fake_checkout, which):
    root, loaded = fake_checkout
    central = root / ".env-files" / ".env"
    dev = root / "apps" / "dev" / "workpilot" / ".env"
    if which == "central":
        central.parent.mkdir(parents=True)
        central.write_text("A=1\n", encoding="utf-8")
    if which in ("central", "dev"):
        dev.parent.mkdir(parents=True)
        dev.write_text("A=2\n", encoding="utf-8")

    script_dir = utils.setup_environment()

    assert script_dir == (root / "apps" / "backend").resolve()
    assert sys.path[0] == str(root.resolve())
    assert loaded == {"central": [central], "dev": [dev], None: []}[which]


def _spec(base, name):
    folder = base / name
    folder.mkdir(parents=True)
    (folder / "spec.md").write_text("# s\n", encoding="utf-8")
    return folder


def test_find_spec_by_name_or_number(tmp_path):
    specs = tmp_path / ".workpilot" / "specs"
    login = _spec(specs, "001-login")
    (specs / "002-draft").mkdir()

    assert utils.find_spec(tmp_path, "001-login") == login
    assert utils.find_spec(tmp_path, "001") == login
    assert utils.find_spec(tmp_path, "002") is None


def test_find_spec_falls_back_to_the_task_worktrees(tmp_path):
    tasks = tmp_path / ".workpilot" / "worktrees" / "tasks"
    exact = _spec(tasks / "003-api" / ".workpilot" / "specs", "003-api")
    (tasks / "004-gone").mkdir()

    assert utils.find_spec(tmp_path, "003-api") == exact
    assert utils.find_spec(tmp_path, "003") == exact
    assert utils.find_spec(tmp_path, "004") is None
    assert utils.find_spec(tmp_path, "009") is None


def test_the_provider_falls_back_to_the_frontend_signal(tmp_path, monkeypatch):
    import core.client

    def broken(_spec_dir):
        raise RuntimeError("no client")

    monkeypatch.setattr(core.client, "peek_active_provider", broken)
    monkeypatch.delenv("SELECTED_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("AUTO_CLAUDE_PROVIDER", raising=False)
    assert utils._active_provider(tmp_path) == "claude"
    monkeypatch.setenv("AUTO_CLAUDE_PROVIDER", "ollama")
    assert utils._active_provider(tmp_path) == "ollama"


@pytest.fixture
def claude_build(tmp_path, monkeypatch):
    spec = tmp_path / ".workpilot" / "specs" / "001-x"
    spec.mkdir(parents=True)
    (spec / "spec.md").write_text("# s\n", encoding="utf-8")
    monkeypatch.setattr(utils, "validate_platform_dependencies", lambda: None)
    monkeypatch.setattr(utils, "_active_provider", lambda _spec_dir: "claude")
    monkeypatch.setattr(utils, "get_auth_token", lambda: "sk-test-0000")
    monkeypatch.setattr(utils, "get_auth_token_source", lambda: "keychain")
    return spec


def test_a_linear_project_is_reported(claude_build, monkeypatch, capsys):
    monkeypatch.setattr(utils, "is_linear_enabled", lambda: True)
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://proxy.example")

    assert utils.validate_environment(claude_build) is True

    out = capsys.readouterr().out
    assert "Auth: keychain" in out
    assert "API Endpoint: https://proxy.example" in out
    assert "Linear integration: ENABLED" in out


def test_without_linear_the_build_says_how_to_enable_it(
    claude_build, monkeypatch, capsys
):
    monkeypatch.setattr(utils, "is_linear_enabled", lambda: False)
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
    assert utils.validate_environment(claude_build) is True
    out = capsys.readouterr().out
    assert "set LINEAR_API_KEY to enable" in out
    assert "API Endpoint" not in out


def test_the_project_dir(tmp_path, monkeypatch):
    assert utils.get_project_dir(tmp_path / "x" / "..") == tmp_path.resolve()

    backend = tmp_path / "apps" / "backend"
    backend.mkdir(parents=True)
    monkeypatch.chdir(backend)
    assert utils.get_project_dir(None) == backend
    (backend / "run.py").write_text("", encoding="utf-8")
    assert utils.get_project_dir(None) == tmp_path

    monkeypatch.chdir(tmp_path)
    assert utils.get_project_dir(None) == tmp_path


def test_the_banner(capsys):
    utils.print_banner()
    assert "AUTO-BUILD FRAMEWORK" in capsys.readouterr().out


def test_a_claude_build_without_a_token_cannot_start(claude_build, monkeypatch, capsys):
    monkeypatch.setattr(utils, "is_linear_enabled", lambda: False)
    monkeypatch.setattr(utils, "get_auth_token", lambda: None)
    problems: list[str] = []

    assert utils.validate_environment(claude_build, problems=problems) is False

    assert "Error: No OAuth token found" in capsys.readouterr().out
    [problem] = problems
    assert "claude setup-token" in problem
    assert "« claude »" in problem


def test_another_provider_needs_no_claude_token(claude_build, monkeypatch, capsys):
    monkeypatch.setattr(utils, "is_linear_enabled", lambda: False)
    monkeypatch.setattr(utils, "_active_provider", lambda _spec_dir: "ollama")
    monkeypatch.setattr(utils, "get_auth_token", lambda: None)

    assert utils.validate_environment(claude_build) is True
    assert "Auth: not required for provider 'ollama'" in capsys.readouterr().out


def test_a_spec_without_spec_md_cannot_start(claude_build, monkeypatch, capsys):
    monkeypatch.setattr(utils, "is_linear_enabled", lambda: False)
    monkeypatch.setattr(utils, "get_auth_token", lambda: None)
    (claude_build / "spec.md").unlink()
    problems: list[str] = []

    # Without a list to fill, the reasons are only printed.
    assert utils.validate_environment(claude_build) is False
    assert utils.validate_environment(claude_build, problems=problems) is False

    assert "spec.md not found" in capsys.readouterr().out
    assert len(problems) == 2
    assert "spec.md est introuvable" in problems[1]
