"""Connecting the brain to an agent whose configuration is not what the round
trips in ``test_brain`` expect: another JSON shape, a file out of reach, a
Claude Code CLI that answers, refuses or hangs."""

from __future__ import annotations

import json
import subprocess

import pytest
from brain import connect as brain_connect
from brain.connect import SERVER_NAME, connect, connect_all


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("WORKPILOT_BRAIN_HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    monkeypatch.delenv("PI_CODING_AGENT_DIR", raising=False)
    monkeypatch.setattr(brain_connect.shutil, "which", lambda _name: None)
    return home


@pytest.fixture
def root(tmp_path):
    return tmp_path / "brain"


def gemini(home, text: str):
    cfg = home / ".gemini" / "settings.json"
    cfg.parent.mkdir(exist_ok=True)
    cfg.write_text(text, encoding="utf-8")
    return cfg


class TestJsonShapes:
    @pytest.mark.parametrize(
        ("text", "reason"),
        [
            ("[1, 2]", "settings.json is not a JSON object"),
            ('{"mcpServers": ["x"]}', "mcpServers is not a map"),
        ],
    )
    def test_another_shape_is_reported_and_left_alone(self, home, root, text, reason):
        cfg = gemini(home, text)

        result = connect(root, "gemini", apply=True)

        assert (result.action, result.reason) == ("error", reason)
        assert cfg.read_text(encoding="utf-8") == text


class TestFilesOutOfReach:
    def test_a_folder_where_the_json_file_should_be(self, home, root):
        (home / ".gemini" / "settings.json").mkdir(parents=True)

        result = connect(root, "gemini", apply=True)

        assert (result.action, result.reason) == (
            "error",
            "settings.json could not be written",
        )

    def test_a_folder_where_the_toml_file_should_be(self, home, root):
        (home / ".codex" / "config.toml").mkdir(parents=True)

        result = connect(root, "codex", apply=True)

        assert (result.action, result.reason) == (
            "error",
            "config.toml could not be written",
        )

    @pytest.mark.parametrize(
        ("name", "file"),
        [("gemini", ".gemini/settings.json"), ("codex", ".codex/config.toml")],
    )
    def test_a_file_that_cannot_be_read(self, home, root, monkeypatch, name, file):
        cfg = home / file
        cfg.parent.mkdir(parents=True)
        cfg.write_text("{}", encoding="utf-8")
        real = type(cfg).read_text

        def locked(self, *args, **kwargs):
            if self == cfg:
                raise PermissionError("locked by the running agent")
            return real(self, *args, **kwargs)

        monkeypatch.setattr(type(cfg), "read_text", locked)

        result = connect(root, name, apply=True)

        assert (result.action, result.reason) == (
            "error",
            f"{cfg.name} could not be read",
        )

    def test_one_agent_out_of_reach_does_not_stop_the_others(self, home, root):
        (home / ".gemini" / "settings.json").mkdir(parents=True)
        (home / ".cursor").mkdir()

        results = {r.agent: r.action for r in connect_all(root, apply=True)}

        assert results["gemini"] == "error" and results["cursor"] == "written"


class TestToml:
    def test_an_entry_the_person_wrote_is_theirs(self, home, root):
        cfg = home / ".codex" / "config.toml"
        cfg.parent.mkdir()
        cfg.write_text(f"[mcp_servers.{SERVER_NAME}]\ncommand = 'x'\n", "utf-8")

        result = connect(root, "codex", apply=True)

        assert result.action == "manual"
        assert result.reason == "an unmanaged entry already exists"

    def test_the_same_block_twice_is_unchanged(self, home, root):
        (home / ".codex").mkdir()
        assert connect(root, "codex", apply=True).action == "written"
        assert connect(root, "codex", apply=True).action == "unchanged"


class TestClaudeCli:
    @pytest.fixture
    def cli(self, monkeypatch):
        calls: list[list[str]] = []

        def install(answer):
            monkeypatch.setattr(brain_connect.shutil, "which", lambda _n: "claude")

            def run(argv, **kwargs):
                calls.append(argv)
                return answer(argv)

            monkeypatch.setattr(brain_connect.subprocess, "run", run)
            return calls

        return install

    def test_the_cli_writes_its_own_file(self, home, root, cli):
        calls = cli(lambda argv: subprocess.CompletedProcess(argv, 0, "", ""))

        result = connect(root, "claude-code", apply=True)

        assert (result.action, result.path) == (
            "written",
            "claude mcp add-json --scope user",
        )
        assert [c[1:3] for c in calls] == [["mcp", "remove"], ["mcp", "add-json"]]
        entry = json.loads(calls[1][-1])
        assert entry["type"] == "stdio"
        assert not (home / ".claude.json").exists()

    def test_a_cli_that_refuses_leaves_the_file_to_us(self, home, root, cli):
        cli(lambda argv: subprocess.CompletedProcess(argv, 1, "", "not signed in"))

        result = connect(root, "claude-code", apply=True)

        assert result.action == "written"
        data = json.loads((home / ".claude.json").read_text(encoding="utf-8"))
        assert SERVER_NAME in data["mcpServers"]

    @pytest.mark.parametrize(
        "raised",
        [subprocess.TimeoutExpired(["claude"], 30), PermissionError("not executable")],
    )
    def test_a_cli_that_hangs_or_cannot_start(self, home, root, cli, raised):
        def fail(_argv):
            raise raised

        cli(fail)

        result = connect(root, "claude-code", apply=True)

        assert result.action == "written"
        assert (home / ".claude.json").is_file()


def test_named_agents_only_and_a_preview_writes_nothing(home, root):
    [only] = connect_all(root, names=["codex"])

    assert only.to_dict()["agent"] == "codex"
    assert only.to_dict()["action"] == "preview"
    assert not (home / ".codex").exists()
