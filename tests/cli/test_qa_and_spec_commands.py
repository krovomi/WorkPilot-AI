"""`--qa`, `--qa-status`, `--review-status`, `--auto-fix` and `--list`."""

from __future__ import annotations

import json
import subprocess
import sys

import pytest
from cli import qa_commands as qc
from cli import spec_commands as sc
from review import ReviewState


def _plan(spec, done, total, signoff=None):
    plan = {
        "phases": [
            {
                "subtasks": [
                    {"id": str(i), "status": "completed" if i < done else "pending"}
                    for i in range(total)
                ]
            }
        ]
    }
    if signoff:
        plan["qa_signoff"] = signoff
    (spec / "implementation_plan.json").write_text(json.dumps(plan), encoding="utf-8")


@pytest.fixture
def spec(tmp_path):
    spec = tmp_path / ".workpilot" / "specs" / "001-login"
    spec.mkdir(parents=True)
    (spec / "spec.md").write_text("# Login\n", encoding="utf-8")
    return spec


@pytest.fixture
def loops(monkeypatch):
    seen = {"approved": True}

    async def qa_loop(**kwargs):
        seen["qa"] = kwargs
        return seen["approved"]

    async def fix_loop(**kwargs):
        seen["fix"] = kwargs
        return seen["approved"]

    monkeypatch.setattr(qc, "run_qa_validation_loop", qa_loop)
    monkeypatch.setattr(qc, "run_auto_fix_loop", fix_loop)
    monkeypatch.setattr(qc, "validate_environment", lambda spec_dir: True)
    return seen


def test_qa_status_of_a_spec_not_reviewed_yet(spec, capsys):
    qc.handle_qa_status_command(spec)
    out = capsys.readouterr().out
    assert "Spec: 001-login" in out
    assert "QA Status: Not started" in out


def test_review_status_follows_the_approval(spec, capsys):
    qc.handle_review_status_command(spec)
    assert "Review required before building." in capsys.readouterr().out

    ReviewState().approve(spec, approved_by="test")
    qc.handle_review_status_command(spec)
    assert "Ready to build - approval is valid." in capsys.readouterr().out

    (spec / "spec.md").write_text("# Login, changed\n", encoding="utf-8")
    qc.handle_review_status_command(spec)
    assert "Spec changed since approval" in capsys.readouterr().out


def test_qa_on_an_unfinished_build_does_not_run(tmp_path, spec, loops, capsys):
    _plan(spec, 1, 3)
    qc.handle_qa_command(tmp_path, spec, "sonnet")
    out = capsys.readouterr().out
    assert "Build not complete (1/3 subtasks)." in out
    assert "qa" not in loops


def test_qa_on_an_approved_build_does_not_run(tmp_path, spec, loops, capsys):
    _plan(spec, 2, 2, {"status": "approved"})
    qc.handle_qa_command(tmp_path, spec, "sonnet")
    assert "Build already approved by QA." in capsys.readouterr().out
    assert "qa" not in loops


def test_human_feedback_reruns_qa_on_an_approved_build(tmp_path, spec, loops, capsys):
    _plan(spec, 2, 2, {"status": "approved"})
    (spec / "QA_FIX_REQUEST.md").write_text("The button is blue.\n", encoding="utf-8")

    qc.handle_qa_command(tmp_path, spec, "sonnet", verbose=True, jev_run="run")

    out = capsys.readouterr().out
    assert "Human feedback detected" in out
    assert "QA validation passed. Ready for merge." in out
    assert loops["qa"] == {
        "jev_run": "run",
        "project_dir": tmp_path,
        "spec_dir": spec,
        "model": "sonnet",
        "verbose": True,
    }


def test_a_rejected_qa_exits_non_zero(tmp_path, spec, loops, capsys):
    _plan(spec, 2, 2)
    loops["approved"] = False
    with pytest.raises(SystemExit) as stop:
        qc.handle_qa_command(tmp_path, spec, "sonnet")
    assert stop.value.code == 1
    assert "QA validation incomplete" in capsys.readouterr().out


