"""`run.py`: each flag reaches its command with the arguments it was given."""

from __future__ import annotations

import importlib
import json
import os

import pytest

# `cli.main` the module: the package's `main` attribute is the function.
cm = importlib.import_module("cli.main")


class _Calls(list):
    result = None


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.delenv("AUTO_BUILD_MODEL", raising=False)
    spec = tmp_path / ".workpilot" / "specs" / "001-login"
    spec.mkdir(parents=True)
    (spec / "spec.md").write_text("# Login\n", encoding="utf-8")
    return tmp_path


@pytest.fixture
def calls(monkeypatch):
    """Every command `main` routes to, replaced by a recorder."""
    from cli import steer_command, verify_commands, workspace_commands

    seen = _Calls()

    def recorder(name):
        def record(*args, **kwargs):
            seen.append((name, args, kwargs))
            return seen.result

        return record

    for name in dir(cm):
        if name.startswith("handle_") or name == "print_specs_list":
            monkeypatch.setattr(cm, name, recorder(name))
    for module, name in [
        (workspace_commands, "handle_merge_preview_command"),
        (workspace_commands, "handle_analyze_impact_command"),
        (workspace_commands, "handle_find_pr_command"),
        (steer_command, "handle_steer_command"),
        (verify_commands, "handle_verify_command"),
    ]:
        monkeypatch.setattr(module, name, recorder(name))
    return seen


def _run(project, *argv):
    cm._run_cli(argv=["--project-dir", str(project), *argv])


@pytest.mark.parametrize(
    ("argv", "name", "expected"),
    [
        (["--doctor"], "handle_doctor_command", {}),
        (["--streaming-server"], "handle_streaming_server_command", None),
        (["--list-recordings"], "handle_list_recordings_command", None),
        (["--replay-recording", "r.json"], "handle_replay_recording_command", None),
        (["--batch-status"], "handle_batch_status_command", None),
        (["--cost-compare"], "handle_cost_compare_command", None),
        (["--cost-report"], "handle_cost_report_command", {"period": "monthly"}),
        (
            ["--cost-report", "weekly"],
            "handle_cost_report_command",
            {"period": "weekly"},
        ),
        (
            ["--cost-budget", "--budget-period", "weekly"],
            "handle_cost_budget_command",
            {"limit": None, "period": "weekly"},
        ),
        (
            ["--cost-budget", "12.5"],
            "handle_cost_budget_command",
            {"limit": 12.5, "period": "monthly"},
        ),
        (
            ["--cost-predict", "001-login", "--predict-model", "m"],
            "handle_cost_predict_command",
            {"spec_id": "001-login", "model": "m", "provider": "anthropic"},
        ),
        (["--onboard"], "handle_onboard_command", {"output": None}),
        (["--env-capture"], "handle_env_capture_command", {"source": "auto"}),
        (["--env-reproduce"], "handle_env_reproduce_command", {}),
        (["--env-validate"], "handle_env_validate_command", {}),
        (
            ["--self-heal"],
            "handle_self_healing_command",
            {"mode": "dashboard", "verbose": False},
        ),
        (
            ["--browser-agent", "screenshot", "--browser-url", "http://x"],
            "handle_browser_agent_command",
            {"mode": "screenshot", "url": "http://x", "name": None, "verbose": False},
        ),
        (["--list-worktrees"], "handle_list_worktrees_command", None),
        (["--cleanup-worktrees"], "handle_cleanup_worktrees_command", None),
    ],
)
def test_project_commands(project, calls, argv, name, expected):
    _run(project, *argv)
    [(called, _args, kwargs)] = calls
    assert called == name
    if expected is not None:
        assert kwargs == expected


def test_list_prints_the_specs(project, calls):
    _run(project, "--list")
    assert calls == [("print_specs_list", (project,), {})]


def test_onboarding_output_path(project, calls, tmp_path):
    _run(project, "--onboard", "--onboard-output", str(tmp_path / "g.md"))
    assert calls[0][2] == {"output": tmp_path / "g.md"}


def test_batch_commands_take_the_project_as_text(project, calls, tmp_path):
    _run(project, "--batch-create", "tasks.json")
    _run(project, "--batch-cleanup")
    _run(project, "--batch-cleanup", "--no-dry-run")
    assert calls == [
        ("handle_batch_create_command", ("tasks.json", str(project)), {}),
        ("handle_batch_cleanup_command", (str(project),), {"dry_run": True}),
        ("handle_batch_cleanup_command", (str(project),), {"dry_run": False}),
    ]


