"""Contracts compared with the target branch, their consumers, the QA gate and the CLI (#389).

The old side of each contract is read at the merge base with the target
branch, so the check is the one a pull request makes; each contract file is
compared on its own; the code that calls what broke is found, grouped by the
consumer registry or by top-level folder; the QA gate only blocks in
``strict`` mode; the CLI exits 1 on an unacknowledged break and 2 when it
could not compare at all.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from api_watcher.__main__ import main as cli
from api_watcher.compare import compare, load_record, resolve_base, valid_ref
from api_watcher.consumers import load_registry, needles_for, parse_registry
from api_watcher.discover import discover, is_contract
from api_watcher.guide import pr_section, render
from foundation.change_scope import ChangeScope
from qa.api_contract_gate import API_CONTRACT_ENV, api_contract_gate

ORDERS = """openapi: 3.0.0
info: {title: Orders, version: "1"}
paths:
  /orders/{id}:
    get: {operationId: getOrder, responses: {"200": {description: ok}}}
  /orders:
    post: {operationId: createOrder, responses: {"201": {description: ok}}}
"""

USERS = 'syntax = "proto3";\nmessage User { string id = 1; string name = 2; }\n'


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


def _write(repo: Path, relative: str, text: str) -> None:
    (repo / relative).parent.mkdir(parents=True, exist_ok=True)
    (repo / relative).write_text(text, encoding="utf-8")


@pytest.fixture(autouse=True)
def _default_mode(monkeypatch):
    monkeypatch.delenv(API_CONTRACT_ENV, raising=False)
    monkeypatch.delenv("DEFAULT_BRANCH", raising=False)


@pytest.fixture
def repo(tmp_path):
    """A monorepo on develop with two contracts and a web client, then a feature branch."""
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q", "-b", "develop")
    _git(root, "config", "user.email", "t@example.test")
    _git(root, "config", "user.name", "t")
    _write(root, "services/orders/api/openapi.yaml", ORDERS)
    _write(root, "services/users/users.proto", USERS)
    _write(root, "contracts/legacy.wsdl", "<definitions/>\n")
    _write(root, "apps/web/src/orders.ts", "await fetch('/orders', {method: 'POST'})\n")
    _write(root, "apps/admin/main.go", 'client.Get("/orders/" + id)\n')
    _write(
        root,
        ".workpilot/api-consumers.yaml",
        "consumers:\n"
        "  - name: Web shop\n"
        '    contact: "@acme/web"\n'
        "    paths: ['apps/web/**']\n"
        "  - name: Partners\n"
        "    contact: partners@example.test\n"
        "    contracts: ['services/users/*']\n",
    )
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "base")
    _git(root, "checkout", "-q", "-b", "feat")
    return root


def _break_orders(root: Path) -> None:
    _write(
        root,
        "services/orders/api/openapi.yaml",
        ORDERS.replace(
            '  /orders:\n    post: {operationId: createOrder, responses: {"201": {description: ok}}}\n',
            "",
        ),
    )


class TestDiscovery:
    def test_free_named_openapi_is_read_only_in_contract_folders(self, tmp_path):
        assert is_contract("api/v1.yaml", lambda: "openapi: 3.1.0\n")
        assert not is_contract("config/app.yaml", lambda: "openapi: 3.1.0\n")
        assert is_contract("legacy/service.thrift")
        assert not is_contract("node_modules/x/openapi.yaml")
        assert not is_contract(".workpilot/worktrees/tasks/1/openapi.yaml")

    def test_every_contract_of_the_monorepo(self, repo):
        assert discover(repo) == [
            "contracts/legacy.wsdl",
            "services/orders/api/openapi.yaml",
            "services/users/users.proto",
        ]


class TestCompare:
    def test_the_target_branch_is_found_without_being_named(self, repo):
        base, target = resolve_base(repo)
        assert target == "develop" and base == _git(repo, "rev-parse", "develop")

    def test_nothing_changed_is_a_pass(self, repo):
        report = compare(repo)
        assert report.status == "pass" and report.contracts == []

    def test_a_removed_endpoint_names_its_consumer(self, repo):
        _break_orders(repo)
        report = compare(repo)
        assert report.status == "breaking"
        [entry] = report.contracts
        assert entry.path == "services/orders/api/openapi.yaml"
        [consumer] = entry.consumers["POST /orders"]
        assert consumer == {
            "name": "Web shop",
            "contact": "@acme/web",
            "files": ["apps/web/src/orders.ts"],
        }

    def test_a_whole_path_does_not_match_a_longer_one(self):
        assert needles_for("POST /orders", {"POST /orders": "createOrder"}) == [
            "/orders\x00",
            "createOrder",
        ]
        assert needles_for("GET /orders/{id}.params.x", {}) == ["/orders/"]
        assert needles_for("Order.id", {}) == []

    def test_each_contract_on_its_own_and_a_deleted_one_breaks(self, repo):
        (repo / "services/users/users.proto").unlink()
        _write(
            repo, "services/billing/schema.graphql", "type Query { invoice: String }\n"
        )
        report = compare(repo)
        status = {entry.path: entry.status for entry in report.contracts}
        assert status == {
            "services/users/users.proto": "removed",
            "services/billing/schema.graphql": "added",
        }
        removed = next(e for e in report.contracts if e.status == "removed")
        assert removed.consumers["services/users/users.proto"][0]["name"] == "Partners"

    def test_an_unsupported_format_is_compared_as_text(self, repo):
        _write(repo, "contracts/legacy.wsdl", "<definitions>\n<x/>\n</definitions>\n")
        report = compare(repo, consumers=False)
        [entry] = report.contracts
        assert entry.status == "unsupported" and entry.text_delta == (3, 1)
        assert report.status == "review"

    def test_a_task_reads_only_the_contracts_it_touched(self, repo):
        _break_orders(repo)
        _write(
            repo, "services/users/users.proto", USERS.replace("name = 2", "name = 3")
        )
        report = compare(repo, files=["services/users/users.proto", "README.md"])
        assert [e.path for e in report.contracts] == ["services/users/users.proto"]

    def test_a_bad_target_is_refused(self, repo):
        assert not valid_ref("--output=/tmp/x")
        assert not valid_ref("a..b")
        assert compare(repo, target="-x").unchecked.startswith("invalid target")

    def test_outside_git_nothing_is_checked(self, tmp_path):
        assert compare(tmp_path).unchecked == "not a git repository"


class TestRegistry:
    def test_entries_are_checked_and_bounded(self):
        consumers, errors = parse_registry(
            {"consumers": [{"name": "A", "contracts": "api/*"}, {"contact": "x"}, "y"]}
        )
        assert [c.name for c in consumers] == ["A"]
        assert consumers[0].contracts == ("api/*",)
        assert len(errors) == 2

    def test_a_task_worktree_reads_the_main_checkout_registry(self, repo):
        tree = repo / ".workpilot" / "worktrees" / "tasks" / "001-x"
        tree.mkdir(parents=True)
        assert [c.name for c in load_registry(tree).consumers] == [
            "Web shop",
            "Partners",
        ]

    def test_an_invalid_registry_is_reported_not_raised(self, tmp_path):
        _write(tmp_path, ".workpilot/api-consumers.yaml", "consumers: [unclosed\n")
        assert load_registry(tmp_path).errors


class TestGuide:
    def test_the_guide_lists_actions_consumers_and_a_timeline(self, repo):
        _break_orders(repo)
        guide = render(compare(repo))
        assert "1 breaking change(s) not acknowledged" in guide
        assert "Consumer: Web shop (@acme/web): `apps/web/src/orders.ts`" in guide
        assert "### Deprecation timeline" in guide


@pytest.fixture
def spec(tmp_path):
    spec = tmp_path / "spec"
    spec.mkdir()
    (spec / "implementation_plan.json").write_text(
        json.dumps({"qa_signoff": {"status": "approved"}}), encoding="utf-8"
    )
    return spec


def _scope(repo: Path) -> ChangeScope:
    return ChangeScope(
        "full",
        "test",
        files=("services/orders/api/openapi.yaml",),
        base=_git(repo, "rev-parse", "develop"),
    )


class TestQaGate:
    def test_warn_records_and_lets_the_approval_stand(self, repo, spec):
        _break_orders(repo)
        assert api_contract_gate(spec, repo, 1, _scope(repo)) is None
        record = load_record(spec)
        assert record["status"] == "breaking"
        assert record["unacknowledgedBreakingCount"] == 1
        assert "@acme/web" in pr_section(spec)

    def test_strict_sends_an_unacknowledged_break_back(self, repo, spec, monkeypatch):
        monkeypatch.setenv(API_CONTRACT_ENV, "strict")
        _break_orders(repo)
        issues, verdict = api_contract_gate(spec, repo, 2, _scope(repo))
        assert issues[0]["type"] == "breaking_api_change"
        assert "rejected" in verdict
        request = (spec / "QA_FIX_REQUEST.md").read_text(encoding="utf-8")
        assert "backward compatible" in request and "POST /orders" in request
        plan = json.loads(
            (spec / "implementation_plan.json").read_text(encoding="utf-8")
        )
        assert plan["qa_signoff"]["status"] == "rejected"

    def test_strict_lets_an_acknowledged_break_through(self, repo, spec, monkeypatch):
        monkeypatch.setenv(API_CONTRACT_ENV, "strict")
        _write(
            repo,
            "services/orders/api/openapi.yaml",
            ORDERS.replace(
                '  /orders:\n    post: {operationId: createOrder, responses: {"201": {description: ok}}}\n',
                "  /orders:\n    x-breaking-acknowledged: true\n",
            ),
        )
        assert api_contract_gate(spec, repo, 1, _scope(repo)) is None
        assert load_record(spec)["status"] == "review"

    def test_off_and_unknown_scope_are_never_a_pass(self, repo, spec, monkeypatch):
        assert api_contract_gate(spec, repo, 1, None) is None
        assert load_record(spec)["status"] == "unchecked"
        monkeypatch.setenv(API_CONTRACT_ENV, "off")
        assert api_contract_gate(spec, repo, 1, _scope(repo)) is None
        assert "disabled" in load_record(spec)["unchecked"]

    def test_no_record_no_pr_section(self, tmp_path):
        assert pr_section(tmp_path) == ""


class TestCli:
    def test_exit_codes(self, repo, tmp_path, capsys):
        assert cli(["check", "--project", str(repo)]) == 0
        _break_orders(repo)
        summary = tmp_path / "summary.md"
        assert cli(["check", "--project", str(repo), "--summary", str(summary)]) == 1
        assert "POST /orders" in summary.read_text(encoding="utf-8")
        assert cli(["check", "--project", str(repo), "--fail-on", "never"]) == 0
        assert cli(["check", "--project", str(tmp_path)]) == 2
        assert cli(["check", "--project", str(repo), "--target=-x"]) == 2

    def test_json_output(self, repo, capsys):
        _break_orders(repo)
        cli(["check", "--project", str(repo), "--json", "--no-consumers"])
        data = json.loads(capsys.readouterr().out)
        assert data["contracts"][0]["changes"][0]["changeType"] == "endpoint_removed"


class TestRunner:
    def test_the_dashboard_compares_with_the_branch(self, repo):
        from runners.api_watcher_runner import run_branch

        _break_orders(repo)
        result = run_branch(repo)
        assert result["mode"] == "branch"
        assert result["report"]["target"] == "develop"
        assert result["diff"]["breakingCount"] == 1
        assert "Deprecation timeline" in result["migrationGuideMarkdown"]

    def test_outside_git_the_baseline_takes_over(self, tmp_path):
        from runners.api_watcher_runner import run_branch

        assert run_branch(tmp_path) is None


class TestCiWorkflow:
    def test_one_pinned_step_per_contract(self, repo):
        import yaml
        from api_watcher.ci import BUF_IMAGE, OASDIFF_IMAGE, github_actions

        text = github_actions(discover(repo), "develop")
        steps = yaml.safe_load(text)["jobs"]["breaking-changes"]["steps"]
        assert [s.get("name") for s in steps[1:]] == [
            "OpenAPI services/orders/api/openapi.yaml",
            "protobuf services/users",
        ]
        assert OASDIFF_IMAGE in text and BUF_IMAGE in text and "@sha256:" in text

    def test_a_hostile_file_name_is_left_out(self):
        from api_watcher.ci import github_actions

        text = github_actions(["x$(id)/openapi.yaml", "a`b`.proto"], "dev$(id)")
        assert "$(id)" not in text and "`" not in text
        assert "branches: [develop]" in text
