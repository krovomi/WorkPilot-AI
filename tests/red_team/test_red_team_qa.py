"""The red team in QA and on the card: the edges `test_red_team_units.py` leaves.

Which workflow asks for it, the one session it opens (any provider, with the
resume variable put back), what the fixer and the log are told, every way the
gate gives up without blocking, and the card's two routes: where they find
the task's code, what a fresh attack records, and what an error answers.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
import qa.red_team_api as api
import qa.red_team_gate as gate
import workflows.registry as registry
from fastapi import FastAPI
from fastapi.testclient import TestClient
from foundation.change_scope import ChangeScope
from red_team import load_record, write_record
from red_team.engine import Attack, RedTeamReport
from workflows.spec import WorkflowError


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def _attack(**overrides) -> Attack:
    values = {
        "id": "a1",
        "mode": "edge",
        "test": "test_red_team_zero",
        "file": "tests/test_shop_red_team.py",
        "target": "shop.unit_price",
        "input": "quantity = 0",
        "expect": "0",
        "outcome": "crash",
        "detail": "ZeroDivisionError: division by zero",
    }
    values.update(overrides)
    return Attack(**values)


def _crashed(*attacks: Attack, files: dict | None = None) -> RedTeamReport:
    return RedTeamReport(
        status="fail",
        reason="an attack crashed the changed code",
        base="abc",
        attacks=list(attacks) or [_attack()],
        files=files if files is not None else {},
    )


SCOPE = ChangeScope(level="full", reason="t", base="abc", files=("shop.py",))


@pytest.fixture
def always(monkeypatch):
    monkeypatch.setenv(gate.RED_TEAM_ENV, "always")


class TestWhenItRuns:
    def test_a_workflow_declaring_attack_resistant_runs_it(self, tmp_path, monkeypatch):
        monkeypatch.delenv(gate.RED_TEAM_ENV, raising=False)
        phases = (SimpleNamespace(hard_gate="tests-pass,attack-resistant"),)
        monkeypatch.setattr(
            registry,
            "load_workflow_for_spec",
            lambda spec: SimpleNamespace(phases=phases),
        )
        assert gate._declared(tmp_path) is True
        assert gate.mode_for(tmp_path) == "run"

    def test_the_default_workflow_or_an_unreadable_one_does_not(
        self, tmp_path, monkeypatch
    ):
        assert gate._declared(tmp_path) is False

        def broken(spec):
            raise WorkflowError("bad yaml")

        monkeypatch.setattr(registry, "load_workflow_for_spec", broken)
        assert gate._declared(tmp_path) is False

    async def test_a_task_it_was_not_asked_for_is_left_alone(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(gate, "mode_for", lambda spec: None)
        assert await gate.red_team_gate(tmp_path, tmp_path, 1, SCOPE, model="m") is None
        assert load_record(tmp_path) is None


class TestTheSession:
    async def test_one_red_team_session_in_the_copy_with_the_qa_provider(
        self, tmp_path, monkeypatch
    ):
        import agents.session as session_module
        import core.client as client_module
        import phase_config
        import workflows.runner as runner
        from task_logger import LogPhase

        made: dict = {}

        class Client:
            async def __aenter__(self):
                made["resume_inside"] = gate.os.environ.get(
                    "AUTO_CLAUDE_RESUME_SESSION_ID"
                )
                return self

            async def __aexit__(self, *exc):
                return False

        def create(**kwargs):
            made["client"] = kwargs
            return Client()

        async def run(client, prompt, spec_dir, verbose, *, phase):
            made["run"] = (prompt, spec_dir, verbose, phase)
            return ("complete", "attacks written", {})

        monkeypatch.setattr(client_module, "create_agent_client", create)
        monkeypatch.setattr(session_module, "run_agent_session", run)
        monkeypatch.setattr(
            phase_config, "get_phase_thinking_budget", lambda spec, phase: 4096
        )
        monkeypatch.setattr(
            runner, "phase_provider", lambda spec, phase: ("codex", "x")
        )
        monkeypatch.setenv("AUTO_CLAUDE_RESUME_SESSION_ID", "coder-session")

        session = gate.make_session(tmp_path / "spec", "model-x", verbose=True)
        result = await session(tmp_path / "copy", "attack it")

        assert result == ("complete", "attacks written", {})
        assert made["client"] == {
            "project_dir": tmp_path / "copy",
            "spec_dir": tmp_path / "spec",
            "model": "model-x",
            "agent_type": "red_team",
            "max_thinking_tokens": 4096,
            "use_subagents": False,
            "provider": "codex",
        }
        assert made["run"] == (
            "attack it",
            tmp_path / "spec",
            True,
            LogPhase.VALIDATION,
        )
        # The coder's session is never resumed, and is given back afterwards.
        assert made["resume_inside"] is None
        assert gate.os.environ["AUTO_CLAUDE_RESUME_SESSION_ID"] == "coder-session"

    async def test_without_a_session_to_resume_none_is_put_back(
        self, tmp_path, monkeypatch
    ):
        import core.client as client_module
        import workflows.runner as runner

        def create(**kwargs):
            raise RuntimeError("no provider")

        monkeypatch.setattr(client_module, "create_agent_client", create)
        monkeypatch.setattr(runner, "phase_provider", lambda spec, phase: (None, "x"))
        monkeypatch.delenv("AUTO_CLAUDE_RESUME_SESSION_ID", raising=False)
        with pytest.raises(RuntimeError):
            await gate.make_session(tmp_path, "m")(tmp_path, "p")
        assert "AUTO_CLAUDE_RESUME_SESSION_ID" not in gate.os.environ


class TestWhatItSays:
    def test_the_fix_request_fences_each_attack(self):
        report = _crashed(
            _attack(detail="AssertionError\n```\nnested fence\n```"),
            _attack(
                test="test_b",
                file="tests/b.py",
                target="",
                input="",
                expect="",
                detail="",
            ),
            files={"tests/test_shop_red_team.py": "def test_red_team_zero(): ..."},
        )
        text = gate.render_fix_request(report)
        assert "### 1. `test_red_team_zero` (edge) — `shop.unit_price`" in text
        assert "````\nAssertionError\n```\nnested fence\n```\n````" in text
        assert "Attack test (`tests/test_shop_red_team.py`):" in text
        assert "### 2. `test_b` (edge) — `tests/b.py`" in text
        assert "- Input: (see the test)" in text and "- Expected: no crash" in text
        assert "```\n(no message)\n```" in text
        assert "Attack test (`tests/b.py`)" not in text  # its source is not kept

    def test_an_issue_reads_the_first_line_of_the_failure(self):
        issues = gate._issues(
            _crashed(_attack(detail=""), _attack(target="", input=""))
        )
        assert issues[0]["description"] == "shop.unit_price: quantity = 0 — "
        assert issues[1]["description"].startswith(
            "tests/test_shop_red_team.py: test_red_team_zero — ZeroDivisionError"
        )

    def test_the_task_log_gets_an_error_for_a_crash(self):
        from task_logger import LogEntryType, LogPhase

        logged = []
        logger = SimpleNamespace(log=lambda *args: logged.append(args))
        gate._say(_crashed(), logger)
        gate._say(RedTeamReport(status="pass"), logger)
        assert [e[1] for e in logged] == [LogEntryType.ERROR, LogEntryType.INFO]
        assert all(e[2] == LogPhase.VALIDATION for e in logged)
        assert (
            "1 crash" in logged[0][0]
            and "✗ test_red_team_zero: quantity = 0" in logged[0][0]
        )
        assert "\n" not in logged[1][0]  # no reason, no crash: one line

    def test_the_signoff_is_rejected_and_keeps_other_issues(self, tmp_path):
        gate._mark_signoff_rejected(tmp_path, [{"type": gate.ISSUE_TYPE}])
        assert not (tmp_path / "implementation_plan.json").exists()

        plan = tmp_path / "implementation_plan.json"
        plan.write_text(
            json.dumps(
                {
                    "qa_signoff": {
                        "status": "approved",
                        "issues_found": [
                            {"type": gate.ISSUE_TYPE, "title": "old crash"},
                            {"type": "other"},
                        ],
                    }
                }
            ),
            encoding="utf-8",
        )
        gate._mark_signoff_rejected(
            tmp_path, [{"type": gate.ISSUE_TYPE, "title": "new"}]
        )
        signoff = json.loads(plan.read_text(encoding="utf-8"))["qa_signoff"]
        assert signoff["status"] == "rejected"
        assert signoff["ready_for_qa_revalidation"] is False
        assert signoff["issues_found"] == [
            {"type": "other"},
            {"type": gate.ISSUE_TYPE, "title": "new"},
        ]

        plan.write_text(json.dumps({"qa_signoff": "approved"}), encoding="utf-8")
        gate._mark_signoff_rejected(tmp_path, [])
        assert json.loads(plan.read_text(encoding="utf-8"))["qa_signoff"]["status"] == (
            "rejected"
        )


class TestTheGateGivesUp:
    async def test_an_unknown_change_set_is_recorded_unknown(self, tmp_path, always):
        assert await gate.red_team_gate(tmp_path, tmp_path, 1, None, model="m") is None
        record = load_record(tmp_path)
        assert record["status"] == "unknown"
        assert record["reason"] == "the change set is unknown"

    async def test_attacks_on_another_base_are_not_replayed(
        self, tmp_path, monkeypatch, always
    ):
        old = _crashed()
        old.base = "older"
        write_record(tmp_path, old)
        seen = {}

        async def fake_run(project_dir, base, files, *, session, previous):
            seen["previous"] = previous
            return RedTeamReport(status="pass", base=base)

        monkeypatch.setattr(gate, "run_red_team", fake_run)
        assert await gate.red_team_gate(tmp_path, tmp_path, 2, SCOPE, model="m") is None
        assert seen["previous"] is None
        assert load_record(tmp_path)["status"] == "pass"

    async def test_an_attack_that_cannot_run_is_skipped(
        self, tmp_path, monkeypatch, always
    ):
        async def broken(*args, **kwargs):
            raise OSError("no scratch copy")

        monkeypatch.setattr(gate, "run_red_team", broken)
        assert await gate.red_team_gate(tmp_path, tmp_path, 1, SCOPE, model="m") is None
        assert load_record(tmp_path) is None

    async def test_a_crash_still_rejects_when_the_request_cannot_be_written(
        self, tmp_path, monkeypatch, always
    ):
        async def crashed(*args, **kwargs):
            return _crashed()

        monkeypatch.setattr(gate, "run_red_team", crashed)
        (tmp_path / "QA_FIX_REQUEST.md").mkdir()
        issues, verdict = await gate.red_team_gate(
            tmp_path, tmp_path, 4, SCOPE, model="m"
        )
        assert verdict == (
            "QA pass #4 rejected: the red team crashed the code (1 attack(s))"
        )
        assert issues[0]["type"] == gate.ISSUE_TYPE


# --- the card's routes -------------------------------------------------------------


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(api.router)
    return TestClient(app)


def _project(tmp_path: Path) -> tuple[Path, Path]:
    project = tmp_path / "project"
    spec = project / ".workpilot" / "specs" / "001-cart"
    spec.mkdir(parents=True)
    return project, spec


class TestWhereTheTaskCodeIs:
    def test_a_spec_outside_a_project_has_none(self, tmp_path):
        assert api._project_of(tmp_path) is None
        assert api._task_code(tmp_path) is None

    def test_without_a_worktree_the_project_is_the_code(self, tmp_path):
        project, spec = _project(tmp_path)
        assert api._task_code(spec) == (project, spec)

    def test_the_older_worktree_layout_and_no_spec_copy(self, tmp_path):
        project, spec = _project(tmp_path)
        legacy = project / ".worktrees" / "001-cart"
        legacy.mkdir(parents=True)
        assert api._task_code(spec) == (legacy, spec)

    def test_a_symlinked_worktree_is_not_followed(self, tmp_path):
        project, spec = _project(tmp_path)
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        tasks = project / ".workpilot" / "worktrees" / "tasks"
        tasks.mkdir(parents=True)
        try:
            (tasks / "001-cart").symlink_to(elsewhere, target_is_directory=True)
        except OSError:
            pytest.skip("symlinks are not available here")
        assert api._task_code(spec) == (project, spec)


class TestTheRecordRoute:
    def test_an_unreadable_record_is_an_internal_error(
        self, tmp_path, client, monkeypatch
    ):
        project, _ = _project(tmp_path)

        def unreadable(spec_dir):
            raise OSError("denied")

        monkeypatch.setattr(api, "_latest", unreadable)
        answer = client.get(
            "/api/red-team/",
            params={"project_dir": str(project), "spec_id": "001-cart"},
        ).json()
        assert answer == {"success": False, "error": "An internal error has occurred."}

    def test_without_an_address_it_says_so(self, client):
        answer = client.get("/api/red-team/").json()
        assert answer["success"] is False and answer["reason"] == "addressing"


class TestTheBaseAndTheFiles:
    def test_what_the_task_changed_since_its_branch_left_the_base(self, tmp_path):
        repo = tmp_path / "repo"
        repo.mkdir()
        _git(repo, "init", "-q", "-b", "main")
        (repo / "shop.py").write_text("x = 1\n", encoding="utf-8")
        (repo / "kept.py").write_text("y = 1\n", encoding="utf-8")
        _git(repo, "add", "shop.py", "kept.py")
        _git(repo, "commit", "-q", "-m", "base")
        base = _git(repo, "rev-parse", "HEAD")
        _git(repo, "checkout", "-q", "-b", "task")
        (repo / "shop.py").write_text("x = 2\n", encoding="utf-8")
        _git(repo, "commit", "-q", "-am", "task")
        (repo / "new.py").write_text("z = 1\n", encoding="utf-8")
        spec = tmp_path / "spec"
        spec.mkdir()
        (spec / "task_metadata.json").write_text(
            json.dumps({"baseBranch": "main"}), encoding="utf-8"
        )
        assert api._base_and_files(spec, repo) == (base, ["new.py", "shop.py"])

    def test_a_base_branch_that_is_not_there(self, tmp_path):
        repo = tmp_path / "repo"
        repo.mkdir()
        _git(repo, "init", "-q", "-b", "main")
        (repo / "a.py").write_text("a = 1\n", encoding="utf-8")
        spec = tmp_path / "spec"
        spec.mkdir()
        (spec / "task_metadata.json").write_text(
            json.dumps({"baseBranch": "gone"}), encoding="utf-8"
        )
        assert api._base_and_files(spec, repo) == ("gone", ["a.py"])


class TestTheRunRoute:
    def test_a_bad_address_is_refused(self, client):
        answer = client.post("/api/red-team/run", json={"spec_id": "x"}).json()
        assert answer["success"] is False and answer["reason"] == "addressing"

    def test_a_spec_outside_a_project_is_refused(self, tmp_path, client):
        answer = client.post("/api/red-team/run", json={"spec_dir": str(tmp_path)})
        assert answer.json() == {
            "success": False,
            "error": "the spec is not inside a project",
        }

    def test_a_fresh_attack_is_recorded_without_its_files(
        self, tmp_path, client, monkeypatch
    ):
        import phase_config

        project, spec = _project(tmp_path)
        seen = {}

        async def attack(code_dir, base, files, *, session, previous):
            seen.update(code_dir=code_dir, base=base, files=files, previous=previous)
            seen["session"] = session
            return _crashed(files={"tests/test_shop_red_team.py": "source"})

        monkeypatch.setattr(phase_config, "get_phase_model", lambda s, p, c: "qa-model")
        monkeypatch.setattr(api, "_base_and_files", lambda s, c: ("abc", ["shop.py"]))

        def make_session(spec_dir, model):
            seen["model"] = model
            return "session"

        monkeypatch.setattr(api, "make_session", make_session)
        monkeypatch.setattr(api, "run_red_team", attack)
        answer = client.post(
            "/api/red-team/run",
            json={"project_dir": str(project), "spec_id": "001-cart"},
        ).json()
        assert answer["success"] is True
        assert answer["record"]["attack_files"] == ["tests/test_shop_red_team.py"]
        assert "files" not in answer["record"]
        assert seen["model"] == "qa-model" and seen["session"] == "session"
        assert seen["previous"] is None
        assert (seen["code_dir"], seen["base"], seen["files"]) == (
            project,
            "abc",
            ["shop.py"],
        )
        assert load_record(spec)["files"] == {"tests/test_shop_red_team.py": "source"}

    def test_a_failed_attack_is_an_internal_error(self, tmp_path, client, monkeypatch):
        project, spec = _project(tmp_path)

        def broken(spec_dir, code_dir):
            raise RuntimeError("git is gone")

        monkeypatch.setattr(api, "_base_and_files", broken)
        answer = client.post(
            "/api/red-team/run",
            json={"project_dir": str(project), "spec_id": "001-cart"},
        ).json()
        assert answer == {"success": False, "error": "An internal error has occurred."}
        assert load_record(spec) is None
