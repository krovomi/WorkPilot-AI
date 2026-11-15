"""Azure Repos pull requests, the unified connector and the client's edges.

The pull request calls are what the Azure DevOps PR review runner
(``runners/azure_devops/azdo_client.py``) reads; the change entries are
deserialized by the real SDK (msrest), as the API answers them, so the file
paths a review sees are the ones Azure DevOps sent.
"""

from __future__ import annotations

import importlib
import sys
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

import azure.devops.v7_0.git.models as git_models
import pytest
from msrest import Deserializer

import src.connectors.azure_devops.client as client_module
from src.config.settings import Settings
from src.connectors.azure_devops import AzureDevOpsConnector
from src.connectors.azure_devops.exceptions import (
    APIError,
    AuthenticationError,
    ConfigurationError,
    RateLimitError,
    RepositoryNotFoundError,
    WorkItemNotFoundError,
)
from src.connectors.azure_devops.models import (
    PullRequest,
    PullRequestFileChange,
    WorkItem,
)

PROJECT = "TestProject"
REPO = "repo-1"

_deserialize = Deserializer(
    {k: v for k, v in vars(git_models).items() if isinstance(v, type)}
)


def _iteration_changes(
    entries: list[dict],
) -> git_models.GitPullRequestIterationChanges:
    """What the SDK returns for ``get_pull_request_iteration_changes``."""
    return _deserialize("GitPullRequestIterationChanges", {"changeEntries": entries})


def _api_pr(**overrides) -> SimpleNamespace:
    fields = {
        "pull_request_id": 42,
        "title": "Add login",
        "description": "Adds the login page",
        "status": "active",
        "source_ref_name": "refs/heads/feature/login",
        "target_ref_name": "refs/heads/main",
        "created_by": SimpleNamespace(display_name="Ada"),
        "creation_date": datetime(2026, 11, 1, 10, 0, 0),
        "is_draft": False,
        "merge_status": "succeeded",
        "url": "https://dev.azure.com/org/_apis/git/pullrequests/42",
        "repository": SimpleNamespace(id=REPO),
    }
    fields.update(overrides)
    return SimpleNamespace(**fields)


# ── create_pull_request ──────────────────────────────────────────────


class TestCreatePullRequest:
    def test_short_branch_names_get_refs_heads_and_links(
        self, repos_client, mock_git_client
    ):
        mock_git_client.create_pull_request.return_value = _api_pr(is_draft=True)

        pr = repos_client.create_pull_request(
            PROJECT,
            REPO,
            "feature/login",
            "main",
            "Add login",
            description="Adds the login page",
            reviewers=["ada@example.com"],
            work_item_ids=[7, 8],
            is_draft=True,
        )

        sent = mock_git_client.create_pull_request.call_args.kwargs
        body = sent["git_pull_request_to_create"]
        assert body.source_ref_name == "refs/heads/feature/login"
        assert body.target_ref_name == "refs/heads/main"
        assert [r.unique_name for r in body.reviewers] == ["ada@example.com"]
        assert [w.id for w in body.work_item_refs] == ["7", "8"]
        assert body.is_draft is True
        assert sent["repository_id"] == REPO
        assert sent["project"] == PROJECT
        assert pr == PullRequest(
            pull_request_id=42,
            title="Add login",
            description="Adds the login page",
            status="active",
            source_branch="refs/heads/feature/login",
            target_branch="refs/heads/main",
            created_by="Ada",
            creation_date=datetime(2026, 11, 1, 10, 0, 0),
            is_draft=True,
            merge_status="succeeded",
            url="https://dev.azure.com/org/_apis/git/pullrequests/42",
            repository_id=REPO,
        )

    def test_full_refs_are_kept_and_optional_parts_left_out(
        self, repos_client, mock_git_client
    ):
        mock_git_client.create_pull_request.return_value = _api_pr(
            created_by=None, repository=None
        )

        pr = repos_client.create_pull_request(
            PROJECT, REPO, "refs/heads/dev", "refs/heads/main", "T"
        )

        body = mock_git_client.create_pull_request.call_args.kwargs[
            "git_pull_request_to_create"
        ]
        assert body.source_ref_name == "refs/heads/dev"
        assert body.target_ref_name == "refs/heads/main"
        assert body.reviewers is None
        assert body.work_item_refs is None
        assert body.description == ""
        assert pr.created_by is None
        assert pr.repository_id is None

    def test_missing_repository_is_named(self, repos_client, mock_git_client):
        mock_git_client.create_pull_request.side_effect = RuntimeError(
            "TF401019: 404 Not Found"
        )

        with pytest.raises(RepositoryNotFoundError) as caught:
            repos_client.create_pull_request(PROJECT, REPO, "a", "b", "T")
        assert caught.value.repository_id == REPO
        assert caught.value.project == PROJECT

    def test_other_failures_become_api_errors(self, repos_client, mock_git_client):
        mock_git_client.create_pull_request.side_effect = RuntimeError("boom")

        with pytest.raises(APIError, match="Failed to create pull request.*boom"):
            repos_client.create_pull_request(PROJECT, REPO, "a", "b", "T")

    def test_connector_errors_pass_through(self, repos_client, mock_git_client):
        mock_git_client.create_pull_request.side_effect = RateLimitError(
            "slow down", retry_after=2
        )

        with pytest.raises(RateLimitError):
            repos_client.create_pull_request(PROJECT, REPO, "a", "b", "T")


