"""``deploy/configure.py``: the server configured for where each team hosts it.

Run on real copies of the deploy examples in a temporary folder.
"""

from __future__ import annotations

import importlib.util
import shutil
import stat
import sys
from pathlib import Path

import pytest

DEPLOY = Path(__file__).resolve().parents[1] / "deploy"
_spec = importlib.util.spec_from_file_location(
    "deploy_configure", DEPLOY / "configure.py"
)
assert _spec and _spec.loader
configure_mod = importlib.util.module_from_spec(_spec)
sys.modules["deploy_configure"] = configure_mod
_spec.loader.exec_module(configure_mod)

EXAMPLES = (
    "server-env.example",
    "Caddyfile.example",
    "docker-compose.override.example.yml",
)


@pytest.fixture
def deploy_dir(tmp_path: Path) -> Path:
    for name in EXAMPLES:
        shutil.copyfile(DEPLOY / name, tmp_path / name)
    return tmp_path


def env_of(directory: Path) -> dict[str, str]:
    values = {}
    for line in (directory / ".env.server").read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    return values


@pytest.mark.parametrize(
    ("hosting", "host", "base", "stream"),
    [
        (
            "public",
            "WorkPilot.Example.com.",
            "https://workpilot.example.com",
            "wss://workpilot.example.com",
        ),
        ("lan", "192.168.1.20", "http://192.168.1.20", "ws://192.168.1.20"),
        ("lan", "fd00::20", "http://[fd00::20]", "ws://[fd00::20]"),
        ("lan", "build-box", "http://build-box", "ws://build-box"),
        ("local", "ignored", "http://localhost", "ws://localhost"),
    ],
)
def test_each_hosting_gets_its_addresses(deploy_dir, hosting, host, base, stream):
    assert (
        configure_mod.main(
            ["--dir", str(deploy_dir), "--hosting", hosting, "--host", host]
        )
        == 0
    )
    env = env_of(deploy_dir)
    assert env["WORKPILOT_HOSTING"] == hosting
    assert env["WORKPILOT_PUBLIC_BASE_URL"] == base
    assert env["WORKPILOT_PUBLIC_STREAM_URL"] == stream
    # The proxy comes with every choice: the stream is reachable only through it.
    assert (deploy_dir / "Caddyfile").read_text(encoding="utf-8") == (
        deploy_dir / "Caddyfile.example"
    ).read_text(encoding="utf-8")
    assert (deploy_dir / "docker-compose.override.yml").exists()


def test_secrets_are_generated_once_and_kept(deploy_dir):
    configure_mod.configure(deploy_dir, "lan", "192.168.1.20")
    first = env_of(deploy_dir)
    assert len(first["POSTGRES_PASSWORD"]) == 48
    assert all(c in "0123456789abcdef" for c in first["POSTGRES_PASSWORD"])
    assert len(first["WORKPILOT_JWT_SECRET"]) == 64
    assert len(first["WORKPILOT_SECRETS_MASTER_KEY"]) == 44
    configure_mod.configure(deploy_dir, "public", "workpilot.example.com")
    second = env_of(deploy_dir)
    for key in configure_mod.SECRET_KEYS:
        assert second[key] == first[key], key
    assert second["WORKPILOT_PUBLIC_BASE_URL"] == "https://workpilot.example.com"


def test_the_operators_own_lines_and_files_stay(deploy_dir):
    configure_mod.configure(deploy_dir, "lan", "10.0.0.5")
    env_path = deploy_dir / ".env.server"
    text = env_path.read_text(encoding="utf-8")
    env_path.write_text(
        text.replace(
            "CLAUDE_CODE_OAUTH_TOKEN=", "CLAUDE_CODE_OAUTH_TOKEN=tok-test-0000"
        )
        + "MY_OWN=1\n",
        encoding="utf-8",
    )
    (deploy_dir / "Caddyfile").write_text("# mine\n", encoding="utf-8")
    done = configure_mod.configure(deploy_dir, "lan", "10.0.0.6")
    env = env_of(deploy_dir)
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "tok-test-0000"  # pragma: allowlist secret
    assert env["MY_OWN"] == "1"
    assert env["WORKPILOT_PUBLIC_BASE_URL"] == "http://10.0.0.6"
    assert (deploy_dir / "Caddyfile").read_text(encoding="utf-8") == "# mine\n"
    assert "Kept your Caddyfile" in done
    # Each key once: a rerun replaces, it does not append.
    lines = env_path.read_text(encoding="utf-8").splitlines()
    assert sum(line.startswith("WORKPILOT_PUBLIC_BASE_URL=") for line in lines) == 1


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX modes")
def test_the_env_file_is_readable_by_its_owner_only(deploy_dir):
    configure_mod.configure(deploy_dir, "local", "")
    mode = stat.S_IMODE((deploy_dir / ".env.server").stat().st_mode)
    assert mode == 0o600


