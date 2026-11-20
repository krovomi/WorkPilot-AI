"""The GitHub view's issue workflows, through the orchestrator.

Triage (classify issues, optionally label them on GitHub), auto-fix (queue an
issue for a spec, find labelled or new issues) and batching (group issues,
preview, approve, report) all start in `GitHubOrchestrator`: it fetches the
issues from GitHub, hands them to the right service and saves what comes back
under `.workpilot/github/issues/`.

What stands in: `gh` (tests/gh_fake.py), the triage engine (its model is
tested in test_triage_engine.py; here it returns real `TriageResult`s) and
the batching model (`batch_model` in conftest.py). The auto-fix processor and
the batch processor are the real ones.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from runners.github.models import AutoFixStatus, TriageCategory, TriageResult

ISSUE_FIELDS = "number,title,body,state,labels,author,comments,createdAt,updatedAt"
LIST = "issue list --state open --limit {} --json number,title,body,labels,author,createdAt,updatedAt,comments"


def issue(number, title="Crash on start", labels=()):
    return {
        "number": number,
        "title": title,
        "body": "",
        "labels": [{"name": name} for name in labels],
    }


def answer_issues(gh, *issues, limit=200, listed=None):
    answers = {
        f"issue view {i['number']} --json {ISSUE_FIELDS}": {"stdout": json.dumps(i)}
        for i in issues
    }
    answers[LIST.format(limit)] = {"stdout": json.dumps(listed or list(issues))}
    gh.answer(answers)


class _Triage:
    """The triage engine's seam: `triage_single_issue(issue, all_issues)`."""

    def __init__(self, labels):
        self.labels = labels
        self.seen = []

    async def triage_single_issue(self, issue, all_issues):
        self.seen.append((issue["number"], [i["number"] for i in all_issues]))
        add, remove = self.labels.get(issue["number"], ([], []))
        return TriageResult(
            issue_number=issue["number"],
            repo="own/repo",
            category=TriageCategory.BUG,
            confidence=0.9,
            labels_to_add=add,
            labels_to_remove=remove,
        )


@pytest.fixture
def triage(orchestrator):
    def run(labels=None, **call):
        orch = orchestrator()
        orch.triage_engine = _Triage(labels or {})
        results = asyncio.run(orch.triage_issues(**call))
        return SimpleNamespace(results=results, engine=orch.triage_engine)

    return run


# ---------------------------------------------------------------------------
# Triage
# ---------------------------------------------------------------------------


def test_chosen_issues_are_triaged_against_each_other_and_saved(
    triage, orchestrator, gh
):
    answer_issues(gh, issue(1), issue(2))

    done = triage(issue_numbers=[1, 2])

    assert [r.issue_number for r in done.results] == [1, 2]
    assert done.engine.seen == [(1, [1, 2]), (2, [1, 2])]
    github_dir = orchestrator.project / ".workpilot" / "github"
    assert TriageResult.load(github_dir, 2).category is TriageCategory.BUG
    assert [(p.phase, p.progress, p.issue_number) for p in orchestrator.progress] == [
        ("fetching", 10, None),
        ("analyzing", 20, 1),
        ("analyzing", 50, 2),
        ("complete", 100, None),
    ]
    assert orchestrator.progress[-1].message == "Triaged 2 issues"
    assert orchestrator.hermes == [False]
    # Without apply_labels, GitHub is only read.
    assert all(c[1] == "view" for c in gh.calls())


def test_suggested_labels_are_applied_when_asked(triage, gh):
    answer_issues(gh, issue(1), issue(2), issue(3))
    gh.answer(
        {
            **{
                f"issue view {n} --json {ISSUE_FIELDS}": {
                    "stdout": json.dumps(issue(n))
                }
                for n in (1, 2, 3)
            },
            "issue edit 1": {"stdout": ""},
            "issue edit 3": {"stderr": "label not found", "code": 1},
        }
    )

    done = triage(
        labels={1: (["bug"], ["needs-triage"]), 3: (["dup"], [])},
        issue_numbers=[1, 2, 3],
        apply_labels=True,
    )

    edits = [c for c in gh.calls() if c[:2] == ["issue", "edit"]]
    assert edits == [
        ["issue", "edit", "1", "--add-label", "bug"],
        ["issue", "edit", "1", "--remove-label", "needs-triage"],
        ["issue", "edit", "3", "--add-label", "dup"],
    ]
    # A label GitHub refuses does not lose the triage.
    assert [r.issue_number for r in done.results] == [1, 2, 3]


