"""The stack autopilot merges opted-in pull requests in stack order (scripts/stack_autopilot.py).

Pure rules first (order, checks, labels), then the git part on throw-away
repositories: a child whose parent was squash-merged must merge develop
without replaying the parent's conflicts, and a real conflict must stop the
pull request instead of pushing markers.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "stack_autopilot", ROOT / "scripts" / "stack_autopilot.py"
)
sa = importlib.util.module_from_spec(_spec)
sys.modules["stack_autopilot"] = sa
_spec.loader.exec_module(sa)

WORKFLOW = ROOT / ".github" / "workflows" / "stack-autopilot.yml"


def _pr(number, head=None, base="develop", body="", labels=(), auto=None):
    return sa.PullRequest(
        number=number,
        head_ref=head or f"feature/{number}",
        head_sha=f"{number:040d}",
        base_ref=base,
        body=body,
        labels=set(labels),
        auto_merge_method=auto,
    )


# -- opt-in and method -------------------------------------------------------


def test_opt_in_is_auto_merge_or_the_label():
    assert _pr(1, auto="squash").opted_in
    assert _pr(2, labels=["autopilot"]).opted_in
    assert not _pr(3).opted_in


def test_method_label_wins_then_auto_merge_then_squash():
    assert _pr(1, labels=["autopilot:merge"], auto="squash").method == "merge"
    assert _pr(2, auto="rebase").method == "rebase"
    assert _pr(3, labels=["autopilot"]).method == "squash"
    assert _pr(4, labels=["autopilot:bogus"]).method == "squash"


def test_from_api_reads_auto_merge_and_labels():
    raw = {
        "number": 7,
        "head": {"ref": "feature/x", "sha": "a" * 40},
        "base": {"ref": "develop"},
        "body": None,
        "labels": [{"name": "autopilot"}],
        "auto_merge": {"merge_method": "merge"},
    }
    pr = sa.from_api(raw)
    assert (pr.number, pr.body, pr.auto_merge_method) == (7, "", "merge")
    assert pr.labels == {"autopilot"}
    assert sa.from_api({**raw, "auto_merge": None}).auto_merge_method is None


# -- order -------------------------------------------------------------------


@pytest.mark.parametrize(
    "body, expected",
    [
        ("It is built on #774 (lot 2), itself on #771 (lot 1).", {774, 771}),
        ("Merge order: #771, #774, then this one.", {771, 774}),
        ("Merge order: #771 #774 #775 #776", {771, 774}),
        ("Stacked on #12. Depends on #9.", {12, 9}),
        (
            "Basée sur #40 ; dépend de la PR #41. Ordre de fusion : #39, #40",
            {39, 40, 41},
        ),
        ("Fixes #775 and mentions #3.", set()),
    ],
)
def test_hinted_parents(body, expected):
    assert sa.hinted_parents(775, body) == expected


def test_order_from_base_branch_hint_and_shared_commits():
    a = _pr(10, head="feature/a")
    b = _pr(11, head="feature/b", base="feature/a")  # real GitHub stack
    c = _pr(12, body="built on #11")
    d = _pr(13)
    e = _pr(14)
    deps = sa.dependencies(
        [a, b, c, d, e], {frozenset((13, 14)): 14, frozenset((10, 13)): None}
    )
    assert deps == {10: set(), 11: {10}, 12: {11}, 13: {10, 14}, 14: set()}
    assert [p.number for p in sa.fronts([a, b, c, d, e], deps, "develop")] == [10, 14]


def test_contradicting_hints_fall_back_to_number_order():
    a = _pr(20, body="built on #21")
    b = _pr(21, body="built on #20")
    deps = sa.dependencies([a, b], {})
    assert deps == {20: set(), 21: {20}}


def test_a_closed_parent_does_not_hold_the_child():
    child = _pr(30, body="built on #29")  # #29 is merged: not in the open list
    assert sa.dependencies([child], {}) == {30: set()}


# -- checks ------------------------------------------------------------------


def _run(name, status="completed", conclusion="success"):
    return {"name": name, "status": status, "conclusion": conclusion}


def test_green_needs_every_check_completed_and_passing():
    runs = [_run("CI Complete"), _run("Analyze (python)", conclusion="skipped")]
    assert sa.checks_verdict(runs, [], 600) == "green"
    assert (
        sa.checks_verdict(runs + [_run("e2e", "in_progress", None)], [], 600)
        == "pending"
    )
    assert (
        sa.checks_verdict(runs + [_run("e2e", conclusion="failure")], [], 600) == "red"
    )
    assert (
        sa.checks_verdict(runs + [_run("e2e", conclusion="cancelled")], [], 600)
        == "red"
    )


def test_only_the_newest_run_of_a_check_counts():
    old = {**_run("e2e", conclusion="failure"), "id": 1}
    new = {**_run("e2e"), "id": 2}
    assert sa.checks_verdict([new, old], [], 600) == "green"
    assert sa.checks_verdict([{**old, "id": 3}, new], [], 600) == "red"


def test_own_check_is_never_waited_for():
    assert (
        sa.checks_verdict(
            [_run("Stack autopilot", "in_progress", None), _run("CI")], [], 9
        )
        == "green"
    )


def test_statuses_count_by_their_latest_state():
    statuses = [
        {"context": "ext", "state": "failure", "updated_at": "2026-11-08T09:00:00Z"},
        {"context": "ext", "state": "success", "updated_at": "2026-11-08T09:05:00Z"},
    ]
    assert sa.checks_verdict([], statuses, 9) == "green"
    assert sa.checks_verdict([], statuses[:1], 9) == "red"


def test_a_commit_without_checks_is_waited_for_then_trusted():
    assert sa.checks_verdict([], [], 60) == "pending"
    assert sa.checks_verdict([], [], sa.NO_CHECK_GRACE_SECONDS) == "green"


# -- conflicts and labels ----------------------------------------------------


def test_generated_audit_cards_are_rebuilt_not_resolved():
    generated, others = sa.split_conflicts(
        ["docs/audit/findings/F161.js", "docs/audit/findings/F161.md", "a.ts"]
    )
    assert generated == ["docs/audit/findings/F161.js"]
    assert others == ["docs/audit/findings/F161.md", "a.ts"]


def test_markers_are_line_starts_only():
    assert sa.has_markers("a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> develop\n")
    assert not sa.has_markers("a = '<<<<<<<'  # not a marker\n")


def test_squash_subject_names_its_pull_request():
    assert sa.squash_number("feat(ui): charter on Settings (lot 9) (#782)") == 782
    assert sa.squash_number("Merge pull request #772 from krovomi/fix") is None


def test_conflict_label_clears_after_a_new_commit():
    events = [
        {
            "event": "labeled",
            "label": {"name": "autopilot/conflit"},
            "created_at": "2026-11-08T09:00:00Z",
        }
    ]
    assert sa.label_is_stale(events, "autopilot/conflit", "2026-11-08T09:30:00Z")
    assert not sa.label_is_stale(events, "autopilot/conflit", "2026-11-08T08:00:00Z")
    assert not sa.label_is_stale([], "autopilot/conflit", "2026-11-08T09:30:00Z")


# -- git: squash-merged parent, real conflict ---------------------------------


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout.strip()


def _commit(cwd: Path, path: str, text: str, message: str) -> str:
    (cwd / path).write_text(text, encoding="utf-8")
    _git(cwd, "add", path)
    _git(cwd, "commit", "-q", "-m", message)
    return _git(cwd, "rev-parse", "HEAD")


class _OfflineGitHub(sa.GitHub):
    def __init__(self):
        super().__init__("o/r", "", None, dry_run=True)
        self.calls: list[str] = []

    def add_labels(self, number, labels):
        self.calls.append(f"label #{number} {labels}")

    def comment(self, number, body):
        self.calls.append(f"comment #{number}")


@pytest.fixture
def stack(tmp_path, monkeypatch):
    """develop, parent #1 squash-merged into it, child #2 built on the parent."""
    origin = tmp_path / "origin.git"
    work = tmp_path / "work"
    _git(tmp_path, "init", "-q", "--bare", "-b", "develop", str(origin))
    _git(tmp_path, "clone", "-q", str(origin), str(work))
    for key, value in (
        ("user.name", "t"),
        ("user.email", "t@t"),
        ("commit.gpgsign", "false"),
    ):
        _git(work, "config", key, value)
    _commit(work, "list.md", "one\ntwo\nthree\n", "base")
    _git(work, "push", "-q", "origin", "HEAD:develop")
    parent = _commit(work, "list.md", "one\ntwo (parent)\nthree\n", "parent")
    child = _commit(work, "list.md", "one\ntwo (parent, child)\nthree\n", "child")
    _git(
        work,
        "push",
        "-q",
        "origin",
        f"{parent}:refs/pull/1/head",
        f"{child}:refs/pull/2/head",
    )
    _git(work, "push", "-q", "origin", f"{child}:refs/heads/feature/child")
    # develop: an unrelated commit, then the parent squashed by GitHub.
    _git(work, "checkout", "-q", "-B", "develop", "origin/develop")
    _commit(work, "other.md", "x\n", "unrelated (#5)")
    _commit(work, "list.md", "one\ntwo (parent)\nthree\n", "parent (#1)")
    _git(work, "push", "-q", "origin", "develop")
    monkeypatch.setattr(sa, "ROOT", work)
    gh = _OfflineGitHub()
    pilot = sa.Autopilot(gh, "develop", can_push=True, claude=False)
    pr = _pr(2, head="feature/child", body="built on #1")
    pr.head_sha = child
    pilot.fetch([pr])
    return work, pilot, pr, gh


