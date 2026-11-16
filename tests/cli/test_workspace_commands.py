"""Workspace commands on a real repository: preview, conflicts, PRs, listing."""

from __future__ import annotations

import json
import subprocess

import pytest
from cli import workspace_commands as wc

SPEC = "001-login"


def git(repo, *args):
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


def write(repo, rel, text):
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _path(name):
    """`src__login__py` is `src/login.py`: the last `__` is the dot."""
    if "__" not in name:
        return name
    head, ext = name.rsplit("__", 1)
    return f"{head.replace('__', '/')}.{ext}"


def commit(repo, message, **files):
    for rel, text in files.items():
        write(repo, _path(rel), text)
    git(repo, "add", "-A")
    git(repo, "commit", "-m", message)


@pytest.fixture
def repo(temp_git_repo):
    write(temp_git_repo, ".gitignore", ".workpilot/\n")
    commit(temp_git_repo, "init", app__py="one\n", README__md="readme\n")
    return temp_git_repo


@pytest.fixture
def task(repo):
    """A task worktree on `workpilot/001-login`, branched from main."""
    path = repo / ".workpilot" / "worktrees" / "tasks" / SPEC
    git(repo, "worktree", "add", "-b", f"workpilot/{SPEC}", str(path))
    return path


# --- branches and changed files ----------------------------------------------


def test_the_default_branch(repo, monkeypatch):
    monkeypatch.delenv("DEFAULT_BRANCH", raising=False)
    assert wc._detect_default_branch(repo) == "main"
    git(repo, "branch", "-m", "main", "trunk")
    assert wc._detect_default_branch(repo) == "main"
    git(repo, "branch", "master")
    assert wc._detect_default_branch(repo) == "master"
    git(repo, "branch", "release")
    monkeypatch.setenv("DEFAULT_BRANCH", "release")
    assert wc._detect_default_branch(repo) == "release"
    monkeypatch.setenv("DEFAULT_BRANCH", "nope")
    assert wc._detect_default_branch(repo) == "master"


def test_changed_files_are_the_task_s_own(repo, task):
    commit(task, "task", src__login__py="x\n", app__py="two\n")
    write(task, "notes.md", "untracked but kept\n")
    write(task, "app.py", "three, uncommitted\n")
    write(task, ".workpilot-discard-list", "notes.md\n")
    commit(repo, "main moves on", other__py="main\n")

    files = wc._get_changed_files_from_git(task, "main")

    assert sorted(files) == ["app.py", "notes.md", "src/login.py"]


def test_changed_files_without_a_merge_base(repo, task, capsys):
    assert wc._get_changed_files_from_git(task, "no-such-branch") == []


def test_the_base_branch_of_a_worktree(repo, task):
    git(repo, "branch", "develop")
    commit(repo, "main ahead", m__py="1\n")
    # develop has no commit past the branch point, main has one.
    assert wc._detect_worktree_base_branch(repo, task, SPEC) == "develop"

    write(task, ".workpilot/worktree-config.json", json.dumps({"base_branch": "rel"}))
    assert wc._detect_worktree_base_branch(repo, task, SPEC) == "rel"

    write(task, ".workpilot/worktree-config.json", "{broken")
    assert wc._detect_worktree_base_branch(repo, task, SPEC) == "develop"


def test_no_base_branch_for_an_unknown_task(repo, tmp_path):
    assert wc._detect_worktree_base_branch(repo, tmp_path, "999-none") is None


# --- git conflicts -----------------------------------------------------------


def test_a_clean_task_has_no_git_conflict(repo, task):
    commit(task, "task", feature__py="f\n")
    result = wc._check_git_merge_conflicts(repo, SPEC, "main")
    assert result == {
        "has_conflicts": False,
        "conflicting_files": [],
        "needs_rebase": False,
        "base_branch": "main",
        "spec_branch": f"workpilot/{SPEC}",
        "commits_behind": 0,
    }


def test_both_sides_editing_a_file_is_a_conflict(repo, task):
    commit(task, "task", app__py="task\n")
    commit(repo, "main", app__py="main\n", side__py="s\n")

    result = wc._check_git_merge_conflicts(repo, SPEC)

    assert result["base_branch"] == "main"
    assert result["has_conflicts"] is True
    assert result["conflicting_files"] == ["app.py"]
    assert (result["needs_rebase"], result["commits_behind"]) == (True, 1)


