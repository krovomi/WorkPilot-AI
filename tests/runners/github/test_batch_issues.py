"""Grouping look-alike GitHub issues into batches fixed together.

The GitHub view's "batch issues" turns a list of open issues into batches:
issues are first pre-grouped by label or title keyword (no model), each
pre-group is handed to one model call that proposes sub-batches
(`ClaudeBatchAnalyzer`), the proposals are clustered (`IssueBatcher`), then
each batch is checked by the batch validator and split when it does not hold.
Batches and the issue-to-batch index live under `.workpilot/github/batches/`.

What stands in: the model (`batch_model` in conftest.py, a stand-in
`create_simple_client` answering with the Claude SDK's messages). The files are
real, in tmp_path.
"""

from __future__ import annotations

import asyncio
import json
import sys

import pytest
from claude_agent_sdk import AssistantMessage, TextBlock, ThinkingBlock, UserMessage
from runners.github.batch_issues import (
    BatchStatus,
    ClaudeBatchAnalyzer,
    IssueBatch,
    IssueBatcher,
    IssueBatchItem,
)


def issue(number, title, labels=(), body=""):
    return {
        "number": number,
        "title": title,
        "body": body,
        "labels": [{"name": name} for name in labels],
    }


ISSUES = [
    issue(1, "Login fails on Safari", ["bug"], "Steps: open the login page"),
    issue(2, "Login fails on Firefox", ["Bug"]),
    issue(3, "Slow dashboard", []),
    issue(4, "Slow search page", []),
    issue(5, "Typo in readme", ["question"]),
]


def batches_reply(*groups, fence="json"):
    body = json.dumps(
        {
            "batches": [
                {"issue_numbers": list(g), "theme": "t", "confidence": 0.8}
                for g in groups
            ]
        }
    )
    return f"```{fence}\n{body}\n```" if fence is not None else body


def analysis(*rules):
    """Answer each analyzer prompt by the first rule whose issue it lists."""

    def answer(prompt):
        for marker, reply in rules:
            if marker in prompt:
                return reply
        return batches_reply()

    return answer


@pytest.fixture
def github_dir(tmp_path):
    return tmp_path / "project" / ".workpilot" / "github"


def batcher(github_dir, **options):
    options.setdefault("validate_batches", False)
    return IssueBatcher(github_dir=github_dir, repo="own/repo", **options)


def saved_index(github_dir):
    path = github_dir / "batches" / "index.json"
    return json.loads(path.read_text(encoding="utf-8"))["issue_to_batch"]


# ---------------------------------------------------------------------------
# The analyzer: one model call per pre-group
# ---------------------------------------------------------------------------


def test_no_issues_ask_the_model_nothing(batch_model, tmp_path):
    analyzer = ClaudeBatchAnalyzer(project_dir=tmp_path)

    assert asyncio.run(analyzer.analyze_and_batch_issues([])) == []
    assert batch_model.prompts == []


def test_a_single_issue_is_its_own_batch(batch_model, tmp_path):
    analyzer = ClaudeBatchAnalyzer(project_dir=tmp_path)

    named = asyncio.run(analyzer.analyze_and_batch_issues([issue(7, "Crash")]))
    untitled = asyncio.run(analyzer.analyze_and_batch_issues([{"number": 8}]))

    assert named == [
        {
            "issue_numbers": [7],
            "theme": "Crash",
            "reasoning": "Single issue in group",
            "confidence": 1.0,
        }
    ]
    assert untitled[0]["theme"] == "Single issue"
    assert batch_model.prompts == []


def test_the_analyzer_defaults_to_the_current_directory(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)

    assert ClaudeBatchAnalyzer().project_dir == tmp_path


def test_the_model_is_shown_every_issue_and_its_batches_are_kept(batch_model):
    batch_model.answers["batch_analysis"] = lambda _p: batches_reply([1, 2], [3])
    issues = [
        issue(1, "Login fails", ["bug", "auth"], "x" * 300),
        issue(2, "Login slow"),
        {"number": 3},
    ]

    result = asyncio.run(ClaudeBatchAnalyzer().analyze_and_batch_issues(issues, 4))

    assert [b["issue_numbers"] for b in result] == [[1, 2], [3]]
    kind, prompt = batch_model.prompts[0]
    assert kind == "batch_analysis"
    assert "- #1: Login fails\n  Labels: bug, auth\n  Body: " + "x" * 200 + "..." in (
        prompt
    )
    assert "- #2: Login slow\n  Labels: none\n  Body: ..." in prompt
    assert "- #3: No title" in prompt
    assert "Maximum 4 issues per batch" in prompt


