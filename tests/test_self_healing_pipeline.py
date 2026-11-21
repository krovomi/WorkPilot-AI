"""The healing pipeline files the fix as a card on the board, and claims nothing else.

The placeholder pipeline (audit F48) named fix, QA and PR steps it never ran.
The fix is now a backlog card whose build plans, codes and runs QA in a
worktree, then waits for a person's review: the incident is `fixing` once the
card is filed, and follows the card's column up to its pull request.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from board_mcp.server import MAX_DESCRIPTION
from self_healing.incident_responder import fix_card
from self_healing.incident_responder.models import (
    HealingStatus,
    Incident,
    IncidentMode,
    IncidentSource,
)
from self_healing.incident_responder.orchestrator import (
    APP_FAILS,
    CARD_FILED,
    CARD_STILL_OPEN,
    FILE_CARD_STEP,
    NEEDS_A_PERSON,
    IncidentResponderOrchestrator,
)

VERIFY_STEP = "Verifying the app runs"

#: The steps whose work the pipeline performs.
STEPS_THAT_RUN = {
    "Analyzing incident",
    VERIFY_STEP,
    FILE_CARD_STEP,
    "Filing what hermes learned",
}


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    """No hermes home, no brain: the cycle finds nothing and files nothing."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "no-hermes"))
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(tmp_path / "no-brain"))


@pytest.fixture
def app_verdict(monkeypatch):
    """The verification loop's verdict, without launching anything."""
    import verify.loop

    verdict = {"status": "pass", "score": 92}

    async def fake_run_verify_loop(*_args, **_kwargs):
        return dict(verdict)

    monkeypatch.setattr(verify.loop, "run_verify_loop", fake_run_verify_loop)
    return verdict


def _orchestrator(
    project: Path, monkeypatch, **kwargs
) -> IncidentResponderOrchestrator:
    orch = IncidentResponderOrchestrator(project, **kwargs)
    monkeypatch.setattr(orch.cicd, "_get_commit_diff", lambda sha: "diff of " + sha)
    return orch


def _steps(operation) -> dict[str, tuple[str, str | None]]:
    return {s.name: (s.status, s.detail) for s in operation.steps}


def _cards(project: Path) -> list[Path]:
    specs = project / ".workpilot" / "specs"
    return sorted(p for p in specs.iterdir() if p.is_dir()) if specs.is_dir() else []


def _read(card: Path, name: str) -> dict:
    return json.loads((card / name).read_text(encoding="utf-8"))


def _move(card: Path, status: str, pr_url: str | None = None) -> None:
    """What a build writes as the card moves: its plan's status, its PR."""
    plan = _read(card, "implementation_plan.json")
    plan["status"] = status
    (card / "implementation_plan.json").write_text(json.dumps(plan), encoding="utf-8")
    if pr_url is not None:
        meta = _read(card, "task_metadata.json")
        meta["prUrl"] = pr_url
        (card / "task_metadata.json").write_text(json.dumps(meta), encoding="utf-8")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    root.mkdir()
    return root


async def _cicd(orch: IncidentResponderOrchestrator):
    return await orch.handle_cicd_failure(
        commit_sha="abc1234def",
        branch="main",
        test_output="FAILED tests/test_x.py::test_y - AssertionError",
    )