def test_conflicts_of_an_unknown_branch(repo):
    result = wc._check_git_merge_conflicts(repo, "404-none", "main")
    assert result["has_conflicts"] is False


def _scenario(repo, files):
    return wc._detect_conflict_scenario(repo, files, f"workpilot/{SPEC}", "main")


def test_conflict_scenarios(repo, task):
    commit(task, "task", same__py="s\n", mine__py="task\n", app__py="task\n")
    commit(repo, "main", same__py="s\n", mine__py="main\n")

    assert _scenario(repo, [])["scenario"] == "normal_conflict"
    assert _scenario(repo, ["same.py"])["scenario"] == "already_merged"
    assert _scenario(repo, ["same.py", "same.py", "mine.py"])["scenario"] == (
        "already_merged"
    )
    diverged = _scenario(repo, ["mine.py", "app.py"])
    assert diverged["scenario"] == "diverged"
    assert diverged["diverged_files"] == ["mine.py", "app.py"]


def test_superseded_changes(repo, task):
    commit(repo, "main rewrites app", app__py="newer\n")
    # The task branch still has the original app.py.
    assert _scenario(repo, ["app.py"])["scenario"] == "superseded"
    commit(repo, "main rewrites b", README__md="newer\n")
    half = _scenario(repo, ["app.py", "README.md", "missing.py"])
    assert half["scenario"] == "superseded"
    assert half["diverged_files"] == ["missing.py"]


def test_a_scenario_without_a_merge_base(repo):
    result = wc._detect_conflict_scenario(repo, ["a.py"], "nope", "main")
    assert result["details"] == "Could not determine merge base"


# --- merge preview -----------------------------------------------------------


def test_preview_without_a_build(repo):
    result = wc.handle_merge_preview_command(repo, "404-none")
    assert result["success"] is False
    assert "No existing build found" in result["error"]


def test_preview_of_a_clean_task(repo, task):
    commit(task, "task", feature__py="f\n", README__md="better\n")
    write(task, ".workpilot-discard-list", "# kept out\nREADME.md\n")

    result = wc.handle_merge_preview_command(repo, SPEC)

    assert result["success"] is True
    assert result["files"] == ["feature.py"]
    assert result["conflicts"] == []
    assert result["gitConflicts"]["hasConflicts"] is False
    assert result["gitConflicts"]["baseBranch"] == "main"
    assert result["summary"]["totalFiles"] == 1


def test_preview_lists_git_conflicts_and_leaves_lock_files_out(repo, task):
    commit(repo, "lock", **{"package-lock.json": "{}\n"})
    git(task, "merge", "-q", "main")
    commit(task, "task", app__py="task\n", **{"package-lock.json": '{"a":1}\n'})
    commit(repo, "main", app__py="main\n", **{"package-lock.json": '{"b":2}\n'})

    result = wc.handle_merge_preview_command(repo, SPEC, base_branch="main")

    git_part = result["gitConflicts"]
    assert git_part["conflictingFiles"] == ["app.py"]
    assert git_part["scenario"] == "diverged"
    assert result["lockFilesExcluded"] == ["package-lock.json"]
    assert [c["file"] for c in result["conflicts"]] == ["app.py"]
    assert result["conflicts"][0]["type"] == "git"
    assert result["summary"]["totalConflicts"] == 1


def test_preview_finds_a_file_the_target_renamed(repo, task):
    commit(task, "task edits app", app__py="one\ntask\n")
    git(repo, "mv", "app.py", "src_app.py")
    commit(repo, "main renames app")

    result = wc.handle_merge_preview_command(repo, SPEC, base_branch="main")

    assert result["gitConflicts"]["totalRenames"] == 1
    assert result["gitConflicts"]["pathMappedAIMerges"] == [
        {
            "oldPath": "app.py",
            "newPath": "src_app.py",
            "reason": "File was renamed/moved and modified in both branches",
        }
    ]


def test_preview_reports_tasks_editing_the_same_file(repo, task, monkeypatch):
    commit(task, "task", app__py="task\n")
    monkeypatch.setattr(
        wc,
        "_detect_parallel_task_conflicts",
        lambda project, spec, files: [{"file": "app.py", "tasks": [spec, "002-x"]}],
    )

    result = wc.handle_merge_preview_command(repo, SPEC, base_branch="main")

    [conflict] = result["conflicts"]
    assert conflict["type"] == "parallel"
    assert "001-login, 002-x" in conflict["reason"]


