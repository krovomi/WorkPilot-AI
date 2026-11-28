"""The workspace around a build: setup, the choice after it, display, git helpers.

Real repositories in ``tmp_path``. The person at the keyboard is the only
stand-in: ``select_menu`` answers for them and ``input`` reads from the test.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from pathlib import Path

import core.merge_event as merge_event
import pytest
from core.workspace import display, finalization, git_utils, workspace_setup
from core.workspace.models import (
    MergeLock,
    SpecNumberLock,
    SpecNumberLockError,
    WorkspaceChoice,
    WorkspaceMode,
)
from core.worktree import WorktreeManager

SPEC = "004-search"
BRANCH = f"workpilot/{SPEC}"


def git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=check,
    )


def commit_file(cwd: Path, name: str, content: str | bytes, message: str) -> None:
    path = cwd / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content, encoding="utf-8")
    git(cwd, "add", "--", name)
    git(cwd, "commit", "-q", "-m", message)


def break_git_file(worktree: Path) -> None:
    """Point a worktree's `.git` file nowhere.

    Rewritten in place: Git for Windows hides `.git`, and Windows refuses to
    open a hidden file for a fresh write ("w"), so "r+" keeps its attributes.
    """
    with (worktree / ".git").open("r+", encoding="utf-8") as handle:
        handle.truncate(0)
        handle.write("gitdir: /nowhere\n")


@pytest.fixture
def repo(isolated_repo, tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("DEFAULT_BRANCH", raising=False)
    monkeypatch.setenv("WORKPILOT_WORKTREE_SETUP", "0")
    return isolated_repo


@pytest.fixture
def built(repo):
    """A finished build: a task worktree that added, changed and deleted files."""
    commit_file(repo, "old.txt", "old\n", "old")
    commit_file(repo, "app.py", "x = 1\n", "app")
    manager = WorktreeManager(repo, base_branch="main", use_local_branch=True)
    info = manager.create_worktree(SPEC)
    commit_file(info.path, "search.py", "def search():\n    return []\n", "search")
    commit_file(info.path, "app.py", "x = 2\n", "app")
    git(info.path, "rm", "-q", "old.txt")
    git(info.path, "commit", "-q", "-m", "drop old")
    return manager


@pytest.fixture
def person(monkeypatch):
    """What the person picks in the menus and types at the prompts."""
    answers = {"menu": [], "typed": []}

    def select_menu(**_kwargs):
        return answers["menu"].pop(0)

    monkeypatch.setattr(finalization, "select_menu", select_menu)
    monkeypatch.setattr(workspace_setup, "select_menu", select_menu)

    def typed(*_prompt):
        value = answers["typed"].pop(0)
        if isinstance(value, BaseException):
            raise value
        return value

    monkeypatch.setattr("builtins.input", typed)
    return answers


@pytest.fixture
def merges(monkeypatch):
    heard: list[merge_event.MergeEvent] = []
    monkeypatch.setattr(merge_event, "SUBSCRIBERS", [heard.append])
    return heard


# ── Choosing and setting up the workspace ───────────────────────────────


class TestChooseWorkspace:
    def test_forced_and_unattended_modes(self, repo):
        assert workspace_setup.choose_workspace(repo, SPEC, force_isolated=True) == (
            WorkspaceMode.ISOLATED
        )
        assert workspace_setup.choose_workspace(repo, SPEC, force_direct=True) == (
            WorkspaceMode.DIRECT
        )
        assert workspace_setup.choose_workspace(repo, SPEC, auto_continue=True) == (
            WorkspaceMode.ISOLATED
        )

    def test_unsaved_work_is_protected(self, repo, person, capsys):
        (repo / "draft.txt").write_text("wip", encoding="utf-8")
        person["typed"] = [""]

        assert workspace_setup.choose_workspace(repo, SPEC) == WorkspaceMode.ISOLATED
        assert "YOUR WORK IS PROTECTED" in capsys.readouterr().out

    def test_unsaved_work_and_a_cancel(self, repo, person):
        (repo / "draft.txt").write_text("wip", encoding="utf-8")
        person["typed"] = [KeyboardInterrupt()]

        with pytest.raises(SystemExit):
            workspace_setup.choose_workspace(repo, SPEC)

    @pytest.mark.parametrize(
        ("picked", "mode"),
        [("direct", WorkspaceMode.DIRECT), ("isolated", WorkspaceMode.ISOLATED)],
    )
    def test_the_person_picks(self, repo, person, picked, mode):
        person["menu"] = [picked]

        assert workspace_setup.choose_workspace(repo, SPEC) == mode

    def test_quitting_the_menu(self, repo, person):
        person["menu"] = [None]

        with pytest.raises(SystemExit):
            workspace_setup.choose_workspace(repo, SPEC)


class TestSetupWorkspace:
    def test_direct_mode_touches_nothing(self, repo, tmp_path):
        spec_dir = tmp_path / "spec"

        assert workspace_setup.setup_workspace(
            repo, SPEC, WorkspaceMode.DIRECT, source_spec_dir=spec_dir
        ) == (repo, None, spec_dir)

    def test_isolated_mode_prepares_the_worktree(self, repo, tmp_path, monkeypatch):
        monkeypatch.setattr(workspace_setup, "_git_hook_check_done", False)
        (repo / ".env").write_text("KEY=placeholder\n", encoding="utf-8")
        (repo / ".env.local").write_text("LOCAL=1\n", encoding="utf-8")
        from security.constants import ALLOWLIST_FILENAME, PROFILE_FILENAME

        (repo / ALLOWLIST_FILENAME).write_text("make\n", encoding="utf-8")
        (repo / PROFILE_FILENAME).write_text('{"stack": ["python"]}', encoding="utf-8")
        spec_dir = tmp_path / "spec"
        spec_dir.mkdir()
        (spec_dir / "spec.md").write_text("# Search\n", encoding="utf-8")
        (spec_dir / "implementation_plan.json").write_text(
            json.dumps(
                {
                    "title": "Search",
                    "description": "Find things",
                    "phases": [{"subtasks": [{"files": ["search.py", "app.py"]}]}],
                }
            ),
            encoding="utf-8",
        )

        path, manager, local_spec = workspace_setup.setup_workspace(
            repo, SPEC, WorkspaceMode.ISOLATED, source_spec_dir=spec_dir
        )

        assert path == repo / ".workpilot" / "worktrees" / "tasks" / SPEC
        assert isinstance(manager, WorktreeManager)
        assert (path / ".env").read_text(encoding="utf-8") == "KEY=placeholder\n"
        assert (path / ".env.local").exists()
        assert (path / ALLOWLIST_FILENAME).read_text(encoding="utf-8") == "make\n"
        profile = json.loads((path / PROFILE_FILENAME).read_text(encoding="utf-8"))
        assert profile["inherited_from"] == str(repo.resolve())
        assert local_spec == path / ".workpilot" / "specs" / SPEC
        assert (local_spec / "spec.md").exists()
        assert ".workpilot/" in (path / ".gitignore").read_text(encoding="utf-8")
        # Setting up a task no longer installs a post-commit hook.
        assert not (repo / ".git" / "hooks" / "post-commit").exists()

    def test_an_existing_env_file_is_kept(self, repo, tmp_path):
        worktree = tmp_path / "wt"
        worktree.mkdir()
        (repo / ".env").write_text("NEW=1\n", encoding="utf-8")
        (worktree / ".env").write_text("MINE=1\n", encoding="utf-8")

        assert workspace_setup.copy_env_files_to_worktree(repo, worktree) == []
        assert (worktree / ".env").read_text(encoding="utf-8") == "MINE=1\n"

    def test_a_broken_profile_is_left_as_copied(self, repo, monkeypatch):
        from security.constants import PROFILE_FILENAME

        monkeypatch.setattr(workspace_setup, "_git_hook_check_done", True)
        (repo / PROFILE_FILENAME).write_text("{not json", encoding="utf-8")

        path, _manager, _spec = workspace_setup.setup_workspace(
            repo, SPEC, WorkspaceMode.ISOLATED
        )

        assert (path / PROFILE_FILENAME).read_text(encoding="utf-8") == "{not json"

    def test_a_spec_copied_twice_is_replaced(self, tmp_path):
        source = tmp_path / "spec"
        source.mkdir()
        (source / "spec.md").write_text("v2", encoding="utf-8")
        worktree = tmp_path / "wt"
        stale = worktree / ".workpilot" / "specs" / SPEC
        stale.mkdir(parents=True)
        (stale / "old.md").write_text("v1", encoding="utf-8")

        target = workspace_setup.copy_spec_to_worktree(source, worktree, SPEC)

        assert sorted(p.name for p in target.iterdir()) == ["spec.md"]

    def test_workpilot_itself_links_its_node_modules(self, repo, monkeypatch, capsys):
        monkeypatch.setattr(workspace_setup, "_git_hook_check_done", True)
        (repo / "package.json").write_text('{"name": "workpilot-ai"}', "utf-8")
        (repo / "node_modules").mkdir()
        (repo / "apps" / "frontend" / "node_modules").mkdir(parents=True)

        path, _m, _s = workspace_setup.setup_workspace(
            repo, SPEC, WorkspaceMode.ISOLATED
        )

        assert (path / "node_modules").is_dir()
        assert (path / "apps" / "frontend" / "node_modules").is_dir()
        assert "Dependencies linked" in capsys.readouterr().out


class TestNodeModulesLinks:
    def test_existing_targets_are_kept(self, tmp_path):
        project, worktree = tmp_path / "p", tmp_path / "w"
        (project / "node_modules").mkdir(parents=True)
        (worktree / "node_modules").mkdir(parents=True)

        assert workspace_setup.symlink_node_modules_to_worktree(project, worktree) == []

    @pytest.mark.skipif(
        workspace_setup.is_windows(), reason="a dangling symlink needs POSIX rights"
    )
    def test_a_dangling_link_is_kept(self, tmp_path):
        project, worktree = tmp_path / "p", tmp_path / "w"
        (project / "node_modules").mkdir(parents=True)
        worktree.mkdir()
        os.symlink(tmp_path / "nowhere", worktree / "node_modules")

        assert workspace_setup.symlink_node_modules_to_worktree(project, worktree) == []

    def test_a_failed_junction_is_a_warning(self, tmp_path, monkeypatch, capsys):
        project, worktree = tmp_path / "p", tmp_path / "w"
        (project / "node_modules").mkdir(parents=True)
        worktree.mkdir()
        monkeypatch.setattr(workspace_setup, "is_windows", lambda: True)

        def no_mklink(args, **_kwargs):
            return subprocess.CompletedProcess(args, 1, "", "access denied")

        monkeypatch.setattr(workspace_setup.subprocess, "run", no_mklink)

        assert workspace_setup.symlink_node_modules_to_worktree(project, worktree) == []
        assert "Could not link node_modules" in capsys.readouterr().out

    def test_a_junction_on_windows(self, tmp_path, monkeypatch):
        project, worktree = tmp_path / "p", tmp_path / "w"
        (project / "node_modules").mkdir(parents=True)
        worktree.mkdir()
        calls: list[list[str]] = []
        monkeypatch.setattr(workspace_setup, "is_windows", lambda: True)

        def mklink(args, **_kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, "", "")

        monkeypatch.setattr(workspace_setup.subprocess, "run", mklink)

        assert workspace_setup.symlink_node_modules_to_worktree(project, worktree) == [
            "node_modules"
        ]
        assert calls[0][:4] == ["cmd", "/c", "mklink", "/J"]


# ── After the build ─────────────────────────────────────────────────────


class TestFinalizeWorkspace:
    def test_direct_mode_is_already_merged(self, repo, capsys):
        assert (
            finalization.finalize_workspace(repo, SPEC, None) == WorkspaceChoice.MERGE
        )
        assert "Changes were made directly" in capsys.readouterr().out

    def test_the_ui_decides_later(self, built, capsys):
        path = built.get_worktree_path(SPEC)
        (path / "left.py").write_text("y = 1\n", encoding="utf-8")

        choice = finalization.finalize_workspace(
            built.project_dir, SPEC, built, auto_continue=True
        )

        assert choice == WorkspaceChoice.LATER
        assert "Worktree preserved for UI review." in capsys.readouterr().out
        assert "left.py" in git(path, "ls-files").stdout  # settled into the branch

    @pytest.mark.parametrize(
        ("picked", "choice"),
        [
            ("test", WorkspaceChoice.TEST),
            ("merge", WorkspaceChoice.MERGE),
            ("review", WorkspaceChoice.REVIEW),
            ("later", WorkspaceChoice.LATER),
        ],
    )
    def test_the_person_picks(self, built, person, capsys, picked, choice):
        person["menu"] = [picked]

        assert finalization.finalize_workspace(built.project_dir, SPEC, built) == choice
        out = capsys.readouterr().out
        assert "+ 1 new file" in out
        assert "~ 1 modified file" in out
        assert "- 1 deleted file" in out


class TestHandleWorkspaceChoice:
    def test_test_instructions(self, built, capsys):
        (built.get_worktree_path(SPEC) / "package.json").write_text("{}", "utf-8")

        finalization.handle_workspace_choice(
            WorkspaceChoice.TEST, built.project_dir, SPEC, built
        )

        out = capsys.readouterr().out
        assert f"cd {built.get_worktree_path(SPEC)}" in out
        assert "npm install && npm run dev" in out

    @pytest.mark.parametrize("choice", [WorkspaceChoice.TEST, WorkspaceChoice.LATER])
    def test_instructions_without_a_worktree(self, repo, capsys, choice):
        manager = WorktreeManager(repo, base_branch="main")

        finalization.handle_workspace_choice(choice, repo, SPEC, manager)

        assert f".workpilot/worktrees/tasks/{SPEC}" in capsys.readouterr().out

    @pytest.mark.parametrize("choice", [WorkspaceChoice.TEST, WorkspaceChoice.LATER])
    def test_instructions_for_a_broken_worktree(self, built, capsys, choice):
        path = built.get_worktree_path(SPEC)
        break_git_file(path)

        finalization.handle_workspace_choice(choice, built.project_dir, SPEC, built)

        assert f"cd {path}" in capsys.readouterr().out

    def test_merge_is_published(self, built, merges, capsys):
        finalization.handle_workspace_choice(
            WorkspaceChoice.MERGE, built.project_dir, SPEC, built
        )

        assert (built.project_dir / "search.py").exists()
        assert not built.get_worktree_path(SPEC).exists()
        # Regression: this merge was the only one the counters never heard.
        assert [(e.spec_name, e.automatic) for e in merges] == [(SPEC, False)]
        assert "Your feature has been added" in capsys.readouterr().out

    def test_a_conflicting_merge_is_not_published(self, built, merges, capsys):
        commit_file(built.project_dir, "app.py", "x = 3\n", "main app")

        finalization.handle_workspace_choice(
            WorkspaceChoice.MERGE, built.project_dir, SPEC, built
        )

        assert merges == []
        assert "There was a conflict merging" in capsys.readouterr().out

    def test_review_lists_the_changes(self, built, capsys):
        finalization.handle_workspace_choice(
            WorkspaceChoice.REVIEW, built.project_dir, SPEC, built
        )

        out = capsys.readouterr().out
        assert "+ search.py" in out
        assert "~ app.py" in out
        assert "- old.txt" in out
        assert f"git diff main...{BRANCH}" in out

    def test_later(self, built, capsys):
        finalization.handle_workspace_choice(
            WorkspaceChoice.LATER, built.project_dir, SPEC, built
        )

        assert "Your build is saved." in capsys.readouterr().out


class TestExistingBuild:
    def test_review(self, built, capsys):
        assert finalization.review_existing_build(built.project_dir, SPEC) is True
        assert "BUILD CONTENTS" in capsys.readouterr().out

    def test_review_without_a_build(self, repo, capsys):
        assert finalization.review_existing_build(repo, SPEC) is False
        assert finalization.discard_existing_build(repo, SPEC) is False
        assert finalization.check_existing_build(repo, SPEC) is False

    @pytest.mark.parametrize("typed", ["no", KeyboardInterrupt()])
    def test_discard_needs_the_word(self, built, person, typed):
        person["typed"] = [typed]

        assert finalization.discard_existing_build(built.project_dir, SPEC) is False
        assert built.get_worktree_path(SPEC).exists()

    def test_discard(self, built, person):
        person["typed"] = ["DELETE"]

        assert finalization.discard_existing_build(built.project_dir, SPEC) is True
        assert not built.get_worktree_path(SPEC).exists()
        assert not built._branch_exists(BRANCH)

    def test_continue_or_review(self, built, person):
        person["menu"] = ["continue", "review", "other"]
        person["typed"] = [""]

        assert finalization.check_existing_build(built.project_dir, SPEC) is True
        assert finalization.check_existing_build(built.project_dir, SPEC) is True
        assert finalization.check_existing_build(built.project_dir, SPEC) is True

    def test_quit(self, built, person):
        person["menu"] = [None]

        with pytest.raises(SystemExit):
            finalization.check_existing_build(built.project_dir, SPEC)

    def test_merge_then_start_fresh(self, built, person, merges):
        person["menu"] = ["merge"]

        assert finalization.check_existing_build(built.project_dir, SPEC) is False
        assert (built.project_dir / "search.py").exists()
        assert [e.spec_name for e in merges] == [SPEC]

    @pytest.mark.parametrize(("typed", "again"), [("delete", False), ("no", True)])
    def test_start_fresh(self, built, person, typed, again):
        person["menu"] = ["fresh"]
        person["typed"] = [typed]

        assert finalization.check_existing_build(built.project_dir, SPEC) is again


class TestAllWorktrees:
    def test_list_and_clean_up(self, built, person):
        assert [
            w.spec_name for w in finalization.list_all_worktrees(built.project_dir)
        ] == [SPEC]
        person["typed"] = ["no", KeyboardInterrupt(), "yes"]

        assert finalization.cleanup_all_worktrees(built.project_dir) is False
        assert finalization.cleanup_all_worktrees(built.project_dir) is False
        assert finalization.cleanup_all_worktrees(built.project_dir) is True
        assert finalization.list_all_worktrees(built.project_dir) == []
        assert finalization.cleanup_all_worktrees(built.project_dir) is False

    def test_clean_up_without_asking(self, built):
        assert finalization.cleanup_all_worktrees(built.project_dir, confirm=False)


# ── Display ─────────────────────────────────────────────────────────────


class TestDisplay:
    def test_no_changes(self, repo, capsys):
        manager = WorktreeManager(repo, base_branch="main", use_local_branch=True)
        manager.create_worktree(SPEC)

        display.show_build_summary(manager, SPEC)
        display.show_changed_files(manager, SPEC)

        out = capsys.readouterr().out
        assert "No changes were made." in out
        assert "No changes." in out

    def test_several_new_files(self, built, capsys):
        commit_file(built.get_worktree_path(SPEC), "more.py", "z = 1\n", "more")

        display.show_build_summary(built, SPEC)

        assert "+ 2 new files" in capsys.readouterr().out

    def test_a_typechange_is_shown_with_its_status(self, built, monkeypatch, capsys):
        monkeypatch.setattr(built, "get_changed_files", lambda _s: [("T", "link")])

        display.show_changed_files(built, SPEC)

        assert "  T link" in capsys.readouterr().out

    def test_staged_merge_message(self, capsys):
        display.print_merge_success(
            True, {"lock_files_excluded": 1}, spec_name=SPEC, keep_worktree=True
        )

        out = capsys.readouterr().out
        assert "CHANGES ADDED TO YOUR PROJECT" in out
        assert "Lock files kept from main." in out
        assert f"--spec {SPEC} --discard" in out

    def test_committed_merge_message_says_what_changed(self, capsys):
        display.print_merge_success(
            False,
            {"files_merged": 3, "conflicts_resolved": 1, "ai_assisted": 1},
            spec_name=SPEC,
            keep_worktree=True,
        )

        # Regression: the stats keys it read were never produced, so
        # "What changed:" stood above nothing.
        out = capsys.readouterr().out
        assert "+ 3 files merged" in out
        assert "~ 1 conflict resolved (1 with AI)" in out

    def test_committed_merge_message_after_cleanup(self, capsys):
        display.print_merge_success(False, {"files_merged": 1})

        out = capsys.readouterr().out
        assert "+ 1 file merged" in out
        assert "What changed:" in out
        assert "The separate workspace has been cleaned up." in out

    def test_conflicts_of_both_kinds(self, capsys):
        display.print_conflict_info(
            {
                "conflicts": [
                    "src/a b.py",
                    {"file": "x.py", "reason": "both", "severity": "critical"},
                    {"file": "y.py", "severity": "low"},
                ]
            }
        )

        out = capsys.readouterr().out
        assert "3 files had conflicts" in out
        assert "x.py ⛔" in out
        assert "git add 'src/a b.py' x.py y.py" in out
        assert "conflict markers" in out
        assert "could not be auto-merged" in out

    def test_no_conflicts_prints_nothing(self, capsys):
        display.print_conflict_info({})

        assert capsys.readouterr().out == ""


# ── Git helpers ─────────────────────────────────────────────────────────


class TestGitUtils:
    def test_renames_are_detected(self, repo):
        commit_file(repo, "a.py", "print('a')\n" * 20, "a")
        base = git(repo, "rev-parse", "HEAD").stdout.strip()
        (repo / "lib").mkdir()
        git(repo, "mv", "a.py", "lib/a.py")
        git(repo, "commit", "-q", "-m", "move")

        renames = git_utils.detect_file_renames(repo, base, "main")

        assert renames == {"a.py": "lib/a.py"}
        assert git_utils.apply_path_mapping("a.py", renames) == "lib/a.py"
        assert git_utils.apply_path_mapping("b.py", renames) == "b.py"
        assert git_utils.detect_file_renames(repo, "nope", "main") == {}

    def test_merge_base_and_contents(self, built, repo):
        assert git_utils.get_merge_base(repo, "main", BRANCH)
        assert git_utils.get_merge_base(repo, "main", "nope") is None
        assert git_utils.get_file_content_from_ref(repo, BRANCH, "app.py") == "x = 2\n"
        assert git_utils.get_file_content_from_ref(repo, BRANCH, "none.py") is None
        commit_file(built.get_worktree_path(SPEC), "logo.png", b"\x89PNG\xff", "logo")
        assert git_utils.get_binary_file_content_from_ref(repo, BRANCH, "logo.png") == (
            b"\x89PNG\xff"
        )
        assert git_utils.get_binary_file_content_from_ref(repo, BRANCH, "x.png") is None

    def test_changed_files_leave_out_workpilot_files(self, built, repo):
        commit_file(
            built.get_worktree_path(SPEC), ".workpilot/specs/x/plan.json", "{}", "p"
        )

        changed = git_utils.get_changed_files_from_branch(repo, "main", BRANCH)
        everything = git_utils.get_changed_files_from_branch(
            repo, "main", BRANCH, exclude_workpilot=False
        )

        assert sorted(changed) == [
            ("app.py", "M"),
            ("old.txt", "D"),
            ("search.py", "A"),
        ]
        assert (".workpilot/specs/x/plan.json", "A") in everything

    def test_legacy_build_worktree(self, repo):
        legacy = repo / ".worktrees" / SPEC
        legacy.mkdir(parents=True)

        assert git_utils.get_existing_build_worktree(repo, SPEC) == legacy

    def test_file_kinds(self):
        assert git_utils.is_binary_file("logo.PNG")
        assert not git_utils.is_binary_file("app.py")
        assert git_utils.is_lock_file("apps/web/pnpm-lock.yaml")
        assert not git_utils.is_lock_file("lock.py")
        assert git_utils._is_workpilot_file(".workpilot\\specs\\x.md")

    @pytest.mark.parametrize(
        ("name", "content", "valid", "message"),
        [
            ("ok.py", "x = 1\n", True, ""),
            ("bad.py", "def f(:\n", False, "Python syntax error"),
            ("ok.json", '{"a": 1}', True, ""),
            ("bad.json", "{", False, "JSON error"),
            ("notes.md", "# anything", True, ""),
        ],
    )
    def test_syntax_of_merged_code(self, tmp_path, name, content, valid, message):
        is_valid, error = git_utils.validate_merged_syntax(name, content, tmp_path)

        assert is_valid is valid
        assert error.startswith(message)


def write_esbuild(bin_dir: Path, body: str) -> Path:
    bin_dir.mkdir(parents=True, exist_ok=True)
    program = bin_dir / "fake_esbuild.py"
    program.write_text(body, encoding="utf-8")
    esbuild = bin_dir / "esbuild"
    esbuild.write_text(
        f'#!/bin/sh\nexec "{sys.executable}" "{program}" "$@"\n',
        encoding="utf-8",
        newline="\n",
    )
    esbuild.chmod(0o755)
    return esbuild


ESBUILD_CHECK = """
import sys
from pathlib import Path
source = Path(sys.argv[1]).read_text(encoding="utf-8")
if "€" not in source:
    sys.exit("fake esbuild: the file lost its characters")