# ── get_pull_request / files / details ───────────────────────────────


class TestGetPullRequest:
    def test_reads_the_pr_with_commits_and_work_items(
        self, repos_client, mock_git_client
    ):
        mock_git_client.get_pull_request.return_value = _api_pr()

        pr = repos_client.get_pull_request(PROJECT, REPO, 42)

        assert pr.title == "Add login"
        mock_git_client.get_pull_request.assert_called_once_with(
            repository_id=REPO,
            project=PROJECT,
            pull_request_id=42,
            include_commits=True,
            include_work_item_refs=True,
        )

    @pytest.mark.parametrize(
        ("error", "expected"),
        [
            (RuntimeError("not found"), RepositoryNotFoundError),
            (RuntimeError("timeout"), APIError),
            (AuthenticationError("expired"), AuthenticationError),
        ],
    )
    def test_errors(self, repos_client, mock_git_client, error, expected):
        mock_git_client.get_pull_request.side_effect = error

        with pytest.raises(expected):
            repos_client.get_pull_request(PROJECT, REPO, 42)


class TestGetPullRequestFiles:
    def test_paths_come_from_the_latest_iteration(self, repos_client, mock_git_client):
        mock_git_client.get_pull_request_iterations.return_value = [
            SimpleNamespace(id=1),
            SimpleNamespace(id=3),
        ]
        mock_git_client.get_pull_request_iteration_changes.return_value = (
            _iteration_changes(
                [
                    {
                        "changeTrackingId": 1,
                        "changeType": "edit",
                        "item": {"path": "/src/app.py"},
                    },
                    {
                        "changeTrackingId": 2,
                        "changeType": "rename",
                        "item": {"path": "/src/new.py"},
                        "originalPath": "/src/old.py",
                    },
                ]
            )
        )

        files = repos_client.get_pull_request_files(PROJECT, REPO, 42)

        assert files == [
            PullRequestFileChange(path="/src/app.py", change_type="edit"),
            PullRequestFileChange(
                path="/src/new.py", change_type="rename", old_path="/src/old.py"
            ),
        ]
        assert (
            mock_git_client.get_pull_request_iteration_changes.call_args.kwargs[
                "iteration_id"
            ]
            == 3
        )

    def test_no_iteration_means_no_files(self, repos_client, mock_git_client):
        mock_git_client.get_pull_request_iterations.return_value = []

        assert repos_client.get_pull_request_files(PROJECT, REPO, 42) == []
        mock_git_client.get_pull_request_iteration_changes.assert_not_called()

    @pytest.mark.parametrize(
        ("error", "expected"),
        [
            (RuntimeError("HTTP 404"), RepositoryNotFoundError),
            (RuntimeError("socket closed"), APIError),
            (ConfigurationError("not connected"), ConfigurationError),
        ],
    )
    def test_errors(self, repos_client, mock_git_client, error, expected):
        mock_git_client.get_pull_request_iterations.side_effect = error

        with pytest.raises(expected):
            repos_client.get_pull_request_files(PROJECT, REPO, 42)


class TestGetPullRequestDetails:
    def test_combines_the_pr_and_its_files(self, repos_client, mock_git_client):
        mock_git_client.get_pull_request.return_value = _api_pr()
        mock_git_client.get_pull_request_iterations.return_value = [
            SimpleNamespace(id=1)
        ]
        mock_git_client.get_pull_request_iteration_changes.return_value = (
            _iteration_changes(
                [
                    {
                        "changeTrackingId": 1,
                        "changeType": "add",
                        "item": {"path": "/README.md"},
                    }
                ]
            )
        )

        details = repos_client.get_pull_request_details(PROJECT, REPO, 42)

        assert details == {
            "id": 42,
            "title": "Add login",
            "description": "Adds the login page",
            "status": "active",
            "sourceRefName": "refs/heads/feature/login",
            "targetRefName": "refs/heads/main",
            "createdBy": {"displayName": "Ada"},
            "creationDate": "2026-11-01T10:00:00",
            "isDraft": False,
            "mergeStatus": "succeeded",
            "url": "https://dev.azure.com/org/_apis/git/pullrequests/42",
            "repositoryId": REPO,
            "additions": 0,
            "deletions": 0,
            "changed_files": 1,
            "files": [
                {
                    "path": "/README.md",
                    "changeType": "add",
                    "additions": 0,
                    "deletions": 0,
                    "changes": 0,
                    "oldPath": None,
                }
            ],
        }

    def test_without_author_or_date(self, repos_client, mock_git_client):
        mock_git_client.get_pull_request.return_value = _api_pr(
            created_by=None, creation_date=None
        )
        mock_git_client.get_pull_request_iterations.return_value = []

        details = repos_client.get_pull_request_details(PROJECT, REPO, 42)

        assert details["createdBy"] is None
        assert details["creationDate"] is None
        assert details["files"] == []