def test_without_a_spec_the_usage_is_printed(project, calls, capsys):
    with pytest.raises(SystemExit) as stop:
        _run(project)
    assert stop.value.code == 1
    assert "--spec is required" in capsys.readouterr().out


def test_an_unknown_spec_lists_the_available_ones(project, calls, capsys):
    with pytest.raises(SystemExit):
        _run(project, "--spec", "404")
    assert "Spec '404' not found" in capsys.readouterr().out
    assert calls == [("print_specs_list", (project,), {})]


def _spec_dir(project):
    return project / ".workpilot" / "specs" / "001-login"


@pytest.mark.parametrize(
    ("argv", "name"),
    [
        (["--qa-status"], "handle_qa_status_command"),
        (["--review-status"], "handle_review_status_command"),
    ],
)
def test_spec_status_commands(project, calls, argv, name):
    _run(project, "--spec", "001", *argv)
    assert calls == [(name, (_spec_dir(project),), {})]


def test_review_and_discard_name_the_spec(project, calls):
    _run(project, "--spec", "001", "--review")
    _run(project, "--spec", "001", "--discard")
    assert [c[:2] for c in calls] == [
        ("handle_review_command", (project, "001-login")),
        ("handle_discard_command", (project, "001-login")),
    ]


def test_merge_preview_prints_its_result_as_json(project, calls, capsys):
    calls.result = {"success": True, "conflicts": []}
    _run(project, "--spec", "001", "--merge-preview", "--base-branch", "develop")
    assert calls[0][2] == {"base_branch": "develop"}
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1]) == {
        "success": True,
        "conflicts": [],
    }


@pytest.mark.parametrize("ok", [True, False])
def test_merge(project, calls, ok):
    calls.result = ok
    if ok:
        _run(project, "--spec", "001", "--merge", "--no-commit")
    else:
        with pytest.raises(SystemExit):
            _run(project, "--spec", "001", "--merge")
    assert calls[0][2]["no_commit"] is ok


@pytest.mark.parametrize("ok", [True, False])
def test_steer(project, calls, ok):
    calls.result = ok
    argv = ["--spec", "001", "--steer", "use redis", "--steer-subtask", "1.2"]
    if ok:
        _run(project, *argv)
    else:
        with pytest.raises(SystemExit):
            _run(project, *argv)
    assert calls[0][1] == (project, _spec_dir(project), "use redis", "1.2")


@pytest.mark.parametrize("flag", ["--analyze-impact", "--find-pr"])
@pytest.mark.parametrize("ok", [True, False])
def test_pr_queries(project, calls, flag, ok):
    calls.result = {"success": ok}
    argv = ["--spec", "001", flag, "--pr-target", "develop"]
    if ok:
        _run(project, *argv)
    else:
        with pytest.raises(SystemExit):
            _run(project, *argv)
    assert calls[0][2] == {
        "project_dir": project,
        "spec_name": "001-login",
        "target_branch": "develop",
    }


def test_create_pr_with_a_body_file(project, calls, tmp_path):
    body = tmp_path / "body.md"
    body.write_text("## Summary\n", encoding="utf-8")
    calls.result = {"success": True}

    _run(
        project,
        "--spec",
        "001",
        "--create-pr",
        "--pr-title",
        "Login",
        "--pr-draft",
        "--pr-body-file",
        str(body),
        "--pr-ignore-cross-review",
    )

    assert calls[0][2] == {
        "project_dir": project,
        "spec_name": "001-login",
        "target_branch": None,
        "title": "Login",
        "draft": True,
        "body": "## Summary\n",
        "allow_cross_review_disagreement": True,
    }


def test_create_pr_with_an_unreadable_body_answers_in_json(
    project, calls, tmp_path, capsys
):
    """The review modal reads the answer as JSON: `json` used to be imported
    only on the merge-preview branch, so this answer was a NameError."""
    with pytest.raises(SystemExit) as stop:
        _run(
            project,
            "--spec",
            "001",
            "--create-pr",
            "--pr-body-file",
            str(tmp_path / "gone.md"),
        )
    assert stop.value.code == 1
    answer = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert answer["success"] is False
    assert "Could not read --pr-body-file" in answer["error"]
    assert calls == []


def test_a_failed_pr_exits_non_zero(project, calls):
    calls.result = {"success": False}
    with pytest.raises(SystemExit):
        _run(project, "--spec", "001", "--create-pr")