class TestTheFixIsACard:
    async def test_a_cicd_failure_files_a_backlog_card(
        self, project, monkeypatch, app_verdict
    ):
        orch = _orchestrator(project, monkeypatch)

        operation = await _cicd(orch)

        (card,) = _cards(project)
        incident = operation.incident
        assert incident.fix_card == card.name
        assert _steps(operation)[FILE_CARD_STEP] == (
            "completed",
            CARD_FILED.format(card=card.name),
        )
        assert operation.success is True
        assert incident.status == HealingStatus.FIXING
        assert incident.error_message is None
        # Nothing was fixed yet: no branch, no PR, nothing resolved.
        assert incident.fix_branch is None
        assert incident.fix_pr_url is None
        assert incident.resolved_at is None

        meta = _read(card, "task_metadata.json")
        assert meta["sourceType"] == "self-healing"
        assert meta["selfHealing"] == {"incidentId": incident.id, "mode": "cicd"}
        assert (meta["kind"], meta["kindSource"]) == ("bug_fix", "user")
        assert _read(card, "implementation_plan.json")["status"] == "pending"
        assert card.name.split("-", 1)[1].startswith("fix-")

    async def test_the_card_carries_the_analysis(
        self, project, monkeypatch, app_verdict
    ):
        orch = _orchestrator(project, monkeypatch)

        operation = await _cicd(orch)

        (card,) = _cards(project)
        body = _read(card, "requirements.json")["task_description"]
        assert body.startswith(fix_card._INTRO[IncidentMode.CICD])
        assert f"Filed by Self-Healing for incident {operation.incident.id}." in body
        # The analysis prompt: the commit, the diff and the failing test.
        assert "abc1234def" in body
        assert "diff of abc1234def" in body
        assert "tests/test_x.py::test_y" in body
        assert _read(card, "implementation_plan.json")["description"] == body

    @pytest.mark.parametrize(
        ("mode", "kind"),
        [
            (IncidentMode.CICD, "bug_fix"),
            (IncidentMode.PRODUCTION, "bug_fix"),
            (IncidentMode.PROACTIVE, "test"),
        ],
    )
    async def test_each_mode_files_a_card_of_its_kind(
        self, project, monkeypatch, app_verdict, mode, kind
    ):
        orch = _orchestrator(project, monkeypatch)
        incident = Incident(
            mode=mode,
            source=IncidentSource.SENTRY,
            title=f"{mode.value} incident",
            source_data={"error_type": "TypeError", "file_path": "app.py"},
        )
        orch._incidents.append(incident)

        operation = await orch.trigger_fix(incident.id)

        (card,) = _cards(project)
        meta = _read(card, "task_metadata.json")
        assert meta["kind"] == kind
        assert meta["selfHealing"]["mode"] == mode.value
        body = _read(card, "requirements.json")["task_description"]
        assert body.startswith(fix_card._INTRO[mode])
        completed = {s.name for s in operation.steps if s.status == "completed"}
        assert completed <= STEPS_THAT_RUN
        details = " ".join(s.detail or "" for s in operation.steps)
        assert "QA validation passed" not in details
        assert "PR created" not in details

    async def test_an_app_that_does_not_start_is_told_to_the_card(
        self, project, monkeypatch, app_verdict
    ):
        app_verdict.update(status="fail", reason="exit code 1 at startup")
        orch = _orchestrator(project, monkeypatch)

        operation = await _cicd(orch)

        steps = _steps(operation)
        assert steps[VERIFY_STEP] == ("failed", "exit code 1 at startup")
        assert steps[FILE_CARD_STEP][0] == "completed"
        (card,) = _cards(project)
        body = _read(card, "requirements.json")["task_description"]
        assert body.endswith(APP_FAILS)
        assert operation.incident.status == HealingStatus.FIXING

    async def test_one_card_per_incident_while_it_is_on_the_board(
        self, project, monkeypatch, app_verdict
    ):
        orch = _orchestrator(project, monkeypatch)
        first = await _cicd(orch)
        incident = first.incident
        incident.status = HealingStatus.FAILED  # what "Retry" is offered on

        again = await orch.retry_incident(incident.id)

        (card,) = _cards(project)
        assert _steps(again)[FILE_CARD_STEP] == (
            "skipped",
            CARD_STILL_OPEN.format(card=card.name),
        )
        assert again.success is False
        # The incident reads its card again: back in the backlog, fixing.
        assert incident.status == HealingStatus.FIXING
        assert incident.fix_card == card.name

    async def test_a_card_taken_off_the_board_can_be_filed_again(
        self, project, monkeypatch, app_verdict
    ):
        orch = _orchestrator(project, monkeypatch)
        incident = (await _cicd(orch)).incident
        (gone,) = _cards(project)
        for path in gone.iterdir():
            path.unlink()
        gone.rmdir()
        orch.refresh_from_board()
        assert incident.status == HealingStatus.ESCALATED

        operation = await orch.trigger_fix(incident.id)

        # A new card, whose number the board may give again.
        (card,) = _cards(project)
        assert incident.fix_card == card.name
        assert operation.success is True
        assert incident.status == HealingStatus.FIXING

    async def test_a_card_that_cannot_be_written_fails_the_incident(
        self, project, monkeypatch, app_verdict
    ):
        def refuse(*_args):
            raise ValueError("another card is being numbered; try again")

        monkeypatch.setattr(fix_card, "file_card", refuse)
        orch = _orchestrator(project, monkeypatch)

        operation = await _cicd(orch)

        assert operation.success is False
        assert operation.incident.status == HealingStatus.FAILED
        assert operation.incident.error_message == (
            "another card is being numbered; try again"
        )
        assert operation.incident.fix_card is None
        assert _cards(project) == []

    async def test_hermes_still_observes_the_incident(
        self, project, monkeypatch, app_verdict
    ):
        orch = _orchestrator(project, monkeypatch)
        observed = []
        monkeypatch.setattr(orch, "_observe_with_hermes", observed.append)

        operation = await _cicd(orch)

        assert observed == [operation]