class TestPullRequestFileChangeModel:
    def test_attributes_win_over_additional_properties(self):
        change = SimpleNamespace(
            item={"path": "/a.py"},
            change_type="edit",
            additions=3,
            deletions=1,
            source={"path": "/old.py"},
        )

        assert PullRequestFileChange.from_api_response(change) == (
            PullRequestFileChange(
                path="/a.py",
                change_type="edit",
                additions=3,
                deletions=1,
                changes=4,
                old_path="/old.py",
            )
        )

    def test_an_empty_change_gives_empty_fields(self):
        assert PullRequestFileChange.from_api_response(
            SimpleNamespace()
        ) == PullRequestFileChange(path="", change_type="")


# ── AzureDevOpsConnector: the facade the app imports ─────────────────


@pytest.fixture
def connector(sample_settings, mock_connection) -> AzureDevOpsConnector:
    built = AzureDevOpsConnector(sample_settings)
    built._client._connection = mock_connection
    return built


class TestConnector:
    def test_from_settings_connects(self, sample_settings, monkeypatch):
        connections = []
        monkeypatch.setattr(
            client_module,
            "Connection",
            lambda base_url, creds: connections.append(base_url) or MagicMock(),
        )

        built = AzureDevOpsConnector.from_settings(sample_settings)

        assert built.is_connected
        assert connections == [sample_settings.organization_url]

    def test_from_env_reads_the_variables(self, monkeypatch):
        monkeypatch.setenv("AZURE_DEVOPS_PAT", "pat-123")
        monkeypatch.setenv("AZURE_DEVOPS_ORG_URL", "https://dev.azure.com/org/")
        monkeypatch.delenv("AZURE_DEVOPS_PROJECT", raising=False)
        monkeypatch.setattr(client_module, "Connection", lambda **_: MagicMock())

        built = AzureDevOpsConnector.from_env()

        assert built.get_connection_info()["organization_url"] == (
            "https://dev.azure.com/org"
        )

    def test_from_env_without_variables_is_a_configuration_error(
        self, monkeypatch, tmp_path
    ):
        monkeypatch.chdir(tmp_path)
        monkeypatch.delenv("AZURE_DEVOPS_PAT", raising=False)
        monkeypatch.delenv("AZURE_DEVOPS_ORG_URL", raising=False)

        with pytest.raises(ConfigurationError, match="AZURE_DEVOPS_PAT"):
            AzureDevOpsConnector.from_env()

    def test_repository_calls_reach_the_git_client(self, connector, mock_git_client):
        mock_git_client.get_repositories.return_value = []
        mock_git_client.get_items.return_value = []
        mock_git_client.get_item.return_value = SimpleNamespace(content="print(1)")
        mock_git_client.get_repository.return_value = SimpleNamespace(
            id=REPO,
            name="repo",
            project=SimpleNamespace(name=PROJECT),
            default_branch="refs/heads/main",
            url="u",
            web_url="w",
            size=1,
        )
        mock_git_client.create_pull_request.return_value = _api_pr()

        assert connector.list_repositories(PROJECT) == []
        assert connector.get_repository(PROJECT, REPO).name == "repo"
        assert connector.list_files(PROJECT, REPO, "/", "main") == []
        assert connector.get_file_content(PROJECT, REPO, "/a.py") == "print(1)"
        pr = connector.create_pull_request(
            PROJECT, REPO, "dev", "main", "T", is_draft=False
        )
        assert pr.pull_request_id == 42
        assert connector.get_repos_client() is connector._repos

    def test_work_item_calls_reach_the_wit_client(
        self, connector, mock_wit_client, sample_api_work_item
    ):
        mock_wit_client.get_work_item.return_value = sample_api_work_item
        mock_wit_client.create_work_item.return_value = sample_api_work_item
        mock_wit_client.update_work_item.return_value = sample_api_work_item
        mock_wit_client.query_by_wiql.return_value = SimpleNamespace(work_items=[])

        assert connector.query(PROJECT, "SELECT [System.Id] FROM WorkItems") == []
        assert connector.list_backlog_items(PROJECT) == []
        assert isinstance(connector.get_item(PROJECT, 1), WorkItem)
        assert isinstance(connector.create_work_item(PROJECT, "Bug", "T"), WorkItem)
        assert isinstance(
            connector.update_work_item(PROJECT, 1, {"System.Title": "New"}), WorkItem
        )
        assert isinstance(connector.link_work_items(PROJECT, 1, 2), WorkItem)
        assert connector.get_work_items_client() is connector._work_items

    def test_disconnect(self, connector):
        assert connector.is_connected
        connector.disconnect()
        assert not connector.is_connected


