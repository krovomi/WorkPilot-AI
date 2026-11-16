"""The small `run.py` commands: onboarding, steering, self-healing, verify."""

from __future__ import annotations

import subprocess

import pytest
from cli import onboarding_commands, self_healing_commands, steer_command
from cli import verify_commands as vc
from foundation.steering import load_messages


def _commit(repo, rel, text):
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    subprocess.run(["git", "add", rel], cwd=repo, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", f"add {rel}"], cwd=repo, check=True, capture_output=True
    )


# --- onboarding ------------------------------------------------------------


def test_onboarding_guide_is_printed_or_written(temp_git_repo, tmp_path, capsys):
    _commit(temp_git_repo, "app/main.py", "def main():\n    return 1\n")

    onboarding_commands.handle_onboard_command(temp_git_repo)
    printed = capsys.readouterr().out

    out = tmp_path / "out" / "deep" / "guide.md"
    onboarding_commands.handle_onboard_command(temp_git_repo, out)
    summary = capsys.readouterr().out

    assert printed.startswith("#")
    assert out.read_text(encoding="utf-8").strip() == printed.strip()
    assert f"Onboarding guide written to {out}" in summary
    assert "tour step(s)" in summary and "glossary term(s)" in summary


# --- steering --------------------------------------------------------------


def test_a_steering_message_reaches_both_copies_of_the_spec(tmp_path, capsys):
    spec = tmp_path / ".workpilot" / "specs" / "001-x"
    spec.mkdir(parents=True)
    copy = tmp_path / ".workpilot/worktrees/tasks/001-x/.workpilot/specs/001-x"
    copy.mkdir(parents=True)

    assert steer_command.handle_steer_command(tmp_path, spec, "use the cache", "2.1")

    [message] = [m for m in load_messages(spec, copy) if not m.delivered]
    assert message.text == "use the cache"
    assert message.target_subtask_id == "2.1"
    out = capsys.readouterr().out
    assert "for subtask 2.1" in out and "(1 message(s) waiting)" in out


def test_the_legacy_worktree_folder_is_found(tmp_path):
    legacy = tmp_path / ".worktrees/002-y/.workpilot/specs/002-y"
    legacy.mkdir(parents=True)
    assert steer_command._worktree_spec_dir(tmp_path, "002-y") == legacy
    assert steer_command._worktree_spec_dir(tmp_path, "003-z") is None


def test_an_empty_steering_message_is_refused(tmp_path, capsys):
    spec = tmp_path / "spec"
    spec.mkdir()
    assert steer_command.handle_steer_command(tmp_path, spec, "   ") is False
    assert "Message not sent" in capsys.readouterr().out


# --- self-healing ----------------------------------------------------------


class _FakeRunner:
    calls: list = []
    result = True

    def __init__(self, project_dir):
        self.project_dir = project_dir

    async def run_cicd(self, commit_sha, branch):
        self.calls.append(("cicd", commit_sha, branch))
        return self.result

    async def run_proactive(self):
        self.calls.append(("proactive",))
        return self.result

    def run_dashboard(self):
        self.calls.append(("dashboard",))
        return self.result


@pytest.fixture
def runner(monkeypatch):
    from runners import self_healing_runner

    _FakeRunner.calls = []
    _FakeRunner.result = True
    monkeypatch.setattr(self_healing_runner, "SelfHealingRunner", _FakeRunner)
    return _FakeRunner


def test_cicd_healing_runs_on_the_current_commit(temp_git_repo, runner, capsys):
    _commit(temp_git_repo, "a.txt", "a\n")
    subprocess.run(
        ["git", "checkout", "-b", "feature/x"],
        cwd=temp_git_repo,
        check=True,
        capture_output=True,
    )
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=temp_git_repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()

    self_healing_commands.handle_self_healing_command(temp_git_repo, "cicd")

    assert runner.calls == [("cicd", head, "feature/x")]
    assert f"commit {head[:7]} on feature/x" in capsys.readouterr().out


def test_cicd_healing_outside_a_repository_stops(tmp_path, runner, capsys):
    with pytest.raises(SystemExit) as stop:
        self_healing_commands.handle_self_healing_command(tmp_path, "cicd")
    assert stop.value.code == 1
    assert runner.calls == []
    assert "Could not determine current commit" in capsys.readouterr().out
    assert self_healing_commands._get_current_branch(tmp_path) == "main"


def test_without_git_the_commit_and_branch_fall_back(tmp_path, monkeypatch):
    def no_git(*_args, **_kwargs):
        raise FileNotFoundError("git")

    monkeypatch.setattr(self_healing_commands.subprocess, "run", no_git)
    assert self_healing_commands._get_current_commit(tmp_path) is None
    assert self_healing_commands._get_current_branch(tmp_path) == "main"


