"""The batch steps behind the GitHub view's issue batching wizard.

`BatchProcessor` (runners/github/services/batch_processor.py) is what the
runner's `batch-issues`, `analyze-preview`, `approve-batches`, `batch-status`
and `process-batches` commands reach through the orchestrator: batch the open
issues and queue each batch's primary issue for auto-fix, preview the batches
without creating them, create the batches a person approved, report them, and
move pending ones on.

What stands in: the model (`batch_model` in conftest.py). The batches, the
batch index and the auto-fix states are real files under tmp_path.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import sys

import pytest
from runners.github.batch_issues import BatchStatus, IssueBatch, IssueBatchItem
from runners.github.models import AutoFixState, AutoFixStatus, GitHubRunnerConfig
from runners.github.services.batch_processor import BatchProcessor


def issue(number, title, labels=("bug",), body=""):
    return {
        "number": number,
        "title": title,
        "body": body,
        "labels": [{"name": name} for name in labels],
    }


LOGIN = [
    issue(1, "Login fails on Safari", body="Since 2.3"),
    issue(2, "Login fails on Firefox"),
    issue(3, "Login fails on Edge"),
]


def grouping(*groups):
    reply = json.dumps({"batches": [{"issue_numbers": list(g)} for g in groups]})
    return lambda _prompt: reply


@pytest.fixture
def processor(tmp_path, monkeypatch):
    project = tmp_path / "project"
    github_dir = project / ".workpilot" / "github"
    github_dir.mkdir(parents=True)
    events: list = []
    # Which module the progress events come from depends on which layout
    # loaded the orchestrator first; the package one, here.
    monkeypatch.delitem(sys.modules, "orchestrator", raising=False)

    def make(report_progress=True):
        return BatchProcessor(
            project_dir=project,
            github_dir=github_dir,
            config=GitHubRunnerConfig(token="placeholder", repo="own/repo"),
            progress_callback=events.append if report_progress else None,
        )

    make.github_dir = github_dir
    make.events = events
    return make


def autofix(github_dir, number, status):
    state = AutoFixState(
        issue_number=number,
        issue_url=f"https://github.com/own/repo/issues/{number}",
        repo="own/repo",
        status=status,
    )
    asyncio.run(state.save(github_dir))


# ---------------------------------------------------------------------------
# Batch and queue
# ---------------------------------------------------------------------------


def test_no_issues_make_no_batches(processor, batch_model):
    assert asyncio.run(processor().batch_and_fix_issues([], None)) == []
    assert [(e.phase, e.progress) for e in processor.events] == [("batching", 10)]
    assert batch_model.prompts == []


def test_issues_are_batched_and_each_primary_issue_queued_for_auto_fix(
    processor, batch_model
):
    batch_model.answers["batch_analysis"] = grouping([1, 2, 3])

    batches = asyncio.run(processor().batch_and_fix_issues(LOGIN, None))

    [batch] = batches
    assert batch.get_issue_numbers() == [1, 2, 3]
    assert batch.status is BatchStatus.ANALYZING
    assert batch.validated and batch.validation_reasoning == "same root cause"
    saved = IssueBatch.load(processor.github_dir, batch.batch_id)
    assert saved.status is BatchStatus.ANALYZING
    state = AutoFixState.load(processor.github_dir, batch.primary_issue)
    assert state.status is AutoFixStatus.ANALYZING
    assert (
        state.issue_url == f"https://github.com/own/repo/issues/{batch.primary_issue}"
    )
    assert [(e.phase, e.progress) for e in processor.events] == [
        ("batching", 10),
        ("batching", 20),
        ("batching", 40),
        ("batching", 60),
        ("batching", 60),
        ("complete", 100),
    ]
    assert processor.events[-1].message == "Batched 3 issues into 1 batches"


def test_issues_already_being_fixed_are_not_batched_again(processor, batch_model):
    github_dir = processor.github_dir
    autofix(github_dir, 1, AutoFixStatus.BUILDING)
    autofix(github_dir, 2, AutoFixStatus.FAILED)
    autofix(github_dir, 3, AutoFixStatus.COMPLETED)
    (github_dir / "issues" / "autofix_notanumber.json").write_text("{}", "utf-8")
    (github_dir / "issues" / "autofix_9.json").write_text("{", encoding="utf-8")
    batch_model.answers["batch_analysis"] = grouping([2, 3])

    batches = asyncio.run(processor().batch_and_fix_issues(LOGIN, None))

    assert [b.get_issue_numbers() for b in batches] == [[2, 3]]


def test_when_every_issue_is_taken_nothing_is_created(processor, batch_model):
    autofix(processor.github_dir, 1, AutoFixStatus.BUILDING)

    batches = asyncio.run(processor().batch_and_fix_issues(LOGIN[:1], None))

    assert batches == []
    assert processor.events[-1].message == "Batched 0 issues into 0 batches"


def test_a_broken_batch_index_fails_the_batching_without_raising(
    processor, batch_model
):
    (processor.github_dir / "batches").mkdir()
    (processor.github_dir / "batches" / "index.json").write_text("{", "utf-8")

    assert asyncio.run(processor().batch_and_fix_issues(LOGIN, None)) == []


def test_progress_events_can_come_from_the_runner_s_own_orchestrator(
    processor, batch_model, monkeypatch
):
    # Under the runner's flat layout the orchestrator is the module
    # `orchestrator`, and its ProgressCallback is the one the runner reads.
    flat = importlib.import_module("runners.github.orchestrator")
    monkeypatch.setitem(sys.modules, "orchestrator", flat)

    asyncio.run(processor().batch_and_fix_issues([], None))

    assert type(processor.events[0]) is flat.ProgressCallback


def test_without_a_progress_listener_the_batching_runs_quietly(processor, batch_model):
    batch_model.answers["batch_analysis"] = grouping([1, 2, 3])

    batches = asyncio.run(
        processor(report_progress=False).batch_and_fix_issues(LOGIN, None)
    )

    assert len(batches) == 1 and processor.events == []


# ---------------------------------------------------------------------------
# Preview
# ---------------------------------------------------------------------------


def preview(processor, issues, **options):
    return asyncio.run(processor().analyze_issues_preview(issues, **options))


def test_a_preview_of_nothing_says_so(processor, batch_model):
    assert preview(processor, []) == {
        "success": True,
        "total_issues": 0,
        "proposed_batches": [],
        "single_issues": [],
        "message": "No open issues found",
    }


def test_a_preview_proposes_batches_without_creating_them(processor, batch_model):
    issues = LOGIN + [issue(4, "Typo in readme", labels=("docs",))]
    batch_model.answers["batch_analysis"] = grouping([1, 2, 3])
    batch_model.answers["batch_validation"] = lambda _p: json.dumps(
        {
            "is_valid": False,
            "confidence": 0.4,
            "reasoning": "different browsers, different bugs",
            "common_theme": "",
        }
    )

    result = preview(processor, issues)

    assert result["success"] and result["total_issues"] == 4
    assert result["analyzed_issues"] == 4 and result["already_batched"] == 0
    [proposed] = result["proposed_batches"]
    assert proposed["primary_issue"] == 1 and proposed["issue_count"] == 3
    assert proposed["issues"][0] == {
        "issue_number": 1,
        "title": "Login fails on Safari",
        "labels": ["bug"],
        "similarity_to_primary": 1.0,
    }
    assert [i["similarity_to_primary"] for i in proposed["issues"]] == [1.0, 0.85, 0.85]
    assert proposed["common_themes"] == ["login"]
    assert (proposed["validated"], proposed["confidence"]) == (False, 0.4)
    assert proposed["reasoning"] == "different browsers, different bugs"
    assert proposed["theme"] == "login"
    assert result["single_issues"] == [
        {
            "issue_number": 4,
            "title": "Typo in readme",
            "labels": ["docs"],
            "reasoning": "No similar issues found.",
        }
    ]
    assert result["message"] == "Found 1 potential batches grouping 3 issues"
    assert not (processor.github_dir / "batches").exists()
    assert processor.events[-1].message == "Analysis complete: 1 batches proposed"


def test_an_issue_left_out_of_a_full_batch_keeps_the_model_s_reasoning(
    processor, batch_model
):
    # Every issue is paired with #2; #2's batch fills up (five) before #6's
    # turn comes, so #6 stays alone, with the model's word on why it was close.
    issues = [issue(n, f"Login fails {n}") for n in range(1, 7)]
    batch_model.answers["batch_analysis"] = grouping(*([n, 2] for n in (1, 3, 4, 5, 6)))

    result = preview(processor, issues)

    assert [b["issue_count"] for b in result["proposed_batches"]] == [5]
    assert result["proposed_batches"][0]["primary_issue"] == 2
    [single] = result["single_issues"]
    assert single["issue_number"] == 6
    assert single["reasoning"] == "Grouped by Claude agent analysis"


def test_a_preview_looks_at_no_more_than_its_limit(processor, batch_model):
    result = preview(processor, LOGIN, max_issues=1)

    assert result["total_issues"] == 1
    assert [s["issue_number"] for s in result["single_issues"]] == [1]


def test_a_preview_leaves_out_issues_already_in_a_batch(processor, batch_model):
    batch_model.answers["batch_analysis"] = grouping([1, 2, 3])
    asyncio.run(processor().batch_and_fix_issues(LOGIN, None))

    result = preview(processor, LOGIN)

    assert result == {
        "success": True,
        "total_issues": 3,
        "already_batched": 3,
        "proposed_batches": [],
        "single_issues": [],
        "message": "All issues are already in batches",
    }


def test_a_batch_the_validator_cannot_check_is_proposed_unchecked(
    processor, batch_model
):
    issues = [issue(1, "Wrong colour"), issue(2, "Bad margin")]
    batch_model.answers["batch_analysis"] = grouping([1, 2])
    batch_model.answers["batch_validation"] = lambda _p: RuntimeError("overloaded")

    [proposed] = preview(processor, issues)["proposed_batches"]

    assert (proposed["validated"], proposed["confidence"]) == (True, 0.5)
    assert proposed["reasoning"].startswith("Validation error (assuming valid)")
    assert proposed["theme"] == ""


def test_a_preview_that_fails_reports_the_error(processor, batch_model):
    (processor.github_dir / "batches").mkdir()
    (processor.github_dir / "batches" / "index.json").write_text("{", "utf-8")

    result = preview(processor, LOGIN)

    assert result["success"] is False and result["error"]
    assert result["proposed_batches"] == [] and result["single_issues"] == []


# ---------------------------------------------------------------------------
# Approve, report, move on
# ---------------------------------------------------------------------------

APPROVED = [
    {
        "primary_issue": 1,
        "issues": [
            {"issue_number": 1, "title": "Login fails", "labels": ["bug"]},
            {"issue_number": 2, "title": "Login slow", "body": "Takes 10s"},
        ],
        "common_themes": ["login"],
    },
    {"primary_issue": 7, "issues": [{"issue_number": 7}]},
]


def test_nothing_approved_creates_nothing(processor):
    assert asyncio.run(processor().approve_and_execute_batches([])) == []
    assert processor.events == []


def test_approved_batches_are_created_on_disk_and_queued(processor):
    created = asyncio.run(processor().approve_and_execute_batches(APPROVED))

    assert [b.get_issue_numbers() for b in created] == [[1, 2], [7]]
    login = IssueBatch.load(processor.github_dir, created[0].batch_id)
    assert login.status is BatchStatus.ANALYZING
    assert login.common_themes == ["login"]
    assert [(i.title, i.body, i.labels) for i in login.issues] == [
        ("Login fails", "", ["bug"]),
        ("Login slow", "Takes 10s", []),
    ]
    assert (
        IssueBatch.load(processor.github_dir, created[1].batch_id).issues[0].title == ""
    )
    index = json.loads(
        (processor.github_dir / "batches" / "index.json").read_text(encoding="utf-8")
    )["issue_to_batch"]
    assert index == {
        "1": created[0].batch_id,
        "2": created[0].batch_id,
        "7": created[1].batch_id,
    }
    assert AutoFixState.load(processor.github_dir, 7).status is AutoFixStatus.ANALYZING
    assert [(e.phase, e.progress) for e in processor.events] == [
        ("executing", 10),
        ("executing", 10),
        ("executing", 50),
        ("complete", 100),
    ]


def test_the_status_lists_every_batch_and_counts_them_by_status(processor):
    assert asyncio.run(processor().get_batch_status()) == {
        "total_batches": 0,
        "by_status": {},
        "batches": [],
    }
    created = asyncio.run(processor().approve_and_execute_batches(APPROVED))
    extra = IssueBatch(
        batch_id="old",
        repo="own/repo",
        primary_issue=9,
        issues=[IssueBatchItem(issue_number=9, title="t", body="")],
        created_at="2020-01-01T00:00:00",
    )
    asyncio.run(extra.save(processor.github_dir))

    status = asyncio.run(processor().get_batch_status())

    assert status["total_batches"] == 3
    assert status["by_status"] == {"analyzing": 2, "pending": 1}
    assert status["batches"][-1] == {
        "batch_id": "old",
        "primary_issue": 9,
        "issue_count": 1,
        "status": "pending",
        "created_at": "2020-01-01T00:00:00",
    }
    assert {b["batch_id"]: b["issue_count"] for b in status["batches"]}[
        created[0].batch_id
    ] == 2


def test_pending_batches_are_moved_on_to_analysis(processor):
    for batch_id, status in (("a", "pending"), ("b", "pending"), ("c", "building")):
        batch = IssueBatch(
            batch_id=batch_id,
            repo="own/repo",
            primary_issue=1,
            issues=[],
            status=BatchStatus(status),
        )
        asyncio.run(batch.save(processor.github_dir))

    assert asyncio.run(processor().process_pending_batches()) == 2

    statuses = {
        b: IssueBatch.load(processor.github_dir, b).status for b in ("a", "b", "c")
    }
    assert statuses == {
        "a": BatchStatus.ANALYZING,
        "b": BatchStatus.ANALYZING,
        "c": BatchStatus.BUILDING,
    }
