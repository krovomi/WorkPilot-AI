"""runners/azure_devops/runner.py, started the way the desktop app starts it.

The app runs `python runners/azure_devops/runner.py review-pr <id> --project
<p> --repo <r> --project-dir <dir>` from `apps/backend`, passes the PAT and the
organization URL in the environment, and parses the whole stdout as one JSON
document. These runs never reach Azure: an organization URL the connector
refuses (not HTTPS) fails the review before any request. The last test runs
`main()` in this process, against the Azure Repos and model stand-ins, to see a
whole review come out of the command line.
"""

from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[3] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "azure_devops" / "runner.py"

REVIEW = ["review-pr", "7", "--project", "Shop", "--repo", "shop-web"]


def run(*argv: str, env: dict[str, str] | None = None, cwd: Path = BACKEND):
    clean = {
        k: v
        for k, v in os.environ.items()
        if k != "PYTHONPATH" and not k.startswith(("AZURE_DEVOPS_", "WORKPILOT_JEV"))
    }
    clean.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", **(env or {}))
    return subprocess.run(
        [sys.executable, str(RUNNER), *argv],
        cwd=cwd,
        env=clean,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
    )


@pytest.fixture
def project(tmp_path: Path) -> Path:
    project = tmp_path / "shop"
    project.mkdir()
    return project


UNREACHABLE = {
    "AZURE_DEVOPS_PAT": "placeholder-pat",  # pragma: allowlist secret
    "AZURE_DEVOPS_ORG_URL": "http://dev.azure.com/contoso",
}


def test_without_a_command_the_usage_is_shown_and_the_run_fails():
    done = run()

    assert done.returncode == 1
    assert "review-pr" in done.stdout


def test_a_review_without_credentials_is_refused(project):
    done = run(*REVIEW, "--project-dir", str(project))

    assert done.returncode == 1
    assert "AZURE_DEVOPS_PAT and AZURE_DEVOPS_ORG_URL must be set" in done.stderr
    assert not (project / ".workpilot").exists()


def test_the_outcome_is_the_only_thing_on_stdout(project):
    done = run(*REVIEW, "--project-dir", str(project), env=UNREACHABLE)

    assert done.returncode == 0, done.stderr
    result = json.loads(done.stdout)
    assert result["pr_id"] == 7
    assert result["success"] is False
    assert "must use HTTPS" in result["error"]
    assert (result["project"], result["repository_id"]) == ("Shop", "shop-web")
    # The progress lines went to stderr, where the app does not parse.
    assert "[AzDO] Starting review for PR #7" in done.stderr
    assert "placeholder-pat" not in done.stdout + done.stderr
    on_disk = project / ".workpilot" / "azure-devops" / "pr" / "review_7.json"
    assert json.loads(on_disk.read_text(encoding="utf-8")) == result


def test_without_a_project_dir_the_review_is_saved_where_it_runs(project):
    done = run(*REVIEW, "--model", "opus", env=UNREACHABLE, cwd=project)

    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout)["success"] is False
    assert (project / ".workpilot" / "azure-devops" / "pr" / "review_7.json").exists()


@pytest.fixture
def runner_module():
    # The runner puts its own folders first on sys.path when imported; the
    # rest of the session must not inherit that order.
    saved = list(sys.path)
    try:
        return importlib.import_module("runners.azure_devops.runner")
    finally:
        sys.path[:] = saved


def test_a_full_review_prints_its_findings_as_json(
    runner_module, project, azure, model, monkeypatch, capsys
):
    azure.change("/src/total.py")
    azure.files[("main", "/src/total.py")] = "x = 1\n"
    azure.files[("feature/checkout", "/src/total.py")] = "x = 2\n"
    model(
        "```json\n"
        + json.dumps(
            [
                {
                    "severity": "medium",
                    "category": "test",
                    "title": "No test for the new total",
                    "description": "The total changed without a test.",
                    "file": "/src/total.py",
                    "line": 1,
                }
            ]
        )
        + "\n```"
    )
    monkeypatch.setenv("AZURE_DEVOPS_PAT", azure.pat)
    monkeypatch.setenv("AZURE_DEVOPS_ORG_URL", azure.org_url)
    monkeypatch.setattr(
        sys,
        "argv",
        ["runner.py", *REVIEW, "--project-dir", str(project), "--thinking", "high"],
    )

    runner_module.main()

    out = capsys.readouterr()
    result = json.loads(out.out)
    assert result["success"] is True
    assert result["verdict"] == "needs_revision"
    assert result["overall_status"] == "request_changes"
    assert [f["title"] for f in result["findings"]] == ["No test for the new total"]
    assert "[AzDO] Review complete: 1 findings" in out.err
