"""The `architecture-map` phase runs the real delta, not a one-shot answer.

It used to fall into `run_skill_phase`'s generic path: a read-only `analyzer`
session that wrote prose to `workflow/architecture-map.md`, never asked
`significance.assess`, never ran archify, and never wrote the
`delta.status.json` the Kanban's Delta tab reads — so the tab stayed empty on
every build. These tests pin the three things that make it real:

* the pipeline the regenerate button runs (`run_task_delta`) is the one the
  phase runs, and a change that cannot move a component opens no session;
* the baseline is read from the main project, because `.workpilot/` is
  gitignored and a worktree never has one;
* what the phase writes reaches the spec directory the UI reads.

No model and no renderer: the session, `authoring.author` and
`compare_models` are replaced, because what is under test is the wiring.
"""

from __future__ import annotations

import asyncio
import importlib
import inspect
import json
import os
import sys
from pathlib import Path

import pytest
from architecture_visualizer.archify import authoring, cli, task_delta
from architecture_visualizer.archify import delta as delta_module
from architecture_visualizer.archify.runtime import Condition, Readiness

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / "workflows" / "feature-build" / "workflow.yaml"


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


def a_model() -> dict:
    return {
        "schema_version": 1,
        "diagram_type": "architecture",
        "meta": {"title": "T", "quality_profile": "showcase"},
        "components": [
            {
                "id": "api",
                "type": "backend",
                "label": "API",
                "sources": [{"path": "src/api"}],
            }
        ],
    }


def write_baseline(project: Path) -> Path:
    path = task_delta.baseline_dir(project) / task_delta.BASELINE_SPEC
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(a_model()), encoding="utf-8")
    return path


def recorded(spec_dir: Path) -> dict:
    return json.loads(delta_module.status_path(spec_dir).read_text(encoding="utf-8"))


class NeverCalled:
    """A session that fails the test if anything opens it."""

    def __init__(self):
        self.calls = 0

    async def __call__(self, prompt: str) -> str:
        self.calls += 1
        raise AssertionError("a session was opened for a change that maps nothing")


@pytest.fixture
def fake_pipeline(monkeypatch):
    """`authoring.author` and `compare_models`, replaced and recorded."""
    seen: dict = {"author": [], "compare": []}

    async def fake_author(*, session, project_dir, spec_path, artifact_path, **kwargs):
        seen["author"].append(
            {
                "project_dir": project_dir,
                "spec_path": spec_path,
                "artifact_path": artifact_path,
                **kwargs,
            }
        )
        seen["response"] = await session("author the head model")
        spec_path.parent.mkdir(parents=True, exist_ok=True)
        spec_path.write_text(json.dumps(a_model()), encoding="utf-8")
        return authoring.AuthoringResult(
            ok=True, spec_path=spec_path, artifact_path=artifact_path, rounds=1
        )

    def fake_compare(spec_dir, baseline_path, head_path, project_dir):
        seen["compare"].append(
            {
                "spec_dir": spec_dir,
                "baseline_path": baseline_path,
                "head_path": head_path,
                "project_dir": project_dir,
            }
        )
        out = delta_module.directory(spec_dir)
        return delta_module.write_status(
            spec_dir,
            delta_module.DeltaStatus(
                status=delta_module.STATUS_MAPPED,
                summary={"components": {"added": 1}},
                artifact=str(out / delta_module.DELTA_HTML),
                receipt=str(out / delta_module.DELTA_RECEIPT),
            ),
        )

    monkeypatch.setattr(authoring, "author", fake_author)
    monkeypatch.setattr(delta_module, "compare_models", fake_compare)
    return seen


def unavailable() -> cli.ArchifyUnavailable:
    return cli.ArchifyUnavailable(
        Readiness(
            ok=False,
            node=None,
            archify_root=None,
            conditions=[
                Condition(
                    name="node",
                    ok=False,
                    detail="node was not found",
                    remedy="install Node 18 or newer",
                    blocking=True,
                )
            ],
        )
    )


# --------------------------------------------------------------------------- #
# run_task_delta
# --------------------------------------------------------------------------- #


