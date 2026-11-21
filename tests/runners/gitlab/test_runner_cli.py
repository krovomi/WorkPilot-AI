"""runners/gitlab/runner.py, the command the app starts for a GitLab MR review.

``python runners/gitlab/runner.py --project-dir <p> review-mr <iid>`` (or
``followup-review-mr``) from ``apps/backend``: the runner finds the token
(flag, ``GITLAB_TOKEN``, glab, the project's config), the GitLab project and
its instance, runs the review and prints the outcome the app shows, with
exit code 0 or 1.

The commands that need no model are started as the app starts them, against
a local GitLab and a fake ``glab``; the ones that call a model run ``main()``
in this process with a stand-in model.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
BACKEND = ROOT / "apps" / "backend"
RUNNER = BACKEND / "runners" / "gitlab" / "runner.py"


def _fake_cli_module():
    """tests/gh_fake.py: its fake CLI answers any program's commands."""
    name = "gitlab_tests_cli_fake"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            name, ROOT / "tests" / "gh_fake.py"
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module  # its dataclasses look their module up
        spec.loader.exec_module(module)
    return sys.modules[name]


@pytest.fixture
def glab(tmp_path):
    """A fake glab, signed out until told otherwise."""
    return _fake_cli_module().write_fake_gh(
        tmp_path / "glab",
        {"--version": {"stdout": "glab 1.50.0\n"}, "auth status": {"code": 1}},
    )


@pytest.fixture
def project(tmp_path):
    project = tmp_path / "shop"
    project.mkdir()
    return project


def write_config(where: Path, **data) -> None:
    folder = where / ".workpilot" / "gitlab"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "config.json").write_text(json.dumps(data), encoding="utf-8")


def seed_review(project: Path, **fields) -> None:
    folder = project / ".workpilot" / "gitlab" / "mr"
    folder.mkdir(parents=True, exist_ok=True)
    data = {
        "mr_iid": 7,
        "project": "group/app",
        "success": True,
        "reviewed_commit_sha": "abc1234def5678",
        **fields,
    }
    (folder / "review_7.json").write_text(json.dumps(data), encoding="utf-8")


def run(project: Path, glab, *argv: str, env: dict[str, str] | None = None):
    clean = {
        k: v
        for k, v in os.environ.items()
        if k not in ("PYTHONPATH",) and not k.startswith("GITLAB_")
    }
    clean.update(
        PYTHONUTF8="1", PYTHONIOENCODING="utf-8", GITLAB_CLI_PATH=str(glab.path)
    )
    clean.update(env or {})
    return subprocess.run(
        [sys.executable, str(RUNNER), "--project-dir", str(project), *argv],
        cwd=BACKEND,
        env=clean,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
    )


class TestStartingTheRunner:
    def test_without_a_command_it_prints_the_commands_and_fails(self, project, glab):
        done = run(project, glab)

        assert done.returncode == 1
        assert "review-mr" in done.stdout
        assert "followup-review-mr" in done.stdout

    def test_without_any_token_it_says_where_to_set_one(self, project, glab):
        done = run(project, glab, "review-mr", "7")

        assert done.returncode == 1
        assert "Error: No GitLab token found." in done.stdout
        assert ["auth", "status", "-t"] in glab.calls()

    def test_without_a_project_it_says_where_to_set_one(self, project, glab):
        done = run(project, glab, "--token", "t", "review-mr", "7")

        assert done.returncode == 1
        assert "Error: No GitLab project found." in done.stdout
        assert ["auth", "status", "-t"] not in glab.calls()


class TestFindingGitLab:
    def test_the_project_config_gives_the_project_instance_and_token(
        self, project, glab, gitlab
    ):
        write_config(
            project, project=gitlab.project, instance_url=gitlab.url, token=gitlab.token
        )

        done = run(project, glab, "review-mr", "7")

        assert done.returncode == 1
        assert "Review failed: MR !7 not found in GitLab." in done.stdout
        assert gitlab.requests[0].path == f"{gitlab.api}/merge_requests/7"
        assert gitlab.requests[0].headers["private-token"] == gitlab.token

    def test_the_token_glab_is_signed_in_with_is_used(self, project, glab, gitlab):
        glab.answer(
            {
                "--version": {"stdout": "glab 1.50.0\n"},
                "auth status": {
                    "stderr": f"gitlab.com\n  ✓ Logged in as ann\n  ✓ Token: {gitlab.token}\n"
                },
            }
        )
        write_config(project, project=gitlab.project, instance_url=gitlab.url)

        done = run(project, glab, "review-mr", "7")

        assert "not found in GitLab" in done.stdout, done.stderr
        assert gitlab.requests[0].headers["private-token"] == gitlab.token

    def test_a_glab_report_without_a_token_gives_none(self, project, glab):
        glab.answer(
            {
                "--version": {"stdout": "glab 1.50.0\n"},
                "auth status": {"stdout": "gitlab.com\n  ✓ Logged in as ann\n"},
            }
        )
        write_config(project, project="group/app")

        done = run(project, glab, "review-mr", "7")

        assert "Error: No GitLab token found." in done.stdout

    def test_the_environment_names_a_self_hosted_instance(self, project, glab, gitlab):
        done = run(
            project,
            glab,
            "review-mr",
            "7",
            env={
                "GITLAB_TOKEN": gitlab.token,
                "GITLAB_PROJECT": gitlab.project,
                "GITLAB_INSTANCE_URL": gitlab.url,
            },
        )

        assert "not found in GitLab" in done.stdout, done.stdout + done.stderr
        assert len(gitlab.requests) == 1

    def test_the_instance_flag_wins_over_the_project_config(
        self, project, glab, gitlab
    ):
        write_config(
            project,
            project=gitlab.project,
            instance_url="http://127.0.0.1:9",
            token="t",
        )

        done = run(project, glab, "--instance", gitlab.url, "review-mr", "7")

        assert "not found in GitLab" in done.stdout
        assert len(gitlab.requests) == 1

    def test_a_broken_project_config_is_reported_and_the_environment_used(
        self, project, glab, gitlab
    ):
        folder = project / ".workpilot" / "gitlab"
        folder.mkdir(parents=True)
        (folder / "config.json").write_text("{broken", encoding="utf-8")

        done = run(
            project,
            glab,
            "--token",
            gitlab.token,
            "--instance",
            gitlab.url,
            "review-mr",
            "7",
            env={"GITLAB_PROJECT": gitlab.project},
        )

        assert "Warning: Failed to read GitLab config" in done.stderr
        assert "not found in GitLab" in done.stdout


