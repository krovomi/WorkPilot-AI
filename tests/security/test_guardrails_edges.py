"""Guardrails at their edges: malformed rules, unreadable files, every condition
that lets a call through, and the ledger when the disk says no.

`test_guardrails_policy.py` covers what the rules are for; this file covers what
happens when the policy, the files or the log are not what a rule expects.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
from datetime import timedelta
from pathlib import Path

import pytest
from security import guardrail_ledger as ledger
from security import guardrail_policy
from security.guardrail_policy import current_branch, load_policy
from security.guardrail_semantics import added_dependencies, dependencies
from security.guardrails import (
    CallContext,
    GuardrailAction,
    GuardrailDecision,
    GuardrailRule,
    evaluate_rules,
    glob_to_regex,
    guardrails_hook,
    relative_path,
)


@pytest.fixture(autouse=True)
def _no_global_policy(monkeypatch, tmp_path_factory):
    monkeypatch.setenv(
        "WORKPILOT_GUARDRAILS_GLOBAL",
        str(tmp_path_factory.mktemp("home") / "none.yaml"),
    )


def _rule(**when) -> GuardrailRule:
    action = when.pop("action", "deny")
    return GuardrailRule.from_dict({"id": "r", "action": action, "when": when})


def _triggers(rule: GuardrailRule, tool: str, tool_input: dict, **context) -> bool:
    decision = evaluate_rules([rule], tool, tool_input, CallContext(**context))
    return decision.action != GuardrailAction.ALLOW


def _write_policy(project: Path, text: str, name: str = "guardrails.yaml") -> Path:
    path = project / ".workpilot" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _hook(root: Path, tool: str, tool_input) -> dict:
    return asyncio.run(
        guardrails_hook(
            {"tool_name": tool, "tool_input": tool_input}, project_root=root
        )
    )


class TestReadingARule:
    def test_question_mark_is_one_character_inside_a_folder(self):
        pattern = glob_to_regex("src/v?.py")
        assert pattern.match("src/v1.py")
        assert not pattern.match("src/v12.py")
        assert not pattern.match("src/v/.py")

    def test_every_mistake_is_named_and_turns_the_rule_off(self):
        rule = GuardrailRule.from_dict(
            {
                "id": "r",
                "severity": "high",
                "when": {"content_max_lines": -1, "content_max_bytes": True},
            }
        )
        assert rule.errors == [
            "rule r: unknown key 'severity'",
            "rule r: 'content_max_lines' must be a positive integer",
            "rule r: 'content_max_bytes' must be a positive integer",
        ]
        assert not _triggers(rule, "Write", {"file_path": "a", "content": "x" * 99})

    def test_a_when_that_is_not_a_mapping_is_an_error(self):
        rule = GuardrailRule.from_dict({"id": "r", "when": ["path_prefix", "src/"]})
        assert rule.errors == ["rule r: 'when' must be a mapping"]


class TestPaths:
    def test_an_absolute_path_outside_the_root_is_kept_as_written(self, tmp_path):
        root = tmp_path / "repo"
        root.mkdir()
        outside = (tmp_path / "other" / "a.py").as_posix()
        assert relative_path(outside, root) == outside

    def test_leading_dot_slashes_are_dropped(self):
        assert relative_path("././src/a.py", None) == "src/a.py"

    def test_a_file_outside_the_root_is_not_read(self, tmp_path):
        root = tmp_path / "repo"
        root.mkdir()
        secret = tmp_path / "secret.txt"
        secret.write_text("pip install x\n", encoding="utf-8")
        context = CallContext(root=root)
        assert context._file(str(secret)) is None
        assert CallContext()._file("a.py") is None
        assert context._file("") is None


class TestConditionsThatLetACallThrough:
    def test_a_rule_with_errors_never_triggers(self):
        rule = GuardrailRule.from_dict({"id": "r", "action": "never"})
        assert rule.errors
        assert not _triggers(rule, "Write", {"file_path": "a.py", "content": ""})

    def test_a_command_rule_does_not_judge_a_write(self):
        rule = _rule(command_pattern="rm -rf")
        assert not _triggers(
            rule, "Write", {"file_path": "a.sh", "content": "rm -rf /"}
        )
        assert _triggers(rule, "Bash", {"command": "rm -rf build"})
        assert not _triggers(rule, "Bash", {"command": "ls"})

    @pytest.mark.parametrize(
        ("when", "content", "triggers"),
        [
            ({"content_regex": "TODO"}, "done", False),
            ({"content_regex": "TODO"}, "# TODO", True),
            ({"content_max_lines": 2}, "a\nb", False),
            ({"content_max_lines": 2}, "a\nb\nc", True),
            ({"content_max_bytes": 3}, "é", False),
            ({"content_max_bytes": 3}, "éé", True),
            ({"forbidden_strings": ["eval("]}, "print(1)", False),
            ({"forbidden_strings": ["eval("]}, "eval(x)", True),
        ],
    )
    def test_content_conditions(self, when, content, triggers):
        rule = _rule(**when)
        assert (
            _triggers(rule, "Write", {"file_path": "a.py", "content": content})
            is triggers
        )

    def test_a_multi_edit_is_judged_on_all_its_new_text(self):
        rule = _rule(forbidden_strings=["eval("])
        edits = {
            "file_path": "a.py",
            "edits": [
                {"old_string": "a", "new_string": "ok"},
                {"old_string": "b", "new_string": "eval(b)"},
                "not an edit",
            ],
        }
        assert _triggers(rule, "MultiEdit", edits)

    def test_a_file_condition_ignores_tools_that_write_nothing(self):
        rule = _rule(adds_regex="import requests")
        assert not _triggers(rule, "Read", {"file_path": "a.py"})

    def test_an_edit_of_a_missing_file_is_judged_on_its_fragments(self, tmp_path):
        rule = _rule(adds_regex="import requests")
        edit = {
            "file_path": "new.py",
            "old_string": "import os",
            "new_string": "import os\nimport requests",
        }
        assert _triggers(rule, "Edit", edit, root=tmp_path)
        unchanged = dict(edit, new_string="import os")
        assert not _triggers(rule, "Edit", unchanged, root=tmp_path)

    def test_an_unreadable_file_counts_as_empty(self, tmp_path, monkeypatch):
        (tmp_path / "a.py").write_text("import requests\n", encoding="utf-8")
        rule = _rule(adds_regex="import requests")
        original = Path.read_text

        def locked(self, *args, **kwargs):
            if self.name == "a.py":
                raise PermissionError("locked")
            return original(self, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", locked)
        # Read, the file would already hold the import; unreadable, the
        # replacement adds it.
        assert _triggers(
            rule,
            "Write",
            {"file_path": "a.py", "content": "import requests\n"},
            root=tmp_path,
        )

    def test_the_rule_message_is_part_of_the_reason(self):
        rule = GuardrailRule.from_dict(
            {
                "id": "no-eval",
                "when": {"forbidden_strings": ["eval("]},
                "message": "use ast.literal_eval",
            }
        )
        decision = evaluate_rules(
            [rule], "Write", {"file_path": "a.py", "content": "eval(x)"}
        )
        assert "[no-eval] (no description) — use ast.literal_eval" in decision.message


class TestTheHook:
    def test_a_tool_input_that_is_not_a_mapping_is_left_alone(self, tmp_path):
        assert _hook(tmp_path, "Write", ["not", "a", "mapping"]) == {}

    def test_a_warning_lets_the_call_through_and_is_logged(self, tmp_path):
        _write_policy(
            tmp_path,
            "rules:\n  - id: big\n    action: warn\n    when:\n"
            "      content_max_lines: 1\n",
        )
        verdict = _hook(tmp_path, "Write", {"file_path": "a.py", "content": "a\nb"})
        assert verdict == {}
        [event] = ledger.activity(tmp_path)["events"]
        assert event["outcome"] == "warn"
        assert event["rules"] == ["big"]
        assert event["task"] is None


class TestReadingThePolicy:
    def _errors(self, project: Path, text: str, name: str = "guardrails.yaml"):
        path = _write_policy(project, text, name)
        policy = load_policy(project)
        path.unlink()
        return policy

    def test_an_empty_or_null_document_has_no_rule(self, tmp_path):
        for text in ("   \n", "~\n"):
            policy = self._errors(tmp_path / text.strip().replace("~", "null"), text)
            assert policy.errors == []
            assert policy.rules == []

    @pytest.mark.parametrize(
        ("text", "error"),
        [
            ("- a\n- b\n", "the document must be a mapping with a 'rules' list"),
            ("rules: {a: 1}\n", "'rules' must be a list"),
            ("rules:\n  - just a string\n", "every rule must be a mapping"),
            (
                "rules:\n  - {id: a, when: {tool: Write}}\n"
                "  - {id: a, when: {tool: Edit}}\n",
                "rule id 'a' is used twice",
            ),
        ],
    )
    def test_a_malformed_document_is_reported(self, tmp_path, text, error):
        policy = self._errors(tmp_path, text)
        assert [e for e in policy.errors if error in e], policy.errors

    def test_an_unreadable_file_is_reported(self, tmp_path, monkeypatch):
        _write_policy(tmp_path, "rules: []\n")
        original = Path.read_text

        def locked(self, *args, **kwargs):
            if self.name == "guardrails.yaml":
                raise PermissionError(13, "Permission denied")
            return original(self, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", locked)
        policy = load_policy(tmp_path)
        assert policy.errors == ["guardrails.yaml: cannot be read (Permission denied)"]

    def test_a_file_that_vanishes_while_stamped_is_still_read(
        self, tmp_path, monkeypatch
    ):
        _write_policy(tmp_path, "rules:\n  - {id: a, when: {tool: Write}}\n")
        original = Path.stat
        calls = {"n": 0}

        def flaky(self, *args, **kwargs):
            if self.name == "guardrails.yaml":
                calls["n"] += 1
                if calls["n"] > 1:  # after `is_file()`, at the stamp
                    raise FileNotFoundError(self)
            return original(self, *args, **kwargs)

        monkeypatch.setattr(Path, "stat", flaky)
        assert [r.id for r in load_policy(tmp_path).rules] == ["a"]

    def test_a_stricter_rule_of_a_later_layer_applies_beside_the_first(self, tmp_path):
        (tmp_path / "workpilot.policy.yaml").write_text(
            "rules:\n  - {id: mig, action: warn, when: {path_prefix: db/}}\n",
            encoding="utf-8",
        )
        _write_policy(
            tmp_path, "rules:\n  - {id: mig, action: deny, when: {path_prefix: db/}}\n"
        )
        policy = load_policy(tmp_path)
        assert [r.id for r in policy.rules] == ["mig", "mig@project"]
        decision = evaluate_rules(
            policy.rules, "Write", {"file_path": "db/1.sql", "content": ""}
        )
        assert decision.action == GuardrailAction.DENY

    def test_a_rule_without_condition_is_flagged(self, tmp_path):
        _write_policy(tmp_path, "rules:\n  - {id: all, action: warn}\n")
        assert load_policy(tmp_path).warnings == [
            "rule 'all' has no condition: it applies to every write and command"
        ]


class TestTheBranch:
    def test_it_is_read_once_then_cached(self, tmp_path, monkeypatch):
        guardrail_policy._BRANCHES.clear()
        calls = []

        def run(args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, stdout="feature/x\n")

        monkeypatch.setattr(guardrail_policy.subprocess, "run", run)
        assert current_branch(tmp_path) == "feature/x"
        assert current_branch(tmp_path) == "feature/x"
        assert len(calls) == 1

    def test_no_git_means_no_branch(self, tmp_path, monkeypatch):
        guardrail_policy._BRANCHES.clear()

        def missing(args, **kwargs):
            raise FileNotFoundError("git")

        monkeypatch.setattr(guardrail_policy.subprocess, "run", missing)
        assert current_branch(tmp_path) is None


class TestTheLedger:
    def _decision(self, action=GuardrailAction.REQUIRE_APPROVAL):
        rule = GuardrailRule.from_dict(
            {"id": "mig", "action": action.value, "when": {"path_prefix": "db/"}}
        )
        return GuardrailDecision(action=action, triggered=[rule], message="m")

    def test_a_log_that_cannot_be_written_never_blocks(self, tmp_path):
        (tmp_path / ".workpilot").write_text("a file, not a folder", encoding="utf-8")
        target = ledger.target_of("Write", {"file_path": "db/1.sql"}, tmp_path)
        ledger.record(tmp_path, self._decision(), "Write", target)  # no raise

    def test_the_log_keeps_its_last_lines(self, tmp_path, monkeypatch):
        monkeypatch.setattr(ledger, "MAX_LOG_LINES", 3)
        target = ledger.target_of("Write", {"file_path": "db/1.sql"}, tmp_path)
        for _ in range(5):
            ledger.record(
                tmp_path, self._decision(GuardrailAction.DENY), "Write", target
            )
        log = tmp_path / ".workpilot" / ledger.LOG_NAME
        assert len(log.read_text(encoding="utf-8").splitlines()) == 3

    def test_an_unreadable_log_is_not_trimmed(self, tmp_path):
        ledger._trim(tmp_path / "missing.jsonl")

    def test_a_failed_atomic_write_leaves_no_temporary_file(
        self, tmp_path, monkeypatch
    ):
        def refuse(src, dst):
            raise PermissionError("in use")

        monkeypatch.setattr(ledger.os, "replace", refuse)
        with pytest.raises(PermissionError):
            ledger._atomic_write(tmp_path / "a.json", "{}")
        assert list(tmp_path.iterdir()) == []

    def _pending(self, project: Path, file: str = "db/1.sql") -> dict:
        target = ledger.target_of("Write", {"file_path": file}, project)
        ledger.record(project, self._decision(), "Write", target, outcome="pending")
        return target

    def test_an_approval_is_for_its_target_and_its_rules(self, tmp_path):
        target = self._pending(tmp_path)
        [request] = ledger.activity(tmp_path)["pending"]
        ledger.answer(tmp_path, request["id"], approved=True)
        other = ledger.target_of("Write", {"file_path": "db/2.sql"}, tmp_path)
        assert not ledger.consume_approval(tmp_path, self._decision(), other)

        stricter = self._decision()
        stricter.triggered.append(
            GuardrailRule.from_dict(
                {"id": "other", "action": "require_approval", "when": {"tool": "Write"}}
            )
        )
        assert not ledger.consume_approval(tmp_path, stricter, target)
        assert ledger.consume_approval(tmp_path, self._decision(), target)
        assert not ledger.consume_approval(tmp_path, self._decision(), target)

    def test_an_approval_with_a_broken_expiry_is_dead(self, tmp_path):
        target = self._pending(tmp_path)
        [request] = ledger.activity(tmp_path)["pending"]
        ledger.answer(tmp_path, request["id"], approved=True)
        path = tmp_path / ".workpilot" / ledger.APPROVALS_NAME
        data = json.loads(path.read_text(encoding="utf-8"))
        data["approvals"][0]["expires_at"] = "tomorrow"
        path.write_text(json.dumps(data), encoding="utf-8")
        assert not ledger.consume_approval(tmp_path, self._decision(), target)

    def test_an_approval_that_cannot_be_marked_used_is_not_used(
        self, tmp_path, monkeypatch
    ):
        target = self._pending(tmp_path)
        [request] = ledger.activity(tmp_path)["pending"]
        ledger.answer(tmp_path, request["id"], approved=True)

        def full_disk(project, approvals):
            raise OSError(28, "No space left on device")

        monkeypatch.setattr(ledger, "_save_approvals", full_disk)
        assert not ledger.consume_approval(tmp_path, self._decision(), target)

    def test_an_expired_request_is_no_longer_pending(self, tmp_path, monkeypatch):
        self._pending(tmp_path)
        later = ledger._now() + ledger.APPROVAL_TTL + timedelta(minutes=1)
        monkeypatch.setattr(ledger, "_now", lambda: later)
        assert ledger.activity(tmp_path)["pending"] == []


class TestDependencyManifests:
    def test_a_broken_manifest_declares_nothing(self):
        assert dependencies("package.json", "{not json") == set()
        assert dependencies("pyproject.toml", "[project") == set()
        assert dependencies("pubspec.yaml", "dependencies: [") == set()

    def test_requirements_skip_options_and_comments(self):
        text = "-r base.txt\n# pinned\nRequests_Toolbelt==1.0  # http\n\n"
        assert dependencies("requirements.txt", text) == {"requests-toolbelt"}

    def test_pyproject_optional_and_poetry_dependencies(self):
        text = (
            "[project]\ndependencies = ['httpx']\n"
            "[project.optional-dependencies]\ndev = ['pytest', 3]\nbad = 'x'\n"
            "[tool.poetry.dependencies]\npython = '^3.12'\nRich = '*'\n"
        )
        assert dependencies("pyproject.toml", text) == {"httpx", "pytest", "rich"}

    def test_cargo_workspace_dependencies(self):
        text = "[dependencies]\nserde = '1'\n[workspace.dependencies]\ntokio = '1'\n"
        assert dependencies("Cargo.toml", text) == {"serde", "tokio"}

    def test_a_dependency_added_to_a_manifest_is_named(self):
        assert added_dependencies(
            "app/pubspec.yaml",
            "dependencies:\n  http: ^1.0\n",
            "dependencies:\n  http: ^1.0\n  dio: ^5.0\n",
        ) == ["dio"]
        assert added_dependencies("README.md", "", "dio") == []