class TestWhenACardIsFiledOnItsOwn:
    async def test_cicd_auto_fix_off_files_nothing(
        self, project, monkeypatch, app_verdict
    ):
        orch = _orchestrator(project, monkeypatch, auto_fix=False)

        operation = await _cicd(orch)

        assert _cards(project) == []
        assert operation.incident.status == HealingStatus.PENDING

    @pytest.mark.parametrize("auto_fix_production", [False, True])
    async def test_production_follows_its_own_setting(
        self, project, monkeypatch, app_verdict, auto_fix_production
    ):
        # The CI/CD setting is on: production does not read it.
        orch = _orchestrator(
            project, monkeypatch, auto_fix_production=auto_fix_production
        )

        operation = await orch.handle_production_incident(
            IncidentSource.SENTRY,
            {"error_type": "TypeError", "error_message": "x is undefined"},
        )

        assert len(_cards(project)) == (1 if auto_fix_production else 0)
        assert (operation.incident.fix_card is not None) is auto_fix_production


class TestTheIncidentFollowsItsCard:
    async def _filed(self, project, monkeypatch):
        orch = _orchestrator(project, monkeypatch)
        incident = (await _cicd(orch)).incident
        (card,) = _cards(project)
        return orch, incident, card

    @pytest.mark.parametrize(
        ("status", "expected"),
        [
            ("queue", HealingStatus.FIXING),
            ("coding", HealingStatus.FIXING),
            ("ai_review", HealingStatus.QA_RUNNING),
            ("human_review", HealingStatus.QA_RUNNING),
            ("pr_created", HealingStatus.PR_CREATED),
        ],
    )
    async def test_the_dashboard_reads_the_card_s_column(
        self, project, monkeypatch, app_verdict, status, expected
    ):
        orch, incident, card = await self._filed(project, monkeypatch)
        _move(card, status)

        data = orch.get_dashboard_data()

        (shown,) = data["incidents"]
        assert shown["status"] == expected.value
        assert shown["fix_card"] == card.name
        stored = json.loads(
            (project / ".workpilot" / "self-healing" / "incidents.json").read_text(
                encoding="utf-8"
            )
        )
        assert stored[0]["status"] == expected.value

    async def test_a_pull_request_is_linked_and_counted(
        self, project, monkeypatch, app_verdict
    ):
        orch, incident, card = await self._filed(project, monkeypatch)
        assert orch.get_stats().auto_fix_rate == 0.0
        _move(card, "human_review", "https://github.com/o/r/pull/7")

        assert orch.refresh_from_board() is True

        assert incident.status == HealingStatus.PR_CREATED
        assert incident.fix_pr_url == "https://github.com/o/r/pull/7"
        assert orch.get_stats().auto_fix_rate == 100.0
        # Nothing moved since: nothing to save.
        assert orch.refresh_from_board() is False

    @pytest.mark.parametrize(
        "url", ["http://github.com/o/r/pull/7", "javascript:alert(1)", "https://"]
    )
    async def test_a_pull_request_link_that_is_not_https_is_not_kept(
        self, project, monkeypatch, app_verdict, url
    ):
        orch, incident, card = await self._filed(project, monkeypatch)
        _move(card, "human_review", url)

        orch.refresh_from_board()

        assert incident.fix_pr_url is None
        assert incident.status == HealingStatus.QA_RUNNING

    async def test_a_card_done_resolves_the_incident_once(
        self, project, monkeypatch, app_verdict
    ):
        orch, incident, card = await self._filed(project, monkeypatch)
        incident.created_at = "2026-11-01T10:00:00"
        _move(card, "done")

        orch.refresh_from_board()

        assert incident.status == HealingStatus.RESOLVED
        assert incident.resolved_at
        stats = orch.get_stats()
        assert stats.resolved_incidents == 1
        assert stats.avg_resolution_time > 0
        # A resolved incident is no longer read from its card.
        _move(card, "build_failed")
        assert orch.refresh_from_board() is False
        assert incident.status == HealingStatus.RESOLVED

    async def test_a_card_done_with_its_pull_request_keeps_both(
        self, project, monkeypatch, app_verdict
    ):
        orch, incident, card = await self._filed(project, monkeypatch)
        _move(card, "done", "https://github.com/o/r/pull/7")

        orch.refresh_from_board()

        assert incident.status == HealingStatus.RESOLVED
        assert incident.fix_pr_url == "https://github.com/o/r/pull/7"

    async def test_a_failed_build_fails_the_incident_until_restarted(
        self, project, monkeypatch, app_verdict
    ):
        orch, incident, card = await self._filed(project, monkeypatch)
        _move(card, "build_failed")

        orch.refresh_from_board()

        assert incident.status == HealingStatus.FAILED
        assert incident.error_message == fix_card.CARD_FAILED
        _move(card, "in_progress")
        orch.refresh_from_board()
        assert incident.status == HealingStatus.FIXING
        assert incident.error_message is None

    async def test_a_card_gone_sends_the_incident_to_a_person(
        self, project, monkeypatch, app_verdict
    ):
        orch, incident, card = await self._filed(project, monkeypatch)
        for path in card.iterdir():
            path.unlink()
        card.rmdir()

        orch.refresh_from_board()

        assert incident.status == HealingStatus.ESCALATED
        assert incident.error_message == fix_card.CARD_GONE

    async def test_a_dismissed_incident_is_left_as_the_person_left_it(
        self, project, monkeypatch, app_verdict
    ):
        orch, incident, card = await self._filed(project, monkeypatch)
        orch.dismiss_incident(incident.id)
        _move(card, "pr_created", "https://github.com/o/r/pull/7")

        assert orch.refresh_from_board() is False

        assert incident.status == HealingStatus.RESOLVED
        assert incident.fix_pr_url is None

    def test_an_incident_without_a_card_is_not_read(self, project):
        orch = IncidentResponderOrchestrator(project)
        incident = Incident(status=HealingStatus.ESCALATED, error_message="why")
        orch._incidents.append(incident)

        assert orch.refresh_from_board() is False
        assert incident.error_message == "why"

    def test_a_card_id_that_is_not_the_board_s_reads_as_gone(self, project):
        orch = IncidentResponderOrchestrator(project)
        incident = Incident(status=HealingStatus.FIXING, fix_card="../../etc")
        orch._incidents.append(incident)

        orch.refresh_from_board()

        assert incident.status == HealingStatus.ESCALATED