def test_without_chosen_issues_every_open_issue_is_triaged(triage, gh):
    answer_issues(gh, issue(4), issue(5))

    done = triage()

    assert [r.issue_number for r in done.results] == [4, 5]


def test_no_open_issues_means_no_triage(triage, orchestrator, gh):
    answer_issues(gh, listed=[])

    assert triage().results == []
    assert orchestrator.hermes == []


# ---------------------------------------------------------------------------
# Auto-fix
# ---------------------------------------------------------------------------


def test_an_issue_is_queued_for_a_spec_and_then_skipped_as_new(orchestrator, gh):
    answer_issues(gh, issue(7), issue(8))
    orch = orchestrator()

    state = asyncio.run(orch.auto_fix_issue(7))
    queue = asyncio.run(orch.get_auto_fix_queue())
    new = asyncio.run(orch.check_new_issues())

    assert state.status is AutoFixStatus.CREATING_SPEC
    assert state.issue_url == "https://github.com/own/repo/issues/7"
    assert [s.issue_number for s in queue] == [7]
    assert new == [{"number": 8}]


def test_labelled_issues_are_found_for_auto_fix(orchestrator, gh):
    answer_issues(gh, issue(7, labels=("Auto-Fix",)), issue(8, labels=("bug",)))

    found = asyncio.run(
        orchestrator(auto_fix_enabled=True).check_auto_fix_labels(
            verify_permissions=False
        )
    )

    assert [f["issue_number"] for f in found] == [7]


# ---------------------------------------------------------------------------
# Batching
# ---------------------------------------------------------------------------

LOGIN = [issue(n, f"Login fails {n}", ("bug",)) for n in (1, 2, 3)]


def _group_all(batch_model):
    batch_model.answers["batch_analysis"] = lambda _p: json.dumps(
        {"batches": [{"issue_numbers": [1, 2, 3]}]}
    )


def test_chosen_issues_are_fetched_and_batched(orchestrator, gh, batch_model):
    answer_issues(gh, *LOGIN)
    _group_all(batch_model)

    batches = asyncio.run(orchestrator().batch_and_fix_issues(issue_numbers=[1, 2, 3]))

    assert [b.get_issue_numbers() for b in batches] == [[1, 2, 3]]
    assert [c[:3] for c in gh.calls()] == [["issue", "view", str(n)] for n in (1, 2, 3)]


def test_every_open_issue_is_batched_by_default(orchestrator, gh, batch_model):
    answer_issues(gh, *LOGIN)
    _group_all(batch_model)

    batches = asyncio.run(orchestrator().batch_and_fix_issues())

    assert [b.get_issue_numbers() for b in batches] == [[1, 2, 3]]
    assert gh.calls()[0][:2] == ["issue", "list"]


def test_a_preview_reads_no_more_issues_than_asked(orchestrator, gh, batch_model):
    answer_issues(gh, *LOGIN, limit=2, listed=LOGIN[:2])

    chosen = asyncio.run(
        orchestrator().analyze_issues_preview(issue_numbers=[1, 2, 3], max_issues=1)
    )
    listed = asyncio.run(orchestrator().analyze_issues_preview(max_issues=2))

    assert chosen["total_issues"] == 1
    assert listed["total_issues"] == 2
    views = [c for c in gh.calls() if c[1] == "view"]
    assert [c[2] for c in views] == ["1"]


def test_approved_batches_are_reported_and_moved_on(orchestrator, gh):
    orch = orchestrator()
    approved = [{"primary_issue": 1, "issues": [{"issue_number": 1, "title": "A"}]}]

    created = asyncio.run(orch.approve_and_execute_batches(approved))
    status = asyncio.run(orch.get_batch_status())
    moved = asyncio.run(orch.process_pending_batches())

    assert [b.primary_issue for b in created] == [1]
    assert status["total_batches"] == 1
    assert status["by_status"] == {"analyzing": 1}
    assert moved == 0
