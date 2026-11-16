"""Stand-ins for what an Azure DevOps PR review talks to: the Azure Repos API and the model.

`azure` replaces the SDK's `Connection` (the only door to the network) with one
whose Git client answers from a scripted repository: one pull request, its
latest iteration's changes and the files on each branch. Everything between
the runner and that client — `AzDOClient`, the shared connector's
`AzureReposClient`, its models — is the real code.

`model` replaces `core.client.create_agent_client` with a client that streams a
scripted answer, the way a provider streams `AgentMessage`s, and keeps the
prompt it was given.
"""

from __future__ import annotations

import importlib
from types import SimpleNamespace

import pytest
from core.agent_client import AgentMessage, ContentBlock, ContentBlockType, MessageRole

ORG_URL = "https://dev.azure.com/contoso"
PROJECT = "Shop"
REPO = "shop-web"
PAT = "placeholder-pat"  # pragma: allowlist secret


def change(path: str, change_type: str = "edit", **stats: int) -> SimpleNamespace:
    """One entry of an iteration's changes, as the SDK hands it over."""
    return SimpleNamespace(item={"path": path}, change_type=change_type, **stats)


class FakeAzureRepos:
    """The Git API of one Azure Repos repository, scripted."""

    org_url = ORG_URL
    project = PROJECT
    repo = REPO
    pat = PAT

    def __init__(self) -> None:
        self.pr = SimpleNamespace(
            pull_request_id=7,
            title="Add checkout page",
            description="Adds the checkout page and its total.",
            status="active",
            source_ref_name="refs/heads/feature/checkout",
            target_ref_name="refs/heads/main",
            created_by=SimpleNamespace(display_name="Ada Lovelace"),
            creation_date=None,
            is_draft=False,
            merge_status="succeeded",
            url=None,
            repository=SimpleNamespace(id=REPO),
        )
        self.changes: list[SimpleNamespace] = []
        # (branch, "/path") -> file content on that branch
        self.files: dict[tuple[str, str], str] = {}
        self.threads: list[dict] = []
        self.fetched: list[tuple[str, str]] = []
        # method name -> exception that call raises
        self.failures: dict[str, Exception] = {}
        self.connections: list[dict] = []

    def change(self, path: str, change_type: str = "edit", **stats: int) -> None:
        """Add a file to the PR's latest iteration."""
        self.changes.append(change(path, change_type, **stats))

    def _maybe_fail(self, name: str) -> None:
        if name in self.failures:
            raise self.failures[name]

    def get_pull_request(self, repository_id, project, pull_request_id, **_):
        self._maybe_fail("get_pull_request")
        assert (repository_id, project) == (REPO, PROJECT)
        assert pull_request_id == self.pr.pull_request_id
        return self.pr

    def get_pull_request_iterations(self, repository_id, project, pull_request_id):
        self._maybe_fail("get_pull_request_iterations")
        return [SimpleNamespace(id=1), SimpleNamespace(id=2)]

    def get_pull_request_iteration_changes(
        self, repository_id, project, pull_request_id, iteration_id
    ):
        assert iteration_id == 2  # the latest iteration
        return SimpleNamespace(change_entries=list(self.changes))

    def get_item(
        self, repository_id, path, project, version_descriptor, include_content
    ):
        branch = version_descriptor.version
        self.fetched.append((branch, path))
        if (branch, path) not in self.files:
            raise RuntimeError("TF401174: 404 Not Found")
        return SimpleNamespace(content=self.files[(branch, path)])

    def create_thread(self, comment_thread, repository_id, pull_request_id, project):
        self._maybe_fail("create_thread")
        self.threads.append(
            {
                "pr": pull_request_id,
                "repo": repository_id,
                "project": project,
                "status": comment_thread.status,
                "comments": [c.content for c in comment_thread.comments],
            }
        )


@pytest.fixture
def azure(monkeypatch) -> FakeAzureRepos:
    repos = FakeAzureRepos()
    client_module = importlib.import_module("src.connectors.azure_devops.client")

    class Connection:
        def __init__(self, base_url, creds):
            repos.connections.append({"base_url": base_url, "creds": creds})
            self.clients = SimpleNamespace(get_git_client=lambda: repos)

    monkeypatch.setattr(client_module, "Connection", Connection)
    return repos


def text(value: str) -> ContentBlock:
    return ContentBlock(type=ContentBlockType.TEXT, text=value)


class Model:
    """A reviewer model that streams one scripted answer and keeps the prompt."""

    def __init__(self, *blocks: ContentBlock, fail: Exception | None = None):
        self.blocks = list(blocks)
        self.fail = fail
        self.prompts: list[str] = []
        self.created_with: dict = {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt: str) -> None:
        self.prompts.append(prompt)

    async def receive_response(self):
        if self.fail:
            raise self.fail
        for block in self.blocks:
            yield AgentMessage(role=MessageRole.ASSISTANT, content=[block])


@pytest.fixture
def model(monkeypatch):
    """`model("answer", ...)` makes a stand-in streaming those blocks (a str is
    a text block) the client every review gets; `model(fail=exc)` one whose
    stream breaks."""
    client_module = importlib.import_module("core.client")

    def install(*answer: str | ContentBlock, fail: Exception | None = None) -> Model:
        blocks = (
            part if isinstance(part, ContentBlock) else text(part) for part in answer
        )
        stand_in = Model(*blocks, fail=fail)

        def create_agent_client(**kwargs):
            stand_in.created_with = kwargs
            return stand_in

        monkeypatch.setattr(client_module, "create_agent_client", create_agent_client)
        return stand_in

    return install


@pytest.fixture(autouse=True)
def _no_review_gate(monkeypatch):
    """The optional external review gate stays off unless a test turns it on."""
    for name in ("WORKPILOT_JEV_ENABLED", "TYPESAFE_API_KEY"):
        monkeypatch.delenv(name, raising=False)
