"""Policy as code (#377): layered guardrails, judged on what a change means.

The bugs these tests keep away: the guardrails of `.workpilot/` (git-ignored)
were never read in a task's worktree, so no Kanban build applied them; a rule
on `path_prefix: migrations/` never matched Claude's absolute paths; a typo in
the file turned a rule off without a word; `require_approval` could only
refuse.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest
from security import guardrail_ledger as ledger
from security.guardrail_policy import load_policy, main_project
from security.guardrail_semantics import (
    added_dependencies,
    defined_tests,
    removed_tests,
)
from security.guardrails import (
    CallContext,
    GuardrailAction,
    evaluate_rules,
    guardrails_hook,
)
from security.path_guard import protected_config_target

RUNNER = (
    Path(__file__).resolve().parents[2]
    / "apps"
    / "backend"
    / "runners"
    / "guardrails_runner.py"
)


@pytest.fixture(autouse=True)
def _no_global_policy(monkeypatch, tmp_path_factory):
    monkeypatch.setenv(
        "WORKPILOT_GUARDRAILS_GLOBAL",
        str(tmp_path_factory.mktemp("home") / "none.yaml"),
    )


def _policy(project: Path, *rules: dict, name: str = "guardrails.json") -> None:
    target = (
        project / ".workpilot" / name
        if not name.startswith("workpilot.")
        else project / name
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps({"version": 1, "rules": list(rules)}), encoding="utf-8"
    )


def _hook(root: Path, tool: str, tool_input: dict) -> dict:
    return asyncio.run(
        guardrails_hook(
            {"tool_name": tool, "tool_input": tool_input}, project_root=root
        )
    )


def _denied(verdict: dict) -> str | None:
    out = verdict.get("hookSpecificOutput") or {}
    return (
        out.get("permissionDecisionReason")
        if out.get("permissionDecision") == "deny"
        else None
    )


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    (root / "src").mkdir(parents=True)
    return root


@pytest.fixture
def worktree(project: Path) -> Path:
    tree = project / ".workpilot" / "worktrees" / "tasks" / "001-orders"
    (tree / "db" / "migrations").mkdir(parents=True)
    return tree


class TestWhereRulesApply:
    def test_the_projects_rules_bind_its_task_worktrees(
        self, project: Path, worktree: Path
    ):
        _policy(
            project,
            {
                "id": "no-mig",
                "when": {"path_prefix": "db/migrations/"},
                "action": "deny",
            },
        )
        assert main_project(worktree) == project
        reason = _denied(
            _hook(
                worktree,
                "Write",
                {
                    "file_path": str(worktree / "db" / "migrations" / "001.sql"),
                    "content": "x",
                },
            )
        )
        assert reason and "no-mig" in reason
        assert (
            _denied(
                _hook(
                    worktree,
                    "Write",
                    {"file_path": str(worktree / "src" / "a.py"), "content": "x"},
                )
            )
            is None
        )

    def test_path_glob(self, project: Path):
        _policy(
            project,
            {"id": "g", "when": {"path_glob": "**/migrations/**"}, "action": "deny"},
        )
        assert _denied(
            _hook(
                project,
                "Write",
                {"file_path": "apps/api/migrations/2026/x.cs", "content": ""},
            )
        )
        assert _denied(
            _hook(project, "Write", {"file_path": "migrations/x.sql", "content": ""})
        )
        assert not _denied(
            _hook(
                project, "Write", {"file_path": "apps/migrationsX/x.sql", "content": ""}
            )
        )

    def test_a_content_rule_never_refuses_a_command(self, project: Path):
        _policy(
            project, {"id": "big", "when": {"content_max_lines": 500}, "action": "deny"}
        )
        assert _denied(_hook(project, "Bash", {"command": "ls"})) is None


class TestInvalidPolicy:
    def test_a_typo_blocks_writes_and_commands_instead_of_disabling_the_rule(
        self, project: Path
    ):
        _policy(project, {"id": "x", "when": {"path_prefx": "db/"}, "action": "deny"})
        reason = _denied(
            _hook(project, "Write", {"file_path": "src/a.py", "content": ""})
        )
        assert reason and "unknown condition 'path_prefx'" in reason
        assert _denied(_hook(project, "Bash", {"command": "ls"}))
        assert _hook(project, "Read", {"file_path": "src/a.py"}) == {}

    @pytest.mark.parametrize(
        ("rule", "error"),
        [
            (
                {"id": "r", "when": {"path_regex": "("}, "action": "deny"},
                "invalid regex",
            ),
            ({"id": "r", "action": "block"}, "unknown action"),
            ({"id": "r", "when": {"deletes_tests": "yes"}}, "must be true or false"),
            ({"when": {}}, "has no id"),
        ],
    )
    def test_each_mistake_is_named(self, project: Path, rule: dict, error: str):
        _policy(project, rule)
        assert any(error in e for e in load_policy(project).errors)

    def test_broken_yaml(self, project: Path):
        (project / ".workpilot").mkdir()
        (project / ".workpilot" / "guardrails.yaml").write_text(
            "rules: [\n", encoding="utf-8"
        )
        assert "not valid YAML" in load_policy(project).errors[0]


class TestLayers:
    def test_global_repository_and_project_add_up(
        self, project: Path, monkeypatch, tmp_path: Path
    ):
        global_file = tmp_path / "global.yaml"
        global_file.write_text(
            "rules:\n  - id: org\n    when: {path_prefix: secrets/}\n    action: deny\n",
            encoding="utf-8",
        )
        monkeypatch.setenv("WORKPILOT_GUARDRAILS_GLOBAL", str(global_file))
        _policy(
            project,
            {"id": "repo", "when": {"path_prefix": "infra/"}, "action": "warn"},
            name="workpilot.policy.yaml",
        )
        _policy(
            project, {"id": "local", "when": {"path_prefix": "db/"}, "action": "deny"}
        )
        policy = load_policy(project)
        assert [s.layer for s in policy.sources] == ["global", "repository", "project"]
        assert {r.id for r in policy.rules} == {"org", "repo", "local"}

    def test_a_later_layer_cannot_weaken_a_rule(self, project: Path):
        _policy(
            project,
            {"id": "deps", "when": {"adds_dependency": True}, "action": "deny"},
            name="workpilot.policy.yaml",
        )
        _policy(
            project, {"id": "deps", "when": {"adds_dependency": True}, "action": "warn"}
        )
        policy = load_policy(project)
        assert [r.action for r in policy.rules] == [GuardrailAction.DENY]
        assert "cannot weaken" in policy.warnings[0]

    def test_yaml_and_json_of_the_project_are_both_read(self, project: Path):
        _policy(project, {"id": "a", "when": {"path_prefix": "a/"}, "action": "deny"})
        (project / ".workpilot" / "guardrails.yaml").write_text(
            "rules:\n  - id: b\n    when: {path_prefix: b/}\n    action: deny\n",
            encoding="utf-8",
        )
        assert {r.id for r in load_policy(project).rules} == {"a", "b"}

    def test_branch_condition(self, project: Path):
        _policy(
            project,
            {
                "id": "main-only",
                "when": {"branch": "release/*", "path_prefix": "src/"},
                "action": "deny",
            },
        )
        rules = load_policy(project).rules
        hit = evaluate_rules(
            rules,
            "Write",
            {"file_path": "src/a", "content": ""},
            CallContext(root=project, branch="release/2.0"),
        )
        miss = evaluate_rules(
            rules,
            "Write",
            {"file_path": "src/a", "content": ""},
            CallContext(root=project, branch="feature/x"),
        )
        assert (hit.action, miss.action) == (
            GuardrailAction.DENY,
            GuardrailAction.ALLOW,
        )


class TestSemantics:
    @pytest.mark.parametrize(
        ("path", "before", "after", "removed"),
        [
            (
                "tests/test_a.py",
                "def test_a():\n    pass\ndef test_b():\n    pass\n",
                "def test_a():\n    pass\n",
                ["test_b"],
            ),
            (
                "src/a.spec.ts",
                "it('adds', () => {});\nit('subtracts', () => {});",
                "it('adds', () => {});",
                ["subtracts"],
            ),
            (
                "Api.Tests/Cart.cs",
                "[Fact]\npublic void Adds() {}\n[Theory]\n[InlineData(1)]\npublic async Task Parses(int x) {}",
                "[Fact]\npublic void Adds() {}",
                ["Parses"],
            ),
            (
                "src/test/CartTest.java",
                "@Test\nvoid adds() {}\n@Test\nvoid parses() {}",
                "@Test\nvoid adds() {}",
                ["parses"],
            ),
            (
                "cart_test.go",
                "func TestAdds(t *testing.T) {}\nfunc TestParses(t *testing.T) {}",
                "func TestAdds(t *testing.T) {}",
                ["TestParses"],
            ),
            (
                "src/lib.rs",
                "#[test]\nfn adds() {}\n#[tokio::test]\nasync fn fetches() {}",
                "#[test]\nfn adds() {}",
                ["fetches"],
            ),
            (
                "spec/cart_spec.rb",
                "it 'adds' do\nend\nit 'parses' do\nend",
                "it 'adds' do\nend",
                ["parses"],
            ),
            (
                "test/cart_test.dart",
                "test('adds', () {});\ntestWidgets('renders', (t) async {});",
                "test('adds', () {});",
                ["renders"],
            ),
            (
                "tests/CartTest.php",
                "public function testAdds() {}\npublic function testParses() {}",
                "public function testAdds() {}",
                ["testParses"],
            ),
            (
                "Tests/CartTests.swift",
                "func testAdds() {}\nfunc testParses() {}",
                "func testAdds() {}",
                ["testParses"],
            ),
        ],
    )
    def test_removed_tests_for_every_stack(self, path, before, after, removed):
        assert removed_tests(path, before, after) == removed

    def test_unknown_language_is_not_judged(self):
        assert defined_tests("notes.txt", "def test_a(): pass") == []

    @pytest.mark.parametrize(
        ("path", "before", "after", "added"),
        [
            (
                "package.json",
                '{"dependencies": {"a": "1"}}',
                '{"dependencies": {"a": "1"}, "devDependencies": {"left-pad": "1"}}',
                ["left-pad"],
            ),
            (
                "Api/Api.csproj",
                '<PackageReference Include="A" />',
                '<PackageReference Include="A" /><PackageReference Include="Dapper" Version="2" />',
                ["Dapper"],
            ),
            ("requirements.txt", "flask==3\n", "flask==3\nrequests>=2\n", ["requests"]),
            (
                "pyproject.toml",
                '[project]\ndependencies = ["flask"]\n',
                '[project]\ndependencies = ["flask", "httpx>=0.27"]\n',
                ["httpx"],
            ),
            (
                "Cargo.toml",
                '[dependencies]\nserde = "1"\n',
                '[dependencies]\nserde = "1"\ntokio = "1"\n',
                ["tokio"],
            ),
            (
                "go.mod",
                "module m\nrequire github.com/a/b v1.0.0\n",
                "module m\nrequire (\n github.com/a/b v1.0.0\n golang.org/x/net v0.1.0\n)\n",
                ["golang.org/x/net"],
            ),
            (
                "pom.xml",
                "",
                "<dependency><groupId>org.x</groupId><artifactId>y</artifactId></dependency>",
                ["org.x:y"],
            ),
            (
                "app/build.gradle.kts",
                'implementation("a:b:1")',
                'implementation("a:b:1")\nimplementation("com.squareup:okhttp:4")',
                ["com.squareup:okhttp"],
            ),
            ("Gemfile", "gem 'rails'\n", "gem 'rails'\ngem 'pry'\n", ["pry"]),
            (
                "composer.json",
                '{"require": {}}',
                '{"require": {"guzzlehttp/guzzle": "^7"}}',
                ["guzzlehttp/guzzle"],
            ),
            (
                "pubspec.yaml",
                "dependencies:\n  http: ^1.0\n",
                "dependencies:\n  http: ^1.0\n  dio: ^5.0\n",
                ["dio"],
            ),
            (
                "Package.swift",
                "",
                '.package(url: "https://github.com/x/y", from: "1.0.0")',
                ["https://github.com/x/y"],
            ),
        ],
    )
    def test_added_dependencies_for_every_stack(self, path, before, after, added):
        assert added_dependencies(path, before, after) == added

    def test_edit_that_removes_a_test_is_denied_with_its_name(self, project: Path):
        (project / "tests").mkdir()
        (project / "tests" / "test_cart.py").write_text(
            "def test_a():\n    pass\n\ndef test_b():\n    pass\n", encoding="utf-8"
        )
        _policy(
            project,
            {"id": "keep-tests", "when": {"deletes_tests": True}, "action": "deny"},
        )
        reason = _denied(
            _hook(
                project,
                "Edit",
                {
                    "file_path": str(project / "tests" / "test_cart.py"),
                    "old_string": "\ndef test_b():\n    pass\n",
                    "new_string": "",
                },
            )
        )
        assert reason and "keep-tests" in reason and "test_b" in reason
        assert _denied(_hook(project, "Bash", {"command": "git rm tests/test_cart.py"}))
        assert not _denied(_hook(project, "Bash", {"command": "rm build/output.log"}))

    def test_new_file_size_and_added_pattern(self, project: Path):
        (project / "src" / "a.ts").write_text("const a: any = 1;\n", encoding="utf-8")
        _policy(
            project,
            {"id": "huge", "when": {"new_file_max_lines": 3}, "action": "deny"},
            {
                "id": "any",
                "when": {"path_regex": "\\.ts$", "adds_regex": ":\\s*any\\b"},
                "action": "deny",
            },
        )
        assert _denied(
            _hook(
                project, "Write", {"file_path": "src/new.py", "content": "1\n2\n3\n4\n"}
            )
        )
        assert not _denied(
            _hook(
                project,
                "Write",
                {"file_path": "src/a.ts", "content": "const a: any = 2;\n"},
            )
        )
        assert _denied(
            _hook(
                project,
                "Write",
                {
                    "file_path": "src/a.ts",
                    "content": "const a: any = 1;\nlet b: any;\n",
                },
            )
        )


class TestApprovals:
    def test_a_request_waits_then_one_identical_call_goes_through(
        self, project: Path, worktree: Path
    ):
        _policy(
            project,
            {
                "id": "deps",
                "when": {"adds_dependency": True},
                "action": "require_approval",
            },
        )
        (worktree / "package.json").write_text('{"dependencies": {}}', encoding="utf-8")
        call = {
            "file_path": str(worktree / "package.json"),
            "content": '{"dependencies": {"zod": "3"}}',
        }

        reason = _denied(_hook(worktree, "Write", call))
        assert reason and "Human approval required" in reason
        _denied(
            _hook(worktree, "Write", call)
        )  # a retry does not stack a second request
        pending = ledger.activity(project)["pending"]
        assert len(pending) == 1
        assert pending[0]["task"] == "001-orders"
        assert pending[0]["target"]["summary"] == "package.json"
        assert pending[0]["details"] == {"deps": ["zod"]}

        ledger.answer(project, pending[0]["id"], approved=True)
        assert ledger.activity(project)["pending"] == []
        assert _denied(_hook(worktree, "Write", call)) is None
        assert _denied(_hook(worktree, "Write", call))  # used once

    def test_a_refusal_keeps_the_call_blocked(self, project: Path):
        _policy(
            project,
            {
                "id": "ask",
                "when": {"command_pattern": "^docker "},
                "action": "require_approval",
            },
        )
        _hook(project, "Bash", {"command": "docker compose up"})
        request = ledger.activity(project)["pending"][0]
        ledger.answer(project, request["id"], approved=False)
        assert _denied(_hook(project, "Bash", {"command": "docker compose up"}))

    def test_agents_cannot_write_the_approvals_the_log_or_the_policy(self):
        assert protected_config_target(".workpilot/guardrail-approvals.json")
        assert protected_config_target("/p/.workpilot/guardrail-log.jsonl")
        assert protected_config_target("workpilot.policy.yaml")
        assert protected_config_target(".workpilot/guardrails.json")

    def test_activity_counts_and_the_noisy_rule_diagnostic(self, project: Path):
        _policy(
            project, {"id": "no-src", "when": {"path_prefix": "src/"}, "action": "deny"}
        )
        for index in range(3):
            _hook(project, "Write", {"file_path": f"src/{index}.py", "content": ""})
        report = ledger.activity(project)
        assert report["counts"] == {"no-src": {"deny": 3}}
        assert report["blockedLast10Min"] == 3


class TestRunner:
    def _run(self, *args: str) -> dict:
        out = subprocess.run(
            [sys.executable, str(RUNNER), *args],
            capture_output=True,
            text=True,
            timeout=120,
        )
        line = next(
            (ln for ln in out.stdout.splitlines() if ln.startswith("GUARDRAILS_")), ""
        )
        prefix, _, payload = line.partition(":")
        return {
            "ok": prefix == "GUARDRAILS_RESULT",
            "value": json.loads(payload) if payload else None,
            "stderr": out.stderr,
        }

    def test_check_diff_is_a_dry_run_over_the_working_tree(self, project: Path):
        def git(*a: str) -> None:
            subprocess.run(["git", *a], cwd=project, check=True, capture_output=True)

        git("init", "-q")
        git("config", "user.email", "t@example.com")
        git("config", "user.name", "t")
        (project / "tests").mkdir()
        (project / "tests" / "test_a.py").write_text(
            "def test_a():\n    pass\n", encoding="utf-8"
        )
        (project / "tests" / "test_b.py").write_text(
            "def test_b():\n    pass\n", encoding="utf-8"
        )
        (project / "package.json").write_text('{"dependencies": {}}', encoding="utf-8")
        git("add", ".")
        git("commit", "-q", "-m", "init")
        _policy(
            project,
            {"id": "keep-tests", "when": {"deletes_tests": True}, "action": "deny"},
            {
                "id": "deps",
                "when": {"adds_dependency": True},
                "action": "require_approval",
            },
        )
        (project / "tests" / "test_a.py").write_text("x = 1\n", encoding="utf-8")
        (project / "tests" / "test_b.py").unlink()
        (project / "package.json").write_text(
            '{"dependencies": {"zod": "3"}}', encoding="utf-8"
        )

        report = self._run("check-diff", "--project-path", str(project))
        assert report["ok"], report
        found = {f["path"]: f["triggered"] for f in report["value"]["files"]}
        assert found == {
            "tests/test_a.py": ["keep-tests"],
            "tests/test_b.py": ["keep-tests"],
            "package.json": ["deps"],
        }
        assert ledger.activity(project)["events"] == []  # a dry run logs nothing

    def test_validate_and_test(self, project: Path):
        _policy(
            project, {"id": "no-src", "when": {"path_prefix": "src/"}, "action": "deny"}
        )
        validate = self._run("validate", "--project-path", str(project))
        assert validate["value"]["rules"][0]["id"] == "no-src"
        tested = self._run(
            "test",
            "--project-path",
            str(project),
            "--tool",
            "Write",
            "--input",
            json.dumps({"file_path": "src/x", "content": ""}),
        )
        assert (tested["value"]["action"], tested["value"]["triggered"]) == (
            "deny",
            ["no-src"],
        )

    def test_answer_an_unknown_request(self, project: Path):
        result = self._run(
            "answer", "--project-path", str(project), "--request", "nope", "--approve"
        )
        assert not result["ok"]


def test_the_log_never_keeps_a_secret_of_a_command(tmp_path):
    command = (
        'curl -H "Authorization: Bearer abcDEF1234567890xyz" '
        "https://api.example.test --data token=s3cr3tvalue "
        "&& echo ghp_abcdefghijklmnopqrstuvwxyz0123"
    )
    target = ledger.target_of("Bash", {"command": command}, tmp_path)
    # The command stays readable; only the secret values are masked.
    assert target["summary"] == (
        'curl -H "Authorization: Bearer ***" '
        "https://api.example.test --data token=*** && echo ***"
    )
    summary = json.dumps(target)
    assert "abcDEF1234567890xyz" not in summary
    assert "s3cr3tvalue" not in summary
    assert "ghp_abcdefghijklmnopqrstuvwxyz0123" not in summary