class TestAFollowUpFromTheCommandLine:
    def test_without_a_first_review_it_says_so(self, project, glab, gitlab):
        done = run(
            project,
            glab,
            "--token",
            "t",
            "--project",
            gitlab.project,
            "followup-review-mr",
            "7",
        )

        assert done.returncode == 1
        assert (
            "Follow-up review failed: No previous review found for MR !7" in done.stdout
        )

    def test_without_new_commits_the_previous_findings_are_shown(
        self, project, glab, gitlab
    ):
        seed_review(
            project,
            overall_status="request_changes",
            verdict="blocked",
            summary="x",
            findings=[
                {
                    "id": "finding-1",
                    "severity": "high",
                    "category": "security",
                    "title": "Token in logs",
                    "description": "d",
                    "file": "app/log.py",
                    "line": 12,
                }
            ],
        )
        gitlab.serve_mr(7)

        done = run(
            project,
            glab,
            "--token",
            gitlab.token,
            "--project",
            gitlab.project,
            "--instance",
            gitlab.url,
            "followup-review-mr",
            "7",
        )

        assert done.returncode == 0, done.stdout + done.stderr
        assert "MR !7 Follow-up Review Complete" in done.stdout
        assert "Status: request_changes" in done.stdout
        assert "Is Follow-up: True" in done.stdout
        assert "Still Open: 1 finding(s)" in done.stdout
        assert "  * [HIGH] Token in logs" in done.stdout
        assert "    File: app/log.py:12" in done.stdout

    def test_a_corrupt_saved_review_is_reported(self, project, glab):
        folder = project / ".workpilot" / "gitlab" / "mr"
        folder.mkdir(parents=True)
        (folder / "review_7.json").write_text("{", encoding="utf-8")

        done = run(
            project, glab, "--token", "t", "--project", "g/a", "followup-review-mr", "7"
        )

        assert done.returncode == 1
        assert "Follow-up review failed: Expecting property name" in done.stdout


def test_a_project_folder_that_cannot_hold_reviews_is_reported(tmp_path, glab):
    not_a_folder = tmp_path / "shop.txt"
    not_a_folder.write_text("", encoding="utf-8")

    done = run(not_a_folder, glab, "--token", "t", "--project", "g/a", "review-mr", "7")

    assert done.returncode == 1
    assert "Error: " in done.stdout
    assert "Traceback" in done.stderr


# ---------------------------------------------------------------------------
# The commands that call a model, in this process
# ---------------------------------------------------------------------------


@pytest.fixture
def runner():
    saved = list(sys.path)
    try:
        yield importlib.import_module("runners.gitlab.runner")
    finally:
        sys.path[:] = saved


@pytest.fixture
def main(runner, monkeypatch, gitlab, project, capsys):
    for name in ("GITLAB_TOKEN", "GITLAB_PROJECT", "GITLAB_INSTANCE_URL"):
        monkeypatch.delenv(name, raising=False)

    def start(*argv: str) -> tuple[int, str]:
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "runner.py",
                "--project-dir",
                str(project),
                "--token",
                gitlab.token,
                "--project",
                gitlab.project,
                "--instance",
                gitlab.url,
                *argv,
            ],
        )
        with pytest.raises(SystemExit) as done:
            runner.main()
        return done.value.code, capsys.readouterr().out

    return start