@pytest.mark.parametrize(
    "reply",
    [
        batches_reply([1, 2], fence=""),
        "Here is my grouping: "
        + json.dumps({"batches": [{"issue_numbers": [1, 2], "meta": {"a": {}}}]})
        + " (done)",
    ],
    ids=["plain fence", "json inside prose"],
)
def test_the_batches_are_read_from_however_the_model_wraps_them(batch_model, reply):
    batch_model.answers["batch_analysis"] = lambda _p: reply

    result = asyncio.run(
        ClaudeBatchAnalyzer().analyze_and_batch_issues([issue(1, "a"), issue(2, "b")])
    )

    assert result[0]["issue_numbers"] == [1, 2]


def test_thinking_and_other_messages_are_not_read_as_the_answer(batch_model):
    batch_model.answers["batch_analysis"] = lambda _p: [
        UserMessage(content="ignored"),
        AssistantMessage(
            content=[
                ThinkingBlock(thinking='{"batches": []}', signature="s"),
                TextBlock(text=batches_reply([1, 2], fence=None)),
            ],
            model="m",
        ),
    ]

    result = asyncio.run(
        ClaudeBatchAnalyzer().analyze_and_batch_issues([issue(1, "a"), issue(2, "b")])
    )

    assert result[0]["issue_numbers"] == [1, 2]


@pytest.mark.parametrize(
    "reply",
    [
        "",
        '{"groups": []}',
        "{ not closed",
        "no json at all",
        RuntimeError("overloaded"),
    ],
    ids=["empty", "no batches key", "unbalanced", "prose", "model error"],
)
def test_an_unusable_answer_leaves_each_issue_on_its_own(batch_model, reply):
    batch_model.answers["batch_analysis"] = lambda _p: reply

    result = asyncio.run(
        ClaudeBatchAnalyzer().analyze_and_batch_issues([issue(1, "a"), issue(2, "b")])
    )

    assert result == [
        {
            "issue_numbers": [n],
            "theme": t,
            "reasoning": "Fallback: individual batch",
            "confidence": 0.5,
        }
        for n, t in ((1, "a"), (2, "b"))
    ]


def test_without_the_claude_sdk_each_issue_is_its_own_batch(batch_model, monkeypatch):
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", None)

    result = asyncio.run(
        ClaudeBatchAnalyzer().analyze_and_batch_issues([issue(1, "a"), {"number": 2}])
    )

    assert [(b["issue_numbers"], b["theme"]) for b in result] == [([1], "a"), ([2], "")]
    assert {b["reasoning"] for b in result} == {"Claude SDK not available"}
    assert batch_model.prompts == []


# ---------------------------------------------------------------------------
# Creating batches
# ---------------------------------------------------------------------------


def test_similar_issues_are_batched_and_saved_with_their_index(batch_model, github_dir):
    batch_model.answers["batch_analysis"] = analysis(
        ("#1:", batches_reply([1, 2])),
        ("#3:", batches_reply([3], [], [4])),
    )

    batches = asyncio.run(batcher(github_dir).create_batches(ISSUES))

    groups = sorted(b.get_issue_numbers() for b in batches)
    assert groups == [[1, 2], [3], [4], [5]]
    login = next(b for b in batches if b.primary_issue == 1)
    assert [i.similarity_to_primary for i in login.issues] == [1.0, 0.85]
    assert login.common_themes == ["login"]
    assert login.theme == "login"
    assert login.validated and login.validation_confidence == 1.0
    assert login.validation_reasoning == "Validation disabled"
    assert login.issues[0].labels == ["bug"]
    lone = next(b for b in batches if b.primary_issue == 5)
    assert lone.theme == ""
    # One model call per pre-group of more than one issue (bug, then "slow").
    assert len(batch_model.prompts) == 2
    # Each batch is on disk and the index points every issue at its batch.
    index = saved_index(github_dir)
    assert set(index) == {"1", "2", "3", "4", "5"}
    reread = IssueBatch.load(github_dir, index["2"])
    assert reread.get_issue_numbers() == [1, 2]
    assert reread.repo == "own/repo"


