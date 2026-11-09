"""The Kanban's quick-command bar: a command runs in a review card's worktree (F181).

The bar used to ask the desktop backend server to run the command. That server
has neither the Claude profile's sign-in nor the provider chosen in the app, so
a Claude subscription failed with "No OAuth token found" and every other
provider was ignored; the agent also wrote into the project folder. The run now
goes through `runners/slash_command_runner.py`, started by the Electron main in
the card's worktree with the app's environment. These tests pin down what the
runner does with what it is given: the instructions come from the project, the
agent works in the worktree, on the provider the environment names.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from runners import slash_command_runner as runner  # noqa: E402
from slash_commands import api, execution  # noqa: E402

RESULT = "__SLASH_COMMAND__:"


def _skill(project: Path, name: str, body: str) -> None:
    d = project / ".agents" / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: what {name} does\n---\n\n{body}\n",
        encoding="utf-8",
    )


def _result(capsys) -> dict:
    lines = [
        line for line in capsys.readouterr().out.splitlines() if line.startswith(RESULT)
    ]
    assert len(lines) == 1, lines
    return json.loads(lines[0][len(RESULT) :])


@pytest.fixture
def dirs(tmp_path, monkeypatch):
    # No user-scoped commands from the machine running the tests.
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    project = tmp_path / "project"
    worktree = tmp_path / "worktree"
    project.mkdir()
    worktree.mkdir()
    return project, worktree


class TestResolvePrompt:
    def test_reads_the_project_skill_and_appends_the_arguments(self, dirs):
        project, _ = dirs
        _skill(project, "create-prd", "Write the PRD.")

        assert execution.resolve_prompt(project, "create-prd", "") == "Write the PRD."
        assert (
            execution.resolve_prompt(project, "create-prd", "  a mobile app ")
            == "Write the PRD.\n\nArguments: a mobile app"
        )

    def test_review_is_a_built_in_any_provider_can_run(self, dirs):
        project, _ = dirs
        prompt = execution.resolve_prompt(project, "review", "")
        assert prompt is not None
        assert "git diff" in prompt
        assert "Do not modify any file" in prompt

    def test_an_unknown_command_has_no_prompt(self, dirs):
        project, _ = dirs
        assert execution.resolve_prompt(project, "nope", "") is None

    def test_the_body_route_serves_the_built_in_review_too(self, dirs):
        project, _ = dirs
        body = api.get_slash_command_body(str(project), "review")
        assert body["success"] is True
        assert "git diff" in body["body"]


class TestRunner:
    def test_runs_the_project_command_in_the_worktree(self, dirs, monkeypatch, capsys):
        project, worktree = dirs
        _skill(project, "create-prd", "Write the PRD.")
        seen: list[tuple[Path, str]] = []

        async def fake_run(workdir: Path, prompt: str, spec_dir: Path):
            seen.append((workdir, prompt))
            # The agent's own notes never go to the worktree.
            assert spec_dir.is_dir()
            assert worktree.resolve() not in spec_dir.resolve().parents
            return True, "PRD written."

        monkeypatch.setattr(execution, "run_prompt", fake_run)
        code = runner.main(
            [
                "--project-dir",
                str(project),
                "--workdir",
                str(worktree),
                "--command",
                "create-prd",
                "--args",
                "a mobile app",
            ]
        )

        assert code == 0
        assert _result(capsys) == {"success": True, "result": "PRD written."}
        assert seen == [
            (worktree.resolve(), "Write the PRD.\n\nArguments: a mobile app")
        ]

    def test_reports_a_failed_run(self, dirs, monkeypatch, capsys):
        project, worktree = dirs
        _skill(project, "create-prd", "Write the PRD.")

        async def fake_run(workdir: Path, prompt: str, spec_dir: Path):
            return False, "workflow run failed: boom"

        monkeypatch.setattr(execution, "run_prompt", fake_run)
        code = runner.main(
            [
                "--project-dir",
                str(project),
                "--workdir",
                str(worktree),
                "--command",
                "create-prd",
            ]
        )

        assert code == 1
        assert _result(capsys) == {
            "success": False,
            "error": "workflow run failed: boom",
        }

    @pytest.mark.parametrize("command", ["../x", "/etc/passwd", "a b"])
    def test_refuses_a_path_as_command_name(self, dirs, capsys, command):
        project, worktree = dirs
        code = runner.main(
            [
                "--project-dir",
                str(project),
                "--workdir",
                str(worktree),
                "--command",
                command,
            ]
        )
        assert code == 1
        assert "invalid command name" in _result(capsys)["error"]

    def test_refuses_an_unknown_command_and_a_missing_worktree(self, dirs, capsys):
        project, worktree = dirs
        assert (
            runner.main(
                [
                    "--project-dir",
                    str(project),
                    "--workdir",
                    str(worktree),
                    "--command",
                    "nope",
                ]
            )
            == 1
        )
        assert _result(capsys)["error"] == "command not found: /nope"

        assert (
            runner.main(
                [
                    "--project-dir",
                    str(project),
                    "--workdir",
                    str(worktree / "gone"),
                    "--command",
                    "review",
                ]
            )
            == 1
        )
        assert "--workdir" in _result(capsys)["error"]

    def test_refuses_arguments_that_are_too_long(self, dirs, capsys):
        project, worktree = dirs
        code = runner.main(
            [
                "--project-dir",
                str(project),
                "--workdir",
                str(worktree),
                "--command",
                "review",
                "--args",
                "x" * (runner.MAX_ARGS_CHARS + 1),
            ]
        )
        assert code == 1
        assert "arguments longer" in _result(capsys)["error"]


class TestRunPrompt:
    @pytest.mark.parametrize(
        "provider", ["claude", "openai", "google", "mistral", "ollama"]
    )
    def test_the_agent_runs_on_the_provider_the_app_chose(
        self, dirs, monkeypatch, provider
    ):
        """`SELECTED_LLM_PROVIDER` comes from the app (`pythonRunnerEnv`)."""
        _, worktree = dirs
        notes = worktree.parent / "notes"
        notes.mkdir()
        import core.client as client_module

        built: list[dict] = []

        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def query(self, prompt):
                self.prompt = prompt

            async def receive_response(self):
                if False:  # pragma: no cover - an async generator with no message
                    yield None

        def fake_create(**kwargs):
            built.append(kwargs)
            return FakeClient()

        monkeypatch.setenv("SELECTED_LLM_PROVIDER", provider)
        monkeypatch.setattr(client_module, "create_agent_client", fake_create)

        ok, text = asyncio.run(execution.run_prompt(worktree, "Write the PRD.", notes))

        assert ok is True
        assert text == ""
        assert len(built) == 1
        assert built[0]["provider"] == provider
        assert built[0]["project_dir"] == worktree
        assert built[0]["spec_dir"] == notes
        assert built[0]["agent_type"] == "coder"

    def test_falls_back_to_a_one_shot_only_when_the_agent_cannot_be_built(
        self, dirs, monkeypatch
    ):
        _, worktree = dirs
        calls: list[str] = []

        async def no_agent(workdir, prompt, spec_dir):
            calls.append("agent")
            return False, "failed to build agent client: no CLI"

        async def oneshot(workdir, prompt, spec_dir):
            calls.append("oneshot")
            return True, "answer"

        monkeypatch.setattr(execution, "_agent_workflow_call", no_agent)
        monkeypatch.setattr(execution, "_oneshot_call", oneshot)
        assert asyncio.run(execution.run_prompt(worktree, "p", worktree.parent)) == (
            True,
            "answer",
        )
        assert calls == ["agent", "oneshot"]

    def test_a_genuine_workflow_error_is_reported_as_is(self, dirs, monkeypatch):
        _, worktree = dirs

        async def failing(workdir, prompt, spec_dir):
            return False, "workflow run failed: rate limited"

        async def oneshot(workdir, prompt, spec_dir):  # pragma: no cover - must not run
            raise AssertionError("no fallback for a genuine error")

        monkeypatch.setattr(execution, "_agent_workflow_call", failing)
        monkeypatch.setattr(execution, "_oneshot_call", oneshot)
        assert asyncio.run(execution.run_prompt(worktree, "p", worktree.parent)) == (
            False,
            "workflow run failed: rate limited",
        )


def test_the_server_no_longer_runs_commands():
    """The route ran the agent in the project folder without the app's sign-in."""
    paths = {getattr(route, "path", "") for route in api.router.routes}
    assert "/api/slash-commands/run" not in paths
    assert "/api/slash-commands" in paths
    assert "/api/slash-commands/body" in paths
