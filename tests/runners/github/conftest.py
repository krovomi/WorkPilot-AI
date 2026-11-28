"""conftest.py for the runners/github tests moved out of the backend.

The runner's modules import each other by bare name (`from gh_client import
...`), so the directory they live in has to be on sys.path — the role of
`apps/backend/runners/github/conftest.py` while these tests sat beside it.

Appended, not prepended: conftests load before collection, and this
directory holds a `services` package of its own that would otherwise shadow
the backend's `services` for every test in the session.
"""

import importlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.gh_fake import write_fake_gh

_GITHUB_RUNNER = (
    Path(__file__).resolve().parents[3] / "apps" / "backend" / "runners" / "github"
)
if str(_GITHUB_RUNNER) not in sys.path:
    sys.path.append(str(_GITHUB_RUNNER))


GH_VERSION = {"--version": {"stdout": "gh version 2.80.0\n"}}


@pytest.fixture
def gh(tmp_path, monkeypatch):
    """A fake `gh` the backend finds first (tests/gh_fake.py).

    It always passes the CLI check (`gh --version`), and `calls()` (with
    `repos()`, the GH_REPO of each call, and `stdins()`, what it read on
    stdin) leaves that check out, so a test sees only the commands the code
    under test sent.
    """
    fake = write_fake_gh(tmp_path / "gh", GH_VERSION)
    answer, calls, repos = fake.answer, fake.calls, fake.repos
    fake.answer = lambda answers: answer({**GH_VERSION, **answers})
    fake.calls = lambda: [c for c in calls() if c != ["--version"]]
    fake.repos = lambda: [
        r for c, r in zip(calls(), repos(), strict=True) if c != ["--version"]
    ]
    stdins = fake.stdins
    fake.stdins = lambda: [
        s for c, s in zip(calls(), stdins(), strict=True) if c != ["--version"]
    ]
    monkeypatch.setenv("GITHUB_CLI_PATH", str(fake.path))
    import core.gh_executable as gh_executable

    monkeypatch.setattr(gh_executable, "_cached_gh_path", None)
    return fake


@pytest.fixture
def orchestrator(gh, tmp_path, monkeypatch):
    """Build a real `GitHubOrchestrator` on `tmp_path/project`, GitHub faked by `gh`.

    `make(**config)` takes `GitHubRunnerConfig` fields on top of a fixed repo
    (`own/repo`) and a placeholder token. Every progress report lands in
    `make.progress`. The hermes turn that ends each workflow is recorded in
    `make.hermes` (whether the review file of PR 5 existed at that moment):
    the cycle itself is tested in tests/test_hermes_github_surface.py.
    """
    module = importlib.import_module("runners.github.orchestrator")
    models = importlib.import_module("runners.github.models")
    project = tmp_path / "project"
    progress: list = []
    hermes: list = []

    async def observe(project_dir):
        saved = Path(project_dir) / ".workpilot" / "github" / "pr" / "review_5.json"
        hermes.append(saved.exists())

    monkeypatch.setattr(module, "observe_with_hermes", observe)

    def make(report_progress: bool = True, **config):
        settings = models.GitHubRunnerConfig(
            token="placeholder-token",  # pragma: allowlist secret
            repo="own/repo",
            **config,
        )
        return module.GitHubOrchestrator(
            project_dir=project,
            config=settings,
            progress_callback=progress.append if report_progress else None,
        )

    make.project = project
    make.progress = progress
    make.hermes = hermes
    return make


class _Session:
    """One model session: the prompt it got, the text it answers."""

    def __init__(self, answer, options, log):
        self.answer, self.options, self.log = answer, options, log

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt):
        self.prompt = prompt
        self.log.append((self.options["agent_type"], prompt))

    async def receive_response(self):
        from claude_agent_sdk import AssistantMessage, TextBlock

        reply = self.answer(self.prompt)
        if isinstance(reply, BaseException):
            raise reply
        if isinstance(reply, list):  # the SDK's own messages, as they come
            for message in reply:
                yield message
            return
        yield AssistantMessage(content=[TextBlock(text=reply)], model="m")


@pytest.fixture
def batch_model(monkeypatch):
    """The model behind issue batching, as a stand-in `create_simple_client`.

    `batch_model.answers[agent_type]` is a function from the prompt to the
    reply text (or an exception to raise, or a list of SDK messages). The batch analyzer asks as
    `batch_analysis`, the batch validator as `batch_validation`; without an
    answer, the analyzer hears an empty reply and the validator accepts.
    `batch_model.prompts` lists `(agent_type, prompt)` in order.
    """
    log: list = []
    answers: dict = {
        "batch_analysis": lambda _prompt: "",
        "batch_validation": lambda _prompt: json.dumps(
            {"is_valid": True, "confidence": 0.9, "reasoning": "same root cause"}
        ),
    }

    def create_simple_client(**options):
        return _Session(answers[options["agent_type"]], options, log)

    monkeypatch.setattr(
        importlib.import_module("core.simple_client"),
        "create_simple_client",
        create_simple_client,
    )
    # The analyzer copies a Claude token into the environment when none is
    # set: give it a placeholder so it never looks at the host's credentials.
    monkeypatch.setenv(
        "CLAUDE_CODE_OAUTH_TOKEN", "placeholder-oauth"
    )  # pragma: allowlist secret
    return SimpleNamespace(answers=answers, prompts=log)
