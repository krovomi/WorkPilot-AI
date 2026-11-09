"""Plan rehearsal: a broken plan is caught from the tree alone, for every stack."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from simulation import rehearse_spec
from simulation.api_mocks import build_index, mock, sample
from simulation.plan_rehearsal import rehearse
from simulation.snapshot import (
    Snapshot,
    SnapshotError,
    normalise_plan_path,
    read_snapshot,
)
from simulation.toolchains import check_command


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "config", "user.email", "t@example.com")
    _git(tmp_path, "config", "user.name", "t")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("print('hi')\n")
    (tmp_path / "package.json").write_text(json.dumps({"scripts": {"test": "vitest"}}))
    (tmp_path / "openapi.yaml").write_text(
        """openapi: 3.0.0
info: {title: shop, version: '1'}
paths:
  /orders/{id}:
    get:
      responses:
        '200':
          content:
            application/json:
              schema: {$ref: '#/components/schemas/Order'}
components:
  schemas:
    Order:
      type: object
      properties:
        id: {type: string, format: uuid}
        total: {type: number}
        lines: {type: array, items: {type: integer}}
"""
    )
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-q", "-m", "init")
    return tmp_path


def _reader(files: dict[str, str]):
    return lambda path: files.get(path)


def _walk(plan: dict, files: dict[str, str] | None = None):
    files = files or {"src/app.py": "", "package.json": '{"scripts": {"test": "x"}}'}
    snapshot = Snapshot(ref="HEAD", files=set(files))
    read = _reader(files)
    return rehearse(plan, snapshot, read, build_index(snapshot.files, read))


def _codes(walk) -> list[str]:
    return [f.code for step in walk.steps for f in step.findings] + [
        f.code for f in walk.plan_findings
    ]


def _sub(sub_id: str, **fields) -> dict:
    return {
        "id": sub_id,
        "description": sub_id,
        "verification": {"type": "manual"},
        **fields,
    }


class TestOrdering:
    def test_a_file_modified_before_it_is_created_is_an_error(self):
        plan = {
            "phases": [
                {
                    "phase": 1,
                    "name": "api",
                    "subtasks": [_sub("1.1", files_to_modify=["src/routes.py"])],
                },
                {
                    "phase": 2,
                    "name": "model",
                    "subtasks": [_sub("2.1", files_to_create=["src/routes.py"])],
                },
            ]
        }
        walk = _walk(plan)
        assert walk.steps[0].status == "error"
        finding = walk.steps[0].findings[0]
        assert (finding.code, finding.params["creator"]) == (
            "file_modified_before_created",
            "2.1",
        )

    def test_a_file_created_by_a_dependency_can_be_modified(self):
        plan = {
            "phases": [
                {
                    "phase": 2,
                    "name": "use",
                    "depends_on": [1],
                    "subtasks": [_sub("2.1", files_to_modify=["src/new.cs"])],
                },
                {
                    "phase": 1,
                    "name": "make",
                    "subtasks": [_sub("1.1", files_to_create=["src/new.cs"])],
                },
            ]
        }
        walk = _walk(plan)
        # phase 1 runs first because phase 2 depends on it, whatever the written order
        assert [s.subtask_id for s in walk.steps] == ["1.1", "2.1"]
        assert all(s.status == "success" for s in walk.steps)

    def test_a_file_from_an_unrelated_phase_is_a_warning(self):
        plan = {
            "phases": [
                {
                    "phase": 1,
                    "name": "a",
                    "subtasks": [_sub("1.1", files_to_create=["lib/a.go"])],
                },
                {
                    "phase": 2,
                    "name": "b",
                    "subtasks": [_sub("2.1", files_to_modify=["lib/a.go"])],
                },
            ]
        }
        assert "file_created_by_unrelated_phase" in _codes(_walk(plan))

    def test_missing_file_names_the_ref(self):
        walk = _walk(
            {"phases": [{"subtasks": [_sub("1", files_to_modify=["Program.cs"])]}]}
        )
        finding = walk.steps[0].findings[0]
        assert finding.code == "file_missing"
        assert "HEAD" in finding.message

    def test_cycle_and_unknown_dependency(self):
        plan = {
            "phases": [
                {"phase": 1, "depends_on": [2], "subtasks": [_sub("1")]},
                {"phase": 2, "depends_on": [1, 9], "subtasks": [_sub("2")]},
            ]
        }
        codes = _codes(_walk(plan))
        assert "phase_cycle" in codes
        assert "phase_unknown_dependency" in codes

    def test_empty_plan(self):
        assert _codes(_walk({"phases": []})) == ["plan_empty"]


class TestFiles:
    def test_paths_outside_the_project_are_errors(self):
        plan = {
            "phases": [
                {
                    "subtasks": [
                        _sub(
                            "1",
                            files_to_modify=[
                                "../secrets.txt",
                                "/etc/passwd",
                                "C:\\x.cs",
                            ],
                        )
                    ]
                }
            ]
        }
        assert _codes(_walk(plan)).count("path_outside_project") == 3

    def test_windows_and_dot_paths_are_repaired(self):
        assert normalise_plan_path(".\\src\\App.tsx") == "src/App.tsx"
        assert normalise_plan_path("./a/./b.rs") == "a/b.rs"

    def test_creating_an_existing_file_twice_and_patterns(self):
        plan = {
            "phases": [
                {
                    "subtasks": [
                        _sub("1", files_to_create=["src/app.py"]),
                        _sub(
                            "2",
                            files_to_create=["src/app.py"],
                            patterns_from=["src/ghost.py"],
                        ),
                    ]
                }
            ]
        }
        codes = _codes(_walk(plan))
        assert {"file_already_exists", "file_created_twice", "pattern_missing"} <= set(
            codes
        )

    def test_parallel_phase_conflict(self):
        plan = {
            "phases": [
                {
                    "parallel_safe": True,
                    "subtasks": [
                        _sub("a", files_to_modify=["src/app.py"]),
                        _sub("b", files_to_modify=["src/app.py"]),
                    ],
                }
            ]
        }
        assert "parallel_conflict" in _codes(_walk(plan))

    def test_binary_files_are_noted_not_blocking(self):
        walk = _walk(
            {"phases": [{"subtasks": [_sub("1", files_to_create=["assets/logo.png"])]}]}
        )
        assert walk.steps[0].status == "success"
        assert "binary_file" in _codes(walk)


class TestToolchains:
    @pytest.mark.parametrize(
        ("command", "manifest"),
        [
            ("dotnet test", "Api/Api.csproj"),
            ("cargo test", "Cargo.toml"),
            ("go test ./...", "go.mod"),
            ("./gradlew test", "build.gradle.kts"),
            ("mvn -q verify", "pom.xml"),
            ("flutter test", "pubspec.yaml"),
            ("vendor/bin/phpunit", "phpunit.xml"),
            ("swift test", "Package.swift"),
            ("bundle exec rspec", "Gemfile"),
        ],
    )
    def test_every_stack_needs_its_manifest(self, command: str, manifest: str):
        bare = Snapshot(ref="HEAD", files={"README.md"})
        assert [f.code for f in check_command(command, bare, _reader({}))] == [
            "command_manifest_missing"
        ]
        with_manifest = Snapshot(ref="HEAD", files={"README.md", manifest})
        assert check_command(command, with_manifest, _reader({})) == []

    def test_missing_npm_script(self):
        files = {"web/package.json": '{"scripts": {"test": "vitest"}}'}
        snapshot = Snapshot(ref="HEAD", files=set(files))
        found = check_command("cd web && npm run e2e", snapshot, _reader(files))
        assert [(f.code, f.params["script"]) for f in found] == [
            ("command_script_missing", "e2e")
        ]
        assert check_command("cd web && pnpm test", snapshot, _reader(files)) == []
        assert check_command("bun test", snapshot, _reader({})) == []

    def test_missing_cd_target(self):
        found = check_command(
            "cd frontend && npm test", Snapshot(ref="HEAD", files={"a"}), _reader({})
        )
        assert [f.code for f in found] == ["command_dir_missing"]

    def test_unknown_tools_are_not_judged(self):
        assert (
            check_command(
                "pytest -q && ./scripts/check.sh",
                Snapshot(ref="HEAD", files=set()),
                _reader({}),
            )
            == []
        )


class TestApiMocks:
    def test_schema_based_mock_with_base_path(self, repo: Path):
        files = {"openapi.yaml": (repo / "openapi.yaml").read_text()}
        index = build_index(set(files), _reader(files))
        result = mock(index, "GET", "http://localhost:5000/api/orders/42", 200)
        assert result.strategy == "schema_based"
        assert json.loads(result.body) == {
            "id": "00000000-0000-0000-0000-000000000000",
            "total": 0.0,
            "lines": [0],
        }
        assert mock(index, "GET", "/orders/42", 404).finding == "api_status_undeclared"
        assert (
            mock(index, "DELETE", "/orders/42", None).finding
            == "api_endpoint_undeclared"
        )
        assert (
            mock(index, "GET", "/ordersX/42", None).finding == "api_endpoint_undeclared"
        )

    def test_no_contract(self):
        assert (
            mock(build_index(set(), _reader({})), "GET", "/x", 200).finding
            == "api_no_contract"
        )

    def test_sample_handles_compositions_and_cycles(self):
        root = {
            "components": {
                "schemas": {
                    "N": {
                        "type": "object",
                        "properties": {"next": {"$ref": "#/components/schemas/N"}},
                    }
                }
            }
        }
        assert (
            sample({"$ref": "#/components/schemas/N"}, root) is not None
        )  # depth-limited, no recursion error
        assert sample(
            {
                "allOf": [
                    {"properties": {"a": {"type": "boolean"}}},
                    {"properties": {"b": {"enum": ["x"]}}},
                ]
            },
            {},
        ) == {"a": True, "b": "x"}


class TestEndToEnd:
    def _spec(self, repo: Path, plan: dict) -> Path:
        spec = repo / ".workpilot" / "specs" / "001-orders"
        spec.mkdir(parents=True)
        (spec / "spec.md").write_text("# Orders\n")
        (spec / "implementation_plan.json").write_text(json.dumps(plan))
        return spec

    def test_report_over_head_ignores_uncommitted_files(self, repo: Path):
        (repo / "src" / "draft.py").write_text("uncommitted\n")
        plan = {
            "phases": [
                {
                    "phase": 1,
                    "name": "Orders",
                    "subtasks": [
                        _sub("1.1", files_to_modify=["src/draft.py"]),
                        {
                            "id": "1.2",
                            "description": "endpoint",
                            "files_to_modify": ["src/app.py"],
                            "verification": {
                                "type": "api",
                                "method": "GET",
                                "url": "/orders/1",
                                "expect_status": 200,
                            },
                        },
                        _sub(
                            "1.3",
                            files_to_create=["src/orders.py"],
                            verification={"type": "command", "run": "npm run lint"},
                        ),
                    ],
                }
            ]
        }
        result = rehearse_spec(repo, self._spec(repo, plan))
        assert result["mode"] == "plan"
        assert result["verdict"] == "blocked"
        statuses = [s["status"] for s in result["steps"]]
        assert statuses == ["error", "success", "warning"]  # draft.py is not in HEAD
        assert result["steps"][1]["mockApiCalls"][0]["strategy"] == "schema_based"
        assert result["contracts"] == ["openapi.yaml"]
        assert {d["filePath"]: d["changeType"] for d in result["diffs"]} == {
            "src/orders.py": "added",
            "src/draft.py": "modified",
            "src/app.py": "modified",
        }
        assert result["totalTokensUsed"] == 0
        assert (
            result["costEstimate"] is None or "total_cost_usd" in result["costEstimate"]
        )

    def test_unreadable_plan(self, repo: Path):
        spec = self._spec(repo, {})
        (spec / "implementation_plan.json").write_text("{not json")
        result = rehearse_spec(repo, spec)
        assert [f["code"] for f in result["planFindings"]][:1] == ["plan_unreadable"]

    def test_timeout_gives_a_partial_report(self, repo: Path):
        snapshot = Snapshot(ref="HEAD", files=set())
        ticks = iter([0.0, 10.0, 10.0, 10.0, 10.0])
        plan = {"phases": [{"subtasks": [_sub("1"), _sub("2")]}]}
        walk = rehearse(
            plan,
            snapshot,
            _reader({}),
            build_index(set(), _reader({})),
            deadline=5.0,
            clock=lambda: next(ticks, 10.0),
        )
        assert walk.partial
        assert [s.status for s in walk.steps][-1] == "skipped"

    def test_bad_ref_is_refused(self, repo: Path):
        with pytest.raises(SnapshotError):
            read_snapshot(repo, "--output=/tmp/x")
        with pytest.raises(SnapshotError):
            read_snapshot(repo, "no-such-branch")


class TestRunner:
    def _run(self, *args: str) -> subprocess.CompletedProcess[str]:
        runner = (
            Path(__file__).resolve().parents[2]
            / "apps"
            / "backend"
            / "runners"
            / "sandbox_runner.py"
        )
        import sys

        return subprocess.run(
            [sys.executable, str(runner), *args],
            capture_output=True,
            text=True,
            timeout=120,
        )

    def test_plan_mode_prints_a_result(self, repo: Path):
        spec = repo / ".workpilot" / "specs" / "002-x"
        spec.mkdir(parents=True)
        (spec / "implementation_plan.json").write_text(
            json.dumps(
                {"phases": [{"subtasks": [_sub("1", files_to_modify=["src/app.py"])]}]}
            )
        )
        out = self._run("--project-path", str(repo), "--spec-dir", str(spec))
        line = next(
            ln for ln in out.stdout.splitlines() if ln.startswith("SANDBOX_RESULT:")
        )
        result = json.loads(line.split(":", 1)[1])["result"]
        assert (result["mode"], result["verdict"]) == ("plan", "ready")

    def test_a_folder_outside_the_specs_is_refused(self, repo: Path, tmp_path_factory):
        elsewhere = tmp_path_factory.mktemp("elsewhere")
        out = self._run("--project-path", str(repo), "--spec-dir", str(elsewhere))
        assert out.returncode == 1
        assert "The spec folder is not a spec of this project" in out.stdout
        nested = repo / ".workpilot" / "specs" / "a" / "b"
        nested.mkdir(parents=True)
        assert (
            self._run("--project-path", str(repo), "--spec-dir", str(nested)).returncode
            == 1
        )