if "((" in source:
    sys.stderr.write("npm warn config\\n✘ [ERROR] Expected \\")\\" but found end of file\\n")
    sys.exit(1)
"""


@pytest.mark.skipif(
    workspace_setup.is_windows(), reason="the fake esbuild is a POSIX shell script"
)
class TestScriptSyntax:
    def test_esbuild_from_node_modules(self, tmp_path):
        write_esbuild(tmp_path / "node_modules" / ".bin", ESBUILD_CHECK)

        ok = git_utils.validate_merged_syntax("a.ts", "const p = '€';\n", tmp_path)
        bad = git_utils.validate_merged_syntax("a.tsx", "f(( // €\n", tmp_path)

        assert ok == (True, "")
        assert bad == (
            False,
            'Syntax error: ✘ [ERROR] Expected ")" but found end of file',
        )

    def test_esbuild_from_the_pnpm_store_of_the_parent(self, tmp_path):
        project = tmp_path / "apps" / "web"
        project.mkdir(parents=True)
        store = tmp_path / "apps" / "node_modules" / ".pnpm"
        write_esbuild(
            store / "esbuild@0.25.0" / "node_modules" / "esbuild" / "bin",
            "import sys; sys.exit(0)\n",
        )

        assert git_utils.validate_merged_syntax("a.js", "x;", project) == (True, "")

    def test_a_hung_esbuild_is_not_a_failure(self, tmp_path, monkeypatch):
        write_esbuild(tmp_path / "node_modules" / ".bin", "")

        def hung(*_a, **_k):
            raise subprocess.TimeoutExpired("esbuild", 15)

        monkeypatch.setattr(git_utils.subprocess, "run", hung)

        assert git_utils.validate_merged_syntax("a.js", "x;", tmp_path) == (True, "")

    def test_without_esbuild_or_npx_nothing_is_checked(self, tmp_path, monkeypatch):
        monkeypatch.setenv("PATH", str(tmp_path / "empty"))

        assert git_utils.validate_merged_syntax("a.jsx", "<a/>", tmp_path) == (
            True,
            "",
        )


# ── Locks ───────────────────────────────────────────────────────────────


class TestMergeLock:
    def test_held_then_released(self, tmp_path):
        with MergeLock(tmp_path, SPEC) as lock:
            assert lock.lock_file.read_text(encoding="utf-8") == str(os.getpid())
        assert not lock.lock_file.exists()

    @pytest.mark.parametrize("content", ["not a pid", "{dead}"])
    def test_a_stale_lock_is_taken_over(self, tmp_path, content):
        dead = subprocess.run(
            [sys.executable, "-c", "import os; print(os.getpid())"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        lock = MergeLock(tmp_path, SPEC)
        lock.lock_dir.mkdir(parents=True)
        lock.lock_file.write_text(content.format(dead=dead), encoding="utf-8")

        with lock:
            assert lock.acquired

    def test_waits_for_a_live_holder(self, tmp_path):
        holder = subprocess.Popen(
            [sys.executable, "-c", "import sys; sys.stdin.read()"],
            stdin=subprocess.PIPE,
        )
        lock = MergeLock(tmp_path, SPEC)
        lock.lock_dir.mkdir(parents=True)
        lock.lock_file.write_text(str(holder.pid), encoding="utf-8")
        finish = threading.Timer(0.3, lambda: (holder.stdin.close(), holder.wait()))
        finish.start()
        try:
            with lock:
                assert lock.acquired
        finally:
            finish.join()

    def test_release_of_a_lock_already_gone(self, tmp_path):
        with MergeLock(tmp_path, SPEC) as lock:
            lock.lock_file.unlink()


class TestSpecNumberLock:
    def test_the_next_number_spans_the_project_and_its_worktrees(self, tmp_path):
        specs = tmp_path / ".workpilot" / "specs"
        (specs / "001-a").mkdir(parents=True)
        (specs / "notes").mkdir()
        task = tmp_path / ".workpilot" / "worktrees" / "tasks" / "x"
        (task / ".workpilot" / "specs" / "007-b").mkdir(parents=True)
        (tmp_path / ".workpilot" / "worktrees" / "tasks" / "file").write_text(
            "", encoding="utf-8"
        )

        with SpecNumberLock(tmp_path) as lock:
            assert lock.get_next_spec_number() == 8
            assert lock.get_next_spec_number() == 8  # cached while held

    def test_the_number_needs_the_lock(self, tmp_path):
        with pytest.raises(SpecNumberLockError):
            SpecNumberLock(tmp_path).get_next_spec_number()

    def test_a_stale_lock_is_taken_over(self, tmp_path):
        lock = SpecNumberLock(tmp_path)
        lock.lock_dir.mkdir(parents=True)
        lock.lock_file.write_text("garbage", encoding="utf-8")

        with lock:
            assert lock.get_next_spec_number() == 1
