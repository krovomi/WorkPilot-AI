"""The approval tier of a green task PR, and the merge it allows (A2)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from cross_review.review import Reviewer, Verdict, tree_fingerprint, write_verdict
from pr_followup.approval import (
    DECISION_FILE,
    approve_green,
    plan_summary,
    review_state,
    trust_score,
)
from pr_followup.forge import GitHubForge, parse_github_pr_url
from pr_followup.loop import run_round
from pr_followup.model import Check, CheckState, PRSnapshot
from pr_followup.state import load_state

URL = "https://github.com/acme/app/pull/7"


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout.strip()


@pytest.fixture
def pr_repo(tmp_path: Path):
    """origin with main, and the task's branch pushed; the worktree on it."""
    origin = tmp_path / "origin.git"
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    project = tmp_path / "project"
    _git(tmp_path, "clone", "-q", str(origin), str(project))
    for key, value in (
        ("user.name", "t"),
        ("user.email", "t@t"),
        ("commit.gpgsign", "false"),
    ):
        _git(project, "config", key, value)
    (project / "README.md").write_text("# app\n", encoding="utf-8")
    (project / "app.py").write_text("def total():\n    return 1\n", encoding="utf-8")
    _git(project, "add", ".")
    _git(project, "commit", "-qm", "base")
    _git(project, "push", "-q", "origin", "HEAD:main")
    spec = tmp_path / "spec"
    spec.mkdir()
    (spec / "implementation_plan.json").write_text(
        '{"qa_signoff": {"status": "approved"}}', encoding="utf-8"
    )
    return project, spec


def _push_change(project: Path, path: str, text: str, title: str) -> PRSnapshot:
    _git(project, "checkout", "-q", "-B", "feature/7")
    (project / path).write_text(text, encoding="utf-8")
    _git(project, "add", path)
    _git(project, "commit", "-qm", title)
    _git(project, "push", "-q", "origin", "feature/7")
    return PRSnapshot(
        url=URL,
        number=7,
        head_sha=_git(project, "rev-parse", "HEAD"),
        head_branch="feature/7",
        base_branch="main",
        title=title,
        checks=(Check("unit", CheckState.PASSED),),
    )


class Merger:
    def __init__(self, ok: bool = True):
        self.ok = ok
        self.heads: list[str] = []

    async def __call__(self, head_sha: str) -> tuple[bool, str]:
        self.heads.append(head_sha)
        return self.ok, "" if self.ok else "merge refused"


async def test_enforce_merges_a_docs_pr_and_keeps_the_record(pr_repo, monkeypatch):
    project, spec = pr_repo
    monkeypatch.setenv("WORKPILOT_APPROVALS", "enforce")
    snap = _push_change(project, "README.md", "# app\n\nUsage.\n", "docs: usage")
    merger = Merger()
    record = await approve_green(project, project, spec, snap, merger)
    assert record["decision"]["tier"] == "N0"
    assert record["merged"] is True and merger.heads == [snap.head_sha]
    kept = json.loads((spec / DECISION_FILE).read_text(encoding="utf-8"))
    assert kept["head"] == snap.head_sha
    plan = json.loads((spec / "implementation_plan.json").read_text(encoding="utf-8"))
    assert plan["qa_signoff"] == {"status": "approved"}
    assert plan["approval"]["tier"] == "N0" and plan["approval"]["merged"] is True


async def test_observe_records_the_tier_and_never_merges(pr_repo, monkeypatch):
    project, spec = pr_repo
    monkeypatch.delenv("WORKPILOT_APPROVALS", raising=False)
    snap = _push_change(project, "README.md", "# app\n\nUsage.\n", "docs: usage")
    merger = Merger()
    record = await approve_green(project, project, spec, snap, merger)
    assert record["decision"]["mode"] == "observe"
    assert record["merged"] is False and merger.heads == []


async def test_a_code_change_without_a_review_on_this_tree_waits(pr_repo, monkeypatch):
    project, spec = pr_repo
    monkeypatch.setenv("WORKPILOT_APPROVALS", "enforce")
    snap = _push_change(project, "app.py", "def total():\n    return 2\n", "fix: total")
    merger = Merger()
    record = await approve_green(project, project, spec, snap, merger)
    decision = record["decision"]
    assert (decision["tier"], decision["action"]) == ("N1", "human")
    assert "review_missing" in [r["code"] for r in decision["reasons"]]
    assert merger.heads == []
    # The same change, agreed by the cross-review on this very tree, merges.
    write_verdict(
        spec, Verdict("agree"), Reviewer("p", "m"), tree_fingerprint(project), None
    )
    record = await approve_green(project, project, spec, snap, merger)
    assert record["decision"]["action"] == "merge" and record["merged"] is True


