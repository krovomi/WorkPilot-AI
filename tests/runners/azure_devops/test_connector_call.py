"""The Azure DevOps connector runner the desktop app calls.

Every value reaches it as an argument: a project folder whose name reads like
code stays a folder name. The connector is a double; git and the project
detection are real.
"""

from __future__ import annotations

import json
import os
import runpy
import subprocess
import sys
import types
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from msrest.exceptions import ClientException
from runners.azure_devops import connector_call

RUNNER = Path(connector_call.__file__)


class FakeAzureDevOpsError(Exception):
    pass


def _item(item_id: int, created: Any) -> SimpleNamespace:
    return SimpleNamespace(
        id=item_id,
        title=f"Item {item_id}",
        description="<p>d</p>",
        state="New",
        work_item_type="Bug",
        assigned_to=None,
        tags=["a"],
        priority=2,
        created_date=created,
        area_path="P",
        iteration_path="P\\1",
        url=f"https://dev.azure.com/o/P/_workitems/edit/{item_id}",
        acceptance_criteria=None,
    )


class FakeConnector:
    """Records what it was asked; `behaviour` says how it answers."""

    calls: list[tuple[str, Any]] = []
    behaviour: dict[str, Any] = {}

    def __init__(self, settings: Any) -> None:
        self.settings = settings
        FakeConnector.calls.append(("init", settings))
        project_error = FakeConnector.behaviour.get("project_error")

        def get_project(name: str) -> None:
            FakeConnector.calls.append(("get_project", name))
            if project_error:
                raise ClientException(project_error)

        core = SimpleNamespace(get_project=get_project)
        self._client = SimpleNamespace(
            _connection=SimpleNamespace(
                clients=SimpleNamespace(get_core_client=lambda: core)
            )
        )

    def connect(self) -> None:
        if FakeConnector.behaviour.get("connect_error"):
            raise FakeAzureDevOpsError("authentication failed")

    def get_connection_info(self) -> dict[str, str]:
        return {"organization": "o", "project": self.settings.project or ""}

    def list_backlog_items(self, project: Any, item_types: Any, max_items: int) -> list:
        FakeConnector.calls.append(("list", (project, item_types, max_items)))
        return [_item(1, datetime(2026, 11, 16, 8, 30)), _item(2, "2026-11-15")]

    def get_item(self, project: Any, item_id: int) -> SimpleNamespace:
        FakeConnector.calls.append(("get", (project, item_id)))
        return _item(item_id, "2026-11-16")

    def list_repositories(self, project: str) -> list:
        return [
            SimpleNamespace(
                id="r-1",
                name="Repo",
                project=project,
                default_branch="main",
                web_url="u",
            )
        ]


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """A project folder, the connector double in place of the shared package, credentials set."""
    package = types.ModuleType("src.connectors.azure_devops")
    package.AzureDevOpsConnector = FakeConnector  # type: ignore[attr-defined]
    exceptions = types.ModuleType("src.connectors.azure_devops.exceptions")
    exceptions.AzureDevOpsError = FakeAzureDevOpsError  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "src.connectors.azure_devops", package)
    monkeypatch.setitem(
        sys.modules, "src.connectors.azure_devops.exceptions", exceptions
    )
    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.setenv("AZURE_DEVOPS_PAT", "pat-test-0000")  # pragma: allowlist secret
    monkeypatch.setenv("AZURE_DEVOPS_ORG_URL", "https://dev.azure.com/o")
    monkeypatch.setenv("AZURE_DEVOPS_PROJECT", "Configured")
    FakeConnector.calls = []
    FakeConnector.behaviour = {}
    project = tmp_path / "project"
    project.mkdir()
    return project


def run(
    project: Path, operation: str, params: Any = None, capsys: Any = None
) -> tuple[int, dict]:
    code = connector_call.main(
        [
            "/nowhere",
            str(project),
            operation,
            json.dumps(params if params is not None else {}),
        ]
    )
    out = capsys.readouterr().out.strip().splitlines()[-1]
    return code, json.loads(out)


