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

import security.path_guard as path_guard  # noqa: E402
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
        # By module object, not by dotted string — see the note in
        # test_security_command_guard.py: under `--import-mode=importlib` a
        # string target can resolve through a placeholder `security` module
        # that pytest itself created.
        monkeypatch.setattr(path_guard, "resolve_write_roots", lambda *_: [])
        hook = make_write_path_hook(None, None)
        assert call(hook, "Write", {"file_path": "/etc/passwd"}) == {}


# ─────────────────────────────────────────────────────────────────────────────
# Inside the roots: the files that decide what an agent may do
# ─────────────────────────────────────────────────────────────────────────────

#: Every file that grants an agent a right, as a build would name it.
SECURITY_CONFIGURATION = (
    ".workpilot-allowlist",
    ".workpilot-security.json",
    ".workpilot/guardrails.yaml",
    ".workpilot/guardrails.yml",
    ".workpilot/guardrails.json",
    ".claude_settings.json",
    ".claude/settings.json",
    ".claude/settings.local.json",
)


class TestSecurityConfigurationIsNotWritable:
    """The roots are the project, and the project holds its own allowlist.

    `get_security_profile` reloads the allowlist and the profile as soon as
    their mtime changes, so before this an agent that wrote
    `.workpilot-security.json` had the commands it listed on its next call.
    """

    @pytest.mark.parametrize("relative", SECURITY_CONFIGURATION)
    def test_each_file_is_refused_by_absolute_path(self, relative, build):
        target = str(build["project"] / relative)
        reason = denied(call(build["hook"], "Write", {"file_path": target}))
        assert "security configuration" in reason

    @pytest.mark.parametrize("relative", SECURITY_CONFIGURATION)
    def test_each_file_is_refused_by_relative_path(self, relative, build):
        assert denied(call(build["hook"], "Edit", {"file_path": relative}))

    @pytest.mark.parametrize("tool", GUARDED_WRITE_TOOLS)
    def test_every_write_tool_is_covered(self, tool, build):
        field = "notebook_path" if tool == "NotebookEdit" else "file_path"
        target = str(build["project"] / ".workpilot-allowlist")
        assert denied(call(build["hook"], tool, {field: target}))

    def test_the_profile_kept_in_the_spec_directory_is_refused(self, build):
        """`ProjectAnalyzer.get_profile_path` stores it there when it has one."""
        target = str(build["spec"] / ".workpilot-security.json")
        assert denied(call(build["hook"], "Write", {"file_path": target}))

    @pytest.mark.parametrize(
        "spelling",
        [
            ".WorkPilot-Allowlist",  # Windows and macOS compare without case
            ".workpilot-allowlist.",  # Windows drops a trailing dot
            ".workpilot-allowlist ",  # … and a trailing space
            ".workpilot-allowlist::$DATA",  # NTFS: the file's default stream
            ".CLAUDE/Settings.Local.JSON",
            "src/../.workpilot-security.json",
        ],
    )
    def test_another_spelling_of_the_same_file_is_refused(self, spelling, build):
        assert denied(call(build["hook"], "Write", {"file_path": spelling}))

    def test_a_link_to_the_allowlist_is_judged_by_where_it_points(self, build):
        allowlist = build["project"] / ".workpilot-allowlist"
        allowlist.write_text("", encoding="utf-8")
        link = build["project"] / "notes.txt"
        link.symlink_to(allowlist)
        assert denied(call(build["hook"], "Write", {"file_path": str(link)}))

    def test_a_directory_linked_to_dot_claude_is_judged_by_where_it_points(self, build):
        (build["project"] / ".claude").mkdir()
        (build["project"] / "config").symlink_to(build["project"] / ".claude")
        target = str(build["project"] / "config" / "settings.json")
        assert denied(call(build["hook"], "Write", {"file_path": target}))

    def test_refused_even_when_no_root_resolved(self, monkeypatch):
        """The wiring-mistake branch opens the roots, not the configuration."""
        monkeypatch.delenv("WORKPILOT_WRITE_ROOTS", raising=False)
        monkeypatch.setattr(path_guard, "resolve_write_roots", lambda *_: [])
        hook = make_write_path_hook(None, None)
        assert denied(call(hook, "Write", {"file_path": ".workpilot-allowlist"}))

    def test_an_extra_write_root_does_not_open_it(self, tmp_path, monkeypatch):
        sibling = tmp_path / "sibling"
        sibling.mkdir()
        monkeypatch.setenv("WORKPILOT_WRITE_ROOTS", str(sibling))
        hook = make_write_path_hook(tmp_path / "worktree", None)
        target = str(sibling / ".claude" / "settings.json")
        assert denied(call(hook, "Write", {"file_path": target}))


