"""Claude Ship on a task PR (A3): its checks as facts, its Steward as the PR's only fixer."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pr_followup import claude_ship
from pr_followup.approval import approve_green, judge
from pr_followup.claude_ship import ShipFacts, hold, read_checks
from pr_followup.forge import GitHubForge, parse_github_pr_url
from pr_followup.loop import run_round
from pr_followup.model import Check, CheckState, PRSnapshot
from pr_followup.state import load_state

from .test_approval import URL, FakeGh, Merger, _push_change, pr_repo  # noqa: F401

APP = {"id": claude_ship.CLAUDE_APP_ID}


def _run(name, status="completed", conclusion="neutral", title="", text="", **extra):
    return {
        "name": name,
        "app": extra.pop("app", APP),
        "status": status,
        "conclusion": conclusion,
        "started_at": extra.pop("started_at", "2026-11-27T10:00:00Z"),
        "output": {"title": title, "text": text, "summary": extra.pop("summary", "")},
    }


def _review(normal, **extra):
    severity = json.dumps({"normal": normal, "nit": 2, "pre_existing": 0})
    return _run(
        "Claude Code Review", text=f"Done.\nbughunter-severity: {severity}\n", **extra
    )


def test_the_switch_is_one_exactly():
    assert claude_ship.active({"WORKPILOT_CLAUDE_SHIP": "1"})
    for value in ("", "0", "true", "yes"):
        assert not claude_ship.active({"WORKPILOT_CLAUDE_SHIP": value})
    assert claude_ship.steward_watching(("x", "claude-pr-steward-watching"))
    assert not claude_ship.steward_watching(())


@pytest.mark.parametrize(
    ("run", "state"),
    [
        (_run("Claude Approvals", status="in_progress", conclusion=None), "pending"),
        (
            _run("Claude Approvals", title="(observe mode) Waiting on human review"),
            "observe",
        ),
        (_run("Claude Approvals", conclusion="success"), "pass"),
        (_run("Claude Approvals", conclusion="neutral", title="Nothing ran"), "pass"),
        (
            _run(
                "Claude Approvals",
                conclusion="failure",
                title="Waiting on human review",
            ),
            "fail",
        ),
    ],
)
def test_claude_approvals_states(run, state):
    assert read_checks([run]).approvals == state


def test_only_the_claude_apps_newest_run_counts():
    other_app = _run("Claude Approvals", conclusion="failure", app={"id": 42})
    old = _run(
        "Claude Approvals", conclusion="failure", started_at="2026-11-27T09:00:00Z"
    )
    new = _run(
        "Claude Approvals", conclusion="success", started_at="2026-11-27T11:00:00Z"
    )
    assert read_checks([other_app]).approvals is None
    assert read_checks([old, new, "junk"]).approvals == "pass"
    assert read_checks(None) == ShipFacts()


def test_code_review_important_findings_decide_its_verdict():
    assert read_checks([_review(0)]).code_review == "agree"
    facts = read_checks([_review(2)])
    assert (facts.code_review, facts.important) == ("disagree", 2)
    summary = _run(
        "Claude Code Review", summary='bughunter-severity: {"normal": 0}', text="none"
    )
    assert read_checks([summary]).code_review == "agree"


@pytest.mark.parametrize(
    "run",
    [
        _review(0, status="in_progress"),
        _run("Claude Code Review", conclusion="skipped"),
        _run("Claude Code Review", text="no marker"),
        _run("Claude Code Review", text="bughunter-severity: {not json}"),
        _run("Claude Code Review", text='bughunter-severity: {"normal": -1}'),
        _run("Claude Code Review", text='bughunter-severity: {"normal": true}'),
        _run("Claude Code Review", text="bughunter-severity: [1]"),
    ],
)
def test_an_unfinished_or_unreadable_review_says_nothing(run):
    assert read_checks([run]).code_review is None


def test_claude_approvals_can_only_hold_a_merge():
    merge = {"tier": "N0", "action": "merge", "merges": True, "reasons": []}
    held = hold(merge, ShipFacts(approvals="pending"))
    assert (held["merges"], held["action"]) == (False, "wait")
    assert held["reasons"][0]["code"] == "claude_approvals_pending"
    failed = hold(merge, ShipFacts(approvals="fail"))
    assert (failed["merges"], failed["action"]) == (False, "human")
    assert failed["reasons"][0]["code"] == "claude_approvals_failed"
    assert hold(merge, ShipFacts(approvals="pass"))["merges"] is True
    human = {"tier": "N2", "action": "human", "merges": False}
    assert hold(human, ShipFacts(approvals="pass"))["action"] == "human"
    assert hold(merge, ShipFacts())["claudeShip"]["approvals"] is None


async def test_claude_code_review_stands_in_for_a_missing_cross_review(
    pr_repo, monkeypatch
):
    project, spec = pr_repo
    monkeypatch.setenv("WORKPILOT_APPROVALS", "enforce")
    snap = _push_change(project, "app.py", "def total():\n    return 2\n", "fix: total")
    assert judge(project, project, spec, snap)["action"] == "human"
    agreed = judge(project, project, spec, snap, ShipFacts(code_review="agree"))
    assert (agreed["action"], agreed["merges"]) == ("merge", True)
    blocked = judge(project, project, spec, snap, ShipFacts(code_review="disagree"))
    assert blocked["action"] == "blocked"
    waits = judge(
        project,
        project,
        spec,
        snap,
        ShipFacts(code_review="agree", approvals="pending"),
    )
    assert waits["merges"] is False


async def test_approve_green_reads_the_head_checks_only_when_given(
    pr_repo, monkeypatch
):
    project, spec = pr_repo
    monkeypatch.setenv("WORKPILOT_APPROVALS", "enforce")
    snap = _push_change(project, "app.py", "def total():\n    return 2\n", "fix: total")
    asked: list[str] = []

    async def runs(head):
        asked.append(head)
        return [_review(0)]

    merger = Merger()
    record = await approve_green(project, project, spec, snap, merger, check_runs=runs)
    assert asked == [snap.head_sha] and record["merged"] is True
    assert record["decision"]["claudeShip"]["codeReview"] == "agree"


async def test_the_forge_reads_the_head_check_runs():
    head = "f" * 40
    gh = FakeGh([(0, json.dumps({"check_runs": [_review(0)]}), "")])
    forge = GitHubForge(parse_github_pr_url(URL), gh)
    assert (await forge.check_runs(head))[0]["name"] == "Claude Code Review"
    assert gh.calls[0] == [
        "api",
        f"repos/acme/app/commits/{head}/check-runs?per_page=100",
    ]
    assert await forge.check_runs("main") is None
    for answer in [
        (1, "", "boom"),
        (0, "nope", ""),
        (0, "[]", ""),
        (0, '{"check_runs": 3}', ""),
    ]:
        forge = GitHubForge(parse_github_pr_url(URL), FakeGh([answer]))
        assert await forge.check_runs(head) is None


async def test_a_pr_the_steward_watches_gets_no_fix_round(pr_repo):
    project, spec = pr_repo
    snap = PRSnapshot(
        url=URL,
        head_sha="a" * 40,
        base_branch="main",
        labels=("claude-pr-steward-watching",),
        checks=(Check("unit", CheckState.FAILED),),
    )

    class Forge:
        async def snapshot(self):
            return snap

        async def base_failing_names(self, _base):
            return frozenset()

    async def fixer(*_args):
        raise AssertionError("the fixer must not run")

    result = await run_round(
        spec_dir=Path(spec),
        worktree_dir=project,
        forge=Forge(),
        fixer=fixer,
        pusher=None,
        stand_down=lambda s: claude_ship.steward_watching(s.labels),
    )
    assert result.action == "steward" and not result.finished
    assert load_state(spec).rounds == 0
    assert load_state(spec).history[-1]["kind"] == "steward"


def test_the_runner_wires_the_steward_only_when_claude_ship_is_on():
    import runners.pr_followup_runner as runner

    assert runner._stand_down(False) is None
    watching = runner._stand_down(True)
    assert watching(PRSnapshot(url=URL, labels=("claude-pr-steward-watching",)))
    assert not watching(PRSnapshot(url=URL))


async def test_the_runner_approver_reads_claude_checks_when_on(pr_repo, monkeypatch):
    import runners.pr_followup_runner as runner

    project, spec = pr_repo
    monkeypatch.setenv("WORKPILOT_APPROVALS", "enforce")
    snap = _push_change(project, "app.py", "def total():\n    return 2\n", "fix: total")

    class Forge:
        async def merge(self, _head):
            return True, ""

        async def check_runs(self, _head):
            return [_review(0)]

    record = await runner._approver(project, project, spec, Forge(), ship=True)(snap)
    assert record["merged"] is True
    record = await runner._approver(project, project, spec, Forge(), ship=False)(snap)
    assert record["merged"] is False
