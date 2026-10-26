"""The follow-through's decisions: the order of the rules is what is tested.

Each test is one way the loop could report a false green or spend a round on
something that is not the PR's to fix.
"""

from __future__ import annotations

from pr_followup.model import Check, CheckState, PRSnapshot, ReviewComment, ReviewThread
from pr_followup.policy import DecisionKind, FollowupConfig, decide
from pr_followup.state import FollowupState

URL = "https://github.com/acme/app/pull/7"


def _snap(*checks: Check, threads: tuple[ReviewThread, ...] = (), **kw) -> PRSnapshot:
    return PRSnapshot(
        url=URL,
        number=7,
        head_sha="a" * 40,
        base_branch="main",
        checks=checks,
        threads=threads,
        **kw,
    )


def _check(name: str, state: CheckState) -> Check:
    return Check(name=name, state=state)


def _thread(tid: str = "T1", last: str = "C2") -> ReviewThread:
    return ReviewThread(
        id=tid,
        path="src/app.py",
        line=3,
        comments=(
            ReviewComment("C1", "rev", "rename this"),
            ReviewComment(last, "rev", "and this"),
        ),
    )


def test_an_unreadable_forge_is_never_green() -> None:
    decision = decide(_snap(error="gh: not logged in"), FollowupState())
    assert decision.kind == DecisionKind.UNKNOWN
    assert not decision.terminal


def test_merged_and_closed_end_the_loop() -> None:
    assert decide(_snap(state="MERGED"), FollowupState()).kind == DecisionKind.MERGED
    assert decide(_snap(state="CLOSED"), FollowupState()).kind == DecisionKind.CLOSED


def test_no_check_waits_then_says_nothing_proves_it_works() -> None:
    cfg = FollowupConfig(no_checks_grace=3)
    assert (
        decide(_snap(), FollowupState(no_checks_polls=0), cfg).kind
        == DecisionKind.PENDING
    )
    final = decide(_snap(), FollowupState(no_checks_polls=2), cfg)
    assert final.kind == DecisionKind.NO_CHECKS
    assert final.terminal


def test_nothing_is_judged_while_a_check_runs() -> None:
    snap = _snap(_check("lint", CheckState.FAILED), _check("tests", CheckState.PENDING))
    assert decide(snap, FollowupState()).kind == DecisionKind.PENDING


def test_green_needs_every_check_passed_and_no_waiting_thread() -> None:
    snap = _snap(_check("lint", CheckState.PASSED), _check("tests", CheckState.PASSED))
    assert decide(snap, FollowupState()).kind == DecisionKind.GREEN
    with_thread = _snap(_check("tests", CheckState.PASSED), threads=(_thread(),))
    assert decide(with_thread, FollowupState()).kind == DecisionKind.FIX


def test_a_failure_red_on_the_base_too_is_not_the_prs() -> None:
    snap = _snap(_check("e2e", CheckState.FAILED), _check("lint", CheckState.PASSED))
    decision = decide(snap, FollowupState(), base_failing_names=frozenset({"e2e"}))
    assert decision.kind == DecisionKind.BASE_RED
    assert [c.name for c in decision.base_failing] == ["e2e"]
    assert decision.failing == ()


def test_only_the_prs_own_failures_go_to_the_fixer() -> None:
    snap = _snap(_check("e2e", CheckState.FAILED), _check("unit", CheckState.FAILED))
    decision = decide(snap, FollowupState(), base_failing_names=frozenset({"e2e"}))
    assert decision.kind == DecisionKind.FIX
    assert [c.name for c in decision.failing] == ["unit"]
    assert [c.name for c in decision.base_failing] == ["e2e"]


def test_an_unknown_base_treats_every_failure_as_the_prs() -> None:
    snap = _snap(_check("e2e", CheckState.FAILED))
    decision = decide(snap, FollowupState(), base_failing_names=None)
    assert [c.name for c in decision.failing] == ["e2e"]


def test_the_round_cap_stops_the_loop() -> None:
    snap = _snap(_check("unit", CheckState.FAILED))
    decision = decide(snap, FollowupState(rounds=3), FollowupConfig(max_rounds=3))
    assert decision.kind == DecisionKind.EXHAUSTED
    assert decision.terminal


def test_a_head_that_produced_no_commit_is_stuck() -> None:
    snap = _snap(_check("unit", CheckState.FAILED))
    decision = decide(snap, FollowupState(no_progress_heads=["a" * 40]))
    assert decision.kind == DecisionKind.STUCK


def test_a_handled_thread_comes_back_only_with_a_new_comment() -> None:
    snap = _snap(_check("unit", CheckState.PASSED), threads=(_thread(last="C2"),))
    handled = FollowupState(handled_threads={"T1": "C2"})
    assert decide(snap, handled).kind == DecisionKind.GREEN
    replied = _snap(_check("unit", CheckState.PASSED), threads=(_thread(last="C3"),))
    assert decide(replied, handled).kind == DecisionKind.FIX


def test_threads_can_be_left_to_people() -> None:
    snap = _snap(_check("unit", CheckState.PASSED), threads=(_thread(),))
    cfg = FollowupConfig(fix_review_threads=False)
    assert decide(snap, FollowupState(), cfg).kind == DecisionKind.GREEN