class TestAReviewFromTheCommandLine:
    def test_the_findings_are_printed_by_severity(self, main, gitlab, model, llm):
        gitlab.serve_mr(7)
        model(
            llm.says(
                llm.review(
                    "needs_revision",
                    [
                        llm.finding("Unbounded loop", "critical"),
                        llm.finding("Rename x", "low"),
                    ],
                )
            )
        )

        code, out = main("--model", "m", "--thinking-level", "high", "review-mr", "7")

        assert code == 0
        assert "MR !7 Review Complete" in out
        assert "Status: request_changes" in out
        assert "Verdict: needs_revision" in out
        assert "Findings: 2" in out
        assert "  ! [CRITICAL] Unbounded loop" in out
        assert "  . [LOW] Rename x" in out
        assert "[MR !7] [100%] Review complete!" in out

    def test_a_clean_review_prints_no_findings(self, main, gitlab, model, llm):
        gitlab.serve_mr(7)
        model(llm.says(llm.review()))

        code, out = main("review-mr", "7")

        assert code == 0
        assert "Findings: 0" in out
        assert "Findings by severity" not in out

    def test_a_failed_review_exits_with_one(self, main, gitlab, model):
        gitlab.serve_mr(7)
        model(fail=ConnectionError("provider down"))

        code, out = main("review-mr", "7")

        assert code == 1
        assert "Review failed: RuntimeError: Review failed: provider down" in out

    def test_an_interrupted_review_exits_with_one(self, main, gitlab, model):
        gitlab.serve_mr(7)
        model(fail=KeyboardInterrupt())

        code, out = main("review-mr", "7")

        assert code == 1
        assert "Interrupted." in out


class TestAFollowUpWithNewCommits:
    def test_resolved_open_and_new_findings_are_counted(
        self, main, gitlab, model, llm, project
    ):
        def old(title):
            return {
                "id": title,
                "severity": "medium",
                "category": "quality",
                "title": title,
                "description": "",
                "file": "a.py",
                "line": 1,
            }

        seed_review(project, findings=[old("Fixed"), old("Still")])
        gitlab.serve_mr(7, sha="0ddc0ffee")
        model(
            llm.says(
                llm.review(
                    "merge_with_changes",
                    [llm.finding("Still"), llm.finding("New", "high")],
                )
            )
        )

        code, out = main("followup-review-mr", "7")

        assert code == 0
        assert "Resolved: 1 finding(s)" in out
        assert "Still Open: 1 finding(s)" in out
        assert "New Issues: 1 finding(s)" in out
        assert "Remaining Findings:" in out
        assert "  * [HIGH] New" in out

    def test_a_follow_up_that_finds_nothing_lists_nothing(
        self, main, gitlab, model, llm, project
    ):
        seed_review(project)
        gitlab.serve_mr(7, sha="0ddc0ffee")
        model(llm.says(llm.review()))

        code, out = main("followup-review-mr", "7")

        assert code == 0
        assert "Is Follow-up: True" in out
        assert "Resolved:" not in out and "New Issues:" not in out
        assert "Remaining Findings:" not in out

    def test_a_failed_follow_up_exits_with_one(self, main, gitlab, model, project):
        seed_review(project)
        gitlab.serve_mr(7, sha="0ddc0ffee")
        model(fail=ConnectionError("provider down"))

        code, out = main("followup-review-mr", "7")

        assert code == 1
        assert (
            "Follow-up review failed: RuntimeError: Review failed: provider down" in out
        )


class TestFindingTheToken:
    def args(self, runner, project, **values):
        import argparse

        defaults = {
            "token": None,
            "project": "g/a",
            "instance": None,
            "project_dir": project,
            "model": "m",
            "thinking_level": "low",
        }
        return argparse.Namespace(**{**defaults, **values})

    def test_without_glab_there_is_no_token(self, runner, project, monkeypatch, capsys):
        monkeypatch.delenv("GITLAB_TOKEN", raising=False)
        finder = importlib.import_module("core.glab_executable")
        monkeypatch.setattr(finder, "get_glab_executable", lambda: None)

        with pytest.raises(SystemExit):
            runner.get_config(self.args(runner, project))

        assert "No GitLab token found" in capsys.readouterr().out

    def test_a_glab_that_cannot_start_gives_no_token(
        self, runner, project, monkeypatch, tmp_path, capsys
    ):
        monkeypatch.delenv("GITLAB_TOKEN", raising=False)
        finder = importlib.import_module("core.glab_executable")
        monkeypatch.setattr(
            finder, "get_glab_executable", lambda: str(tmp_path / "missing-glab")
        )

        with pytest.raises(SystemExit):
            runner.get_config(self.args(runner, project))

        assert "No GitLab token found" in capsys.readouterr().out

    def test_the_instance_defaults_to_gitlab_com(self, runner, project, monkeypatch):
        monkeypatch.delenv("GITLAB_INSTANCE_URL", raising=False)

        config = runner.get_config(self.args(runner, project, token="t"))

        assert config.instance_url == "https://gitlab.com"
        assert (config.model, config.thinking_level) == ("m", "low")

    def test_progress_without_an_mr_has_no_prefix(self, runner, capsys):
        runner.print_progress(runner.ProgressCallback("setup", 5, "Starting"))

        assert capsys.readouterr().out == "[  5%] Starting\n"
