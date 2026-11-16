"""The .NET public API gate's edges: what it reads, and every way it gives up.

`test_qa_dotnet_api_gate.py` runs the gate end to end on a real repository.
These tests pin the rest: which workflows make it strict, the timeout and
offline readings, a base that is no commit, the SDK missing from PATH, more
projects than it compares, what the fixer and the log are told, and the
records it still writes when a file cannot be written.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
import qa.dotnet_api_gate as gate_module
import workflows.registry as registry
from foundation.change_scope import ChangeScope
from qa.dotnet_api_gate import (
    DOTNET_API_ENV,
    TIMEOUT_ENV,
    check,
    dotnet_api_gate,
    gate_mode,
    render_fix_request,
)
from rea.dotnet_api import (
    FAIL,
    NONE,
    ApiReport,
    AssemblyResult,
    load_record,
)
from workflows.spec import WorkflowError

from tests.rea.test_qa_dotnet_api_gate import (
    LAUNCHER,
    PROJECT,
    Builder,
    _git,
    _locator,
    _runner,
)
from tests.rea.test_qa_dotnet_api_gate import (
    task as task,  # the fixture, re-exported for this module
)


@pytest.fixture(autouse=True)
def no_variables(monkeypatch):
    monkeypatch.delenv(DOTNET_API_ENV, raising=False)
    monkeypatch.delenv(TIMEOUT_ENV, raising=False)


def _scope(base: str, *files: str) -> ChangeScope:
    return ChangeScope(level="full", reason="t", files=files, base=base)


class TestWhatMakesItStrict:
    def test_a_workflow_declaring_the_gate_makes_it_strict(self, tmp_path, monkeypatch):
        phases = (
            SimpleNamespace(hard_gate=None),
            SimpleNamespace(hard_gate="tests-pass,public-api-stable"),
        )
        monkeypatch.setattr(
            registry,
            "load_workflow_for_spec",
            lambda spec: SimpleNamespace(phases=phases),
        )
        assert gate_module._declared(tmp_path) is True
        assert gate_mode(tmp_path) == "strict"

    def test_a_workflow_without_it_or_unreadable_declares_nothing(
        self, tmp_path, monkeypatch
    ):
        # The real default workflow does not declare it.
        assert gate_module._declared(tmp_path) is False

        def broken(spec):
            raise WorkflowError("bad yaml")

        monkeypatch.setattr(registry, "load_workflow_for_spec", broken)
        assert gate_module._declared(tmp_path) is False
        assert gate_mode(tmp_path) == "warn"

    def test_off_and_an_unknown_value(self, tmp_path, monkeypatch):
        monkeypatch.setenv(DOTNET_API_ENV, "OFF ")
        assert gate_mode(tmp_path) == "off"
        monkeypatch.setenv(DOTNET_API_ENV, "loud")
        assert gate_mode(tmp_path) == "warn"


class TestTheReadings:
    @pytest.mark.parametrize(
        ("raw", "seconds"),
        [("", 600), ("abc", 600), ("5", 60), ("90", 90), ("99999", 3600)],
    )
    def test_the_timeout_is_bounded(self, monkeypatch, raw, seconds):
        monkeypatch.setenv(TIMEOUT_ENV, raw)
        assert gate_module._timeout() == seconds

    def test_an_unreadable_offline_policy_reads_as_strict(self, tmp_path, monkeypatch):
        def unreadable(project_dir):
            raise OSError("denied")

        monkeypatch.setattr(gate_module, "airgap_status", unreadable)
        assert gate_module._offline(tmp_path) is True
        monkeypatch.setattr(
            gate_module, "airgap_status", lambda p: {"airgapStrict": False}
        )
        assert gate_module._offline(tmp_path) is False

    def test_a_base_that_is_no_commit_here(self, task):
        project, _, _ = task
        with pytest.raises(OSError, match="not a commit here"):
            gate_module._commit(project, "0" * 40)

    def test_a_failed_listing_of_the_base(self, task, monkeypatch):
        project, _, scope = task

        def failing(args, **kwargs):
            return SimpleNamespace(returncode=128, stdout="", stderr="fatal: bad tree")

        monkeypatch.setattr(gate_module, "run_git", failing)
        with pytest.raises(OSError, match="bad tree"):
            gate_module._base_projects(project, scope.base)

    def test_projects_under_build_folders_are_not_the_base_s(self, task):
        project, _, _ = task
        (project / "obj" / "Gen").mkdir(parents=True)
        (project / "obj/Gen/Gen.csproj").write_text("<Project/>", encoding="utf-8")
        _git(project, "add", "-f", "obj/Gen/Gen.csproj")
        _git(project, "commit", "-q", "-m", "generated")
        head = _git(project, "rev-parse", "HEAD")
        assert sorted(gate_module._base_projects(project, head)) == sorted(
            [PROJECT, "src/Lib.Tests/Lib.Tests.csproj"]
        )


class TestCheck:
    def test_no_dotnet_file_is_nothing_to_check(self, task):
        project, spec, scope = task
        report = check(
            spec,
            project,
            _scope(scope.base, "README.md"),
            mode="warn",
            launcher=LAUNCHER,
        )
        assert report.status == NONE and "no .NET source" in report.notes[0]

    def test_without_the_sdk_it_is_unchecked(self, task, monkeypatch):
        project, spec, scope = task
        monkeypatch.setattr(gate_module, "find_executable", lambda name: None)
        report = check(spec, project, scope, mode="warn", launcher=LAUNCHER)
        assert report.unchecked == "the .NET SDK (dotnet) is not on PATH"

    def test_with_the_sdk_it_builds_with_dotnet(self, task, monkeypatch):
        project, spec, scope = task
        made = []

        def dotnet_builder(dotnet, *, timeout):
            made.append((dotnet, timeout))
            return Builder()

        monkeypatch.setattr(gate_module, "find_executable", lambda name: "/sdk/dotnet")
        monkeypatch.setattr(gate_module, "DotnetBuilder", dotnet_builder)
        report = check(
            spec, project, scope, mode="warn", launcher=LAUNCHER, runner=_runner
        )
        assert made == [("/sdk/dotnet", 600)]
        assert report.status == FAIL

    def test_a_file_no_library_owns(self, task):
        project, spec, scope = task
        report = check(
            spec,
            project,
            _scope(scope.base, "tools/Script.cs"),
            mode="warn",
            launcher=LAUNCHER,
            builder=Builder(),
        )
        assert report.status == NONE
        assert report.notes == ["the change set reaches no library project"]

    def test_projects_beyond_the_limit_leave_it_unchecked(self, task, monkeypatch):
        project, spec, scope = task
        (project / "src/Lib/Api.cs").write_text(
            "public void Run() {}", encoding="utf-8"
        )
        (project / "src/Extra").mkdir()
        (project / "src/Extra/Extra.csproj").write_text("<Project/>", encoding="utf-8")
        monkeypatch.setattr(gate_module, "MAX_PROJECTS", 1)
        report = check(
            spec,
            project,
            _scope(scope.base, "Directory.Build.props"),  # reaches every project
            mode="warn",
            launcher=LAUNCHER,
            builder=Builder(),
            runner=_runner,
        )
        assert report.status == "unchecked"
        assert report.unchecked.startswith("1 more project(s) beyond the first 1")


def _broken_report() -> ApiReport:
    report = ApiReport(mode="strict", status=FAIL, rea="rea 6.9.0")
    report.assemblies = [
        AssemblyResult(
            project="src/A/A.csproj",
            before="net8.0",
            after="net9.0",
            status="breaking",
            breaking=[{"kind": "removed", "member": "A.Run", "detail": "gone"}],
        ),
        AssemblyResult(
            project="src/B/B.csproj",
            before="net9.0",
            after="net9.0",
            status="breaking",
            breaking=[{"kind": "hidden", "member": "B.Go"}],
        ),
        AssemblyResult(
            project="src/C/C.csproj",
            status="breaking",
            breaking=[{"kind": "renamed", "member": "C.X"}],
        ),
    ]
    return report


class TestWhatItSays:
    def test_the_fix_request_names_each_side(self, tmp_path):
        text = render_fix_request(_broken_report(), tmp_path)
        assert "1. removed in `src/A/A.csproj (net8.0 → net9.0)`" in text
        assert "2. hidden in `src/B/B.csproj (net9.0)`" in text
        assert "3. renamed in `src/C/C.csproj`" in text
        assert "removed: A.Run -> gone" in text
        assert "hidden: B.Go\n" in text

    def test_a_fix_request_without_members_has_no_quote(self):
        text = render_fix_request(ApiReport(status=FAIL))
        assert "## The members" not in text and "## To fix (blocking)" in text

    def test_the_log_lists_each_assembly(self, capsys):
        report = ApiReport(status="unchecked", rea="rea 6.9.0", unchecked="1 more")
        report.assemblies = [
            AssemblyResult(
                project="src/A/A.csproj",
                after="net9.0",
                status="compatible",
                public_members=3,
                added=2,
            ),
            AssemblyResult(
                project="src/B/B.csproj",
                after="net9.0",
                status="compatible",
                public_members=1,
            ),
            AssemblyResult(project="src/C/C.csproj", detail="could not pair"),
        ]
        gate_module._say(report)
        out = capsys.readouterr().out
        assert "✓ src/A/A.csproj (net9.0): 3 public member(s) kept, 2 added" in out
        assert "✓ src/B/B.csproj (net9.0): 1 public member(s) kept\n" in out
        assert "? src/C/C.csproj (?): could not pair" in out
        assert "  ? 1 more" in out

    def test_the_task_log_gets_an_error_for_a_break(self):
        from task_logger import LogEntryType, LogPhase

        logged = []
        logger = SimpleNamespace(log=lambda *args: logged.append(args))
        gate_module._say(_broken_report(), logger)
        gate_module._say(ApiReport(unchecked="no SDK"), logger)
        gate_module._say(ApiReport(status=NONE), logger)
        assert [entry[1] for entry in logged] == [
            LogEntryType.ERROR,
            LogEntryType.INFO,
        ]
        assert all(entry[2] == LogPhase.VALIDATION for entry in logged)
        assert "✗ src/A/A.csproj (net9.0): removed A.Run" in logged[0][0]
        assert logged[1][0] == "🔌 .NET public API: not checked — no SDK"

    def test_no_plan_no_signoff_to_mark(self, tmp_path):
        gate_module._mark_signoff_rejected(tmp_path, [{"type": "public_api_break"}])
        assert not (tmp_path / "implementation_plan.json").exists()

    def test_the_signoff_keeps_other_issues_and_replaces_its_own(self, tmp_path):
        (tmp_path / "implementation_plan.json").write_text(
            json.dumps(
                {
                    "qa_signoff": {
                        "status": "approved",
                        "issues_found": [
                            {"type": "public_api_break", "title": "old"},
                            {"type": "other", "title": "kept"},
                            "a stray line",
                        ],
                    }
                }
            ),
            encoding="utf-8",
        )
        gate_module._mark_signoff_rejected(tmp_path, [{"type": "public_api_break"}])
        plan = json.loads((tmp_path / "implementation_plan.json").read_text("utf-8"))
        assert plan["qa_signoff"]["issues_found"] == [
            {"type": "other", "title": "kept"},
            "a stray line",
            {"type": "public_api_break"},
        ]
        assert plan["qa_signoff"]["status"] == "rejected"


class TestWhenAFileCannotBeWritten:
    def test_the_record_fails_too_and_it_still_does_not_raise(self, task):
        project, spec, _ = task
        (spec / "dotnet_public_api.json").mkdir()  # the record cannot be written
        bogus = _scope("--output=x", "src/Lib/Api.cs")
        assert (
            dotnet_api_gate(
                spec, project, 1, bogus, locator=_locator([]), runner=_runner
            )
            is None
        )

    def test_a_rejection_without_its_fix_request_file(self, task, monkeypatch):
        project, spec, scope = task
        monkeypatch.setenv(DOTNET_API_ENV, "strict")
        monkeypatch.setattr(gate_module, "_offline", lambda p: True)
        (spec / "QA_FIX_REQUEST.md").mkdir()
        downloads: list[bool] = []
        issues, verdict = dotnet_api_gate(
            spec,
            project,
            3,
            scope,
            locator=_locator(downloads),
            builder=Builder(),
            runner=_runner,
        )
        assert downloads == [False]  # strict, but offline: no download
        assert verdict.startswith("QA pass #3 rejected: 1 public member(s)")
        assert issues[0]["description"].endswith(f"({PROJECT})")
        assert load_record(spec)["status"] == "fail"
        # The request could not be written, so the signoff was not reached either.
        plan = json.loads((spec / "implementation_plan.json").read_text("utf-8"))
        assert plan["qa_signoff"]["status"] == "approved"
