"""`test_placement.settings`: the card over the project, closed lists only."""

from __future__ import annotations

from pathlib import Path

from test_placement.settings import load_settings


def _project(tmp_path: Path, text: str) -> Path:
    (tmp_path / ".workpilot").mkdir()
    (tmp_path / ".workpilot" / ".env").write_text(text, encoding="utf-8")
    return tmp_path


def test_default_is_auto_with_no_route_and_no_push(tmp_path):
    settings = load_settings(tmp_path, env={})
    assert settings.mode == "auto"
    assert settings.decided_by == "default"
    assert settings.routes == frozenset()
    assert settings.allow_branch_push is False


def test_the_project_file_gives_the_default(tmp_path):
    project = _project(
        tmp_path, "# c\nTEST_PLACEMENT='ci'\nTEST_PLACEMENT_ALLOW_BRANCH_PUSH=true\n"
    )
    settings = load_settings(project, env={})
    assert (settings.mode, settings.decided_by) == ("ci", "project")
    assert settings.allow_branch_push is True


def test_the_card_wins_over_the_project(tmp_path):
    project = _project(tmp_path, "TEST_PLACEMENT=ci\n")
    settings = load_settings(project, env={"WORKPILOT_TEST_PLACEMENT": "machine"})
    assert (settings.mode, settings.decided_by) == ("machine", "task")


def test_a_value_outside_the_list_is_the_default(tmp_path):
    settings = load_settings(
        tmp_path, env={"WORKPILOT_TEST_PLACEMENT": "cloud; rm -rf /"}
    )
    assert (settings.mode, settings.decided_by) == ("auto", "default")


def test_routes_come_from_the_environment_only(tmp_path):
    project = _project(tmp_path, "WORKPILOT_TEST_PLACEMENT_ROUTES=ci,server\n")
    assert load_settings(project, env={}).routes == frozenset()
    env = {"WORKPILOT_TEST_PLACEMENT_ROUTES": " CI , server, anywhere"}
    assert load_settings(tmp_path, env=env).routes == frozenset({"ci", "server"})