def test_the_model_comes_from_the_flag_or_the_environment(project, calls, monkeypatch):
    monkeypatch.setenv("AUTO_BUILD_MODEL", "from-env")
    _run(project, "--spec", "001", "--qa")
    _run(project, "--spec", "001", "--qa", "--model", "from-flag", "--verbose")
    assert [(c[0], c[2]["model"], c[2]["verbose"]) for c in calls] == [
        ("handle_qa_command", "from-env", False),
        ("handle_qa_command", "from-flag", True),
    ]


@pytest.mark.parametrize(
    ("argv", "name", "extra"),
    [
        (["--verify"], "handle_verify_command", {}),
        (
            ["--auto-fix", "--auto-fix-max-attempts", "4"],
            "handle_auto_fix_command",
            {"max_attempts": 4},
        ),
        (["--followup"], "handle_followup_command", {}),
    ],
)
def test_spec_commands(project, calls, argv, name, extra):
    _run(project, "--spec", "001", *argv)
    [(called, _args, kwargs)] = calls
    assert called == name
    assert kwargs["spec_dir"] == _spec_dir(project)
    assert kwargs["project_dir"] == project
    for key, value in extra.items():
        assert kwargs[key] == value


def test_without_a_command_the_spec_is_built(project, calls):
    _run(
        project,
        "--spec",
        "001-login",
        "--isolated",
        "--skip-qa",
        "--max-iterations",
        "3",
        "--force",
        "--base-branch",
        "develop",
    )
    [(called, _args, kwargs)] = calls
    assert called == "handle_build_command"
    assert kwargs["spec_dir"] == _spec_dir(project)
    assert (kwargs["force_isolated"], kwargs["force_direct"]) == (True, False)
    assert (kwargs["skip_qa"], kwargs["max_iterations"]) == (True, 3)
    assert (kwargs["force_bypass_approval"], kwargs["base_branch"]) == (
        True,
        "develop",
    )


# --- main ----------------------------------------------------------------


@pytest.fixture
def entry(monkeypatch):
    import core.sentry

    captured = []
    monkeypatch.setattr(cm, "setup_environment", lambda: None)
    monkeypatch.setattr(core.sentry, "init_sentry", lambda component: None)
    monkeypatch.setattr(core.sentry, "capture_exception", captured.append)
    return captured


@pytest.mark.parametrize(
    ("raised", "code"), [(KeyboardInterrupt(), 130), (RuntimeError("boom"), 1)]
)
def test_main_turns_an_escape_into_an_exit_code(
    entry, monkeypatch, capsys, raised, code
):
    def run(argv, jev_run):
        raise raised

    monkeypatch.setattr(cm, "_run_cli", run)
    with pytest.raises(SystemExit) as stop:
        cm.main(["--list"])
    assert stop.value.code == code
    if code == 1:
        assert entry == [raised]
        assert "Unexpected error: boom" in capsys.readouterr().out


def test_main_runs_the_cli_with_a_run_context(entry, monkeypatch, project):
    seen = {}
    monkeypatch.setattr(cm, "_run_cli", lambda argv, jev_run: seen.update(run=jev_run))
    cm.main(["--list"])
    assert seen["run"] is not None


def test_a_local_run_drops_the_server_key(entry, monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setenv("TYPESAFE_API_KEY", "sk-test-0000")
    monkeypatch.setattr(cm, "_run_cli", lambda argv, jev_run: None)
    run = SimpleNamespace(context=SimpleNamespace(server_mode=False))
    cm.main(["--list"], jev_run=run)
    assert "TYPESAFE_API_KEY" not in os.environ


def test_doctor_reports_dependencies_and_variables(monkeypatch, capsys):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://proxy.example")
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    cm.handle_doctor_command()
    out = capsys.readouterr().out
    assert "[     OK] httpx" in out
    rows = {
        line.split()[0]: line.split(maxsplit=1)[1].strip()
        for line in out.splitlines()
        if line.startswith("  ") and line.split()[0].isupper()
    }
    assert rows["ANTHROPIC_BASE_URL"] == "set"
    assert rows["CLAUDE_CONFIG_DIR"] == "not set"
    assert "proxy.example" not in out


def test_the_run_context_learns_the_project_and_the_spec(project, calls):
    from dataclasses import dataclass
    from types import SimpleNamespace

    @dataclass
    class Context:
        project_dir: object = None
        spec_dir: object = None

    run = SimpleNamespace(context=Context())
    cm._run_cli(
        argv=["--project-dir", str(project), "--spec", "001", "--qa-status"],
        jev_run=run,
    )
    assert run.context == Context(project, _spec_dir(project))