def test_issues_already_batched_or_excluded_are_left_out(batch_model, github_dir):
    asyncio.run(batcher(github_dir).create_batches(ISSUES[:2]))

    again = batcher(github_dir)
    assert again.is_issue_in_batch(1) and not again.is_issue_in_batch(3)
    assert asyncio.run(again.create_batches(ISSUES[:2])) == []
    batches = asyncio.run(again.create_batches(ISSUES, exclude_issue_numbers={3, 4}))

    assert [b.get_issue_numbers() for b in batches] == [[5]]


def test_batches_smaller_than_the_minimum_are_not_created(batch_model, github_dir):
    batch_model.answers["batch_analysis"] = analysis(("#1:", batches_reply([1, 2])))

    batches = asyncio.run(batcher(github_dir, min_batch_size=2).create_batches(ISSUES))

    assert [b.get_issue_numbers() for b in batches] == [[1, 2]]


def test_a_batch_never_grows_past_its_maximum(batch_model, github_dir):
    bugs = [issue(n, f"Issue {n}", ["bug"]) for n in (1, 2, 3)]
    batch_model.answers["batch_analysis"] = lambda _p: batches_reply([1, 2, 3])

    batches = asyncio.run(batcher(github_dir, max_batch_size=2).create_batches(bugs))

    assert sorted(len(b.issues) for b in batches) == [1, 2]


def test_issues_less_similar_than_the_threshold_stay_apart(batch_model, github_dir):
    batch_model.answers["batch_analysis"] = analysis(("#1:", batches_reply([1, 2])))

    batches = asyncio.run(
        batcher(github_dir, similarity_threshold=0.9).create_batches(ISSUES[:2])
    )

    assert sorted(b.get_issue_numbers() for b in batches) == [[1], [2]]


# ---------------------------------------------------------------------------
# Validating batches
# ---------------------------------------------------------------------------


def validated_batches(batch_model, github_dir, verdict, **options):
    batch_model.answers["batch_analysis"] = lambda _p: batches_reply([1, 2, 3])
    batch_model.answers["batch_validation"] = lambda _p: json.dumps(verdict)
    issues = [
        issue(1, "Login fails", ["bug"]),
        issue(2, "Login timeout", ["bug"]),
        issue(3, "Wrong colour", ["bug"]),
    ]
    return asyncio.run(
        batcher(github_dir, validate_batches=True, **options).create_batches(issues)
    )


def test_a_batch_the_validator_accepts_takes_its_theme(batch_model, github_dir):
    batches = validated_batches(
        batch_model,
        github_dir,
        {
            "is_valid": True,
            "confidence": 0.9,
            "reasoning": "same",
            "common_theme": "Auth",
        },
    )

    [batch] = batches
    assert batch.validated and batch.theme == "Auth"
    assert (batch.validation_confidence, batch.validation_reasoning) == (0.9, "same")
    kinds = [kind for kind, _ in batch_model.prompts]
    assert kinds == ["batch_analysis", "batch_validation"]


def test_an_accepted_batch_without_a_theme_takes_its_first_keyword(
    batch_model, github_dir
):
    [batch] = validated_batches(
        batch_model, github_dir, {"is_valid": True, "reasoning": "ok"}
    )

    assert batch.theme == "login"


def test_an_accepted_batch_without_any_theme_stays_untitled(batch_model, github_dir):
    batch_model.answers["batch_analysis"] = lambda _p: batches_reply([1, 2])
    issues = [issue(1, "Wrong colour", ["bug"]), issue(2, "Bad margin", ["bug"])]

    [batch] = asyncio.run(
        batcher(github_dir, validate_batches=True).create_batches(issues)
    )

    assert batch.theme == ""


def test_a_rejected_batch_is_split_as_the_validator_suggests(batch_model, github_dir):
    batches = validated_batches(
        batch_model,
        github_dir,
        {
            "is_valid": False,
            "confidence": 0.7,
            "reasoning": "two causes",
            "suggested_splits": [[1, 2], [3], [99]],
            "common_theme": "",
        },
    )

    assert sorted(b.get_issue_numbers() for b in batches) == [[1, 2], [3]]
    assert all(b.validated and b.validation_confidence == 0.7 for b in batches)
    assert all(b.validation_reasoning.startswith("Split from 1_") for b in batches), [
        b.validation_reasoning for b in batches
    ]
    assert all(b.validation_reasoning.endswith(": two causes") for b in batches)
    assert sorted(saved_index(github_dir)) == ["1", "2", "3"]