class TestRunTaskDelta:
    @pytest.mark.asyncio
    async def test_an_inert_change_is_recorded_without_opening_a_session(
        self, tmp_path: Path
    ):
        project = tmp_path / "project"
        spec = project / ".workpilot" / "specs" / "001-x"
        write_baseline(project)
        session = NeverCalled()

        status = await task_delta.run_task_delta(
            project, spec, session=session, changed_files=["docs/guide.md"]
        )

        assert status.status == delta_module.STATUS_NOT_SIGNIFICANT
        assert recorded(spec)["status"] == "not-significant"
        assert session.calls == 0

    @pytest.mark.asyncio
    async def test_no_baseline_is_a_record_not_an_error(self, tmp_path: Path):
        spec = tmp_path / "spec"
        status = await task_delta.run_task_delta(
            tmp_path, spec, session=NeverCalled(), changed_files=["src/api/a.py"]
        )
        assert status.status == delta_module.STATUS_NO_BASELINE
        assert recorded(spec)["status"] == "no-baseline"

    @pytest.mark.asyncio
    async def test_the_baseline_is_read_from_the_main_project(self, tmp_path: Path):
        """`.workpilot/` is gitignored, so a worktree never carries the baseline."""
        main = tmp_path / "main"
        worktree = main / ".workpilot" / "worktrees" / "tasks" / "001-x"
        worktree.mkdir(parents=True)
        spec = worktree / ".workpilot" / "specs" / "001-x"
        write_baseline(main)

        status = await task_delta.run_task_delta(
            worktree,
            spec,
            session=NeverCalled(),
            baseline_project_dir=main,
            changed_files=["docs/guide.md"],
        )

        assert status.status == delta_module.STATUS_NOT_SIGNIFICANT

    @pytest.mark.asyncio
    async def test_a_significant_change_is_authored_and_compared(
        self, tmp_path: Path, fake_pipeline
    ):
        project = tmp_path / "project"
        spec = tmp_path / "spec"
        baseline = write_baseline(project)
        prompts: list[str] = []

        async def session(prompt: str) -> str:
            prompts.append(prompt)
            return "written"

        status = await task_delta.run_task_delta(
            project,
            spec,
            session=session,
            changed_files=["src/api/routes.py"],
            task_summary="add an endpoint",
        )

        assert status.status == delta_module.STATUS_MAPPED
        assert prompts == ["author the head model"]
        (authored,) = fake_pipeline["author"]
        assert authored["spec_path"] == spec / "architecture" / "head.arch.json"
        assert authored["baseline"] == a_model()
        assert authored["task_summary"] == "add an endpoint"
        (compared,) = fake_pipeline["compare"]
        assert compared["baseline_path"] == baseline
        assert compared["spec_dir"] == spec

    @pytest.mark.asyncio
    async def test_the_record_can_live_beside_the_main_spec(
        self, tmp_path: Path, fake_pipeline
    ):
        """The head model is written where the session may write; the answer
        is written where the Kanban reads, with paths that survive the merge."""
        project = tmp_path / "worktree"
        spec = project / ".workpilot" / "specs" / "001-x"
        main_spec = tmp_path / "main" / ".workpilot" / "specs" / "001-x"
        write_baseline(tmp_path / "main")

        status = await task_delta.run_task_delta(
            project,
            spec,
            session=lambda _p: asyncio.sleep(0, "ok"),
            baseline_project_dir=tmp_path / "main",
            changed_files=["src/api/routes.py"],
            record_dir=main_spec,
        )

        assert status.status == delta_module.STATUS_MAPPED
        assert fake_pipeline["author"][0]["spec_path"].is_relative_to(spec)
        assert recorded(main_spec)["artifact"].startswith(str(main_spec))
        assert not delta_module.status_path(spec).exists()

    @pytest.mark.asyncio
    async def test_a_missing_runtime_is_recorded(self, tmp_path: Path, monkeypatch):
        project = tmp_path / "project"
        spec = tmp_path / "spec"
        write_baseline(project)

        async def refuse(**_kwargs):
            raise unavailable()

        monkeypatch.setattr(authoring, "author", refuse)

        status = await task_delta.run_task_delta(
            project,
            spec,
            session=NeverCalled(),
            changed_files=["src/api/routes.py"],
        )

        assert status.status == delta_module.STATUS_RUNTIME_MISSING
        assert "Node 18" in status.reason
        assert recorded(spec)["status"] == "runtime-missing"

    @pytest.mark.asyncio
    async def test_a_failed_authoring_carries_its_diagnostics(
        self, tmp_path: Path, monkeypatch
    ):
        project = tmp_path / "project"
        spec = tmp_path / "spec"
        write_baseline(project)

        async def fail(**_kwargs):
            return authoring.AuthoringResult(
                ok=False, error="2 errors", diagnostics=[{"code": "x/1"}]
            )

        monkeypatch.setattr(authoring, "author", fail)

        status = await task_delta.run_task_delta(
            project, spec, session=NeverCalled(), changed_files=["src/api/a.py"]
        )

        assert status.status == delta_module.STATUS_FAILED
        assert status.diagnostics == [{"code": "x/1"}]
        # Diagnostics are for the caller printing them, not part of the record.
        assert "diagnostics" not in recorded(spec)


