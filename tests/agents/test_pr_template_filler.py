"""The PR template filler: the project's template, filled by the agent.

``core/worktree_pr.py`` asks it for the PR body when the project has a
GitHub PR template. The model is a stand-in at ``create_agent_client``; the
template lookup, the prompt it reads, the session loop and the clean-up of the
answer are the real ones.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from agents import pr_template_filler as filler
from replay import recorder as replay_recorder

TEMPLATE = "## Summary\n\n- [ ] Bug fix\n- [ ] Feature\n"


# -- the SDK's message shapes, read by class name by the session loop ---------


class TextBlock:
    def __init__(self, text: str) -> None:
        self.text = text


class AssistantMessage:
    def __init__(self, text: str) -> None:
        self.content = [TextBlock(text)]


class ResultMessage:
    def __init__(self) -> None:
        self.session_id = "sess-pr"
        self.subtype = "success"
        self.usage = {"input_tokens": 10, "output_tokens": 5}
        self.total_cost_usd = 0.0


class _Options:
    model = "claude-sonnet-test"


class _Client:
    """What ``create_agent_client`` hands back: an SDK client that answers."""

    def __init__(self, answer: str | None, fail: Exception | None = None) -> None:
        self.options = _Options()
        self._answer = answer
        self._fail = fail
        self.prompts: list[str] = []

    async def __aenter__(self) -> _Client:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def query(self, prompt: str) -> None:
        self.prompts.append(prompt)
        if self._fail is not None:
            raise self._fail

    async def receive_response(self):
        if self._answer is not None:
            yield AssistantMessage(self._answer)
        yield ResultMessage()


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "project"
    (root / ".workpilot" / "specs" / "001-login").mkdir(parents=True)
    monkeypatch.setattr(
        replay_recorder,
        "_replay_recorder",
        replay_recorder.ReplayRecorder(storage_dir=tmp_path / "replays"),
    )
    monkeypatch.setenv(
        "WORKPILOT_AGENT_DEBUGGER_STATE", str(tmp_path / "debugger" / "state.json")
    )
    import core.usage_tracker as usage_tracker

    monkeypatch.setattr(usage_tracker, "_get_analytics_db_session", lambda: None)
    return root


def _spec(project: Path) -> Path:
    return project / ".workpilot" / "specs" / "001-login"


SINGLE = "single"


def _template(project: Path, relative: str, content: str | bytes) -> Path:
    """A template in the project, at the path the filler reads (`SINGLE` or a
    file of the template folder)."""
    path = project / (
        filler.SINGLE_TEMPLATE if relative == SINGLE else filler.TEMPLATE_DIR / relative
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content, encoding="utf-8")
    return path


def _model(monkeypatch: pytest.MonkeyPatch, client: _Client) -> list[dict]:
    calls: list[dict] = []

    def create_agent_client(**kwargs: Any) -> _Client:
        calls.append(kwargs)
        return client

    monkeypatch.setattr(filler, "create_agent_client", create_agent_client)
    return calls


# -- finding the template ------------------------------------------------------


def test_the_single_template_file_is_used(project: Path) -> None:
    _template(project, SINGLE, TEMPLATE)

    assert filler.detect_pr_template(str(project)) == TEMPLATE


def test_the_first_template_of_the_folder_is_used(project: Path) -> None:
    _template(project, "b_feature.md", "feature")
    _template(project, "a_bugfix.md", "bugfix")
    _template(project, "notes.txt", "not a template")

    assert filler.detect_pr_template(project) == "bugfix"


def test_an_empty_single_template_falls_back_to_the_folder(project: Path) -> None:
    _template(project, SINGLE, "  \n")
    _template(project, "default.md", "from the folder")

    assert filler.detect_pr_template(project) == "from the folder"


def test_no_template_an_empty_one_or_an_unreadable_one_is_none(
    project: Path,
) -> None:
    assert filler.detect_pr_template(project) is None

    _template(project, "default.md", "\n")
    assert filler.detect_pr_template(project) is None

    # Not UTF-8: the read fails and the PR keeps its default body.
    _template(project, SINGLE, b"\xff\xfe\x00broken")
    _template(project, "default.md", b"\xff\xfe\x00broken")
    assert filler.detect_pr_template(project) is None


# -- what the prompt is given --------------------------------------------------


def test_a_small_diff_is_given_whole() -> None:
    assert filler._truncate_diff("diff --git a/x b/x\n+one") == (
        "diff --git a/x b/x\n+one"
    )


def test_a_large_diff_keeps_only_its_file_level_lines() -> None:
    diff = "\n".join(
        [
            "diff --git a/src/login.ts b/src/login.ts",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/src/login.ts",
            "+" + "x" * filler.MAX_DIFF_CHARS,
            "rename from old.ts",
            "deleted file mode 100644",
            "Binary files a/logo.png and b/logo.png differ",
            " 3 files changed, 12 insertions(+), 2 deletions(-)",
        ]
    )

    out = filler._truncate_diff(diff)

    assert out.splitlines() == [
        "(Diff truncated to file-level summaries due to size)",
        "",
        "diff --git a/src/login.ts b/src/login.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/login.ts",
        "rename from old.ts",
        "deleted file mode 100644",
        "Binary files a/logo.png and b/logo.png differ",
        " 3 files changed, 12 insertions(+), 2 deletions(-)",
    ]


def test_a_large_diff_without_file_lines_is_cut_at_the_limit() -> None:
    diff = "y" * (filler.MAX_DIFF_CHARS + 50)

    out = filler._truncate_diff(diff)

    assert out == "y" * filler.MAX_DIFF_CHARS + "\n\n(... diff truncated due to size)"


@pytest.mark.parametrize(
    ("answer", "body"),
    [
        ("```markdown\n## Summary\n```", "## Summary"),
        ("```md\n## Summary\n```", "## Summary"),
        ("```\n## Summary\n```", "## Summary"),
        ("## Summary\n", "## Summary"),
    ],
)
def test_code_fences_around_the_answer_are_removed(answer: str, body: str) -> None:
    assert filler._strip_markdown_fences(answer) == body


def test_the_spec_is_given_cut_or_said_to_be_missing(project: Path) -> None:
    spec = _spec(project)
    assert filler._load_spec_overview(spec) == "(No spec overview available)"

    (spec / "spec.md").write_text("# Login\n", encoding="utf-8")
    assert filler._load_spec_overview(spec) == "# Login\n"

    (spec / "spec.md").write_text("s" * 9000, encoding="utf-8")
    assert filler._load_spec_overview(spec) == (
        "s" * 8000 + "\n\n(... spec truncated for brevity)"
    )

    (spec / "spec.md").write_bytes(b"\xff\xfe\x00broken")
    assert filler._load_spec_overview(spec) == "(No spec overview available)"


# -- the agent run ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_template_is_filled_from_the_change(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _template(project, SINGLE, TEMPLATE)
    (_spec(project) / "spec.md").write_text("# Add a login form\n", encoding="utf-8")
    client = _Client("```markdown\n## Summary\n\n- [ ] Bug fix\n- [x] Feature\n```")
    calls = _model(monkeypatch, client)

    body = await filler.run_pr_template_filler(
        project,
        _spec(project),
        model="claude-sonnet-test",
        thinking_budget=2048,
        branch_name="feature/login",
        target_branch="develop",
        diff_summary="diff --git a/src/login.ts b/src/login.ts",
        commit_log="feat: login form",
    )

    assert body == "## Summary\n\n- [ ] Bug fix\n- [x] Feature"
    assert calls == [
        {
            "project_dir": project,
            "spec_dir": _spec(project),
            "model": "claude-sonnet-test",
            "agent_type": "pr_template_filler",
            "max_thinking_tokens": 2048,
        }
    ]
    [prompt] = client.prompts
    for part in (
        TEMPLATE,
        "**Source branch:** feature/login",
        "**Target branch:** develop",
        "diff --git a/src/login.ts b/src/login.ts",
        "# Add a login form",
        "feat: login form",
    ):
        assert part in prompt


@pytest.mark.asyncio
async def test_without_a_template_the_agent_is_not_run(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _model(monkeypatch, _Client("unused"))

    assert await filler.run_pr_template_filler(project, _spec(project), "m") is None
    assert calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "client",
    [
        pytest.param(_Client("   "), id="blank answer"),
        pytest.param(_Client(None), id="no answer"),
        pytest.param(
            _Client(None, fail=RuntimeError("connection reset")), id="session error"
        ),
    ],
)
async def test_no_usable_answer_leaves_the_default_body(
    project: Path, monkeypatch: pytest.MonkeyPatch, client: _Client
) -> None:
    _template(project, SINGLE, TEMPLATE)
    _model(monkeypatch, client)

    assert await filler.run_pr_template_filler(project, _spec(project), "m") is None


@pytest.mark.asyncio
async def test_a_client_that_cannot_open_leaves_the_default_body(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _template(project, SINGLE, TEMPLATE)

    class _Unreachable(_Client):
        async def __aenter__(self) -> _Client:
            raise OSError("no route to the model")

    _model(monkeypatch, _Unreachable("unused"))

    assert await filler.run_pr_template_filler(project, _spec(project), "m") is None
    log = (_spec(project) / "task_logs.json").read_text(encoding="utf-8")
    assert "PR template filler error: no route to the model" in log