def test_splits_smaller_than_the_minimum_are_dropped(batch_model, github_dir):
    batches = validated_batches(
        batch_model,
        github_dir,
        {"is_valid": False, "reasoning": "x", "suggested_splits": [[1, 2], [3]]},
        min_batch_size=2,
    )

    assert [b.get_issue_numbers() for b in batches] == [[1, 2]]


def test_a_rejected_batch_without_splits_becomes_one_batch_per_issue(
    batch_model, github_dir
):
    batches = validated_batches(
        batch_model,
        github_dir,
        {"is_valid": False, "confidence": 0.6, "reasoning": "no"},
    )

    assert sorted(b.get_issue_numbers() for b in batches) == [[1], [2], [3]]
    assert {b.validation_reasoning for b in batches} == {"Split from invalid batch: no"}
    assert all(b.common_themes == [] and b.theme == "" for b in batches)


# ---------------------------------------------------------------------------
# Reading batches back
# ---------------------------------------------------------------------------


def _write(github_dir, batch_id, primary, status="pending", created="2026-01-01"):
    batch = IssueBatch(
        batch_id=batch_id,
        repo="own/repo",
        primary_issue=primary,
        issues=[IssueBatchItem(issue_number=primary, title="t", body="b")],
        status=BatchStatus(status),
        created_at=created,
    )
    asyncio.run(batch.save(github_dir))
    return batch


def test_batches_are_listed_newest_first_and_a_corrupt_file_is_skipped(github_dir):
    assert batcher(github_dir).get_all_batches() == []
    _write(github_dir, "a", 1, "pending", "2026-01-01")
    _write(github_dir, "b", 2, "building", "2026-03-01")
    _write(github_dir, "c", 3, "analyzing", "2026-02-01")
    _write(github_dir, "d", 4, "completed", "2026-04-01")
    (github_dir / "batches" / "batch_broken.json").write_text("{", encoding="utf-8")

    found = batcher(github_dir)

    assert [b.batch_id for b in found.get_all_batches()] == ["d", "b", "c", "a"]
    assert [b.batch_id for b in found.get_pending_batches()] == ["c", "a"]
    assert [b.batch_id for b in found.get_active_batches()] == ["b"]


def test_a_batch_is_found_by_any_of_its_issues(batch_model, github_dir):
    batch_model.answers["batch_analysis"] = analysis(("#1:", batches_reply([1, 2])))
    asyncio.run(batcher(github_dir).create_batches(ISSUES[:2]))

    found = batcher(github_dir)

    assert found.get_batch_for_issue(2).get_issue_numbers() == [1, 2]
    assert found.get_batch_for_issue(42) is None


def test_removing_a_batch_frees_its_issues(batch_model, github_dir):
    batch_model.answers["batch_analysis"] = analysis(("#1:", batches_reply([1, 2])))
    [batch] = asyncio.run(batcher(github_dir).create_batches(ISSUES[:2]))
    remover = batcher(github_dir)

    assert remover.remove_batch("missing") is False
    assert remover.remove_batch(batch.batch_id) is True
    assert saved_index(github_dir) == {}
    assert IssueBatch.load(github_dir, batch.batch_id) is None
    assert not batcher(github_dir).is_issue_in_batch(1)


def test_a_batch_round_trips_and_keeps_its_status_history(github_dir):
    batch = _write(github_dir, "x", 9)
    first_update = batch.updated_at

    batch.update_status(BatchStatus.FAILED, error="build broke")
    batch.update_status(BatchStatus.PENDING)

    assert batch.error == "build broke" and batch.updated_at >= first_update
    reread = IssueBatch.load(github_dir, "x")
    assert reread.to_dict() | {"updated_at": None} == IssueBatch.from_dict(
        reread.to_dict()
    ).to_dict() | {"updated_at": None}
    minimal = IssueBatch.from_dict({"batch_id": "m", "repo": "r", "primary_issue": 1})
    assert minimal.status is BatchStatus.PENDING and minimal.issues == []
    item = IssueBatchItem.from_dict({"issue_number": 1, "title": "t"})
    assert (item.body, item.labels, item.similarity_to_primary) == ("", [], 1.0)


def test_the_batcher_defaults_to_the_project_above_its_state(github_dir):
    assert batcher(github_dir).project_dir == github_dir.parent.parent
