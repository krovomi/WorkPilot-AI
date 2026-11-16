"""Adding a finished task to the project: `merge_existing_build`, end to end.

A real project with a task worktree. Main and the task change files the way
real work does (side by side, on the same lines, adding, deleting, renaming),
then the merge runs as `run.py --merge` runs it. The model that resolves a
conflict is the only stand-in: `core.simple_client.create_simple_client`
returns a client that answers from the test.
"""

from __future__ import annotations

import importlib
import subprocess
from pathlib import Path

import core.workspace as workspace_pkg
import pytest
from core.workspace import merge_existing_build
from core.workspace.models import ParallelMergeTask
from core.worktree import WorktreeManager
from phase_config import MODEL_ID_MAP

ws = workspace_pkg._workspace_module
SPEC = "003-discounts"
BRANCH = f"workpilot/{SPEC}"

BASE_APP = "def price(x):\n    return x\n"
MAIN_APP = "def price(x):\n    return round(x, 2)\n"
TASK_APP = "def price(x):\n    return x * 0.9\n"
MERGED_APP = "def price(x):\n    return round(x * 0.9, 2)\n"


def git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=check,
    )


def write(cwd: Path, name: str, content: str | bytes) -> None:
    path = cwd / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content, encoding="utf-8")


def commit(cwd: Path, message: str, **files: str | bytes | None) -> None:
    for name, content in files.items():
        name = name.replace("__", "/").replace("_dot_", ".")
        if content is None:
            git(cwd, "rm", "-q", "--", name)
        else:
            write(cwd, name, content)
            git(cwd, "add", "--", name)
    git(cwd, "commit", "-q", "-m", message)


def staged(repo: Path) -> list[str]:
    return git(repo, "diff", "--cached", "--name-only").stdout.split()


# ── The model ───────────────────────────────────────────────────────────


class TextBlock:
    def __init__(self, text: str):
        self.text = text


class AssistantMessage:
    def __init__(self, text: str):
        self.content = [TextBlock(text)]


class Model:
    """Stands in for the Claude client of the merge: one answer per session."""

    def __init__(self):
        self.answers: list[str] = [MERGED_APP]
        self.sessions: list[dict] = []

    def client(self, **options):
        model = self
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        record = {"options": options, "prompt": None}
        self.sessions.append(record)

        class Client:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def query(self, prompt):
                record["prompt"] = prompt

            async def receive_response(self):
                if answer:
                    yield AssistantMessage(answer)

        del model
        return Client()


@pytest.fixture
def model(monkeypatch):
    # Patched on the module objects `from core.x import y` reads (sys.modules):
    # a file that mocks `core` at collection can leave the package attribute
    # on another copy, and the real client would then be reached.
    simple_client = importlib.import_module("core.simple_client")
    auth = importlib.import_module("core.auth")
    m = Model()
    monkeypatch.setattr(simple_client, "create_simple_client", m.client)
    monkeypatch.setattr(auth, "get_auth_token", lambda *_a: "tok-test")
    monkeypatch.setattr(auth, "ensure_claude_code_oauth_token", lambda: None)
    m.auth = auth
    m.simple_client = simple_client
    return m


# ── The project ─────────────────────────────────────────────────────────


class Project:
    def __init__(self, repo: Path):
        self.repo = repo
        commit(repo, "app", app_dot_py=BASE_APP)
        self.manager = WorktreeManager(repo, base_branch="main", use_local_branch=True)
        self.task = self.manager.create_worktree(SPEC).path

    def main(self, message: str = "main work", **files) -> None:
        commit(self.repo, message, **files)

    def work(self, message: str = "task work", **files) -> None:
        commit(self.task, message, **files)

    def read(self, name: str) -> str:
        return (self.repo / name).read_text(encoding="utf-8")


