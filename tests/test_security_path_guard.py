"""Where a build may write.

Every path here that gets refused was, before `security.path_guard` existed,
an ordinary successful write: the only hook on `Write` and `Edit` was the
guardrails hook, and it returns "no opinion" when the project has no
`.workpilot/guardrails.yaml` — which is the default.

The three that matter most are the ones that change the *next* run:
`~/.claude/settings.json` rewrites the agent's own permissions,
`~/.ssh/authorized_keys` rewrites who may log in, and a write into the main
checkout rewrites the branch the worktree existed to protect.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "backend"))

from security.path_guard import (  # noqa: E402
    GUARDED_WRITE_TOOLS,
    make_write_path_hook,
    resolve_write_roots,
)


def call(hook, tool_name: str, tool_input: dict) -> dict:
    return asyncio.run(hook({"tool_name": tool_name, "tool_input": tool_input}))


def denied(result: dict) -> str:
    assert result, "the hook allowed a write it should have refused"
    output = result["hookSpecificOutput"]
    assert output["permissionDecision"] == "deny"
    return output["permissionDecisionReason"]


@pytest.fixture
def build(tmp_path, monkeypatch):
    """A worktree, a spec directory beside it, and a main checkout it must not touch."""
    monkeypatch.delenv("WORKPILOT_WRITE_ROOTS", raising=False)

    project = tmp_path / "worktree"
    spec = tmp_path / "specs" / "001-feature"
    main_checkout = tmp_path / "main-checkout"
    for directory in (project, spec, main_checkout):
        directory.mkdir(parents=True)

    return {
        "project": project,
        "spec": spec,
        "main_checkout": main_checkout,
        "hook": make_write_path_hook(project, spec),
    }


class TestWhatIsRefused:
    @pytest.mark.parametrize("tool", GUARDED_WRITE_TOOLS)
    def test_every_write_tool_is_covered(self, tool, build):
        """`MultiEdit` and `NotebookEdit` write too."""
        field = "notebook_path" if tool == "NotebookEdit" else "file_path"
        outside = str(Path.home() / ".bashrc")
        assert denied(call(build["hook"], tool, {field: outside}))

    def test_the_agents_own_settings_are_out_of_reach(self, build):
        target = str(Path.home() / ".claude" / "settings.json")
        assert "outside" in denied(
            call(build["hook"], "Write", {"file_path": target, "content": "{}"})
        )

    def test_the_main_checkout_is_out_of_reach_of_a_worktree_build(self, build):
        """The isolation the product promises, enforced instead of assumed."""
        target = str(build["main_checkout"] / "src" / "app.py")
        assert denied(call(build["hook"], "Write", {"file_path": target}))

    def test_a_relative_path_escaping_upwards_is_refused(self, build):
        assert denied(
            call(build["hook"], "Write", {"file_path": "../main-checkout/app.py"})
        )

    def test_a_symlink_is_judged_by_where_it_points(self, build):
        """A link planted in the worktree is not a way out of it."""
        link = build["project"] / "innocent.txt"
        link.symlink_to(Path.home() / ".bashrc")
        assert denied(call(build["hook"], "Write", {"file_path": str(link)}))


class TestWhatIsAllowed:
    def test_a_file_in_the_worktree(self, build):
        target = str(build["project"] / "src" / "app.py")
        assert call(build["hook"], "Write", {"file_path": target}) == {}

    def test_a_relative_path_inside_the_worktree(self, build):
        assert call(build["hook"], "Edit", {"file_path": "src/app.py"}) == {}

    def test_a_file_in_the_spec_directory(self, build):
        """The plan, the QA report and the ledgers live there."""
        target = str(build["spec"] / "qa_report.md")
        assert call(build["hook"], "Write", {"file_path": target}) == {}

    def test_a_scratch_file_in_workpilots_own_temp_directory(self, build):
        from security.path_guard import workpilot_scratch_dir

        target = str(workpilot_scratch_dir() / "scratch.diff")
        assert call(build["hook"], "Write", {"file_path": target}) == {}

    def test_the_rest_of_the_system_temp_directory_is_not_a_root(self, build):
        """`/tmp` is shared with every process on the machine."""
        import tempfile

        target = str(Path(tempfile.gettempdir()) / "someone-elses.sock")
        assert denied(call(build["hook"], "Write", {"file_path": target}))

    def test_a_tool_that_writes_nothing_is_not_this_hooks_business(self, build):
        assert call(build["hook"], "Bash", {"command": "rm -rf /"}) == {}
        assert call(build["hook"], "Read", {"file_path": "/etc/passwd"}) == {}


class TestTheEscapeHatchIsAdditiveOnly:
    def test_a_named_root_is_writable(self, tmp_path, monkeypatch):
        sibling = tmp_path / "sibling-repo"
        sibling.mkdir()
        monkeypatch.setenv("WORKPILOT_WRITE_ROOTS", str(sibling))

        project = tmp_path / "worktree"
        project.mkdir()
        hook = make_write_path_hook(project, None)

        assert call(hook, "Write", {"file_path": str(sibling / "a.py")}) == {}

    def test_naming_a_root_does_not_open_the_rest(self, tmp_path, monkeypatch):
        """There is no value of this variable that turns the guard off."""
        sibling = tmp_path / "sibling-repo"
        sibling.mkdir()
        monkeypatch.setenv("WORKPILOT_WRITE_ROOTS", str(sibling))

        project = tmp_path / "worktree"
        project.mkdir()
        hook = make_write_path_hook(project, None)

        assert denied(call(hook, "Write", {"file_path": str(Path.home() / ".bashrc")}))


class TestRootResolution:
    def test_the_project_is_listed_first(self, tmp_path):
        roots = resolve_write_roots(tmp_path / "p", tmp_path / "s")
        assert roots[0] == (tmp_path / "p").resolve()

    def test_a_duplicate_is_listed_once(self, tmp_path):
        roots = resolve_write_roots(tmp_path, tmp_path)
        assert roots.count(tmp_path.resolve()) == 1

    def test_no_roots_means_the_hook_says_nothing_rather_than_refusing_everything(
        self, monkeypatch
    ):
        """A wiring mistake must not look like an attack on every write."""
        monkeypatch.delenv("WORKPILOT_WRITE_ROOTS", raising=False)
        monkeypatch.setattr("security.path_guard.resolve_write_roots", lambda *_: [])
        hook = make_write_path_hook(None, None)
        assert call(hook, "Write", {"file_path": "/etc/passwd"}) == {}