def test_a_review_counts_only_for_the_head_tree(pr_repo):
    project, spec = pr_repo
    head = _git(project, "rev-parse", "HEAD")
    assert review_state(spec, project, head) == "none"
    write_verdict(
        spec, Verdict("agree"), Reviewer("p", "m"), tree_fingerprint(project), None
    )
    assert review_state(spec, project, head) == "agree"
    assert review_state(spec, project, "0" * 40) == "none"
    (project / "app.py").write_text("changed\n", encoding="utf-8")
    _git(project, "commit", "-qam", "later")
    assert review_state(spec, project, _git(project, "rev-parse", "HEAD")) == "none"


def test_the_trust_is_the_lowest_session_score(tmp_path):
    assert trust_score(tmp_path) is None
    (tmp_path / "agent_safety.json").write_text(
        json.dumps(
            {
                "sessions": [
                    {"trustScore": 92.5},
                    {"trustScore": 71.0},
                    {"trustScore": True},
                    {"phase": "qa"},
                ]
            }
        ),
        encoding="utf-8",
    )
    assert trust_score(tmp_path) == 71


async def test_an_unusable_base_is_an_error_never_a_merge(pr_repo, monkeypatch):
    project, spec = pr_repo
    monkeypatch.setenv("WORKPILOT_APPROVALS", "enforce")
    snap = _push_change(project, "README.md", "x\n", "docs: x")
    bad = PRSnapshot(url=URL, head_sha=snap.head_sha, base_branch="-main")
    merger = Merger()
    record = await approve_green(project, project, spec, bad, merger)
    assert "error" in record["decision"] and merger.heads == []
    assert "error" in plan_summary(record)


async def test_a_green_round_asks_the_approver(pr_repo):
    project, spec = pr_repo
    snap = _push_change(project, "README.md", "x\n", "docs: x")

    class Forge:
        async def snapshot(self):
            return snap

    async def approver(seen):
        assert seen is snap
        return {"decision": {"tier": "N0"}, "merged": True}

    result = await run_round(
        spec_dir=spec,
        worktree_dir=project,
        forge=Forge(),
        fixer=None,
        pusher=None,
        approver=approver,
    )
    assert result.finished and result.to_dict()["approval"]["merged"] is True
    assert load_state(spec).history[-1]["kind"] == "merged_by_tier"


class FakeGh:
    def __init__(self, answers):
        self.answers = list(answers)
        self.calls: list[list[str]] = []

    async def __call__(self, args):
        self.calls.append(args)
        return self.answers.pop(0)


async def test_the_merge_is_pinned_to_the_judged_head_and_tries_the_allowed_method():
    head = "a" * 40
    gh = FakeGh(
        [(1, "", "Squash merges are not allowed on this repository"), (0, "", "")]
    )
    forge = GitHubForge(parse_github_pr_url(URL), gh)
    assert await forge.merge(head) == (True, "")
    assert gh.calls[0][-3:] == ["--squash", "--match-head-commit", head]
    assert gh.calls[1][-3:] == ["--merge", "--match-head-commit", head]
    refused = FakeGh([(1, "", "Head branch was modified")])
    forge = GitHubForge(parse_github_pr_url(URL), refused)
    assert await forge.merge(head) == (False, "Head branch was modified")
    assert len(refused.calls) == 1
    assert await forge.merge("HEAD") == (False, "not a commit id")


async def test_the_snapshot_reads_the_title_and_labels():
    view = {
        "number": 7,
        "state": "OPEN",
        "headRefOid": "b" * 40,
        "headRefName": "feature/7",
        "baseRefName": "main",
        "title": "fix(api): total",
        "labels": [{"name": "semver:patch"}, {"name": ""}, "odd"],
    }
    threads = {
        "data": {"repository": {"pullRequest": {"reviewThreads": {"nodes": []}}}}
    }
    gh = FakeGh(
        [(0, json.dumps(view), ""), (0, "[]", ""), (0, json.dumps(threads), "")]
    )
    snap = await GitHubForge(parse_github_pr_url(URL), gh).snapshot()
    assert snap.title == "fix(api): total" and snap.labels == ("semver:patch",)
    view["labels"] = None
    gh = FakeGh(
        [(0, json.dumps(view), ""), (0, "[]", ""), (0, json.dumps(threads), "")]
    )
    assert (await GitHubForge(parse_github_pr_url(URL), gh).snapshot()).labels == ()


async def test_a_head_git_does_not_know_is_an_error(pr_repo, monkeypatch):
    project, spec = pr_repo
    snap = PRSnapshot(url=URL, head_sha="c" * 40, base_branch="main")
    record = await approve_green(project, project, spec, snap, Merger())
    assert "change set" in record["decision"]["error"]