# ── AzureDevOpsClient without the SDK ────────────────────────────────


class TestClientWithoutSdk:
    def test_connect_says_how_to_install_the_sdk(self, sample_settings, monkeypatch):
        monkeypatch.setattr(client_module, "AZURE_DEVOPS_AVAILABLE", False)

        with pytest.raises(ConfigurationError, match="pip install azure-devops"):
            client_module.AzureDevOpsClient(sample_settings).connect()

    def test_module_imports_when_the_sdk_is_missing(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "azure.devops.connection", None)
        fresh_name = "azure_client_without_sdk"
        spec = importlib.util.spec_from_file_location(
            fresh_name, client_module.__file__
        )
        fresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fresh)

        assert fresh.AZURE_DEVOPS_AVAILABLE is False
        assert fresh.Connection is None


# ── Exceptions and models: the messages users read ───────────────────


class TestMessages:
    def test_repository_not_found_without_project(self):
        assert str(RepositoryNotFoundError("r")) == "Repository 'r' not found."

    def test_work_item_not_found_without_project(self):
        assert str(WorkItemNotFoundError(5)) == "Work item 5 not found."

    def test_rate_limit_without_delay(self):
        assert str(RateLimitError("Too many requests.")) == "Too many requests."

    def test_unreadable_priority_is_dropped(self):
        item = SimpleNamespace(
            id=1,
            fields={
                "System.Title": "T",
                "System.WorkItemType": "Bug",
                "System.State": "New",
                "Microsoft.VSTS.Common.Priority": "high",
            },
            url=None,
        )

        assert WorkItem.from_api_response(item).priority is None


class TestSettings:
    def test_from_env_file(self, tmp_path, monkeypatch):
        monkeypatch.delenv("AZURE_DEVOPS_PAT", raising=False)
        monkeypatch.delenv("AZURE_DEVOPS_ORG_URL", raising=False)
        monkeypatch.delenv("AZURE_DEVOPS_PROJECT", raising=False)
        env_file = tmp_path / "azure.env"
        env_file.write_text(
            "AZURE_DEVOPS_PAT=p\n"
            "AZURE_DEVOPS_ORG_URL=https://dev.azure.com/org/\n"
            "AZURE_DEVOPS_PROJECT=Proj\n",
            encoding="utf-8",
        )

        settings = Settings.from_env(str(env_file))

        assert settings == Settings(
            pat="p", organization_url="https://dev.azure.com/org", project="Proj"
        )

    def test_from_env_names_every_missing_variable(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        monkeypatch.delenv("AZURE_DEVOPS_PAT", raising=False)
        monkeypatch.delenv("AZURE_DEVOPS_ORG_URL", raising=False)

        with pytest.raises(ValueError) as caught:
            Settings.from_env()
        assert "AZURE_DEVOPS_PAT, AZURE_DEVOPS_ORG_URL" in str(caught.value)

    def test_from_env_without_project(self, monkeypatch, tmp_path):
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("AZURE_DEVOPS_PAT", "p")
        monkeypatch.setenv("AZURE_DEVOPS_ORG_URL", "https://dev.azure.com/org")
        monkeypatch.setenv("AZURE_DEVOPS_PROJECT", "")

        assert Settings.from_env().project is None

    @pytest.mark.parametrize(
        ("pat", "url", "message"),
        [
            ("  ", "https://dev.azure.com/o", "cannot be empty"),
            ("p", "http://dev.azure.com/o", "must start with 'https://'"),
        ],
    )
    def test_validate_refuses(self, pat, url, message):
        with pytest.raises(ValueError, match=message):
            Settings(pat=pat, organization_url=url).validate()

    def test_validate_accepts(self):
        Settings(pat="p", organization_url="https://dev.azure.com/o").validate()


class TestWiqlOnARepositoryName:
    def test_a_missing_project_hints_at_project_versus_repository(
        self, work_items_client, mock_wit_client
    ):
        mock_wit_client.query_by_wiql.side_effect = RuntimeError(
            "TF200016: The following project does not exist: my-repo"
        )

        with pytest.raises(APIError, match="PROJECT name, not the repository name"):
            work_items_client.query_work_items("my-repo", "SELECT [System.Id]")