@pytest.mark.parametrize("mode", ["proactive", "dashboard"])
def test_each_mode_calls_its_runner(tmp_path, runner, mode):
    self_healing_commands.handle_self_healing_command(tmp_path, mode)
    assert runner.calls == [(mode,)]


@pytest.mark.parametrize("mode", ["proactive", "dashboard"])
def test_a_failed_run_exits_non_zero(temp_git_repo, runner, mode):
    runner.result = False
    with pytest.raises(SystemExit) as stop:
        self_healing_commands.handle_self_healing_command(temp_git_repo, mode)
    assert stop.value.code == 1


def test_a_failed_cicd_healing_exits_non_zero(temp_git_repo, runner):
    _commit(temp_git_repo, "a.txt", "a\n")
    runner.result = False
    with pytest.raises(SystemExit):
        self_healing_commands.handle_self_healing_command(temp_git_repo, "cicd")


def test_the_dashboard_is_shown_from_the_real_runner(tmp_path, capsys):
    """`--self-heal` defaults to the dashboard, which the runner shows
    synchronously: the command used to hand its bool to `asyncio.run`."""
    self_healing_commands.handle_self_healing_command(tmp_path, "dashboard")
    assert "Self-Healing Dashboard" in capsys.readouterr().out


def test_an_unknown_mode_is_refused(tmp_path, runner, capsys):
    with pytest.raises(SystemExit):
        self_healing_commands.handle_self_healing_command(tmp_path, "nightly")
    assert "Valid modes: cicd, proactive, dashboard" in capsys.readouterr().out
    assert runner.calls == []


# --- verify ----------------------------------------------------------------


@pytest.fixture
def verify_seams(monkeypatch):
    import verify.git
    import verify.loop
    import verify.phase
    import workflows.runner

    seen: dict = {}

    def make_agent_runner(code_dir, spec_dir, *, model, provider, verbose):
        seen["runner"] = (code_dir, spec_dir, model, provider, verbose)
        return "agent-runner"

    async def run_verify_loop(code_dir, spec_dir, runner, options):
        seen["loop"] = (code_dir, spec_dir, runner, options)
        options.log("started")
        return seen.get("record", {"status": "passed", "score": 92})

    monkeypatch.setattr(verify.phase, "make_agent_runner", make_agent_runner)
    monkeypatch.setattr(verify.loop, "run_verify_loop", run_verify_loop)
    monkeypatch.setattr(verify.git, "changed_files", lambda d: ["a.py"])
    monkeypatch.setattr(
        workflows.runner, "phase_provider", lambda spec, phase: (None, "")
    )
    monkeypatch.setattr(
        workflows.runner,
        "find_skill_body",
        lambda root, pack, skill, provider: seen.get("skill"),
    )
    return seen


def test_verify_runs_in_the_task_worktree_when_there_is_one(
    tmp_path, verify_seams, capsys
):
    spec = tmp_path / ".workpilot/specs/001-x"
    spec.mkdir(parents=True)
    worktree = tmp_path / ".workpilot/worktrees/tasks/001-x"
    local_spec = worktree / ".workpilot/specs/001-x"
    local_spec.mkdir(parents=True)
    verify_seams["skill"] = ("Run the app.", tmp_path / "SKILL.md", {})

    record = vc.handle_verify_command(tmp_path, spec, "m-1", effort="high")

    assert record == {"status": "passed", "score": 92}
    code_dir, spec_dir, runner, options = verify_seams["loop"]
    assert (code_dir, spec_dir, runner) == (worktree, local_spec, "agent-runner")
    assert verify_seams["runner"] == (worktree, local_spec, "m-1", None, False)
    assert (options.model, options.effort, options.provider) == ("m-1", "high", "")
    assert options.skill_body == "Run the app."
    assert options.changed_files == ["a.py"]
    out = capsys.readouterr().out
    assert "provider: default" in out
    assert "  started" in out
    assert "Verify: passed (score 92/100)" in out
    assert str(local_spec / "verify" / "report.md") in out


def test_verify_without_a_worktree_runs_in_the_project(tmp_path, verify_seams, capsys):
    spec = tmp_path / "spec"
    spec.mkdir()
    verify_seams["record"] = {"status": "failed", "reason": "app did not start"}

    record = vc.handle_verify_command(tmp_path, spec, None)

    assert record["status"] == "failed"
    code_dir, spec_dir, _runner, options = verify_seams["loop"]
    assert (code_dir, spec_dir, options.model, options.skill_body) == (
        tmp_path,
        spec,
        "",
        "",
    )
    assert "Verify: failed — app did not start" in capsys.readouterr().out