async def test_a_failing_judge_is_recorded_as_an_error(pr_repo, monkeypatch):
    project, spec = pr_repo
    snap = _push_change(project, "README.md", "x\n", "docs: x")

    def broken(*_args):
        raise OSError("disk gone")

    monkeypatch.setattr("pr_followup.approval.judge", broken)
    record = await approve_green(project, project, spec, snap, Merger())
    assert record["decision"] == {"error": "disk gone"}


async def test_the_records_are_never_written_through_a_link(pr_repo, tmp_path):
    project, spec = pr_repo
    snap = _push_change(project, "README.md", "x\n", "docs: x")
    target = tmp_path / "elsewhere.json"
    target.write_text("{}", encoding="utf-8")
    (spec / DECISION_FILE).symlink_to(target)
    (spec / "implementation_plan.json").unlink()
    (spec / "implementation_plan.json").symlink_to(target)
    await approve_green(project, project, spec, snap, Merger())
    assert target.read_text(encoding="utf-8") == "{}"


@pytest.mark.parametrize("plan", ["not json", "[1, 2]"])
async def test_an_unreadable_plan_is_left_alone(pr_repo, plan):
    project, spec = pr_repo
    snap = _push_change(project, "README.md", "x\n", "docs: x")
    (spec / "implementation_plan.json").write_text(plan, encoding="utf-8")
    await approve_green(project, project, spec, snap, Merger())
    assert (spec / "implementation_plan.json").read_text(encoding="utf-8") == plan
    assert (spec / DECISION_FILE).is_file()


async def test_a_plan_that_cannot_be_rewritten_keeps_the_record(pr_repo):
    project, spec = pr_repo
    snap = _push_change(project, "README.md", "x\n", "docs: x")
    (spec / "implementation_plan.json.ap-partial").mkdir()
    (spec / "approval_decision.json.partial").mkdir()
    record = await approve_green(project, project, spec, snap, Merger())
    assert record["decision"]["tier"] == "N0"
    assert not (spec / DECISION_FILE).exists()


async def test_a_green_pr_left_to_a_person_is_remembered_as_green(pr_repo):
    project, spec = pr_repo
    snap = PRSnapshot(
        url=URL, head_sha="d" * 40, checks=(Check("u", CheckState.PASSED),)
    )

    class Forge:
        async def snapshot(self):
            return snap

    async def approver(_snap):
        return {"decision": {"tier": "N2"}, "merged": False}

    await run_round(
        spec_dir=spec,
        worktree_dir=project,
        forge=Forge(),
        fixer=None,
        pusher=None,
        approver=approver,
    )
    assert load_state(spec).history[-1]["kind"] == "green"


async def test_the_runner_merger_needs_a_forge_that_merges():
    import runners.pr_followup_runner as runner

    assert await runner._merger(object())("e" * 40) == (
        False,
        "this forge cannot merge a pull request",
    )

    class Forge:
        async def merge(self, head):
            return True, head

    assert await runner._merger(Forge())("e" * 40) == (True, "e" * 40)


async def test_the_runner_approver_judges_with_the_forge_merge(pr_repo, monkeypatch):
    import runners.pr_followup_runner as runner

    project, spec = pr_repo
    monkeypatch.setenv("WORKPILOT_APPROVALS", "enforce")
    snap = _push_change(project, "README.md", "x\n", "docs: x")

    class Forge:
        heads: list[str] = []

        async def merge(self, head):
            self.heads.append(head)
            return True, ""

    forge = Forge()
    record = await runner._approver(project, project, spec, forge)(snap)
    assert record["merged"] is True and forge.heads == [snap.head_sha]


async def test_the_task_sandbox_reaches_the_tier(pr_repo, monkeypatch):
    project, spec = pr_repo
    monkeypatch.setenv("WORKPILOT_APPROVALS", "enforce")
    snap = _push_change(project, "README.md", "x\n", "docs: x")
    (spec / "sandbox_evidence.json").write_text(
        json.dumps(
            {"sessions": [{"kind": "none"}], "blockedHosts": ["evil.example:443"]}
        ),
        encoding="utf-8",
    )
    merger = Merger()
    record = await approve_green(project, project, spec, snap, merger)
    decision = record["decision"]
    assert decision["facts"]["sandbox"] == "none"
    assert decision["facts"]["blockedHosts"] == ["evil.example:443"]
    assert {"unsandboxed", "blocked_hosts"} <= {r["code"] for r in decision["reasons"]}
    assert decision["tier"] == "N2" and merger.heads == []