def git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def test_lists_work_items_of_the_configured_project(world: Path, capsys) -> None:
    code, answer = run(
        world, "list_work_items", {"item_types": ["Bug"], "max_items": 5}, capsys
    )
    assert code == 0
    assert [item["id"] for item in answer["data"]] == [1, 2]
    assert answer["data"][0]["createdDate"] == "2026-11-16T08:30:00"
    assert answer["data"][1]["createdDate"] == "2026-11-15"
    assert ("list", ("Configured", ["Bug"], 5)) in FakeConnector.calls
    settings = FakeConnector.calls[0][1]
    assert isinstance(settings, connector_call.FallbackSettings) or hasattr(
        settings, "pat"
    )
    assert settings.project == "Configured"


def test_takes_the_project_of_the_git_remote_first(world: Path, capsys) -> None:
    git(world, "init", "-q")
    git(
        world,
        "remote",
        "add",
        "origin",
        "https://dev.azure.com/o/From%20Remote/_git/Shop",
    )
    code, answer = run(world, "list_work_items", {}, capsys)
    assert code == 0
    assert ("list", ("From Remote", None, 100)) in FakeConnector.calls


def test_gets_one_work_item(world: Path, capsys) -> None:
    code, answer = run(world, "get_work_item", {"work_item_id": "42"}, capsys)
    assert (code, answer["data"]["id"]) == (0, 42)
    assert ("get", ("Configured", 42)) in FakeConnector.calls


def test_lists_repositories_only_for_a_project(
    world: Path, capsys, monkeypatch: pytest.MonkeyPatch
) -> None:
    code, answer = run(world, "list_repositories", {}, capsys)
    assert (code, answer["data"][0]["name"], answer["data"][0]["project"]) == (
        0,
        "Repo",
        "Configured",
    )
    monkeypatch.delenv("AZURE_DEVOPS_PROJECT")
    code, answer = run(world, "list_repositories", {}, capsys)
    assert (code, answer) == (
        1,
        {"error": "Project name is required to list repositories"},
    )


def test_detects_the_repository_of_the_remote(world: Path, capsys) -> None:
    git(world, "init", "-q")
    git(world, "remote", "add", "origin", "https://dev.azure.com/o/P/_git/My%20Repo")
    assert run(world, "detect_repository", {}, capsys) == (
        0,
        {"data": {"repository": "My Repo"}},
    )


@pytest.mark.parametrize(
    ("project_error", "expected"),
    [
        (None, {"data": {"organization": "o", "project": "Configured"}}),
        (
            "TF200016: The following project does not exist",
            {"error": "Project not found: 'Configured'."},
        ),
        (
            "403 forbidden",
            {"error": "Cannot access project 'Configured': 403 forbidden"},
        ),
    ],
)
def test_checks_the_connection_and_the_project(
    world: Path, capsys, project_error: str | None, expected: dict
) -> None:
    FakeConnector.behaviour = {"project_error": project_error}
    code, answer = run(world, "test_connection", {}, capsys)
    assert code == (1 if project_error else 0)
    if "error" in expected:
        assert answer["error"].startswith(expected["error"])
    else:
        assert answer == expected
    assert ("get_project", "Configured") in FakeConnector.calls