def test_an_interrupted_qa_says_how_to_resume(tmp_path, spec, monkeypatch, capsys):
    _plan(spec, 2, 2)

    async def interrupted(**_kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(qc, "run_qa_validation_loop", interrupted)
    monkeypatch.setattr(qc, "validate_environment", lambda spec_dir: True)

    qc.handle_qa_command(tmp_path, spec, "sonnet")

    assert "--spec 001-login --qa" in capsys.readouterr().out


@pytest.mark.parametrize("handler", ["qa", "fix"])
def test_an_invalid_environment_stops_before_the_loop(
    tmp_path, spec, monkeypatch, handler
):
    monkeypatch.setattr(qc, "validate_environment", lambda spec_dir: False)
    command = qc.handle_qa_command if handler == "qa" else qc.handle_auto_fix_command
    with pytest.raises(SystemExit):
        command(tmp_path, spec, "sonnet")


def test_auto_fix_reads_its_attempts_from_the_environment(
    tmp_path, spec, loops, monkeypatch, capsys
):
    monkeypatch.setenv("AUTO_FIX_MAX_ATTEMPTS", "7")
    qc.handle_auto_fix_command(tmp_path, spec, "sonnet")
    out = capsys.readouterr().out
    assert "Max attempts: 7" in out
    assert "Auto-fix successful" in out
    assert loops["fix"]["max_attempts"] == 7


def test_auto_fix_failure_and_interruption(tmp_path, spec, loops, monkeypatch, capsys):
    loops["approved"] = False
    with pytest.raises(SystemExit):
        qc.handle_auto_fix_command(tmp_path, spec, "sonnet", max_attempts=2)
    assert "Auto-fix failed" in capsys.readouterr().out
    assert loops["fix"]["max_attempts"] == 2

    async def interrupted(**_kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(qc, "run_auto_fix_loop", interrupted)
    qc.handle_auto_fix_command(tmp_path, spec, "sonnet", max_attempts=1)
    assert "--spec 001-login --auto-fix" in capsys.readouterr().out


# --- listing specs ---------------------------------------------------------


def _spec(project, name, plan=None, spec_md=True):
    folder = project / ".workpilot" / "specs" / name
    folder.mkdir(parents=True)
    if spec_md:
        (folder / "spec.md").write_text("# s\n", encoding="utf-8")
    if plan is not None:
        _plan(folder, *plan)
    return folder


def test_list_specs_reads_each_status(temp_git_repo):
    _spec(temp_git_repo, "001-done", (2, 2))
    _spec(temp_git_repo, "002-half", (1, 2))
    _spec(temp_git_repo, "003-empty", (0, 0))
    _spec(temp_git_repo, "004-new")
    _spec(temp_git_repo, "005-no-spec", spec_md=False)
    _spec(temp_git_repo, "notes")
    (temp_git_repo / ".workpilot" / "specs" / "006-file").write_text(
        "", encoding="utf-8"
    )

    specs = sc.list_specs(temp_git_repo)

    assert [(s["folder"], s["status"], s["progress"]) for s in specs] == [
        ("001-done", "complete", "2/2"),
        ("002-half", "in_progress", "1/2"),
        ("003-empty", "initialized", "0/0"),
        ("004-new", "pending", "-"),
    ]
    assert specs[0]["number"] == "001" and specs[0]["name"] == "done"


def test_a_spec_with_a_worktree_is_marked_built(temp_git_repo, capsys):
    _spec(temp_git_repo, "001-login", (1, 2))
    subprocess.run(
        ["git", "commit", "--allow-empty", "-m", "init"],
        cwd=temp_git_repo,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [
            "git",
            "worktree",
            "add",
            "-b",
            "workpilot/001-login",
            str(temp_git_repo / ".workpilot/worktrees/tasks/001-login"),
        ],
        cwd=temp_git_repo,
        check=True,
        capture_output=True,
    )

    [spec] = sc.list_specs(temp_git_repo)
    assert (spec["status"], spec["has_build"]) == ("in_progress (has build)", True)

    sc.print_specs_list(temp_git_repo)
    out = capsys.readouterr().out
    assert "[..] 001-login" in out
    assert "Status: in_progress (has build) | Subtasks: 1/2" in out


def test_without_a_specs_folder_nothing_is_listed(tmp_path, monkeypatch):
    monkeypatch.setattr(sc, "get_specs_dir", lambda project: tmp_path / "missing")
    assert sc.list_specs(tmp_path) == []


@pytest.fixture
def spec_runner(monkeypatch):
    calls = []
    real_run = subprocess.run

    def run(cmd, *args, **kwargs):
        if cmd[0] == sys.executable and str(cmd[1]).endswith("spec_runner.py"):
            calls.append((cmd[2:], kwargs.get("cwd")))
            return subprocess.CompletedProcess(cmd, 0)
        return real_run(cmd, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", run)
    return calls


def test_no_spec_starts_a_build_from_the_typed_task(
    tmp_path, spec_runner, monkeypatch, capsys
):
    monkeypatch.setattr("builtins.input", lambda prompt: "  add a login page ")
    sc.print_specs_list(tmp_path)
    assert spec_runner == [
        (
            ["--task", "add a login page", "--complexity", "simple", "--auto-approve"],
            tmp_path,
        )
    ]
    assert "Starting build for: add a login page" in capsys.readouterr().out


def test_no_spec_and_no_task_opens_the_interactive_mode(
    tmp_path, spec_runner, monkeypatch
):
    monkeypatch.setattr("builtins.input", lambda prompt: "")
    sc.print_specs_list(tmp_path)
    assert spec_runner == [(["--interactive"], tmp_path)]


def test_no_spec_and_a_closed_input_cancels(tmp_path, spec_runner, monkeypatch, capsys):
    def closed(prompt):
        raise EOFError

    monkeypatch.setattr("builtins.input", closed)
    sc.print_specs_list(tmp_path)
    assert spec_runner == []
    assert "Cancelled." in capsys.readouterr().out


def test_no_spec_without_auto_create_prints_the_command(tmp_path, capsys):
    sc.print_specs_list(tmp_path, auto_create=False)
    assert "python runners/spec_runner.py --interactive" in capsys.readouterr().out


def test_no_spec_runner_prints_the_command(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(sc.sys, "executable", "")
    sc.print_specs_list(tmp_path)
    assert "python runners/spec_runner.py --interactive" in capsys.readouterr().out
