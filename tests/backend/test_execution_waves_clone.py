"""What the server's execution-wave plan reads from a clone
(``shared_features.waves.git_reads``, ``service``), against real git
repositories: the files a build workspace changed, its diff and head, a test
merge in the object store only, the history's co-changes, the code of a card's
files. And the refusals: a link that leaves the clone, a file swapped or too
large, a manifest or ``.env`` never read, a secret-shaped symbol dropped, a
branch name that is not one, an object id that is not one.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest
from shared_features.waves import git_reads, service
from shared_features.waves.git_reads import CodeBudget
from shared_features.waves.scorer import build_footprint

# A key-shaped value the redaction masks; not a real key.
_FAKE_KEY = "sk-ant-api03-" + "A" * 24  # pragma: allowlist secret


def git(*args: str, cwd: Path) -> str:
    return subprocess.run(
        [
            "git",
            "-c",
            "user.name=Waves",
            "-c",
            "user.email=waves@example.test",
            "-c",
            "commit.gpgsign=false",
            *args,
        ],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def commit(repo: Path, files: dict[str, str], message: str) -> None:
    for name, text in files.items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    git("add", *files, cwd=repo)
    git("commit", "-q", "-m", message, cwd=repo)


def card(clone: Path, name: str, files: list[str], **meta) -> Path:
    directory = clone / ".workpilot" / "specs" / name
    directory.mkdir(parents=True, exist_ok=True)
    plan = {
        "feature": f"Card {name}",
        "status": meta.pop("status", "backlog"),
        "created_at": meta.pop("created_at", "2026-11-01T10:00:00Z"),
        "phases": [{"subtasks": [{"files_to_modify": files}]}],
    }
    (directory / "implementation_plan.json").write_text(
        json.dumps(plan), encoding="utf-8"
    )
    (directory / "task_metadata.json").write_text(json.dumps(meta), encoding="utf-8")
    (directory / "spec.md").write_text("# spec\n", encoding="utf-8")
    return directory


def workspace(clone: Path, name: str, files: dict[str, str] | None = None) -> Path:
    path = clone / ".workpilot" / "worktrees" / "tasks" / name
    git("worktree", "add", "-q", "-b", f"wp/{name}", str(path), "main", cwd=clone)
    if files:
        commit(path, files, name)
    return path


@pytest.fixture
def clone(tmp_path) -> Path:
    repo = tmp_path / "clone"
    repo.mkdir()
    git("init", "-q", "-b", "main", cwd=repo)
    commit(repo, {"src/shared.py": "a = 1\nb = 2\nc = 3\n", "README.md": "x\n"}, "init")
    for i in range(3):
        commit(
            repo,
            {"api/user.py": f"v{i}\n", "impl/user_impl.py": f"v{i}\n"},
            f"pair {i}",
        )
    return repo


# -- git reads ---------------------------------------------------------------


def test_changed_files_are_commits_index_and_untracked_minus_workpilot(clone):
    path = workspace(clone, "001-a", {"src/feature.py": "def load_user():\n    pass\n"})
    (path / "notes.txt").write_text("untracked\n", encoding="utf-8")
    (path / ".workpilot").mkdir()
    (path / ".workpilot" / "state.json").write_text("{}", encoding="utf-8")
    (path / "bin").mkdir()
    (path / "bin" / "out.dll").write_text("x", encoding="utf-8")
    files = git_reads.changed_files(clone, "001-a", "main")
    assert files == ["src/feature.py", "notes.txt"]
    assert git_reads.changed_files(clone, "002-none", "main") is None
    # A base that is no branch name, or that does not exist, says nothing.
    assert git_reads.changed_files(clone, "001-a", "--output=x") is None
    assert git_reads.changed_files(clone, "001-a", "a..b") is None
    assert git_reads.changed_files(clone, "001-a", "nowhere") is None


def test_a_workspace_linked_out_of_the_clone_is_not_one(clone, tmp_path):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    tasks = clone / ".workpilot" / "worktrees" / "tasks"
    tasks.mkdir(parents=True)
    os.symlink(outside, tasks / "001-link")
    assert git_reads.workspace_of(clone, "001-link") is None
    assert git_reads.workspace_head(clone, "001-link") is None
    assert git_reads.workspace_diff(clone, "001-link", "main") is None


def test_diff_head_and_a_test_merge_in_the_object_store(clone):
    workspace(clone, "001-a", {"src/shared.py": "a = 10\nb = 2\nc = 3\n"})
    workspace(clone, "002-b", {"src/shared.py": "a = 20\nb = 2\nc = 3\n"})
    workspace(clone, "003-c", {"src/shared.py": "a = 1\nb = 2\nc = 30\n"})
    diff = git_reads.workspace_diff(clone, "001-a", "main")
    assert diff.startswith("diff --git a/src/shared.py") and "-a = 1" in diff
    heads = {c: git_reads.workspace_head(clone, c) for c in ("001-a", "002-b", "003-c")}
    assert all(git_reads.OBJECT_ID.match(h) for h in heads.values())
    refs_before = git("for-each-ref", cwd=clone)
    conflict = git_reads.trial_merge(clone, heads["001-a"], heads["002-b"], 8)
    assert conflict.verdict == "conflict" and conflict.files == ("src/shared.py",)
    assert (
        git_reads.trial_merge(clone, heads["001-a"], heads["003-c"], 8).verdict
        == "clean"
    )
    assert git("for-each-ref", cwd=clone) == refs_before
    assert git_reads.trial_merge(clone, "main", heads["002-b"], 8) is None
    assert git_reads.trial_merge(clone, "0" * 40, "1" * 40, 8) is None
    assert git_reads.workspace_head(clone, "009-none") is None
    no_git = lambda *a, **k: None  # noqa: E731
    original = git_reads.git_run
    git_reads.git_run = no_git
    try:
        assert git_reads.trial_merge(clone, heads["001-a"], heads["002-b"], 8) is None
    finally:
        git_reads.git_run = original


def test_keep_diff_sections_and_card_files():
    diff = "noise\ndiff --git a/x b/x\n-x\ndiff --git a/.workpilot/y b/.workpilot/y\n-y"
    assert (
        git_reads.keep_diff_sections(diff, git_reads.is_card_file)
        == "diff --git a/x b/x\n-x"
    )
    assert not git_reads.is_card_file(".workpilot")
    assert not git_reads.is_card_file(".workpilot-allowlist")
    assert not git_reads.is_card_file("src/obj/x.cs")
    assert git_reads.is_card_file("src/bin")


def test_git_answers_nothing_over_the_cap_or_without_git(clone, monkeypatch):
    monkeypatch.setattr(git_reads, "GIT_CAP", 4)
    assert git_reads.git(clone, ["log", "-1"]) is None
    monkeypatch.setattr(
        "foundation.git_executable.get_git_executable", lambda: str(clone / "no-git")
    )
    assert git_reads.git_run(clone, ["status"], timeout=5) is None


def test_co_changes_from_the_history(clone, monkeypatch):
    index, commits = git_reads.read_co_changes(clone)
    assert commits == 4
    assert index["api/user.py"] == frozenset({"impl/user_impl.py"})
    sweeping = [[f"f{i}" for i in range(git_reads.MAX_FILES_PER_COMMIT + 1)]] * 3
    assert git_reads.co_change_index(sweeping + [["one"]]) == {}
    assert git_reads.parse_log("\x1e\n\na\0b\0\x1e\nc\0") == [["a", "b"], ["c"]]
    monkeypatch.setattr(git_reads, "git", lambda *a, **k: None)
    assert git_reads.read_co_changes(clone) is None


def test_the_code_of_a_card_is_read_inside_its_root_only(clone, tmp_path):
    path = workspace(
        clone,
        "001-a",
        {
            "src/users.py": "def fetch_user():\n    pass\n",
            "src/shared.py": f"a = 1\nb = 2\nc = 3\nold_name = '{_FAKE_KEY}'\n",
        },
    )
    commit(path, {"src/shared.py": "a = 1\nb = 2\nc = 3\n"}, "drop it")
    (path / "src" / "big.py").write_text(
        "x" * (git_reads.MAX_CODE_FILE_BYTES + 1), encoding="utf-8"
    )
    (path / "src" / "blob.py").write_bytes(b"abc\0def")
    secret = tmp_path / "secret.py"
    secret.write_text("def leaked_fn(): pass\n", encoding="utf-8")
    os.symlink(secret, path / "src" / "linked.py")
    (path / ".env").write_text("API_TOKEN_VALUE=1\n", encoding="utf-8")
    footprint = build_footprint(
        [
            "src/users.py",
            "src/shared.py",
            "src/big.py",
            "src/blob.py",
            "src/linked.py",
            "src/missing.py",
            ".env",
            "package.json",
            "../outside.py",
        ]
    )
    budget = CodeBudget()
    code = git_reads.read_spec_code(clone, "001-a", "main", footprint, budget)
    assert budget.read == 7 and not budget.capped
    assert "fetch_user" in code.symbols
    assert "leaked_fn" not in code.symbols and "API_TOKEN_VALUE" not in code.symbols
    assert all(_FAKE_KEY not in s for s in code.removed)
    # Read from the clone when the card has no workspace.
    plain = git_reads.read_spec_code(
        clone, "002-none", "main", build_footprint(["src/shared.py"]), budget
    )
    assert plain.removed == [] and plain.symbols == {}
    assert git_reads.read_text_inside(clone.resolve(), "README.md") == "x\n"


def test_a_file_swapped_after_its_check_is_not_read(clone, monkeypatch):
    real_fstat = os.fstat

    def swapped(fd):
        result = real_fstat(fd)
        return os.stat_result((result.st_mode, result.st_ino + 1, *tuple(result)[2:]))

    monkeypatch.setattr(git_reads.os, "fstat", swapped)
    assert git_reads.read_text_inside(clone.resolve(), "README.md") is None


def test_the_code_budget_caps_a_plan(clone, monkeypatch):
    monkeypatch.setattr(git_reads, "MAX_PLAN_CODE_FILES", 1)
    budget = CodeBudget()
    git_reads.read_spec_code(
        clone, "x", "main", build_footprint(["README.md", "src/shared.py"]), budget
    )
    assert budget.read == 1 and budget.capped


# -- the clone's cards and the plan --------------------------------------------


def test_cards_are_read_from_the_clone(clone, tmp_path):
    card(
        clone,
        "001-login",
        ["src/a.py"],
        priority="urgent",
        blockedBy=["002-cart", "../x"],
    )
    card(clone, "002-cart", ["src/b.py"], baseBranch="--evil", archivedAt="2026-11-01")
    directory = card(clone, "003-help", [], status="in_progress", created_at="nope")
    card(clone, "005-naive", [], created_at="2026-11-01T10:00:00", baseBranch="feat/x")
    card(clone, "006-none", [], created_at=None)
    (directory / "spec.md").unlink()
    (clone / ".workpilot" / "specs" / "not-a-card").mkdir()
    outside = tmp_path / "planted"
    outside.mkdir()
    os.symlink(outside, clone / ".workpilot" / "specs" / "004-linked")
    cards = {c.id: c for c in service.read_cards(clone, "develop")}
    assert set(cards) == {"001-login", "002-cart", "003-help", "005-naive", "006-none"}
    assert cards["005-naive"].created_at_ms == 1793527200000
    assert cards["005-naive"].base_branch == "feat/x"
    assert cards["006-none"].created_at_ms == 0
    login = cards["001-login"]
    assert login.title == "Card 001-login" and login.priority_weight == 4
    assert login.blocked_by == ["002-cart"] and login.base_branch == "develop"
    assert login.planned_files == ["src/a.py"] and login.has_spec
    assert cards["002-cart"].archived and cards["002-cart"].base_branch == "develop"
    assert cards["003-help"].column == "in_progress" and not cards["003-help"].has_spec
    assert cards["003-help"].created_at_ms == 0
    assert service.read_cards(tmp_path / "empty", None) == []


def test_json_reads_refuse_links_folders_and_oversized_files(tmp_path, monkeypatch):
    good = tmp_path / "good.json"
    good.write_text('{"a": 1}', encoding="utf-8")
    os.symlink(good, tmp_path / "link.json")
    (tmp_path / "list.json").write_text("[1]", encoding="utf-8")
    (tmp_path / "bad.json").write_bytes(b"\xff")
    (tmp_path / "dir.json").mkdir()
    assert service.read_json(good) == {"a": 1}
    for name in ("link.json", "list.json", "bad.json", "dir.json", "missing.json"):
        assert service.read_json(tmp_path / name) == {}
    monkeypatch.setattr(service, "MAX_JSON_BYTES", 3)
    assert service.read_json(good) == {}


def test_json_reads_refuse_links_without_o_nofollow(tmp_path, monkeypatch):
    # Windows has no O_NOFOLLOW: the link is refused all the same.
    good = tmp_path / "good.json"
    good.write_text('{"a": 1}', encoding="utf-8")
    os.symlink(good, tmp_path / "link.json")
    monkeypatch.delattr(os, "O_NOFOLLOW", raising=False)
    assert service.read_json(tmp_path / "link.json") == {}
    assert service.read_json(good) == {"a": 1}


def test_json_reads_refuse_a_file_swapped_after_the_check(tmp_path, monkeypatch):
    good = tmp_path / "good.json"
    good.write_text('{"a": 1}', encoding="utf-8")
    real_fstat = os.fstat

    def swapped(fd):
        result = real_fstat(fd)
        return os.stat_result((result.st_mode, result.st_ino + 1, *tuple(result)[2:]))

    monkeypatch.setattr(service.os, "fstat", swapped)
    assert service.read_json(good) == {}


def test_subtask_files_prefer_what_was_changed():
    assert service.subtask_files(
        {"files_changed": ["a", "a"], "files_to_modify": ["b"]}
    ) == ["a"]
    assert service.subtask_files(
        {"files_to_modify": ["b", 3], "files_to_create": ["c"], "files": ["b"]}
    ) == ["b", "c"]
    assert service.plan_files(
        {"phases": ["x", {"subtasks": ["y", {"files": ["z"]}]}]}
    ) == ["z"]


@pytest.mark.parametrize(
    "raw",
    [
        [],
        {"tolerance": -1},
        {"tolerance": True},
        {"tolerance": "1"},
        {"driftThreshold": 5000},
        {"unplannedPolicy": "maybe"},
        {"fragileZones": "yes"},
        {"codeLinks": 1},
        {"maxParallel": 0},
        {"maxParallel": True},
        {"maxParallel": 2.5},
    ],
)
def test_options_out_of_bounds_are_refused(raw):
    assert service.parse_options(raw) is None


def test_options_in_bounds():
    assert service.parse_options(None) == service.WaveOptions()
    parsed = service.parse_options(
        {"tolerance": 2, "maxParallel": 5, "codeLinks": False}
    )
    assert parsed.tolerance == 2 and parsed.max_parallel == 5 and not parsed.code_links
    assert service.parse_options(parsed.as_dict()) == parsed


def test_the_plan_of_a_clone(clone):
    card(clone, "001-a", ["src/shared.py"])
    card(clone, "002-b", ["src/shared.py"])
    card(clone, "003-c", ["api/user.py", "package.json"])
    card(clone, "004-d", ["package.json"], status="in_progress")
    card(clone, "005-e", ["src/x.py"], archivedAt="2026-11-01")
    card(clone, "006-f", [])
    workspace(clone, "001-a", {"src/shared.py": "a = 10\nb = 2\nc = 3\n"})
    workspace(clone, "002-b", {"src/shared.py": "a = 20\nb = 2\nc = 3\n"})
    plan = service.build_plan(clone, "main", service.WaveOptions(tolerance=1))
    assert plan["maxParallel"] == 3 and plan["tolerance"] == 1
    assert plan["mergeChecks"]["checked"] == 1 and plan["mergeChecks"]["conflicts"] == 1
    assert sorted(len(w["taskIds"]) for w in plan["waves"]) == [1, 1, 2]
    assert plan["fragileZones"] == {"enabled": True, "commits": 4}
    assert plan["codeLinks"]["enabled"] and plan["codeLinks"]["files"] >= 2
    assert plan["runningConflicts"] == [
        {"taskId": "003-c", "runningTaskId": "004-d", "score": 3}
    ]
    assert "005-e" not in plan["order"]
    only = service.build_plan(
        clone,
        "main",
        service.WaveOptions(fragile_zones=False, code_links=False),
        only=["003-c"],
    )
    assert only["order"] == ["003-c"] and only["fragileZones"]["commits"] is None
    avoided = service.avoided_by(plan)
    assert avoided == {"conflicts": 1, "risk": plan["totalRisk"] - plan["residualRisk"]}