# --------------------------------------------------------------------------- #
# The workflow phase
# --------------------------------------------------------------------------- #


def architecture_map_phase(effort: str = "medium", changed_files=None):
    from workflows import load_workflow, resolve_profile

    profile = resolve_profile(
        load_workflow(WORKFLOW_PATH), effort, changed_files=changed_files
    )
    return next(r for r in profile.run if r.id == "architecture-map")


def phase_context(tmp_path: Path, *, changed_files, isolated: bool = True):
    """A context shaped like an isolated build's: worktree + main project."""
    from workflows import PhaseContext

    main = tmp_path / "main"
    main_spec = main / ".workpilot" / "specs" / "001-x"
    main_spec.mkdir(parents=True)
    if isolated:
        project = main / ".workpilot" / "worktrees" / "tasks" / "001-x"
        spec = project / ".workpilot" / "specs" / "001-x"
        spec.mkdir(parents=True)
    else:
        project, spec = main, main_spec
    (spec / "requirements.json").write_text(
        json.dumps({"task_description": "Add an orders endpoint"}), encoding="utf-8"
    )
    write_baseline(main)
    return PhaseContext(
        project_dir=project,
        spec_dir=spec,
        model="claude-sonnet-4-5",
        repo_root=REPO_ROOT,
        effort="medium",
        changed_files=changed_files,
        source_project_dir=main if isolated else None,
        source_spec_dir=main_spec if isolated else None,
    )


@pytest.fixture
def agent_stack(monkeypatch):
    """`create_agent_client` and `run_agent_session`, recorded."""
    import agents.session as agent_session
    import core.client as core_client

    seen: dict = {"clients": []}

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    def fake_create(**kwargs):
        kwargs["resume_visible"] = "AUTO_CLAUDE_RESUME_SESSION_ID" in os.environ
        seen["clients"].append(kwargs)
        return _Client()

    async def fake_session(client, message, spec_dir, verbose=False, **_kw):
        seen["prompt"] = message
        return "complete", "head model written", {}

    monkeypatch.setattr(core_client, "create_agent_client", fake_create)
    monkeypatch.setattr(agent_session, "run_agent_session", fake_session)
    return seen


