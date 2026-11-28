"""The spec runner, as the Kanban starts it.

The app runs ``runners/spec_runner.py`` with the task, its model and provider,
and (unless --no-build) expects the build to follow in ``run.py``. The spec
pipeline itself is the spec package's (its own tests); here it is a stand-in
that records how it was asked and writes the spec folder it would. The review
state, the arguments, the environment and the build command are real.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "spec_runner.py"
PY_ENV = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}


@pytest.fixture
def runner(monkeypatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("spec_runner_t", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def project(tmp_path) -> Path:
    root = tmp_path / "shop"
    (root / ".workpilot" / "specs").mkdir(parents=True)
    return root


class Pipeline:
    """Stands in for SpecOrchestrator: records its arguments, then a scripted end."""

    def __init__(self, project: Path, outcome=True, approve: bool = True):
        self.project = project
        self.outcome = outcome
        self.approve = approve
        self.made: dict = {}
        self.ran: dict = {}

    def __call__(self, **kwargs):
        from review import ReviewState

        self.made = kwargs
        pipeline = self

        class Orchestrator:
            project_dir = kwargs["project_dir"]
            spec_dir = kwargs.get("spec_dir") or (
                kwargs["project_dir"] / ".workpilot" / "specs" / "001-cart"
            )

            async def run(self, interactive, auto_approve):
                pipeline.ran = {
                    "interactive": interactive,
                    "auto_approve": auto_approve,
                }
                self.spec_dir.mkdir(parents=True, exist_ok=True)
                (self.spec_dir / "spec.md").write_text("# Cart", encoding="utf-8")
                if isinstance(pipeline.outcome, BaseException):
                    raise pipeline.outcome
                if pipeline.approve:
                    ReviewState().approve(self.spec_dir, approved_by="auto")
                return pipeline.outcome

        return Orchestrator()


@pytest.fixture
def start(runner, project, monkeypatch, capsys):
    """main() with the given arguments; returns (exit code, stdout, the build)."""
    build: dict = {}

    def execv(path, argv):
        build.update(path=path, argv=argv, how="execv")
        raise SystemExit(0)

    def run(argv, *_args, **_kwargs):
        # Windows starts the build as a child (issue #609) instead of execv.
        build.update(path=argv[0], argv=argv, how="subprocess")
        return subprocess.CompletedProcess(argv, 0)

    monkeypatch.setattr(runner.os, "execv", execv)
    monkeypatch.setattr(runner.subprocess, "run", run)
    # main() writes the provider into os.environ: setting it first makes
    # monkeypatch restore the variable (or its absence) after the test.
    monkeypatch.setenv("SELECTED_LLM_PROVIDER", "")
    monkeypatch.delenv("SELECTED_LLM_PROVIDER")

    def go(*args: str, pipeline: Pipeline | None = None):
        pipeline = pipeline or Pipeline(project)
        monkeypatch.setattr(runner, "SpecOrchestrator", pipeline)
        argv = ["spec_runner.py", "--project-dir", str(project), *args]
        monkeypatch.setattr(sys, "argv", argv)
        with pytest.raises(SystemExit) as stop:
            runner.main()
        return stop.value.code, capsys.readouterr().out, build, pipeline

    return go


class TestASpecThenItsBuild:
    @pytest.mark.parametrize(
        ("windows", "how"), [(False, "execv"), (True, "subprocess")]
    )
    def test_an_approved_spec_hands_over_to_the_build(
        self, start, project, runner, monkeypatch, windows, how
    ):
        monkeypatch.setattr(runner, "is_windows", lambda: windows)

        code, _, build, pipeline = start("--task", "Add a cart", "--auto-approve")

        assert code == 0
        assert build["how"] == how
        assert pipeline.made["task_description"] == "Add a cart"
        assert pipeline.made["project_dir"] == project
        assert pipeline.ran == {"interactive": False, "auto_approve": True}
        argv = build["argv"]
        assert build["path"] == sys.executable == argv[0]
        assert argv[1].endswith("run.py")
        assert argv[2:] == [
            "--spec",
            "001-cart",
            "--project-dir",
            str(project),
            "--auto-continue",
        ]

    def test_an_auto_approved_spec_without_a_review_gate_skips_revalidation(
        self, start, project
    ):
        spec = project / ".workpilot" / "specs" / "007-x"
        spec.mkdir(parents=True)
        (spec / "task_metadata.json").write_text(
            json.dumps({"requireReviewBeforeCoding": False}), encoding="utf-8"
        )

        _, _, build, _ = start(
            "--task",
            "x",
            "--spec-dir",
            str(spec),
            "--auto-approve",
            "--base-branch",
            "develop",
            "--direct",
        )

        assert build["argv"][-4:] == ["--force", "--base-branch", "develop", "--direct"]

    @pytest.mark.parametrize(
        "metadata", ['{"requireReviewBeforeCoding": true}', "{broken", None]
    )
    def test_a_review_gate_or_an_unreadable_metadata_keeps_the_check(
        self, start, project, metadata
    ):
        spec = project / ".workpilot" / "specs" / "007-x"
        spec.mkdir(parents=True)
        if metadata is not None:
            (spec / "task_metadata.json").write_text(metadata, encoding="utf-8")

        _, _, build, _ = start("--task", "x", "--spec-dir", str(spec), "--auto-approve")

        assert "--force" not in build["argv"]

    def test_no_build_stops_after_the_spec(self, start):
        code, _, build, _ = start("--task", "x", "--no-build")

        assert code == 0 and build == {}

    def test_a_spec_that_is_not_approved_does_not_build(self, start, project):
        code, out, build, _ = start(
            "--task", "x", pipeline=Pipeline(project, approve=False)
        )

        assert code == 1 and build == {}
        assert "Build cannot start: spec not approved." in out
        # The command it gives is one that exists, for this spec and project.
        assert "review.py" not in out
        assert "--continue 001-cart" in out
        assert str(RUNNER.resolve()) in out

    def test_a_failed_spec_exits_1(self, start, project):
        code, _, build, _ = start("--task", "x", pipeline=Pipeline(project, False))

        assert code == 1 and build == {}

    def test_on_windows_the_build_runs_as_a_child(self, start, runner, monkeypatch):
        seen = {}

        def run(cmd):
            seen["cmd"] = cmd
            return subprocess.CompletedProcess(cmd, 4)

        monkeypatch.setattr(runner, "is_windows", lambda: True)
        monkeypatch.setattr(runner.subprocess, "run", run)

        code, _, build, _ = start("--task", "x")

        assert code == 4 and build == {}
        assert seen["cmd"][1].endswith("run.py")

    @pytest.mark.parametrize(
        ("error", "said"),
        [
            (FileNotFoundError(), "executable not found"),
            (OSError("no memory"), "Error starting coding phase: no memory"),
            (KeyboardInterrupt(), "Coding phase interrupted."),
        ],
    )
    def test_on_windows_a_build_that_cannot_start_says_so(
        self, start, runner, monkeypatch, error, said
    ):
        def run(_cmd):
            raise error

        monkeypatch.setattr(runner, "is_windows", lambda: True)
        monkeypatch.setattr(runner.subprocess, "run", run)

        code, out, _, _ = start("--task", "x")

        assert code == 1 and said in out

    def test_a_private_review_key_builds_in_this_process(
        self, start, monkeypatch, project
    ):
        import types

        from integrations.jev.runtime import JevRun

        built = {}
        real = JevRun.from_env

        def from_env(context, **kw):
            jev = real(context, **kw)
            monkeypatch.setattr(type(jev), "has_credential", property(lambda _s: True))
            return jev

        def build_main(argv, jev_run):
            built.update(argv=argv, jev=jev_run)

        monkeypatch.setattr(JevRun, "from_env", staticmethod(from_env))
        monkeypatch.setitem(sys.modules, "run", types.SimpleNamespace(main=build_main))

        code, _, build, _ = start("--task", "x")

        assert code == 0 and build == {}
        assert built["argv"][:2] == ["--spec", "001-cart"]


class TestTheTask:
    def test_a_task_file_is_read(self, start, project, tmp_path):
        task = tmp_path / "task.md"
        task.write_text("  Add a cart\x00 with totals \n", encoding="utf-8")

        _, _, _, pipeline = start("--task-file", str(task), "--no-build")

        assert pipeline.made["task_description"] == "Add a cart with totals"

    @pytest.mark.parametrize(
        ("content", "said"),
        [
            (None, "Error: Task file not found"),
            ("   \n", "Error: Task file is empty"),
            (b"\xff\xfe\xfa", "Error: Task file cannot be read"),
        ],
    )
    def test_a_task_file_that_gives_no_task_is_refused(
        self, start, tmp_path, content, said
    ):
        task = tmp_path / "task.md"
        if isinstance(content, bytes):
            task.write_bytes(content)
        elif content is not None:
            task.write_text(content, encoding="utf-8")

        code, out, _, pipeline = start("--task-file", str(task))

        assert code == 1 and said in out
        assert pipeline.made == {}

    def test_a_long_task_is_warned_about_but_kept(self, start):
        code, out, _, pipeline = start("--task", "x" * 5001, "--no-build")

        assert code == 0
        assert "Task description is very long (5001 chars)" in out
        assert len(pipeline.made["task_description"]) == 5001

    def test_without_a_task_the_spec_is_gathered_interactively(self, start):
        _, _, _, pipeline = start("--no-build", "--continue", "003-old")

        assert pipeline.ran["interactive"] is True
        assert pipeline.made["spec_name"] == "003-old"

    def test_direct_mode_is_warned_about(self, start):
        _, out, _, _ = start("--task", "x", "--no-build", "--direct")

        assert "without worktree isolation" in out


class TestTheModelAndProvider:
    def test_anthropic_runs_on_claude_with_the_model_asked(self, start):
        _, _, _, pipeline = start(
            "--task", "x", "--no-build", "--provider", "Anthropic", "--model", "opus"
        )

        assert os.environ["SELECTED_LLM_PROVIDER"] == "claude"
        assert pipeline.made["model"].startswith("claude-opus")

    def test_another_provider_gets_its_own_model(self, start, monkeypatch):
        # Whatever model the task saved: the app always passes one, and a
        # Claude id sent to Ollama failed every phase of the spec.
        import phase_config

        monkeypatch.setattr(
            phase_config,
            "_resolve_provider_model",
            lambda model, provider: f"{provider}:{model}",
        )

        _, _, _, pipeline = start(
            "--task",
            "x",
            "--no-build",
            "--provider",
            "ollama",
            "--model",
            "claude-opus-4-5",
        )

        assert os.environ["SELECTED_LLM_PROVIDER"] == "ollama"
        assert pipeline.made["model"] == "ollama:claude-opus-4-5"

    def test_the_apps_settings_go_to_the_pipeline(self, start):
        _, _, _, pipeline = start(
            "--task",
            "x",
            "--no-build",
            "--thinking-level",
            "high",
            "--complexity",
            "simple",
            "--no-ai-assessment",
        )

        made = pipeline.made
        assert (made["thinking_level"], made["complexity_override"]) == (
            "high",
            "simple",
        )
        assert made["use_ai_assessment"] is False


class TestAnEndThatIsNotASpec:
    def test_a_pause_is_not_a_failure(self, start, project):
        from foundation.build_signals import BuildPaused

        code, out, _, _ = start(
            "--task", "x", pipeline=Pipeline(project, BuildPaused("spec"))
        )

        assert code == 0
        assert "Spec creation paused" in out
        assert "--continue 001-cart" in out

    def test_an_interrupt_says_how_to_continue(self, start, project):
        code, out, _, _ = start(
            "--task", "x", pipeline=Pipeline(project, KeyboardInterrupt())
        )

        assert code == 1
        assert "Spec creation interrupted." in out
        assert "--continue 001-cart" in out

    def test_an_unexpected_error_is_reported(self, start, project, runner, monkeypatch):
        captured = []
        monkeypatch.setattr(
            runner, "capture_exception", lambda e, **kw: captured.append((e, kw))
        )

        code, out, _, _ = start(
            "--task", "x", pipeline=Pipeline(project, RuntimeError("boom"))
        )

        assert code == 1
        assert "Unexpected error: boom" in out
        assert str(captured[0][1]["spec_dir"]).endswith("001-cart")


class TestTheProject:
    @pytest.fixture(autouse=True)
    def nothing_above(self, tmp_path, monkeypatch):
        """Only what a test makes exists: the machine's own folders stay out."""
        real_exists = Path.exists
        monkeypatch.setattr(
            Path,
            "exists",
            lambda self: self.is_relative_to(tmp_path) and real_exists(self),
        )

    def test_inside_workpilots_own_backend_the_project_is_the_repository(
        self, runner, tmp_path
    ):
        backend = tmp_path / "repo" / "apps" / "backend"
        (backend / "core").mkdir(parents=True)
        (backend / "run.py").write_text("", encoding="utf-8")
        (backend / "core" / "client.py").write_text("", encoding="utf-8")
        (tmp_path / "repo" / ".git").mkdir()

        assert runner._project_root(backend) == tmp_path / "repo"

    def test_a_subfolder_finds_the_project_with_a_workpilot_folder(
        self, runner, project
    ):
        sub = project / "src" / "cart"
        sub.mkdir(parents=True)

        assert runner._project_root(sub) == project
        assert runner._project_root(project) == project

    def test_a_folder_with_no_project_around_it_is_the_project(self, runner, tmp_path):
        lone = tmp_path / "lone"
        lone.mkdir()

        assert runner._project_root(lone) == lone

    def test_a_backend_copy_outside_a_repository_stays_where_it_is(
        self, runner, tmp_path
    ):
        backend = tmp_path / "backend"
        (backend / "core").mkdir(parents=True)
        (backend / "run.py").write_text("", encoding="utf-8")
        (backend / "core" / "client.py").write_text("", encoding="utf-8")

        assert runner._project_root(backend) == backend


def test_the_command_line_refuses_an_unknown_complexity():
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--task", "x", "--complexity", "huge"],
        cwd=BACKEND,
        env=PY_ENV,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )

    assert done.returncode == 2
    assert "invalid choice: 'huge'" in done.stderr


def test_the_backend_env_files_are_loaded_when_there_are_some(monkeypatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    import cli.utils

    env_file = BACKEND.parent.parent / ".env-files" / ".env"
    dev_env_file = BACKEND.parent / "dev" / "workpilot" / ".env"
    real_exists = Path.exists
    for present in (env_file, dev_env_file):
        loaded: list[Path] = []
        monkeypatch.setattr(
            Path,
            "exists",
            lambda self, present=present: self == present or real_exists(self),
        )
        monkeypatch.setattr(
            cli.utils, "import_dotenv", lambda loaded=loaded: loaded.append
        )
        spec = importlib.util.spec_from_file_location("spec_runner_env_t", RUNNER)
        spec.loader.exec_module(importlib.util.module_from_spec(spec))
        assert loaded == [present]
