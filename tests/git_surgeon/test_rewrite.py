"""Git History Surgeon (#360): plan, replay on a new branch, branches, messages."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "backend"))

from git_surgeon import (  # noqa: E402
    SurgeonError,
    apply,
    delete_merged,
    list_branches,
    make_plan,
)
from git_surgeon import history as surgeon_history  # noqa: E402
from git_surgeon.apply import validate  # noqa: E402
from git_surgeon.commits import Commit, FileChange, read_range  # noqa: E402
from git_surgeon.conventions import (
    Convention,
    conforms,
    detect_convention,
    suggest_message,
)  # noqa: E402
from git_surgeon.domains import domain_of, domains_of  # noqa: E402
from git_surgeon.messages import reword  # noqa: E402
from git_surgeon.planner import build_plan, trailers  # noqa: E402

CONVENTIONAL = Convention("conventional", "default")


def _env(name: str = "Ana", email: str = "ana@example.test") -> dict[str, str]:
    # A git hook exports GIT_* variables (index, author): the test's repo ignores them.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(
        GIT_AUTHOR_NAME=name,
        GIT_AUTHOR_EMAIL=email,
        GIT_COMMITTER_NAME="Ana",
        GIT_COMMITTER_EMAIL="ana@example.test",
    )
    return env


def _git(
    root: Path, *args: str, author: tuple[str, str] = ("Ana", "ana@example.test")
) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
        env=_env(*author),
    )
    return result.stdout.strip()


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _commit(
    root: Path, message: str, files: dict[str, str], author=("Ana", "ana@example.test")
) -> str:
    for rel, text in files.items():
        _write(root, rel, text)
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", message, author=author)
    return _git(root, "rev-parse", "HEAD")


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    _git(root, "config", "user.name", "Ana")
    _git(root, "config", "user.email", "ana@example.test")
    _git(root, "config", "commit.gpgsign", "false")
    _commit(root, "chore: init", {"src/auth/login.py": "a\n"})
    _git(root, "checkout", "-q", "-b", "feature")
    _commit(root, "add token refresh", {"src/auth/login.py": "a\nb\n"})
    _commit(root, "wip", {"src/auth/login.py": "a\nb\nc\n"})
    _commit(
        root,
        "fix typo",
        {"src/auth/login.py": "a\nb\nc\nd\n"},
        author=("Bo", "bo@example.test"),
    )
    _commit(root, "feat(pay): add payment", {"src/pay/pay.py": "p\n"})
    _commit(root, "fixup! feat(pay): add payment", {"src/pay/pay.py": "p\nq\n"})
    big = {f"src/pay/f{i}.py": "x\n" for i in range(13)}
    big.update({"tests/test_pay.py": "assert 'do-not-send'\n", "docs/pay.md": "m\n"})
    _commit(root, "big change (#12)\n\nWhy it matters.\n\nRefs: #7", big)
    return root


def test_domains_are_the_same_for_every_stack() -> None:
    assert domain_of("apps/frontend/src/App.tsx") == "frontend"
    assert domain_of("src/Orders/Api.cs") == "Orders"
    assert domain_of("tests/OrdersTests.cs") == "tests"
    assert domain_of("pkg/billing/invoice_test.go") == "tests"
    assert domain_of("db/migrations/001_init.sql") == "db"
    assert (
        domain_of("Cargo.toml") == "build"
        and domain_of("src/App/App.csproj") == "build"
    )
    assert domain_of(".github/workflows/ci.yml") == "ci"
    assert domain_of("docs/guide.md") == "docs" and domain_of("README.md") == "docs"
    assert domains_of(
        ["docs/a.md", "src/pay/a.py", "migrations/1.sql", "tests/test_a.py"]
    ) == [
        "db",
        "pay",
        "tests",
        "docs",
    ]


def test_the_convention_comes_from_the_project_then_the_history(repo: Path) -> None:
    assert (
        detect_convention(repo, ["feat: a", "fix(x): b", "wip"]).kind == "conventional"
    )
    assert (
        detect_convention(repo, [":bug: Fix a", ":sparkles: Add b"]).kind == "gitmoji"
    )
    _write(
        repo,
        ".workpilot/git-surgeon.json",
        json.dumps({"convention": "custom", "pattern": r"^[A-Z]+-\d+ "}),
    )
    custom = detect_convention(repo, ["feat: a"])
    assert custom.kind == "custom" and conforms("ABC-12 add login", custom)
    assert not conforms("add login", custom)


def test_messages_by_rules_follow_the_convention() -> None:
    assert suggest_message(
        ["Add token refresh"], ["src/auth/x.py"], ["auth"], CONVENTIONAL
    ) == ("feat(auth): add token refresh")
    assert (
        suggest_message(["wip"], ["tests/test_a.py"], ["tests"], CONVENTIONAL)
        == "test: update test_a"
    )
    gitmoji = suggest_message(
        ["fix crash on start"], ["src/a.py"], ["root"], Convention("gitmoji", "history")
    )
    assert gitmoji.startswith(":bug: Fix crash")
    assert not conforms("fix", CONVENTIONAL) and conforms(
        "fix(auth): token race", CONVENTIONAL
    )


def test_the_plan_joins_fixups_inside_one_part_and_splits_mixed_commits(
    repo: Path,
) -> None:
    plan = make_plan(repo)
    steps = plan["plan"]
    kinds = [s["kind"] for s in steps]
    assert kinds == ["squash", "squash", "split", "split", "split"]
    auth, pay = steps[0], steps[1]
    assert auth["reason"] == "fixups" and len(auth["sources"]) == 3
    assert auth["message"].startswith("feat(auth): add token refresh")
    assert "Co-authored-by: Bo <bo@example.test>" in auth["message"]
    assert pay["reason"] == "autosquash" and pay["message"] == "feat(pay): add payment"
    split = steps[2:]
    assert [s["message"].split("\n")[0] for s in split] == [
        "chore(pay): big change (#12)",
        "test: big change (#12)",
        "docs: big change (#12)",
    ]
    assert "Why it matters." in split[0]["message"] and all(
        "Refs: #7" in s["message"] for s in split
    )
    assert plan["before"]["percent"] < plan["after"]["percent"] == 100
    assert plan["blocked"] == "" and plan["messagesBy"] == "rules"


def test_two_parts_are_never_squashed_together() -> None:
    def commit(sha: str, subject: str, path: str) -> Commit:
        return Commit(
            sha * 40,
            ["0" * 40],
            "Ana",
            "a@x",
            "2026-11-01T00:00:00+00:00",
            subject,
            [FileChange(path, 3, 0)],
        )

    commits = [
        commit("a", "feat(auth): login", "src/auth/a.py"),
        commit("b", "fix", "src/auth/a.py"),
        commit("c", "fix", "src/pay/p.py"),
        commit("d", "feat(pay): refund", "src/pay/p.py"),
    ]
    steps = build_plan(commits, CONVENTIONAL)
    assert [(s.kind, len(s.sources)) for s in steps] == [
        ("squash", 2),
        ("reword", 1),
        ("keep", 1),
    ]


def test_apply_makes_a_new_branch_with_the_same_files_and_keeps_the_old_one(
    repo: Path,
) -> None:
    head = _git(repo, "rev-parse", "HEAD")
    plan = make_plan(repo)
    result = apply(repo, plan["base"], plan["head"], plan["plan"])
    assert (
        result["branch"].startswith("surgeon/feature-")
        and result["treeMatches"] is True
    )
    assert (
        _git(repo, "rev-parse", "HEAD") == head
        and _git(repo, "branch", "--show-current") == "feature"
    )
    new = result["head"]
    assert _git(repo, "rev-parse", f"{new}^{{tree}}") == _git(
        repo, "rev-parse", f"{head}^{{tree}}"
    )
    subjects = _git(repo, "log", "--format=%s", f"{plan['base']}..{new}").splitlines()
    assert subjects[0] == "docs: big change (#12)" and len(subjects) == 5
    assert (
        _git(repo, "log", "-1", "--format=%an <%ae>", f"{new}~4")
        == "Ana <ana@example.test>"
    )
    assert (
        _git(repo, "show", "--name-only", "--format=", f"{new}~1")
        == "tests/test_pay.py"
    )
    assert "Co-authored-by: Bo" in _git(repo, "log", "-1", "--format=%B", f"{new}~4")
    worktrees = _git(repo, "worktree", "list", "--porcelain")
    assert worktrees.count("worktree ") == 1
    assert surgeon_history.monthly(repo)[0]["squash"] == 2
    assert result["after"]["percent"] == 100


def test_untouched_commits_keep_their_sha(repo: Path) -> None:
    plan = make_plan(repo)
    first = plan["commits"][0]
    steps = [
        {"kind": "keep", "sources": [c["sha"]], "message": c["message"], "paths": []}
        for c in plan["commits"]
    ]
    steps[-1]["message"] = "docs: big change (#12)"
    result = apply(repo, plan["base"], plan["head"], steps, branch="feat/tidy")
    assert result["branch"] == "feat/tidy"
    assert _git(repo, "rev-parse", "feat/tidy~5") == first["sha"]
    assert result["kept"] == 5


def test_a_plan_must_cover_every_commit_once(repo: Path) -> None:
    plan = make_plan(repo)
    commits = read_range(repo, plan["base"], plan["head"])
    with pytest.raises(SurgeonError, match="exactly once"):
        validate(plan["plan"][1:], commits)
    with pytest.raises(SurgeonError, match="outside the range"):
        validate([{"kind": "keep", "sources": ["f" * 40], "message": "x"}], commits)
    with pytest.raises(SurgeonError, match="only a squash"):
        validate(
            [{"kind": "keep", "sources": [c.sha for c in commits], "message": "x"}],
            commits,
        )


def test_a_moved_branch_or_a_conflict_stops_without_a_branch(repo: Path) -> None:
    plan = make_plan(repo)
    with pytest.raises(SurgeonError, match="moved"):
        apply(repo, plan["base"], "0" * 40, plan["plan"])
    commits = plan["commits"]
    swapped = [commits[1], commits[0], *commits[2:]]
    steps = [
        {"kind": "keep", "sources": [c["sha"]], "message": c["message"], "paths": []}
        for c in swapped
    ]
    with pytest.raises(SurgeonError, match="conflict"):
        apply(repo, plan["base"], plan["head"], steps)
    assert not _git(repo, "branch", "--list", "surgeon/*")
    assert _git(repo, "worktree", "list", "--porcelain").count("worktree ") == 1


def test_merge_commits_block_the_rewrite(repo: Path) -> None:
    _git(repo, "checkout", "-q", "-b", "side", "main")
    _commit(repo, "feat(side): side work", {"side.txt": "s\n"})
    _git(repo, "checkout", "-q", "feature")
    _git(repo, "merge", "-q", "--no-ff", "-m", "Merge side", "side")
    plan = make_plan(repo)
    assert plan["blocked"] == "merges" and plan["plan"] == []
    assert any(w["code"] == "merges" for w in plan["warnings"])


def test_only_merged_local_branches_are_deleted(repo: Path) -> None:
    _git(repo, "branch", "done", "main")
    _git(repo, "branch", "open-work", "feature")
    rows = {b["name"]: b for b in list_branches(repo)["branches"]}
    assert rows["done"]["merged"] and not rows["open-work"]["merged"]
    assert rows["main"]["protected"] and rows["feature"]["current"]
    assert rows["open-work"]["suggestedName"] == "feat/open-work"
    result = delete_merged(repo, ["done", "open-work", "feature", "main"])
    assert result["deleted"] == ["done"]
    assert result["refused"] == {
        "open-work": "not_merged",
        "feature": "in_use",
        "main": "in_use",
    }
    assert not _git(repo, "branch", "--list", "done")


def test_the_model_only_words_subjects_and_is_checked(repo: Path) -> None:
    plan = make_plan(repo)
    commits = read_range(repo, plan["base"], plan["head"])
    steps = build_plan(commits, CONVENTIONAL)
    answers = {
        steps[0].id: "feat(auth): refresh tokens before they expire",
        steps[1].id: "added payment",  # outside the convention: refused
        steps[2].id: "chore(pay): x\nsecond line",  # two lines: refused
    }
    seen: list[str] = []

    def ask(prompt: str, _dir: str | None) -> str:
        seen.append(prompt)
        return json.dumps(answers)

    assert reword(steps, commits, CONVENTIONAL, ask=ask) == 1
    assert steps[0].message.startswith(
        "feat(auth): refresh tokens before they expire\n"
    )
    assert "Co-authored-by: Bo" in steps[0].message
    assert steps[1].message == "feat(pay): add payment"
    # the paths and messages, quoted as data; never the code
    assert "do-not-send" not in seen[0] and "</user_content>" in seen[0]


def test_a_model_that_fails_leaves_the_rule_messages(repo: Path) -> None:
    def ask(_prompt: str, _dir: str | None) -> str:
        raise RuntimeError("no model")

    plan = make_plan(repo, ai=True, ask=ask)
    assert (
        plan["messagesBy"] == "rules"
        and plan["plan"][1]["message"] == "feat(pay): add payment"
    )


def test_trailers_are_the_last_paragraph_only() -> None:
    assert trailers("feat: a\n\nbody\n\nRefs: #1\nCo-authored-by: B <b@x>") == [
        "Refs: #1",
        "Co-authored-by: B <b@x>",
    ]
    assert trailers("feat: a\n\nNote: this is prose, not a trailer\nreally") == []