class TestTheWorkflowPhase:
    def test_it_has_a_dedicated_executor(self):
        from workflows.runner import CUSTOM_EXECUTORS, SKILL_PHASE_AGENTS

        assert "architecture-map" in CUSTOM_EXECUTORS
        # The safety net: were the executor ever bypassed, the one-shot path
        # would at least run under the agent that may write the model.
        assert SKILL_PHASE_AGENTS["architecture-map"] == "architecture_visualizer"

    def test_run_skill_phase_dispatches_to_it_and_opens_no_session(
        self, tmp_path: Path, agent_stack
    ):
        """Through the same door the build uses, an inert change costs nothing."""
        from workflows.runner import run_skill_phase

        ctx = phase_context(tmp_path, changed_files=["tests/test_orders.py"])
        resolved = architecture_map_phase(changed_files=ctx.changed_files)

        outcome = asyncio.run(run_skill_phase(resolved, ctx))

        assert agent_stack["clients"] == []
        assert outcome.succeeded is True
        assert "not significant" in outcome.detail
        assert recorded(ctx.source_spec_dir)["status"] == "not-significant"

    def test_a_mapped_delta_succeeds_on_the_architecture_agent(
        self, tmp_path: Path, agent_stack, fake_pipeline, monkeypatch
    ):
        from architecture_visualizer.archify.phase import run_architecture_map_phase

        monkeypatch.setenv("AUTO_CLAUDE_RESUME_SESSION_ID", "sess-7")
        ctx = phase_context(tmp_path, changed_files=["src/api/routes.py"])
        resolved = architecture_map_phase(changed_files=ctx.changed_files)

        outcome = asyncio.run(run_architecture_map_phase(resolved, ctx))

        assert outcome.succeeded is True
        assert outcome.phase_id == "architecture-map"
        (client,) = agent_stack["clients"]
        assert client["agent_type"] == "architecture_visualizer"
        # The authoring session works on the task's code, in a fresh context.
        assert client["project_dir"] == ctx.project_dir
        assert client["resume_visible"] is False
        assert os.environ["AUTO_CLAUDE_RESUME_SESSION_ID"] == "sess-7"
        (authored,) = fake_pipeline["author"]
        assert authored["spec_path"].is_relative_to(ctx.spec_dir)
        assert authored["changed_files"] == ["src/api/routes.py"]
        assert "orders endpoint" in authored["task_summary"]
        # Compared against the main project's baseline, recorded where the
        # Kanban reads it.
        (compared,) = fake_pipeline["compare"]
        assert compared["spec_dir"] == ctx.source_spec_dir
        assert compared["baseline_path"].is_relative_to(ctx.source_project_dir)
        assert recorded(ctx.source_spec_dir)["status"] == "mapped"
        assert outcome.output_path is not None
        assert outcome.output_path.parent == ctx.spec_dir / "workflow"

    def test_a_direct_build_records_in_its_own_spec(
        self, tmp_path: Path, agent_stack, fake_pipeline
    ):
        from architecture_visualizer.archify.phase import run_architecture_map_phase

        ctx = phase_context(
            tmp_path, changed_files=["src/api/routes.py"], isolated=False
        )
        resolved = architecture_map_phase(changed_files=ctx.changed_files)

        outcome = asyncio.run(run_architecture_map_phase(resolved, ctx))

        assert outcome.succeeded is True
        assert recorded(ctx.spec_dir)["status"] == "mapped"

    def test_a_missing_runtime_could_not_run(
        self, tmp_path: Path, agent_stack, monkeypatch
    ):
        from architecture_visualizer.archify.phase import run_architecture_map_phase

        async def refuse(**_kwargs):
            raise unavailable()

        monkeypatch.setattr(authoring, "author", refuse)
        ctx = phase_context(tmp_path, changed_files=["src/api/routes.py"])
        resolved = architecture_map_phase(changed_files=ctx.changed_files)

        outcome = asyncio.run(run_architecture_map_phase(resolved, ctx))

        assert outcome.succeeded is None
        assert "Node 18" in outcome.detail
        assert recorded(ctx.source_spec_dir)["status"] == "runtime-missing"

    def test_a_failed_authoring_is_a_failure(
        self, tmp_path: Path, agent_stack, monkeypatch
    ):
        from architecture_visualizer.archify.phase import run_architecture_map_phase

        async def fail(**_kwargs):
            return authoring.AuthoringResult(ok=False, error="the model is invalid")

        monkeypatch.setattr(authoring, "author", fail)
        ctx = phase_context(tmp_path, changed_files=["src/api/routes.py"])
        resolved = architecture_map_phase(changed_files=ctx.changed_files)

        outcome = asyncio.run(run_architecture_map_phase(resolved, ctx))

        assert outcome.succeeded is False
        assert "the model is invalid" in outcome.detail

    def test_an_unexpected_error_is_unknown_never_success(
        self, tmp_path: Path, monkeypatch
    ):
        from architecture_visualizer.archify.phase import run_architecture_map_phase

        async def boom(*_a, **_k):
            raise RuntimeError("disk full")

        monkeypatch.setattr(task_delta, "run_task_delta", boom)
        ctx = phase_context(tmp_path, changed_files=["src/api/routes.py"])
        resolved = architecture_map_phase(changed_files=ctx.changed_files)

        outcome = asyncio.run(run_architecture_map_phase(resolved, ctx))

        assert outcome.succeeded is None
        assert "disk full" in outcome.detail

    def test_a_setup_error_is_unknown_never_raised(self, tmp_path: Path, monkeypatch):
        """Resolving the provider happens before the delta; it is guarded too."""
        import workflows.runner as runner
        from architecture_visualizer.archify.phase import run_architecture_map_phase

        def broken(*_a, **_k):
            raise ValueError("task_metadata.json is unreadable")

        monkeypatch.setattr(runner, "phase_provider", broken)
        ctx = phase_context(tmp_path, changed_files=["src/api/routes.py"])
        resolved = architecture_map_phase(changed_files=ctx.changed_files)

        outcome = asyncio.run(run_architecture_map_phase(resolved, ctx))

        assert outcome.succeeded is None
        assert "unreadable" in outcome.detail

    def test_a_report_error_is_unknown_never_raised(
        self, tmp_path: Path, agent_stack, monkeypatch
    ):
        from architecture_visualizer.archify import phase as phase_module

        def broken(*_a, **_k):
            raise TypeError("unserialisable summary")

        monkeypatch.setattr(phase_module, "_report", broken)
        ctx = phase_context(tmp_path, changed_files=["tests/test_orders.py"])
        resolved = architecture_map_phase(changed_files=ctx.changed_files)

        outcome = asyncio.run(phase_module.run_architecture_map_phase(resolved, ctx))

        assert outcome.succeeded is None
        assert "unserialisable" in outcome.detail

    def test_the_report_carries_the_authoring_diagnostics(
        self, tmp_path: Path, agent_stack, monkeypatch
    ):
        """The record keeps one sentence; the refusals land in the phase report."""
        from architecture_visualizer.archify.phase import run_architecture_map_phase

        async def fail(**_kwargs):
            return authoring.AuthoringResult(
                ok=False,
                error="the model is invalid",
                diagnostics=[
                    {"code": "ir/unknown-component", "message": "api-gateway"}
                ],
            )

        monkeypatch.setattr(authoring, "author", fail)
        ctx = phase_context(tmp_path, changed_files=["src/api/routes.py"])
        resolved = architecture_map_phase(changed_files=ctx.changed_files)

        outcome = asyncio.run(run_architecture_map_phase(resolved, ctx))

        report = outcome.output_path.read_text(encoding="utf-8")
        assert "ir/unknown-component" in report
        assert "api-gateway" in report
        assert "diagnostics" not in recorded(ctx.source_spec_dir)