class TestLookalikesStayWritable:
    """The rule is about these files, not about every name that resembles one."""

    @pytest.mark.parametrize(
        "relative",
        [
            "config/guardrails.yaml",  # the project's own guardrails, not ours
            "src/settings.json",
            ".claude/agents/reviewer.md",
            ".claude/commands/deploy.md",
            ".workpilot/specs/001-feature/spec.md",
            ".workpilot/guardrails.md",
            "docs/workpilot-allowlist.md",
            "allowlist.txt",
        ],
    )
    def test_a_lookalike_is_written(self, relative, build):
        assert call(build["hook"], "Write", {"file_path": relative}) == {}

    def test_the_main_checkout_message_still_wins_outside_the_roots(self, build):
        target = str(build["main_checkout"] / ".workpilot-allowlist")
        assert "outside" in denied(call(build["hook"], "Write", {"file_path": target}))


class TestProtectedConfigTarget:
    def test_a_wildcard_is_answered_only_on_request(self):
        from security.path_guard import protected_config_target

        assert protected_config_target(".workpilot-allow*") is None
        assert protected_config_target(".workpilot-allow*", glob=True)

    def test_a_bare_wildcard_does_not_match_a_dotfile(self):
        """`*` in a shell skips names that start with a dot; `.*` does not."""
        from security.path_guard import protected_config_target

        assert protected_config_target("*", glob=True) is None
        assert protected_config_target(".*", glob=True) == ".*"
        assert protected_config_target(".claude/*", glob=True) == ".claude/*"

    def test_the_directory_is_answered_only_on_request(self):
        from security.path_guard import protected_config_target

        assert protected_config_target(".claude") is None
        assert protected_config_target(".claude", directories=True) == ".claude/"
        assert protected_config_target("sub/.workpilot", directories=True)

    def test_a_windows_path_is_read_on_either_separator(self):
        from security.path_guard import protected_config_target

        assert protected_config_target("C:\\proj\\.claude\\settings.json")


# ─────────────────────────────────────────────────────────────────────────────
# The same rule for the providers that never reach the SDK's hooks
# ─────────────────────────────────────────────────────────────────────────────


class TestTheExecutorRefusesTheSameWrites:
    """Copilot, OpenAI, Windsurf, LiteLLM and the local models write through
    `ToolExecutor`, which confined writes to the project and nothing else."""

    @pytest.fixture
    def executor(self, tmp_path):
        from core.runtimes.tool_executor import ToolExecutor

        return ToolExecutor(str(tmp_path), agent_type="coder")

    @pytest.mark.parametrize("relative", SECURITY_CONFIGURATION)
    def test_write_file_is_refused(self, relative, executor, tmp_path):
        with pytest.raises(ValueError, match="security configuration"):
            asyncio.run(
                executor.execute("write_file", {"path": relative, "content": "nc\n"})
            )
        assert not (tmp_path / relative).exists()

    def test_an_existing_allowlist_is_left_as_it_was(self, executor, tmp_path):
        allowlist = tmp_path / ".workpilot-allowlist"
        allowlist.write_text("pytest\n", encoding="utf-8")
        with pytest.raises(ValueError):
            asyncio.run(
                executor.execute(
                    "write_file",
                    {"path": ".workpilot-allowlist", "content": "pytest\nnc\n"},
                )
            )
        assert allowlist.read_text(encoding="utf-8") == "pytest\n"

    def test_a_link_to_the_allowlist_is_refused(self, executor, tmp_path):
        (tmp_path / ".workpilot-allowlist").write_text("", encoding="utf-8")
        (tmp_path / "notes.txt").symlink_to(tmp_path / ".workpilot-allowlist")
        with pytest.raises(ValueError, match="security configuration"):
            asyncio.run(
                executor.execute("write_file", {"path": "notes.txt", "content": "nc"})
            )

    def test_creating_the_directory_in_its_place_is_refused(self, executor):
        with pytest.raises(ValueError, match="security configuration"):
            asyncio.run(
                executor.execute(
                    "create_directory", {"path": ".claude/settings.local.json"}
                )
            )

    def test_reading_it_is_still_allowed(self, executor, tmp_path):
        """What the allowlist grants is no secret, and QA reads it."""
        (tmp_path / ".workpilot-allowlist").write_text("pytest\n", encoding="utf-8")
        result = asyncio.run(
            executor.execute("read_file", {"path": ".workpilot-allowlist"})
        )
        assert result == "pytest\n"

    def test_an_ordinary_file_is_still_written(self, executor, tmp_path):
        asyncio.run(
            executor.execute("write_file", {"path": "src/app.py", "content": "x = 1\n"})
        )
        assert (tmp_path / "src" / "app.py").read_text(encoding="utf-8") == "x = 1\n"