class TestTheCard:
    def test_a_long_analysis_is_cut_and_says_so(self):
        incident = Incident(title="t")

        body = fix_card.card_body(
            incident, "x" * (MAX_DESCRIPTION * 2), MAX_DESCRIPTION
        )

        assert len(body) == MAX_DESCRIPTION
        assert body.endswith(fix_card.CUT)

    def test_a_short_analysis_is_whole(self):
        body = fix_card.card_body(Incident(title="t"), "analysis", MAX_DESCRIPTION)

        assert body.endswith("\n\nanalysis")

    def test_the_title_is_one_line(self):
        incident = Incident(title="Tests  broke\non main\t" + "x" * 300)

        title = fix_card.card_title(incident)

        assert title.startswith("Fix: Tests broke on main x")
        assert len(title) == 200

    @pytest.mark.parametrize("metadata", [None, "[1, 2]", "{not json"])
    def test_a_card_that_does_not_read_has_no_pr(self, project, metadata):
        directory = project / ".workpilot" / "specs" / "001-fix-x"
        directory.mkdir(parents=True)
        if metadata is not None:
            (directory / "task_metadata.json").write_text(metadata, encoding="utf-8")

        state = fix_card.card_state(project, "001-fix-x")

        assert state == fix_card.CardState("backlog", "")


class TestIncidentsStoredBeforeTheFixCards:
    """The placeholder's "healed" incidents are on users' disks already."""

    def _store(self, project: Path, incidents: list[Incident]) -> None:
        data_dir = project / ".workpilot" / "self-healing"
        data_dir.mkdir(parents=True)
        (data_dir / "incidents.json").write_text(
            json.dumps([i.to_dict() for i in incidents]), encoding="utf-8"
        )

    def _claimed(self, status: HealingStatus) -> Incident:
        incident = Incident(title="claimed", status=status, resolved_at="2026-10-01")
        incident.fix_branch = f"self-healing/{incident.id}"
        return incident

    @pytest.mark.parametrize(
        "status", [HealingStatus.PR_CREATED, HealingStatus.QA_RUNNING]
    )
    def test_a_claimed_heal_is_reopened(self, project, status):
        claimed = self._claimed(status)
        self._store(project, [claimed])

        (incident,) = IncidentResponderOrchestrator(project).get_incidents()

        assert incident.status == HealingStatus.ESCALATED
        assert incident.resolved_at is None
        assert incident.fix_branch is None
        assert incident.error_message == NEEDS_A_PERSON

    @pytest.mark.parametrize("status", [HealingStatus.RESOLVED, HealingStatus.FAILED])
    def test_a_person_s_or_a_failure_s_verdict_stays(self, project, status):
        self._store(project, [self._claimed(status)])

        (incident,) = IncidentResponderOrchestrator(project).get_incidents()

        assert incident.status == status
        assert incident.fix_branch is None

    def test_a_real_pr_is_left_alone(self, project):
        incident = self._claimed(HealingStatus.PR_CREATED)
        incident.fix_pr_url = "https://example.invalid/pr/1"
        self._store(project, [incident])

        (loaded,) = IncidentResponderOrchestrator(project).get_incidents()

        assert loaded.status == HealingStatus.PR_CREATED
        assert loaded.fix_branch == incident.fix_branch