# --------------------------------------------------------------------------- #
# The runner and the build
# --------------------------------------------------------------------------- #


@pytest.fixture
def runner_module():
    return importlib.import_module("runners.architecture_visualizer_runner")


class TestTheRunnerDelegates:
    def test_the_baseline_location_is_single_sourced(self, runner_module):
        assert runner_module.baseline_dir is task_delta.baseline_dir
        assert runner_module.BASELINE_SPEC == task_delta.BASELINE_SPEC

    @pytest.mark.asyncio
    async def test_action_delta_runs_run_task_delta(self, runner_module, monkeypatch):
        calls: list[dict] = []
        status = delta_module.DeltaStatus(
            status=delta_module.STATUS_MAPPED, summary={"components": {"added": 1}}
        )

        async def fake_run(project_dir, spec_dir, **kwargs):
            calls.append({"project_dir": project_dir, "spec_dir": spec_dir, **kwargs})
            return status

        sentinel = object()
        monkeypatch.setattr(runner_module, "run_task_delta", fake_run)
        monkeypatch.setattr(runner_module, "_make_session", lambda *_a: sentinel)

        payload = await runner_module.action_delta(
            project_dir=Path("/p"),
            spec_dir=Path("/p/spec"),
            changed_files=["a.py"],
            task_summary="t",
            model=None,
            thinking=None,
            force=True,
        )

        (call,) = calls
        assert call["project_dir"] == Path("/p")
        assert call["spec_dir"] == Path("/p/spec")
        assert call["session"] is sentinel
        assert call["changed_files"] == ["a.py"]
        assert call["task_summary"] == "t"
        assert call["force"] is True
        assert payload == {
            "status": "success",
            "action": "delta",
            "error": "",
            "delta": status.to_dict(),
        }

    @pytest.mark.asyncio
    async def test_the_cli_shapes_are_kept(self, runner_module, monkeypatch):
        answers = iter(
            [
                delta_module.DeltaStatus(
                    status=delta_module.STATUS_NOT_SIGNIFICANT, reason="inert"
                ),
                delta_module.DeltaStatus(
                    status=delta_module.STATUS_FAILED,
                    reason="2 errors",
                    diagnostics=[{"code": "x/1"}],
                ),
                delta_module.DeltaStatus(
                    status=delta_module.STATUS_UNRELIABLE, reason="renamed"
                ),
            ]
        )

        async def fake_run(*_a, **_k):
            return next(answers)

        monkeypatch.setattr(runner_module, "run_task_delta", fake_run)
        monkeypatch.setattr(runner_module, "_make_session", lambda *_a: None)

        async def run() -> dict:
            return await runner_module.action_delta(
                Path("/p"), Path("/s"), None, "", None, None, False
            )

        inert = await run()
        assert inert == {
            "status": "success",
            "action": "delta",
            "delta": inert["delta"],
        }
        failed = await run()
        assert failed["status"] == "error"
        assert failed["error"] == "2 errors"
        assert failed["diagnostics"] == [{"code": "x/1"}]
        unreliable = await run()
        assert unreliable["status"] == "error"
        assert unreliable["error"] == "renamed"
        assert "diagnostics" not in unreliable

    def test_the_session_reads_model_settings_only_when_prompted(
        self, runner_module, monkeypatch
    ):
        """A delta that maps nothing never asks for a model, nor for its settings."""
        import phase_config

        def unreadable(*_a, **_k):
            raise ValueError("settings are unreadable")

        monkeypatch.setattr(phase_config, "get_phase_model", unreadable)
        monkeypatch.setattr(phase_config, "get_phase_thinking_budget", unreadable)

        session = runner_module._make_session(Path("/p"), Path("/s"), None, None)

        assert callable(session)
        with pytest.raises(ValueError, match="unreadable"):
            asyncio.run(session("map it"))