def test_child_of_a_squashed_parent_merges_develop_without_conflict(stack):
    work, pilot, pr, gh = stack
    found = pilot.squashed_parents(pr.head_sha)
    assert [n for n, *_ in found] == [1]
    assert pilot.sync(pr)
    assert (work / "list.md").read_text(
        encoding="utf-8"
    ) == "one\ntwo (parent, child)\nthree\n"
    assert (work / "other.md").is_file()
    assert _git(work, "merge-base", "--is-ancestor", "origin/develop", "HEAD") == ""
    assert gh.calls == []


def test_a_real_conflict_blocks_and_leaves_no_marker(stack):
    work, pilot, pr, gh = stack
    _git(work, "checkout", "-q", "develop")
    _commit(work, "list.md", "one\ntwo (someone else)\nthree\n", "rewrite (#6)")
    _git(work, "push", "-q", "origin", "develop")
    pilot.fetch([pr])
    assert not pilot.sync(pr)
    assert gh.calls == ["label #2 ['autopilot/conflit']", "comment #2"]
    assert _git(work, "status", "--porcelain") == ""
    assert not sa.has_markers((work / "list.md").read_text(encoding="utf-8"))


def test_without_a_pat_nothing_is_pushed(stack):
    _, pilot, pr, _ = stack
    pilot.can_push = False
    assert not pilot.sync(pr)


