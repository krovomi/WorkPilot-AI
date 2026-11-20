"""The brain's small helpers on the inputs nothing else hands them: Windows
folders, a config key removed, a kind or an agent that does not exist, a task
reference that is not one, and a note that breaks the prompt section."""

from __future__ import annotations

from pathlib import Path

import pytest
from brain import Brain, agents, home, memories, runtime, tasks


class TestHome:
    @pytest.mark.parametrize(
        ("appdata", "expected"),
        [
            ("D:/Profiles/me/Roaming", Path("D:/Profiles/me/Roaming") / "WorkPilot"),
            ("", None),
        ],
    )
    def test_on_windows_the_brain_lives_in_appdata(
        self, monkeypatch, tmp_path, appdata, expected
    ):
        monkeypatch.setattr(home.sys, "platform", "win32")
        monkeypatch.setenv("APPDATA", appdata)
        monkeypatch.setattr(Path, "home", lambda: tmp_path)

        base = home._user_base()

        assert base == (expected or tmp_path / "AppData" / "Roaming" / "WorkPilot")

    def test_a_key_set_to_none_is_removed(self, tmp_path, monkeypatch):
        monkeypatch.setenv(home.CONFIG_ENV, str(tmp_path / "brain.json"))
        home.write_config(path="/vault", enabled=False)

        assert home.write_config(path=None) == {"enabled": False}
        assert home.read_config() == {"enabled": False}

    def test_a_kind_that_does_not_exist(self, tmp_path):
        with pytest.raises(ValueError, match="unknown note kind 'diary'"):
            home.kind_dir(tmp_path, "diary")

    def test_a_folder_that_cannot_be_looked_into_is_no_brain(
        self, tmp_path, monkeypatch
    ):
        def denied(self):
            raise PermissionError("denied")

        monkeypatch.setattr(Path, "is_file", denied)

        assert home.is_brain(tmp_path) is False


class TestAgents:
    @pytest.mark.parametrize("local", ["C:/Users/me/AppData/Local", ""])
    def test_hermes_on_windows(self, monkeypatch, tmp_path, local):
        monkeypatch.delenv("HERMES_HOME", raising=False)
        monkeypatch.setenv("WORKPILOT_BRAIN_HOME", str(tmp_path))
        monkeypatch.setattr(agents.sys, "platform", "win32")
        monkeypatch.setenv("LOCALAPPDATA", local)

        found = agents._hermes_home()

        base = Path(local) if local else tmp_path / "AppData" / "Local"
        assert found == base / "hermes"

    def test_an_agent_the_brain_does_not_know(self):
        with pytest.raises(KeyError, match="unknown agent 'emacs'"):
            agents.agent("emacs")


class TestTasks:
    def test_a_workpilot_folder_at_the_top_names_nothing_before_it(self):
        assert tasks.project_name_from(".workpilot/specs/001-x") == "001-x"
        assert tasks.project_name_from("/srv/shop/.worktrees/001-x") == "shop"

    @pytest.mark.parametrize("ref", ["", "shop", "/001", "shop/"])
    def test_what_is_not_a_task_reference(self, ref):
        with pytest.raises(ValueError, match="not a task reference"):
            tasks.split_task(ref)


class TestRuntime:
    @pytest.fixture
    def brain(self, tmp_path, monkeypatch):
        monkeypatch.delenv("BRAIN_ENABLED", raising=False)
        monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")
        root = tmp_path / "vault"
        monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(root))
        made = Brain(root)
        made.init()
        return made

    def test_the_server_of_a_task_says_which_task(self, brain):
        config = runtime.mcp_server_config(brain.root, task="shop/001")
        assert config["env"]["WORKPILOT_BRAIN_TASK"] == "shop/001"

    def test_a_note_that_breaks_the_instructions_leaves_the_section(
        self, brain, monkeypatch
    ):
        def broken(_root):
            raise RuntimeError("a note no parser reads")

        monkeypatch.setattr(memories, "instructions", broken)

        section = runtime.awareness_section(brain.root)

        assert "## Shared brain (WorkPilot Brain)" in section

    def test_a_tool_that_answers_in_text(self, brain):
        listed = runtime._call("brain_skill", {"name": "graph-first-recall"})
        assert listed.startswith("---")