@pytest.fixture
def project(isolated_repo, tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("DEFAULT_BRANCH", raising=False)
    return Project(isolated_repo)


# ── merge_existing_build ────────────────────────────────────────────────


class TestMergeExistingBuild:
    def test_no_build_to_add(self, project, capsys):
        assert merge_existing_build(project.repo, "999-none") is False
        assert "No existing build found for '999-none'" in capsys.readouterr().out

    def test_not_from_the_task_branch_itself(self, project, capsys):
        git(project.task, "checkout", "-q", "--detach")
        git(project.repo, "checkout", "-q", BRANCH)

        assert merge_existing_build(project.repo, SPEC) is False
        assert "You're on the spec branch" in capsys.readouterr().out

    def test_the_task_is_added_and_committed(self, project):
        project.work(cart_dot_py="CART = []\n")

        assert merge_existing_build(project.repo, SPEC) is True

        assert project.read("cart.py") == "CART = []\n"
        assert git(project.repo, "status", "--porcelain", "--", "cart.py").stdout == ""
        assert git(project.repo, "log", "-1", "--format=%s").stdout.startswith(
            "workpilot: Merge"
        )
        assert project.task.exists(), "the worktree stays for testing"

    def test_staged_for_review(self, project, capsys):
        project.work(cart_dot_py="CART = []\n")

        assert merge_existing_build(project.repo, SPEC, no_commit=True) is True

        assert staged(project.repo) == ["cart.py"]
        assert "STAGING BUILD FOR REVIEW" in capsys.readouterr().out

    @pytest.mark.parametrize("no_commit", [False, True])
    def test_plain_git_merge(self, project, capsys, no_commit):
        project.work(cart_dot_py="CART = []\n")

        assert (
            merge_existing_build(
                project.repo, SPEC, no_commit=no_commit, use_smart_merge=False
            )
            is True
        )

        out = capsys.readouterr().out
        assert "--discard" in out
        assert ("Changes are staged" in out) is no_commit

    def test_plain_git_merge_conflict(self, project, capsys):
        project.main(app_dot_py=MAIN_APP)
        project.work(app_dot_py=TASK_APP)

        assert merge_existing_build(project.repo, SPEC, use_smart_merge=False) is False
        assert "There was a conflict merging the changes." in capsys.readouterr().out

    def test_side_by_side_work_is_combined(self, project):
        project.main(notes_dot_md="# Shop\n")
        project.work(cart_dot_py="CART = []\n")

        assert merge_existing_build(project.repo, SPEC) is True

        assert project.read("cart.py") == "CART = []\n"
        assert project.read("notes.md") == "# Shop\n"

    def test_a_conflict_is_resolved_by_the_model(self, project, model):
        project.main(app_dot_py=MAIN_APP)
        project.work(app_dot_py=TASK_APP, cart_dot_py="CART = []\n")

        assert merge_existing_build(project.repo, SPEC) is True

        # Regression: the answer was stripped, and the file lost its last newline.
        assert project.read("app.py") == MERGED_APP
        assert sorted(staged(project.repo)) == ["app.py", "cart.py"]
        prompt = model.sessions[0]["prompt"]
        assert "FILE: app.py" in prompt
        assert "return x * 0.9" in prompt
        # The merge is a text-only call: no tools reach the project.
        assert model.sessions[0]["options"]["agent_type"] == "commit_message"

    def test_an_unresolved_conflict_is_left_to_the_person(self, project, model, capsys):
        model.answers = ["I cannot merge this file safely."]
        project.main(app_dot_py=MAIN_APP)
        project.work(app_dot_py=TASK_APP, cart_dot_py="CART = []\n")

        assert merge_existing_build(project.repo, SPEC) is False

        out = capsys.readouterr().out
        assert "1 conflict(s) require manual resolution" in out
        assert "AI resolved 1 file(s)" in out  # the new file
        assert len(model.sessions) == 2  # the fast model, then the capable one

    def test_a_held_merge_lock_falls_back_to_git(self, project, monkeypatch, capsys):
        def held(*_args):
            raise ws.MergeLockError("Could not acquire merge lock for x after 30s")

        monkeypatch.setattr(ws.MergeLock, "__enter__", held)
        project.work(cart_dot_py="CART = []\n")

        assert merge_existing_build(project.repo, SPEC) is True
        assert "Could not acquire merge lock" in capsys.readouterr().out

    def test_semantic_conflicts_are_shown_then_git_merges(
        self, project, monkeypatch, capsys
    ):
        conflict = {"file": "app.py", "can_auto_merge": False, "reason": "both"}
        monkeypatch.setattr(
            ws.MergePreview,
            "preview_merge",
            lambda self, specs: {
                "files_to_merge": ["app.py"],
                "conflicts": [conflict],
                "summary": {"auto_mergeable": 0},
            },
        )
        project.work(cart_dot_py="CART = []\n")

        assert merge_existing_build(project.repo, SPEC) is True
        assert "Attempting git merge anyway..." in capsys.readouterr().out

    def test_a_failing_analysis_falls_back_to_git(self, project, monkeypatch, capsys):
        def broken(self, specs):
            raise RuntimeError("analysis broke")

        monkeypatch.setattr(ws.MergePreview, "preview_merge", broken)
        project.work(cart_dot_py="CART = []\n")

        assert merge_existing_build(project.repo, SPEC) is True
        assert "Smart merge error: analysis broke" in capsys.readouterr().out


class TestProgressInSubprocessMode:
    def test_progress_is_emitted_when_stdout_is_piped(self, monkeypatch):
        monkeypatch.setattr("sys.stdout.isatty", lambda: False)

        assert ws._create_merge_progress_callback() is ws.emit_progress

    def test_no_progress_in_a_terminal(self, monkeypatch):
        monkeypatch.setattr("sys.stdout.isatty", lambda: True)

        assert ws._create_merge_progress_callback() is None


# ── _resolve_git_conflicts_with_ai, file by file ────────────────────────


def resolve(project, files: list[str]) -> dict:
    conflicts = {
        "has_conflicts": True,
        "conflicting_files": files,
        "base_branch": "main",
        "spec_branch": BRANCH,
    }
    return ws._resolve_git_conflicts_with_ai(
        project.repo, SPEC, project.task, conflicts
    )


class TestResolveConflicts:
    def test_every_kind_of_change(self, project, model):
        # Base: files both sides will touch.
        project.main(
            "base",
            notes_dot_txt="a\n",
            gone_dot_txt="old\n",
            kept_dot_txt="keep\n",
            **{"package-lock.json": '{"v": 0}\n'},
        )
        git(project.task, "merge", "-q", "main")
        project.main(
            "main moves on",
            app_dot_py=MAIN_APP,
            notes_dot_txt="a\nfrom main\n",
            **{"package-lock.json": '{"v": "main"}\n'},
        )
        project.work(
            "task",
            app_dot_py=TASK_APP,
            notes_dot_txt="a\nfrom main\n",  # the same change on both sides
            gone_dot_txt=None,
            kept_dot_txt="keep, edited\n",
            logo_dot_png=b"\x89PNG\x00\x01",
            new__module_dot_py="VALUE = 1\n",
            **{"package-lock.json": '{"v": "task"}\n'},
        )

        result = resolve(
            project,
            ["app.py", "notes.txt", "gone.txt", "package-lock.json", "absent.txt"],
        )

        assert result["success"] is True
        assert project.read("app.py") == MERGED_APP
        assert project.read("notes.txt") == "a\nfrom main\n"
        assert not (project.repo / "gone.txt").exists()
        assert project.read("package-lock.json") == '{"v": "main"}\n'
        assert project.read("kept.txt") == "keep, edited\n"
        assert (project.repo / "logo.png").read_bytes() == b"\x89PNG\x00\x01"
        assert project.read("new/module.py") == "VALUE = 1\n"
        assert result["lock_files_excluded"] == ["package-lock.json"]
        stats = result["stats"]
        assert stats["ai_assisted"] == 1
        assert stats["simple_3way_merged"] == 1
        assert stats["lock_files_excluded"] == 1

    def test_a_file_new_on_both_sides(self, project, model):
        project.main(api_dot_py="A = 'main'\n")
        project.work(api_dot_py="A = 'task'\n")
        model.answers = ["A = 'both'\n"]

        result = resolve(project, ["api.py"])

        assert result["success"] is True
        assert project.read("api.py") == "A = 'both'\n"
        assert "BASE (common ancestor" not in model.sessions[0]["prompt"]

    def test_a_task_file_main_never_had(self, project, model):
        project.work(extra_dot_py="X = 1\n")

        result = resolve(project, ["extra.py"])

        assert project.read("extra.py") == "X = 1\n"
        assert result["stats"]["ai_assisted"] == 0

    def test_a_task_change_to_a_deleted_main_file(self, project, model):
        project.work("task deletes", app_dot_py=None)

        result = resolve(project, ["app.py"])

        assert result["success"] is True
        assert not (project.repo / "app.py").exists()

    def test_the_task_change_follows_a_rename_on_main(self, project, model):
        git(project.repo, "mv", "app.py", "pricing.py")
        git(project.repo, "commit", "-q", "-m", "rename")
        project.main(pricing_dot_py=MAIN_APP)
        project.work(app_dot_py=TASK_APP, other_dot_py="Y = 2\n")
        model.answers = [MERGED_APP]

        result = resolve(project, ["app.py"])

        assert result["success"] is True
        assert project.read("pricing.py") == MERGED_APP
        assert not (project.repo / "app.py").exists()

    def test_a_renamed_file_changed_only_by_the_task(self, project, model, capsys):
        project.main(helper_dot_py="def helper():\n    return 1\n\n\nVALUE = 10\n")
        git(project.task, "merge", "-q", "main")
        git(project.repo, "mv", "helper.py", "helpers.py")
        git(project.repo, "commit", "-q", "-m", "rename helper")
        project.work(helper_dot_py="def helper():\n    return 2\n\n\nVALUE = 10\n")
        project.main(app_dot_py=MAIN_APP)
        project.work(app_dot_py=TASK_APP)
        model.answers = [MERGED_APP, "def helper():\n    return 2\n\n\nVALUE = 10\n"]

        result = resolve(project, ["app.py"])

        assert result["success"] is True
        assert project.read("helpers.py").startswith("def helper():\n    return 2")
        assert "path-mapped file(s) with AI" in capsys.readouterr().out

    def test_the_model_breaks_the_code(self, project, model):
        model.answers = ["def price(x:\n    return"]
        project.main(app_dot_py=MAIN_APP)
        project.work(app_dot_py=TASK_APP)

        result = resolve(project, ["app.py"])

        assert result["success"] is False
        assert result["remaining_conflicts"][0]["reason"].startswith(
            "AI merge failed: Invalid syntax: Python syntax error"
        )
        assert result["partial_success"] is False

    def test_the_model_says_nothing(self, project, model):
        model.answers = [""]
        project.main(app_dot_py=MAIN_APP)
        project.work(app_dot_py=TASK_APP)

        result = resolve(project, ["app.py"])

        assert result["remaining_conflicts"][0]["reason"] == (
            "AI merge failed: AI returned empty response"
        )

    def test_the_fast_model_fails_and_the_capable_one_merges(self, project, model):
        model.answers = [
            "I need to see more context.",
            "```python\n" + MERGED_APP + "```",
        ]
        project.main(app_dot_py=MAIN_APP)
        project.work(app_dot_py=TASK_APP)

        result = resolve(project, ["app.py"])

        assert result["success"] is True
        assert project.read("app.py") == MERGED_APP
        # On Claude: a quick model first, then a capable one.
        models = [s["options"]["model"] for s in model.sessions]
        assert models == [MODEL_ID_MAP["haiku"], MODEL_ID_MAP["sonnet"]]


class TestParallelMerges:
    def _task(self, project, **overrides) -> ParallelMergeTask:
        fields = {
            "file_path": "app.py",
            "main_content": MAIN_APP,
            "worktree_content": TASK_APP,
            "base_content": BASE_APP,
            "spec_name": SPEC,
            "project_dir": project.repo,
        }
        fields.update(overrides)
        return ParallelMergeTask(**fields)

    def test_nothing_to_merge(self, project):
        import asyncio

        assert asyncio.run(ws._run_parallel_merges([], project.repo)) == []

    def test_one_sided_change_needs_no_model(self, project, model):
        import asyncio

        task = self._task(project, main_content=BASE_APP)

        [result] = asyncio.run(ws._run_parallel_merges([task], project.repo))

        assert result.was_auto_merged is True
        assert result.merged_content == TASK_APP
        assert model.sessions == []

    def test_a_crashing_client_is_a_failed_file(self, project, model, monkeypatch):
        import asyncio

        def crash(**_options):
            raise RuntimeError("SDK not installed")

        monkeypatch.setattr(model.simple_client, "create_simple_client", crash)

        [result] = asyncio.run(
            ws._run_parallel_merges([self._task(project)], project.repo)
        )

        assert result.success is False
        assert result.error == "SDK not installed"

    def test_a_large_file_is_cut_in_the_prompt(self):
        big = "x = 1\n" * 4000

        prompt = ws._build_merge_prompt("big.py", big, big, big, SPEC)

        assert prompt.count("... (truncated)") == 3
        assert "```python" in prompt

    @pytest.mark.parametrize(
        ("path", "language"),
        [("a.tsx", "typescript"), ("b.yml", "yaml"), ("c.unknown", "text")],
    )
    def test_the_language_follows_the_extension(self, path, language):
        assert ws._infer_language_from_path(path) == language

    def test_an_unclosed_fence_is_stripped(self):
        assert ws._strip_code_fences("```python\nx = 1") == "x = 1"
        assert ws._strip_code_fences("x = 1") == "x = 1"


class TestWorkpilotFilesInTheWay:
    def test_a_conflict_only_in_workpilot_files_falls_back_to_git(
        self, project, capsys
    ):
        commit(project.repo, "notes", **{".workpilot/notes.md": "base\n"})
        git(project.task, "merge", "-q", "main")
        commit(project.repo, "main notes", **{".workpilot/notes.md": "main\n"})
        project.work(
            "task notes",
            cart_dot_py="CART = []\n",
            **{".workpilot/notes.md": "task\n"},
        )

        assert merge_existing_build(project.repo, SPEC) is False

        out = capsys.readouterr().out
        assert "Branches diverged but no conflicts detected" in out
        assert "Git merge failed unexpectedly" in out
        assert not (project.repo / ".git" / "MERGE_HEAD").exists()


class TestRebaseOutsideAWorktree:
    def _branch_only(self, project) -> None:
        """The task's worktree is gone, its branch is still there."""
        git(project.repo, "worktree", "remove", "--force", str(project.task))

    def test_from_a_detached_project(self, project):
        project.work(cart_dot_py="CART = []\n")
        self._branch_only(project)
        git(project.repo, "checkout", "-q", "--detach")

        assert ws._rebase_spec_branch(project.repo, SPEC, "main") is False

    def test_an_unknown_task_branch(self, project):
        self._branch_only(project)
        git(project.repo, "branch", "-D", BRANCH)

        assert ws._rebase_spec_branch(project.repo, SPEC, "main") is False

    def test_an_unknown_base(self, project):
        project.work(cart_dot_py="CART = []\n")
        self._branch_only(project)

        assert ws._rebase_spec_branch(project.repo, SPEC, "nope") is False
        assert git(project.repo, "branch", "--show-current").stdout.strip() == "main"