# -- workflow ----------------------------------------------------------------


def test_workflow_runs_develops_script_with_the_pat_and_one_run_at_a_time():
    yaml = pytest.importorskip("yaml")
    data = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    triggers = data.get("on", data.get(True))
    assert {
        "push",
        "workflow_run",
        "schedule",
        "workflow_dispatch",
        "pull_request",
    } <= set(triggers)
    assert "pull_request_target" not in triggers
    assert data["concurrency"]["cancel-in-progress"] is False
    job = data["jobs"]["stack-autopilot"]
    assert job["name"] in sa.OWN_CHECKS
    checkout = job["steps"][0]
    assert checkout["with"]["ref"] == "develop"
    assert "secrets.PAT_TOKEN" in checkout["with"]["token"]
    run_env = job["steps"][-1]["env"]
    assert {"PAT_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "GITHUB_TOKEN"} <= set(run_env)


def test_workflow_waits_for_the_workflows_that_exist():
    yaml = pytest.importorskip("yaml")
    names = set()
    for path in (ROOT / ".github" / "workflows").glob("*.yml"):
        names.add(yaml.safe_load(path.read_text(encoding="utf-8")).get("name"))
    data = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    waited = data.get("on", data.get(True))["workflow_run"]["workflows"]
    assert set(waited) <= names, set(waited) - names