@pytest.mark.parametrize(
    ("hosting", "host", "message"),
    [
        ("public", "203.0.113.7", "no certificate for an IP address"),
        ("public", "intranet", "full DNS name"),
        ("lan", "https://box", "without scheme, port or path"),
        ("lan", "box:8080", "without scheme, port or path"),
        ("lan", "user@box", "without scheme, port or path"),
        ("lan", "bad_name!", "Not a host name"),
        ("lan", "", "Not a host name"),
        ("moon", "x", "Unknown hosting"),
    ],
)
def test_an_answer_it_cannot_use_writes_nothing(deploy_dir, hosting, host, message):
    with pytest.raises(configure_mod.ConfigError, match=message):
        configure_mod.configure(deploy_dir, hosting, host)
    assert not (deploy_dir / ".env.server").exists()


def test_the_command_line_reports_a_refusal(deploy_dir, capsys):
    code = configure_mod.main(
        ["--dir", str(deploy_dir), "--hosting", "public", "--host", "10.1.1.1"]
    )
    assert code == 2
    assert "error:" in capsys.readouterr().err


def test_it_asks_when_no_choice_is_given(deploy_dir, monkeypatch, capsys):
    answers = iter(["2", "192.168.0.9"])
    monkeypatch.setattr("builtins.input", lambda _prompt: next(answers))
    assert configure_mod.main(["--dir", str(deploy_dir)]) == 0
    assert env_of(deploy_dir)["WORKPILOT_PUBLIC_BASE_URL"] == "http://192.168.0.9"
    out = capsys.readouterr().out
    assert "Where does this WorkPilot server run?" in out
    assert "connect to http://192.168.0.9" in out


@pytest.mark.parametrize(
    ("answer", "hosting"), [("", "public"), ("local", "local"), ("3", "local")]
)
def test_the_question_takes_a_number_a_name_or_the_default(
    monkeypatch, answer, hosting
):
    monkeypatch.setattr("builtins.input", lambda _prompt: answer)
    assert configure_mod.ask_hosting() == hosting


def test_a_closed_input_is_a_refusal(deploy_dir, monkeypatch):
    def closed(_prompt):
        raise EOFError

    monkeypatch.setattr("builtins.input", closed)
    assert configure_mod.main(["--dir", str(deploy_dir)]) == 2


def test_an_unknown_answer_is_refused(monkeypatch):
    monkeypatch.setattr("builtins.input", lambda _prompt: "9")
    with pytest.raises(configure_mod.ConfigError, match="Not a choice"):
        configure_mod.ask_hosting()


def test_the_host_question_follows_the_choice(monkeypatch):
    monkeypatch.setattr("builtins.input", lambda prompt: prompt)
    assert configure_mod.ask_host(configure_mod.HOSTINGS["local"]) == "localhost"
    assert "DNS name" in configure_mod.ask_host(configure_mod.HOSTINGS["public"])
    assert "IP address" in configure_mod.ask_host(configure_mod.HOSTINGS["lan"])


def test_every_secret_the_compose_needs_is_written(deploy_dir):
    configure_mod.configure(deploy_dir, "local", "")
    env = env_of(deploy_dir)
    compose = (DEPLOY / "docker-compose.yml").read_text(encoding="utf-8")
    assert "${POSTGRES_PASSWORD" in compose
    assert env["POSTGRES_PASSWORD"]
    override = (DEPLOY / "docker-compose.override.example.yml").read_text(
        encoding="utf-8"
    )
    assert "${WORKPILOT_PUBLIC_BASE_URL" in override
    assert env["WORKPILOT_PUBLIC_BASE_URL"]
