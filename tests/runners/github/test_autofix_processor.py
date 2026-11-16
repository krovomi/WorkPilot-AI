"""Auto-fix: an issue labelled for it is queued for a spec, if the right person asked.

`AutoFixProcessor` (runners/github/services/autofix_processor.py) checks who
added the trigger label (a maintainer, not whoever opened the issue), records
the auto-fix state under `.workpilot/github/issues/` and hands the issue to
spec creation. It also lists the queue and finds newly labelled issues for the
desktop app. GitHub is a fake `gh` (conftest's `gh`); permissions go through
the real `GitHubPermissionChecker`.
"""

from __future__ import annotations

import asyncio
import json
import sys
import types
from dataclasses import dataclass

import pytest
from runners.github.gh_client import GHClient
from runners.github.models import AutoFixState, AutoFixStatus, GitHubRunnerConfig
from runners.github.permissions import GitHubPermissionChecker
from runners.github.services.autofix_processor import AutoFixProcessor


def labelled_by(login: str, label: str = "auto-fix") -> dict:
    return {
        "stdout": json.dumps(
            [
                {"event": "labeled", "label": {"name": "bug"}, "actor": {"login": "x"}},
                {
                    "event": "labeled",
                    "label": {"name": label},
                    "actor": {"login": login},
                },
            ]
        )
    }


MAINTAINER = {
    "api /repos/own/repo/issues/5/events": labelled_by("ann"),
    "api /repos/own/repo/collaborators/ann/permission": {
        "stdout": json.dumps({"permission": "admin"})
    },
}
STRANGER = {
    "api /repos/own/repo/issues/5/events": labelled_by("eve"),
    "api /repos/own/repo/collaborators/eve/permission": {"code": 1},
    "api /repos/own/repo": {"stdout": json.dumps({"owner": {"type": "User"}})},
    "api /repos/own/repo/contributors": {"stdout": "[]"},
}


@pytest.fixture(autouse=True)
def package_orchestrator(monkeypatch):
    # The runner's bare-named copy, when an earlier test loaded the runner.
    monkeypatch.delitem(sys.modules, "orchestrator", raising=False)


@pytest.fixture
def github_dir(tmp_path):
    return tmp_path / ".workpilot" / "github"


@pytest.fixture
def progress():
    return []


def processor(tmp_path, github_dir, progress, enabled=True) -> AutoFixProcessor:
    config = GitHubRunnerConfig(token="t", repo="own/repo", auto_fix_enabled=enabled)
    checker = GitHubPermissionChecker(
        gh_client=GHClient(project_dir=tmp_path, repo="own/repo"),
        repo="own/repo",
        allowed_roles=config.auto_fix_allowed_roles,
    )
    return AutoFixProcessor(
        github_dir, config, checker, progress_callback=progress.append
    )


def test_a_maintainer_s_label_queues_the_issue_for_a_spec(
    gh, tmp_path, github_dir, progress, capsys
):
    gh.answer(MAINTAINER)
    state = asyncio.run(
        processor(tmp_path, github_dir, progress).process_issue(5, {}, "auto-fix")
    )
    assert state.status is AutoFixStatus.CREATING_SPEC
    assert state.issue_url == "https://github.com/own/repo/issues/5"
    assert AutoFixState.load(github_dir, 5).status is AutoFixStatus.CREATING_SPEC
    assert [(p.phase, p.progress) for p in progress] == [
        ("fetching", 10),
        ("verifying", 15),
        ("analyzing", 30),
        ("complete", 100),
    ]
    assert all(p.issue_number == 5 for p in progress)
    assert "Auto-fix authorized for #5 (triggered by ann, role: COLLABORATOR)" in (
        capsys.readouterr().out
    )


def test_without_a_trigger_label_nobody_is_checked(gh, tmp_path, github_dir, progress):
    state = asyncio.run(processor(tmp_path, github_dir, progress).process_issue(5, {}))
    assert state.status is AutoFixStatus.CREATING_SPEC
    assert gh.calls() == []


def test_a_stranger_s_label_is_refused_and_nothing_is_queued(
    gh, tmp_path, github_dir, progress, capsys
):
    gh.answer(STRANGER)
    with pytest.raises(PermissionError, match="Auto-fix not authorized: User eve"):
        asyncio.run(
            processor(tmp_path, github_dir, progress).process_issue(5, {}, "auto-fix")
        )
    assert AutoFixState.load(github_dir, 5) is None
    assert "Auto-fix denied for #5" in capsys.readouterr().out


def test_a_refused_retry_leaves_the_finished_run_on_record(
    gh, tmp_path, github_dir, progress
):
    done = AutoFixState(
        issue_number=5,
        issue_url="u",
        repo="own/repo",
        status=AutoFixStatus.COMPLETED,
        pr_number=40,
    )
    asyncio.run(done.save(github_dir))
    gh.answer(STRANGER)
    with pytest.raises(PermissionError):
        asyncio.run(
            processor(tmp_path, github_dir, progress).process_issue(5, {}, "auto-fix")
        )
    kept = AutoFixState.load(github_dir, 5)
    assert (kept.status, kept.pr_number, kept.error) == (
        AutoFixStatus.COMPLETED,
        40,
        None,
    )


