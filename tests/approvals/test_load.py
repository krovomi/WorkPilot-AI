"""Loading the policy: main checkout only, app setting and file mode combined."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from approvals.load import app_mode, effective_mode, load_approval_policy
from security.guardrail_policy import load_policy

RUNNER = (
    Path(__file__).resolve().parents[2]
    / "apps"
    / "backend"
    / "runners"
    / "approvals_runner.py"
)


@pytest.mark.parametrize(
    ("env", "mode"),
    [
        ({}, "observe"),
        ({"WORKPILOT_APPROVALS": "OFF"}, "off"),
        ({"WORKPILOT_APPROVALS": "enforce"}, "enforce"),
        ({"WORKPILOT_APPROVALS": "yes"}, "observe"),
    ],
)
def test_app_mode(env, mode):
    assert app_mode(env) == mode


@pytest.mark.parametrize(
    ("app", "file", "mode"),
    [
        ("enforce", "", "enforce"),
        ("enforce", "observe", "observe"),
        ("enforce", "off", "off"),
        ("observe", "enforce", "observe"),
        ("off", "enforce", "off"),
    ],
)
def test_the_file_can_only_restrict_the_app_setting(app, file, mode):
    assert effective_mode(app, file) == mode


def test_without_a_file_the_built_ins_run_in_the_app_mode(tmp_path):
    policy = load_approval_policy(tmp_path, env={"WORKPILOT_APPROVALS": "enforce"})
    assert policy.mode == "enforce" and not policy.declared and policy.errors == ()


def test_the_file_section_and_requires_review_are_read(tmp_path):
    (tmp_path / "workpilot.policy.yaml").write_text(
        "version: 1\nfiles:\n  requires_review: ['infra/**']\napprovals:\n  mode: observe\n  limits:\n    max_files: 3\n",
        encoding="utf-8",
    )
    policy = load_approval_policy(tmp_path, env={"WORKPILOT_APPROVALS": "enforce"})
    assert policy.mode == "observe" and policy.max_files == 3
    assert policy.requires_review == ("infra/**",)
    assert policy.source == "workpilot.policy.yaml"


@pytest.mark.parametrize(
    "text", ["approvals: [", "- a\n- b\n", "approvals:\n  mode: always\n"]
)
def test_an_unreadable_or_wrong_file_is_an_error(tmp_path, text):
    (tmp_path / "workpilot.policy.yaml").write_text(text, encoding="utf-8")
    assert load_approval_policy(tmp_path, env={}).errors


def test_the_guardrails_accept_the_section_in_the_repository_layer_only(tmp_path):
    (tmp_path / "workpilot.policy.yaml").write_text(
        "version: 1\napprovals:\n  mode: observe\n", encoding="utf-8"
    )
    assert load_policy(tmp_path).errors == []
    project = tmp_path / "other"
    (project / ".workpilot").mkdir(parents=True)
    (project / ".workpilot" / "guardrails.yaml").write_text(
        "version: 1\napprovals:\n  mode: observe\n", encoding="utf-8"
    )
    errors = load_policy(project).errors
    assert any("only read from workpilot.policy.yaml" in e for e in errors)


def test_a_wrong_approvals_section_does_not_stop_the_agents(tmp_path):
    (tmp_path / "workpilot.policy.yaml").write_text(
        "version: 1\napprovals:\n  mode: always\n", encoding="utf-8"
    )
    assert load_policy(tmp_path).errors == []
    assert load_approval_policy(tmp_path, env={}).errors


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
    )


def test_the_runner_prints_the_decision(tmp_path):
    _git(tmp_path, "init", "-q", "-b", "main")
    (tmp_path / "package.json").write_text(
        '{"dependencies": {"vite": "7.1.2"}}\n', encoding="utf-8"
    )
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-qm", "base")
    _git(tmp_path, "checkout", "-qb", "bump")
    (tmp_path / "package.json").write_text(
        '{"dependencies": {"vite": "7.1.3"}}\n', encoding="utf-8"
    )
    _git(tmp_path, "commit", "-qam", "bump")
    result = subprocess.run(
        [
            sys.executable,
            str(RUNNER),
            "--project-dir",
            str(tmp_path),
            "--base-branch",
            "main",
            "--title",
            "chore(deps): bump vite from 7.1.2 to 7.1.3",
            "--ci",
            "green",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={
            "PATH": __import__("os").environ.get("PATH", ""),
            "WORKPILOT_APPROVALS": "enforce",
        },
        check=False,
    )
    decision = json.loads(result.stdout)["decision"]
    assert result.returncode == 0
    assert (decision["tier"], decision["action"], decision["merges"]) == (
        "N0",
        "merge",
        True,
    )


def test_the_runner_reports_an_error_outside_git(tmp_path):
    result = subprocess.run(
        [
            sys.executable,
            str(RUNNER),
            "--project-dir",
            str(tmp_path),
            "--base-branch",
            "main",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert result.returncode == 1
    assert "error" in json.loads(result.stdout)
