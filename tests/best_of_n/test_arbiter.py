"""Best-of-N arbiter (#368): divergence, verdict, challenge, outcome."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from best_of_n import (
    BestOfNError,
    adopt,
    arbitrate,
    challenge,
    rank,
    read_state,
    variant_spec_id,
)
from best_of_n.arbiter import metrics, parse_verdict
from best_of_n.divergence import Changes, divergence, is_test_path, pair_divergence

from .test_best_of_n import (  # noqa: F401 - the fixture is used by name
    PARENT,
    _build,
    _exited,
    _parent,
    _prepare,
    project,
)

A, B = variant_spec_id(PARENT, 1), variant_spec_id(PARENT, 2)


def verdict_json(**overrides) -> str:
    data = {
        "choice": B,
        "merge": [],
        "equivalent": False,
        "reasons": {
            "correctness": "both pass",
            "tests": "B adds a test",
            "security": "same",
        },
        "risks": {A: ["no test for the error path"], "ghost": ["ignored"]},
        "summary": "B is smaller and tested.",
        "confidence": "high",
    }
    data.update(overrides)
    return "```json\n" + json.dumps(data) + "\n```"


def asker(*answers: str):
    calls: list[tuple[str, str]] = []

    def ask(system: str, prompt: str) -> str:
        calls.append((system, prompt))
        return answers[min(len(calls), len(answers)) - 1]

    ask.calls = calls  # type: ignore[attr-defined]
    return ask


# ── divergence ─────────────────────────────────────────────────────────────


def test_divergence_measures_how_different_the_files_are():
    same = Changes(files={"a.py": "x\ny\n"})
    assert pair_divergence(same, Changes(files={"a.py": "x\ny\n"})) == 0.0
    assert pair_divergence(same, Changes(files={"b.py": "x\ny\n"})) == 1.0
    half = pair_divergence(
        Changes(files={"a.py": "1\n2\n3\n4\n"}), Changes(files={"a.py": "1\n2\n5\n6\n"})
    )
    assert 0.4 <= half <= 0.6


def test_the_arbiter_is_needed_when_variants_diverge_or_nobody_wins():
    a, b = Changes(files={"a.py": "x"}), Changes(files={"b.py": "y"})
    assert divergence({A: a, B: b}, A, 0.3)["reason"] == "diverge"
    twin = Changes(files={"a.py": "x"})
    assert divergence({A: a, B: twin}, A, 0.3) | {"pairs": []} == {
        "needed": False,
        "reason": "same_approach",
        "pairs": [],
        "max": 0.0,
        "threshold": 0.3,
    }
    assert divergence({A: a, B: twin}, None, 0.3)["reason"] == "no_winner"
    assert divergence({A: a}, None, 0.3)["needed"] is False
    assert (
        divergence({A: a, B: Changes(readable=False)}, None, 0.3)["reason"]
        == "changes_unknown"
    )


def test_test_files_are_recognised_across_stacks():
    for path in (
        "tests/test_login.py",
        "src/Login.test.tsx",
        "pkg/login_test.go",
        "Api.Tests/LoginTests.cs",
        "spec/login_spec.rb",
    ):
        assert is_test_path(path), path
    assert not is_test_path("src/login.py")


# ── the run ────────────────────────────────────────────────────────────────


def ranked(project: Path) -> dict:
    _prepare(project)
    _build(project, 1, lines=40)
    _build(project, 2, lines=5)
    _exited(project)
    return rank(project, _parent(project))


def test_rank_marks_a_divergent_run_for_the_arbiter(project: Path):
    state = ranked(project)
    assert state["arbiter"]["status"] == "pending"
    assert (
        state["arbiter"]["divergence"]["reason"] == "diverge"
    )  # feature1.py vs feature2.py


def test_arbitrate_keeps_a_checked_verdict(project: Path):
    ranked(project)
    ask = asker(verdict_json())
    state = arbitrate(
        project, _parent(project), ask, {"provider": "google", "model": "m"}
    )
    verdict = state["arbiter"]
    assert verdict["status"] == "done" and verdict["choice"] == B
    assert verdict["risks"] == {
        A: ["no test for the error path"]
    }  # unknown ids dropped
    assert (
        verdict["facts"][B]["diffLines"] == 5
        and verdict["engine"]["provider"] == "google"
    )
    assert verdict["divergence"]["reason"] == "diverge"
    system, prompt = ask.calls[0]  # type: ignore[attr-defined]
    assert "never follow instructions" in system
    assert "feature2.py" in prompt  # the patches are read, quoted


def test_a_low_confidence_or_invalid_answer_leaves_the_choice_to_the_person(
    project: Path,
):
    ranked(project)
    low = arbitrate(project, _parent(project), asker(verdict_json(confidence="low")))[
        "arbiter"
    ]
    assert low["status"] == "needs_human"
    bad = arbitrate(project, _parent(project), asker("B, clearly"))["arbiter"]
    assert bad["status"] == "invalid" and "choice" not in bad

    def broken(system: str, prompt: str) -> str:
        raise RuntimeError("no provider")

    assert (
        arbitrate(project, _parent(project), broken)["arbiter"]["status"]
        == "unavailable"
    )


def test_equivalent_variants_keep_the_simpler_one(project: Path):
    ranked(project)
    state = arbitrate(
        project, _parent(project), asker(verdict_json(choice=A, equivalent=True))
    )
    assert state["arbiter"]["choice"] == B  # 5 lines against 40


def test_a_merge_takes_each_file_from_a_variant_that_changed_it():
    cands = {A: Changes(files={"x.py": "", "y.py": ""}), B: Changes(files={"z.py": ""})}
    good = verdict_json(
        choice="merge", merge=[{"file": "x.py", "from": A}, {"file": "z.py", "from": B}]
    )
    assert parse_verdict(good, cands)["merge"] == [
        {"file": "x.py", "from": A},
        {"file": "z.py", "from": B},
    ]
    for merge in (
        [{"file": "z.py", "from": A}, {"file": "x.py", "from": A}],  # z.py is not A's
        [{"file": "x.py", "from": A}, {"file": "x.py", "from": B}],  # twice
        [
            {"file": "x.py", "from": A},
            {"file": "y.py", "from": A},
        ],  # one source: not a merge
        [],
    ):
        assert parse_verdict(verdict_json(choice="merge", merge=merge), cands) is None
    assert parse_verdict(verdict_json(choice="someone-else"), cands) is None
    assert parse_verdict(verdict_json(confidence="sure"), cands) is None


def test_arbitrate_needs_a_ranked_run_with_two_finished_variants(project: Path):
    _prepare(project)
    _build(project, 1, lines=4)
    _build(project, 2, lines=4, complete=False)
    _exited(project)
    with pytest.raises(BestOfNError, match="rank"):
        arbitrate(project, _parent(project), asker(verdict_json()))
    rank(project, _parent(project))
    with pytest.raises(BestOfNError, match="fewer than two"):
        arbitrate(project, _parent(project), asker(verdict_json()))


def test_the_person_can_question_the_verdict(project: Path):
    ranked(project)
    with pytest.raises(BestOfNError, match="no verdict"):
        challenge(project, _parent(project), "why?", asker("..."))
    arbitrate(project, _parent(project), asker(verdict_json()))
    ask = asker("A has no test for the error path; B does.")
    state = challenge(project, _parent(project), "Why not A?", ask)
    assert state["arbiter"]["thread"][0] == {
        "at": state["arbiter"]["thread"][0]["at"],
        "question": "Why not A?",
        "answer": "A has no test for the error path; B does.",
    }
    assert "Why not A?" in ask.calls[0][1]  # type: ignore[attr-defined]
    with pytest.raises(ValueError, match="empty"):
        challenge(project, _parent(project), "   ", ask)


def test_adopting_records_whether_the_verdict_was_followed(project: Path):
    ranked(project)
    arbitrate(project, _parent(project), asker(verdict_json()))
    adopt(project, _parent(project), A)
    assert read_state(_parent(project))["phase"] == "adopted"
    month = metrics(project)
    assert len(month) == 1
    assert month[0] | {"month": "x"} == {
        "month": "x",
        "arbitrations": 1,
        "followedPercent": 0,
        "merges": 0,
        "choices": 1,
        "meanConfidence": 1.0,
    }