def test_a_failing_preview_answers_with_an_error(repo, task, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("git exploded")

    monkeypatch.setattr(wc, "_get_changed_files_from_git", broken)
    result = wc.handle_merge_preview_command(repo, SPEC, base_branch="main")
    assert (result["success"], result["error"]) == (False, "git exploded")


def test_parallel_detection_reads_the_other_tasks(repo, monkeypatch):
    import merge

    class Tracker:
        def get_active_tasks(self):
            return {SPEC, "002-x"}

        def get_files_modified_by_tasks(self, tasks):
            assert tasks == ["002-x"]
            return {"app.py": ["002-x"], "other.py": ["002-x"]}

    class Preview:
        def __init__(self, project_dir):
            self.evolution_tracker = Tracker()

    monkeypatch.setattr(merge, "MergePreview", Preview)
    # Another task counts while its worktree is there
    (repo / ".workpilot" / "worktrees" / "tasks" / "002-x").mkdir(parents=True)

    assert wc._detect_parallel_task_conflicts(repo, SPEC, ["app.py"]) == [
        {"file": "app.py", "tasks": [SPEC, "002-x"]}
    ]

    Tracker.get_active_tasks = lambda self: {SPEC}
    assert wc._detect_parallel_task_conflicts(repo, SPEC, ["app.py"]) == []

    def broken(self):
        raise RuntimeError("no data")

    Tracker.get_active_tasks = broken
    assert wc._detect_parallel_task_conflicts(repo, SPEC, ["app.py"]) == []


# --- merge, PRs ---------------------------------------------------------------


def test_a_staged_merge_publishes_the_event_and_suggests_a_message(repo, monkeypatch):
    import commit_message
    import core.merge_event

    events, asked = [], []
    monkeypatch.setattr(wc, "merge_existing_build", lambda *a, **k: True)
    monkeypatch.setattr(core.merge_event, "publish", events.append)

    def suggest(**kwargs):
        asked.append(kwargs)
        return "feat: login"

    monkeypatch.setattr(commit_message, "generate_commit_message_sync", suggest)
    spec = repo / ".workpilot" / "specs" / SPEC
    spec.mkdir(parents=True)
    write(repo, "staged.py", "x\n")
    git(repo, "add", "staged.py")

    assert wc.handle_merge_command(repo, SPEC, no_commit=True) is True

    [event] = events
    assert (event.spec_name, event.automatic) == (SPEC, False)
    assert asked[0]["files_changed"] == ["staged.py"]
    assert "staged.py" in asked[0]["diff_summary"]
    assert (spec / "suggested_commit_message.txt").read_text("utf-8") == "feat: login"


def test_a_failed_merge_publishes_nothing(repo, monkeypatch):
    import core.merge_event

    events = []
    monkeypatch.setattr(wc, "merge_existing_build", lambda *a, **k: False)
    monkeypatch.setattr(core.merge_event, "publish", events.append)
    assert wc.handle_merge_command(repo, SPEC) is False
    assert events == []


@pytest.mark.parametrize("message", [None, "feat: x"])
def test_the_commit_message_suggestion_never_fails_the_merge(
    repo, monkeypatch, message
):
    import commit_message

    monkeypatch.setattr(
        commit_message, "generate_commit_message_sync", lambda **k: message
    )
    wc._generate_and_save_commit_message(repo, "404-no-spec")

    def broken(**kwargs):
        raise RuntimeError("model down")

    monkeypatch.setattr(commit_message, "generate_commit_message_sync", broken)
    wc._generate_and_save_commit_message(repo, SPEC)
    assert not (repo / ".workpilot").exists()


def _last_json(capsys):
    return json.loads(capsys.readouterr().out.strip().splitlines()[-1])


def test_create_pr_without_a_build_answers_in_json(repo, capsys):
    """The review modal reads the last JSON line: this outcome printed none."""
    result = wc.handle_create_pr_command(repo, "404-none")
    assert result["success"] is False
    assert _last_json(capsys) == {
        "success": False,
        "error": "No build found for this spec",
    }


@pytest.fixture
def manager(monkeypatch):
    seen = {}

    class Manager:
        base_branch = "main"

        def __init__(self, project_dir, base_branch=None):
            seen["base"] = base_branch

        def push_and_create_pr(self, **kwargs):
            seen["pr"] = kwargs
            result = seen["answer"]
            if isinstance(result, BaseException):
                raise result
            return result

        def find_existing_pr_url(self, spec_name, target_branch):
            result = seen["answer"]
            if isinstance(result, BaseException):
                raise result
            return result

        def preview_pr_body(self, **kwargs):
            seen["preview"] = kwargs
            result = seen["answer"]
            if isinstance(result, BaseException):
                raise result
            return result

    import core.worktree

    monkeypatch.setattr(core.worktree, "WorktreeManager", Manager)
    monkeypatch.setattr(wc, "WorktreeManager", Manager)
    return seen


@pytest.mark.parametrize("exists", [False, True])
def test_create_pr(repo, task, manager, capsys, exists):
    manager["answer"] = {
        "success": True,
        "pr_url": "https://github.com/o/r/pull/7" if not exists else None,
        "already_exists": exists,
        "pushed": True,
        "cross_review_blocked": False,
        "stack_linked": 1,
        "stack_note": "on top of #6",
    }

    result = wc.handle_create_pr_command(
        repo, SPEC, target_branch="develop", title="Login", draft=True, body="b"
    )

    assert manager["base"] == "develop"
    assert manager["pr"]["title"] == "Login" and manager["pr"]["draft"] is True
    assert result["stack_linked"] is True
    assert "cross_review_blocked" not in result
    out = capsys.readouterr().out
    assert ("PR already exists!" in out) is exists
    assert ("Check GitHub for the PR URL" in out) is exists
    assert json.loads(out.strip().splitlines()[-1])["success"] is True


def test_create_pr_refused(repo, task, manager, capsys):
    manager["answer"] = {
        "success": False,
        "error": "no remote",
        "cross_review_blocked": True,
    }
    result = wc.handle_create_pr_command(repo, SPEC)
    assert result["cross_review_blocked"] is True
    assert _last_json(capsys)["error"] == "no remote"


def test_create_pr_that_raises(repo, task, manager, capsys):
    manager["answer"] = RuntimeError("gh missing")
    result = wc.handle_create_pr_command(repo, SPEC)
    assert result == {
        "success": False,
        "error": "gh missing",
        "message": "Failed to create PR",
    }
    assert _last_json(capsys) == result


def test_find_pr(repo, task, manager, capsys):
    assert wc.handle_find_pr_command(repo, "404-none")["success"] is False
    capsys.readouterr()
    manager["answer"] = None
    assert wc.handle_find_pr_command(repo, SPEC) == {"success": True, "pr_url": None}
    manager["answer"] = RuntimeError("api down")
    assert wc.handle_find_pr_command(repo, SPEC)["error"] == "api down"
    assert _last_json(capsys)["success"] is False


def test_analyze_impact(repo, task, manager, capsys):
    assert wc.handle_analyze_impact_command(repo, "404-none")["success"] is False
    manager["answer"] = {"body": "## Impact"}
    result = wc.handle_analyze_impact_command(repo, SPEC, "develop")
    assert result == {
        "success": True,
        "body": "## Impact",
        "rating": "N/A",
        "features": "Non evalue",
    }
    assert manager["preview"]["include_impact"] is True
    manager["answer"] = RuntimeError("no diff")
    assert wc.handle_analyze_impact_command(repo, SPEC)["error"] == "no diff"


# --- listing ---------------------------------------------------------------


def test_listing_worktrees(repo, capsys, monkeypatch):
    wc.handle_list_worktrees_command(repo)
    assert "No worktrees found." in capsys.readouterr().out

    from types import SimpleNamespace

    tree = SimpleNamespace(
        spec_name=SPEC,
        branch="workpilot/001-login",
        path="/w",
        commit_count=2,
        files_changed=3,
    )
    monkeypatch.setattr(wc, "list_all_worktrees", lambda project: [tree])
    wc.handle_list_worktrees_command(repo)
    out = capsys.readouterr().out
    assert "Branch: workpilot/001-login" in out
    assert "Commits: 2, Files: 3" in out
    assert "--cleanup-worktrees" in out


def test_review_discard_and_cleanup_reach_the_workspace(repo, monkeypatch):
    seen = []
    monkeypatch.setattr(wc, "review_existing_build", lambda p, s: seen.append("review"))
    monkeypatch.setattr(
        wc, "discard_existing_build", lambda p, s: seen.append("discard")
    )
    monkeypatch.setattr(
        wc,
        "cleanup_all_worktrees",
        lambda p, confirm: seen.append(("cleanup", confirm)),
    )
    wc.handle_review_command(repo, SPEC)
    wc.handle_discard_command(repo, SPEC)
    wc.handle_cleanup_worktrees_command(repo)
    assert seen == ["review", "discard", ("cleanup", True)]


# --- the less travelled paths ----------------------------------------------


def test_changed_files_of_unrelated_histories(repo, task):
    """No merge base: the two-dot diff is the fallback."""
    git(repo, "checkout", "-q", "--orphan", "island")
    git(repo, "rm", "-rfq", ".")
    commit(repo, "island", only__py="x\n")
    git(repo, "checkout", "-q", "main")
    files = wc._get_changed_files_from_git(task, "island")
    assert "only.py" in files and "app.py" in files


def test_a_merge_tree_without_conflict_lines_falls_back_to_the_diff(
    repo, task, monkeypatch
):
    import core.workspace

    commit(task, "task", app__py="task\n", mine__py="m\n")
    commit(repo, "main", app__py="main\n", theirs__py="t\n")
    monkeypatch.setattr(core.workspace, "_parse_merge_tree_conflicts", lambda out: [])

    result = wc._check_git_merge_conflicts(repo, SPEC, "main")

    assert result["has_conflicts"] is True
    assert result["conflicting_files"] == ["app.py"]


def test_a_git_that_cannot_run_reports_no_conflict(repo, monkeypatch):
    def no_git(*args, **kwargs):
        raise OSError("git not found")

    monkeypatch.setattr(wc.subprocess, "run", no_git)
    assert wc._check_git_merge_conflicts(repo, SPEC, "main")["has_conflicts"] is False
    scenario = wc._detect_conflict_scenario(repo, ["a.py"], "b", "main")
    assert scenario["scenario"] == "normal_conflict"
    assert "git not found" in scenario["details"]
    assert wc._detect_worktree_base_branch(repo, repo, SPEC) is None


def test_a_file_git_cannot_show_counts_as_diverged(repo, task, monkeypatch):
    real_run = subprocess.run

    def run(cmd, *args, **kwargs):
        if cmd[:2] == ["git", "show"]:
            raise OSError("pipe broke")
        return real_run(cmd, *args, **kwargs)

    monkeypatch.setattr(wc.subprocess, "run", run)
    assert _scenario(repo, ["app.py"])["diverged_files"] == ["app.py"]


def test_a_mixed_conflict_is_a_normal_one(repo, task):
    commit(task, "task", same__py="s\n")
    commit(repo, "main", same__py="s\n", app__py="newer\n")
    assert _scenario(repo, ["same.py", "app.py"])["scenario"] == "normal_conflict"


def test_preview_falls_back_to_the_default_branch(repo, task, monkeypatch):
    monkeypatch.delenv("DEFAULT_BRANCH", raising=False)
    git(repo, "branch", "-m", "main", "trunk")
    (task / ".workpilot-discard-list").mkdir()

    result = wc.handle_merge_preview_command(repo, SPEC)

    assert result["success"] is True
    assert result["gitConflicts"]["baseBranch"] == "main"


def test_the_message_suggestion_without_its_module_or_git(repo, monkeypatch):
    import builtins

    real_import = builtins.__import__

    def no_module(name, *args, **kwargs):
        if name == "commit_message":
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_module)
    wc._generate_and_save_commit_message(repo, SPEC)
    monkeypatch.setattr(builtins, "__import__", real_import)

    import commit_message

    seen = []
    monkeypatch.setattr(
        commit_message,
        "generate_commit_message_sync",
        lambda **kwargs: seen.append(kwargs),
    )

    def no_git(*args, **kwargs):
        raise OSError("git not found")

    monkeypatch.setattr(wc.subprocess, "run", no_git)
    wc._generate_and_save_commit_message(repo, SPEC)
    assert seen[0]["diff_summary"] == "" and seen[0]["files_changed"] == []