def test_an_issue_already_in_progress_is_returned_as_it_is(
    gh, tmp_path, github_dir, progress
):
    asyncio.run(
        AutoFixState(
            issue_number=5,
            issue_url="u",
            repo="own/repo",
            status=AutoFixStatus.BUILDING,
        ).save(github_dir)
    )
    state = asyncio.run(
        processor(tmp_path, github_dir, progress).process_issue(5, {}, "auto-fix")
    )
    assert state.status is AutoFixStatus.BUILDING
    assert gh.calls() == []


def test_a_run_that_breaks_after_starting_is_marked_failed(tmp_path, github_dir):
    def callback(update):
        if update.phase == "complete":
            raise RuntimeError("the app went away")

    config = GitHubRunnerConfig(token="t", repo="own/repo")
    autofix = AutoFixProcessor(github_dir, config, None, progress_callback=callback)
    with pytest.raises(RuntimeError, match="the app went away"):
        asyncio.run(autofix.process_issue(5, {}))
    failed = AutoFixState.load(github_dir, 5)
    assert (failed.status, failed.error) == (AutoFixStatus.FAILED, "the app went away")


def test_progress_uses_the_runner_s_orchestrator_when_it_is_loaded(
    tmp_path, github_dir, monkeypatch
):
    @dataclass
    class RunnerProgress:
        phase: str
        progress: int
        message: str
        issue_number: int | None = None

    monkeypatch.setitem(
        sys.modules,
        "orchestrator",
        types.SimpleNamespace(ProgressCallback=RunnerProgress),
    )
    seen = []
    config = GitHubRunnerConfig(token="t", repo="own/repo")
    asyncio.run(
        AutoFixProcessor(github_dir, config, None, seen.append).process_issue(6, {})
    )
    assert seen and all(isinstance(update, RunnerProgress) for update in seen)


def test_without_a_callback_nothing_is_reported(tmp_path, github_dir):
    config = GitHubRunnerConfig(token="t", repo="own/repo")
    state = asyncio.run(AutoFixProcessor(github_dir, config, None).process_issue(6, {}))
    assert state.status is AutoFixStatus.CREATING_SPEC


def test_the_queue_lists_the_newest_first_and_skips_unreadable_files(
    tmp_path, github_dir, progress
):
    autofix = processor(tmp_path, github_dir, progress)
    assert asyncio.run(autofix.get_queue()) == []
    for number, created in ((1, "2026-11-01"), (2, "2026-11-03"), (3, "2026-11-02")):
        state = AutoFixState(issue_number=number, issue_url="u", repo="own/repo")
        state.created_at = created
        asyncio.run(state.save(github_dir))
    issues = github_dir / "issues"
    (issues / "autofix_notes.json").write_text("{}", encoding="utf-8")
    (issues / "autofix_9.json").write_text("{broken", encoding="utf-8")
    # Its number reads as 7, but the state of #7 lives in autofix_7.json.
    (issues / "autofix_007.json").write_text("{}", encoding="utf-8")
    assert [s.issue_number for s in asyncio.run(autofix.get_queue())] == [2, 3, 1]


ISSUES = [
    {"number": 5, "title": "Crash", "labels": [{"name": "Auto-Fix"}]},
    {"number": 6, "title": "Typo", "labels": [{"name": "docs"}]},
    {"number": 7, "title": "Busy", "labels": [{"name": "auto-fix"}]},
    {"number": 8, "labels": [{"name": "auto-fix"}]},
]


def test_newly_labelled_issues_are_found_case_blind(tmp_path, github_dir, progress):
    autofix = processor(tmp_path, github_dir, progress)
    asyncio.run(
        AutoFixState(
            issue_number=7,
            issue_url="u",
            repo="own/repo",
            status=AutoFixStatus.BUILDING,
        ).save(github_dir)
    )
    asyncio.run(
        AutoFixState(
            issue_number=8, issue_url="u", repo="own/repo", status=AutoFixStatus.FAILED
        ).save(github_dir)
    )
    found = asyncio.run(autofix.check_labeled_issues(ISSUES, verify_permissions=False))
    assert found == [
        {"issue_number": 5, "trigger_label": "auto-fix", "title": "Crash"},
        {"issue_number": 8, "trigger_label": "auto-fix", "title": ""},
    ]


def test_with_auto_fix_off_no_issue_is_found(tmp_path, github_dir, progress):
    autofix = processor(tmp_path, github_dir, progress, enabled=False)
    assert asyncio.run(autofix.check_labeled_issues(ISSUES)) == []


def test_only_labels_a_maintainer_added_count(
    gh, tmp_path, github_dir, progress, capsys
):
    gh.answer(
        {
            **MAINTAINER,
            "api /repos/own/repo/issues/8/events": labelled_by("eve"),
            **{k: v for k, v in STRANGER.items() if "events" not in k},
            "api /repos/own/repo/issues/7/events": {"stderr": "HTTP 500", "code": 1},
        }
    )
    found = asyncio.run(
        processor(tmp_path, github_dir, progress).check_labeled_issues(ISSUES)
    )
    assert [f["issue_number"] for f in found] == [5]
    out = capsys.readouterr().out
    assert "[PERMISSION] #5 authorized (by ann, role: COLLABORATOR)" in out
    assert "[PERMISSION] Error checking #7" in out
    assert "[PERMISSION] Skipping #8: User eve has role 'NONE'" in out