class TestTheBuildCarriesItBack:
    def test_the_phase_context_knows_the_main_project(self, tmp_path: Path):
        from cli.build_commands import _phase_context

        profile = type("P", (), {"effort": "medium"})()
        ctx = _phase_context(
            profile,
            tmp_path / "wt",
            tmp_path / "wt" / "spec",
            "m",
            False,
            None,
            source_project_dir=tmp_path,
            source_spec_dir=tmp_path / "spec",
        )
        assert ctx.source_project_dir == tmp_path
        assert ctx.source_spec_dir == tmp_path / "spec"

    def test_the_post_qa_window_is_synced_to_the_main_spec(self):
        from cli import build_commands

        source = inspect.getsource(build_commands.handle_build_command)
        window = source.index('after="qa", before=None')
        assert "_sync_spec_back(" in source[window:]
        assert "source_spec_dir=source_spec_dir" in source

    def test_the_sync_carries_the_phase_records(self, tmp_path: Path):
        from cli.build_commands import _sync_spec_back

        spec = tmp_path / "wt" / "spec"
        (spec / "architecture").mkdir(parents=True)
        (spec / "architecture" / "head.arch.json").write_text("{}", encoding="utf-8")
        (spec / "workflow").mkdir()
        (spec / "workflow" / "architecture-map.md").write_text("x", encoding="utf-8")
        source = tmp_path / "main" / "spec"

        _sync_spec_back(spec, source, "after the post-QA phases")

        assert (source / "architecture" / "head.arch.json").is_file()
        assert (source / "workflow" / "architecture-map.md").is_file()

    def test_the_sync_never_fails_a_build(self, tmp_path: Path, monkeypatch):
        import agents.utils as agent_utils

        def explode(*_a, **_k):
            raise OSError("read-only file system")

        monkeypatch.setattr(agent_utils, "sync_spec_to_source", explode)
        from cli.build_commands import _sync_spec_back

        _sync_spec_back(tmp_path / "a", tmp_path / "b", "after the post-QA phases")
        _sync_spec_back(tmp_path / "a", None, "in direct mode")


if __name__ == "__main__":  # pragma: no cover
    sys.exit(pytest.main([__file__, "-q"]))