def test_checks_the_connection_without_a_project(
    world: Path, capsys, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("AZURE_DEVOPS_PROJECT")
    code, _ = run(world, "test_connection", {}, capsys)
    assert code == 0
    assert not any(call[0] == "get_project" for call in FakeConnector.calls)


def test_says_what_the_connector_said(world: Path, capsys) -> None:
    FakeConnector.behaviour = {"connect_error": True}
    assert run(world, "list_work_items", {}, capsys) == (
        1,
        {"error": "authentication failed"},
    )


def test_refuses_without_credentials(
    world: Path, capsys, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("AZURE_DEVOPS_PAT")
    assert run(world, "get_work_item", {"work_item_id": 1}, capsys) == (
        1,
        {"error": "Azure DevOps not configured"},
    )


@pytest.mark.parametrize(
    ("operation", "params_json", "error"),
    [
        ("drop_everything", "{}", "Unknown operation: drop_everything"),
        ("list_work_items", "[1]", "params must be a JSON object"),
        ("list_work_items", "{", "Expecting property name"),
        ("get_work_item", '{"work_item_id": "x"}', "invalid literal"),
    ],
)
def test_refuses_what_it_cannot_run(
    world: Path, capsys, operation: str, params_json: str, error: str
) -> None:
    code = connector_call.main(["/nowhere", str(world), operation, params_json])
    answer = json.loads(capsys.readouterr().out.strip())
    assert code == 1
    assert error in answer["error"]


def test_refuses_a_wrong_number_of_arguments(capsys) -> None:
    assert connector_call.main(["only-one"]) == 1
    assert "usage" in json.loads(capsys.readouterr().out)["error"]


def test_a_folder_name_that_reads_like_code_stays_a_name(tmp_path: Path) -> None:
    """End to end, as the app runs it: its own process, the shared package from argv."""
    root = tmp_path / "connectors"
    package = root / "src" / "connectors" / "azure_devops"
    package.mkdir(parents=True)
    for folder in (root / "src", root / "src" / "connectors"):
        (folder / "__init__.py").write_text("", encoding="utf-8")
    (package / "exceptions.py").write_text(
        "class AzureDevOpsError(Exception):\n    pass\n", encoding="utf-8"
    )
    (package / "__init__.py").write_text(
        "import os\n"
        "class AzureDevOpsConnector:\n"
        "    def __init__(self, settings):\n"
        "        self.settings = settings\n"
        "    def connect(self):\n"
        "        pass\n"
        "    def get_connection_info(self):\n"
        "        return {'cwd': os.getcwd(), 'project': self.settings.project}\n",
        encoding="utf-8",
    )
    project = tmp_path / "o'neil'); import os; os.mkdir('pwned'); ('"
    project.mkdir()
    result = subprocess.run(
        [sys.executable, str(RUNNER), str(root), str(project), "test_connection", "{}"],
        cwd=project,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={
            # Neither the caller's Azure settings nor a coverage hook that would load the real package first.
            **{
                k: v
                for k, v in os.environ.items()
                if not k.startswith(("AZURE_DEVOPS_", "COV_CORE", "COVERAGE_"))
            },
            "AZURE_DEVOPS_PAT": "pat-test-0000",  # pragma: allowlist secret
            "AZURE_DEVOPS_ORG_URL": "https://dev.azure.com/o",
        },
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    data = json.loads(result.stdout)["data"]
    assert Path(data["cwd"]).resolve() == project.resolve()
    assert data["project"] is None
    assert not (project / "pwned").exists()
    assert not (tmp_path / "pwned").exists()


def test_uses_its_own_settings_when_the_package_has_none(
    world: Path, capsys, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(sys.modules, "src.config.settings", None)
    code, _ = run(world, "get_work_item", {"work_item_id": 3}, capsys)
    assert code == 0
    settings = FakeConnector.calls[0][1]
    assert isinstance(settings, connector_call.FallbackSettings)
    assert (settings.organization_url, settings.project) == (
        "https://dev.azure.com/o",
        "Configured",
    )


def test_runs_as_a_script(world: Path, capsys, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        [str(RUNNER), "/nowhere", str(world), "get_work_item", '{"work_item_id": 9}'],
    )
    with pytest.raises(SystemExit) as exited:
        runpy.run_path(str(RUNNER), run_name="__main__")
    assert exited.value.code == 0
    assert json.loads(capsys.readouterr().out)["data"]["id"] == 9
