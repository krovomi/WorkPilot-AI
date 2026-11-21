"""The governance sections of workpilot.policy.yaml (#353, lot 2): hours, files, budget.

What these tests keep away: a typo in a section that turns a limit off without
a word (every key is checked, every number bounded, and an invalid section
refuses everything); a schedule judged in the machine's time zone instead of
the one the file names; a schedule in the layer the app rewrites, or in the
worktree the agent can edit.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
import yaml
from security import guardrail_ledger as ledger
from security import policy_audit
from security.governance_policy import (
    MAX_GLOBS,
    MAX_WINDOWS,
    Governance,
    Window,
    parse_governance,
    schedule_refusal,
)
from security.guardrail_policy import load_policy
from security.guardrails import GuardrailAction, guardrails_hook


@pytest.fixture(autouse=True)
def _no_global_policy(monkeypatch, tmp_path_factory):
    monkeypatch.setenv(
        "WORKPILOT_GUARDRAILS_GLOBAL",
        str(tmp_path_factory.mktemp("home") / "none.yaml"),
    )


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    root.mkdir()
    return root


def _repo_policy(project: Path, doc: dict) -> None:
    (project / "workpilot.policy.yaml").write_text(
        yaml.safe_dump(doc), encoding="utf-8"
    )


def _parse(doc: dict) -> tuple[Governance, list[str]]:
    return parse_governance(doc, "workpilot.policy.yaml", source="repository:x")


def _closed_window(now: datetime | None = None) -> str:
    """A UTC window that starts two hours after now: closed right now."""
    moment = now or datetime.now(UTC)
    minute = moment.hour * 60 + moment.minute
    start, end = (minute + 120) % 1440, (minute + 180) % 1440
    return f"{start // 60:02d}:{start % 60:02d}-{end // 60:02d}:{end % 60:02d}"


def _hook(project: Path, tool: str, tool_input: dict, root: Path | None = None) -> dict:
    return asyncio.run(
        guardrails_hook(
            {"tool_name": tool, "tool_input": tool_input},
            project_root=root or project,
        )
    )


def _denied(verdict: dict) -> bool:
    return verdict.get("hookSpecificOutput", {}).get("permissionDecision") == "deny"


# A Monday, 10:00 in Paris (08:00 UTC, summer time).
MONDAY_10_PARIS = datetime(2026, 6, 1, 8, 0, tzinfo=UTC)


class TestParsing:
    def test_a_full_policy_is_read(self):
        gov, errors = _parse(
            {
                "schedule": {
                    "timezone": "Europe/Paris",
                    "allowed_hours": ["08:00-19:00", "22:00-06:00"],
                    "days": ["mon", "Tuesday", "fri"],
                },
                "files": {
                    "forbidden": ["**/migrations/**", "./.env*", "infra\\secret.tf"],
                    "requires_review": [".github/workflows/**"],
                },
                "budget": {"max_tokens_per_hour": 500_000},
            }
        )
        assert errors == []
        assert gov.timezone == "Europe/Paris"
        assert [w.label() for w in gov.windows] == ["08:00-19:00", "22:00-06:00"]
        assert gov.days == (0, 1, 4)
        assert gov.forbidden == ["**/migrations/**", ".env*", "infra/secret.tf"]
        assert gov.requires_review == [".github/workflows/**"]
        assert gov.max_tokens_per_hour == 500_000
        assert gov.active and gov.has_schedule

    def test_the_task_budget_and_the_loop_limit_are_read(self):
        gov, errors = _parse(
            {
                "budget": {"max_tokens_per_task": 2_000_000},
                "loop_detection": {"max_same_tool_call": 3},
            }
        )
        assert errors == []
        assert gov.max_tokens_per_task == 2_000_000
        assert gov.max_same_tool_call == 3
        assert gov.active
        shown = gov.to_dict()
        assert shown["budget"] == {
            "maxTokensPerHour": None,
            "maxTokensPerTask": 2_000_000,
        }
        assert shown["loopDetection"] == {"maxSameToolCall": 3}

    def test_the_loop_limit_alone_is_a_policy(self):
        gov, errors = _parse({"loop_detection": {"max_same_tool_call": 2}})
        assert errors == [] and gov.active
        assert gov.to_dict()["budget"] is None

    def test_nothing_set_is_no_limit(self):
        gov, errors = _parse({})
        assert errors == []
        assert not gov.active and not gov.has_schedule
        assert gov.is_open()
        assert gov.to_dict()["schedule"] is None
        assert gov.to_dict()["budget"] is None
        assert gov.to_dict()["loopDetection"] is None

    @pytest.mark.parametrize(
        ("doc", "expected"),
        [
            ({"schedule": "always"}, "'schedule' must be a mapping"),
            ({"files": ["a"]}, "'files' must be a mapping"),
            (
                {
                    "schedule": {
                        "timezone": "UTC",
                        "allowed_hours": ["08:00-09:00"],
                        "hour": 1,
                    }
                },
                "unknown key 'schedule.hour'",
            ),
            ({"files": {"forbiden": ["a"]}}, "unknown key 'files.forbiden'"),
            (
                {"budget": {"max_cost_per_day": 5}},
                "unknown key 'budget.max_cost_per_day'",
            ),
            (
                {"schedule": {"allowed_hours": ["08:00-09:00"]}},
                "'schedule.timezone' is required",
            ),
            (
                {"schedule": {"timezone": "  ", "allowed_hours": ["08:00-09:00"]}},
                "is required",
            ),
            (
                {"schedule": {"timezone": 2, "allowed_hours": ["08:00-09:00"]}},
                "is required",
            ),
            (
                {
                    "schedule": {
                        "timezone": "Paris time",
                        "allowed_hours": ["08:00-09:00"],
                    }
                },
                "is not a time zone name",
            ),
            (
                {"schedule": {"timezone": "x" * 70, "allowed_hours": ["08:00-09:00"]}},
                "is not a time zone name",
            ),
            (
                {
                    "schedule": {
                        "timezone": "Mars/Olympus_Mons",
                        "allowed_hours": ["08:00-09:00"],
                    }
                },
                "unknown on this machine",
            ),
            (
                {
                    "schedule": {
                        "timezone": "UTC+15:00",
                        "allowed_hours": ["08:00-09:00"],
                    }
                },
                "out of range",
            ),
            (
                {
                    "schedule": {
                        "timezone": "UTC+01:75",
                        "allowed_hours": ["08:00-09:00"],
                    }
                },
                "out of range",
            ),
            (
                {"schedule": {"timezone": "UTC"}},
                "'schedule.allowed_hours' must be a list",
            ),
            ({"schedule": {"timezone": "UTC", "allowed_hours": []}}, "must be a list"),
            (
                {
                    "schedule": {
                        "timezone": "UTC",
                        "allowed_hours": ["00:00-01:00"] * (MAX_WINDOWS + 1),
                    }
                },
                f"at most {MAX_WINDOWS} windows",
            ),
            (
                {"schedule": {"timezone": "UTC", "allowed_hours": ["8h-19h"]}},
                "is not an 'HH:MM-HH:MM' window",
            ),
            (
                {"schedule": {"timezone": "UTC", "allowed_hours": [800]}},
                "is not an 'HH:MM-HH:MM' window",
            ),
            (
                {"schedule": {"timezone": "UTC", "allowed_hours": ["24:00-25:00"]}},
                "is not a valid window",
            ),
            (
                {"schedule": {"timezone": "UTC", "allowed_hours": ["08:60-09:00"]}},
                "is not a valid window",
            ),
            (
                {"schedule": {"timezone": "UTC", "allowed_hours": ["08:00-09:61"]}},
                "is not a valid window",
            ),
            (
                {"schedule": {"timezone": "UTC", "allowed_hours": ["08:00-24:01"]}},
                "is not a valid window",
            ),
            (
                {"schedule": {"timezone": "UTC", "allowed_hours": ["08:00-08:00"]}},
                "is not a valid window",
            ),
            (
                {
                    "schedule": {
                        "timezone": "UTC",
                        "allowed_hours": ["08:00-09:00"],
                        "days": "mon",
                    }
                },
                "'schedule.days' must be a list",
            ),
            (
                {
                    "schedule": {
                        "timezone": "UTC",
                        "allowed_hours": ["08:00-09:00"],
                        "days": [],
                    }
                },
                "'schedule.days' must be a list",
            ),
            (
                {
                    "schedule": {
                        "timezone": "UTC",
                        "allowed_hours": ["08:00-09:00"],
                        "days": ["lundi"],
                    }
                },
                "is not a day",
            ),
            (
                {
                    "schedule": {
                        "timezone": "UTC",
                        "allowed_hours": ["08:00-09:00"],
                        "days": [1],
                    }
                },
                "is not a day",
            ),
            (
                {"files": {"forbidden": "**/migrations/**"}},
                "'files.forbidden' must be a list",
            ),
            (
                {"files": {"forbidden": ["a"] * (MAX_GLOBS + 1)}},
                f"at most {MAX_GLOBS} globs",
            ),
            ({"files": {"forbidden": ["/etc/passwd"]}}, "is not a glob relative"),
            ({"files": {"forbidden": ["C:/Windows/**"]}}, "is not a glob relative"),
            ({"files": {"forbidden": ["../outside/**"]}}, "is not a glob relative"),
            ({"files": {"requires_review": ["a/\x00b"]}}, "is not a glob relative"),
            ({"files": {"requires_review": [""]}}, "is not a glob relative"),
            ({"files": {"requires_review": [3]}}, "is not a glob relative"),
            ({"files": {"requires_review": ["a" * 300]}}, "is not a glob relative"),
            ({"budget": {"max_tokens_per_hour": "lots"}}, "must be a whole number"),
            ({"budget": {"max_tokens_per_hour": True}}, "must be a whole number"),
            ({"budget": {"max_tokens_per_hour": 10}}, "must be a whole number"),
            ({"budget": {"max_tokens_per_hour": 10**12}}, "must be a whole number"),
            ({"budget": {"max_tokens_per_task": 999}}, "'budget.max_tokens_per_task'"),
            ({"budget": {"max_tokens_per_task": 10**11}}, "must be a whole number"),
            ({"budget": {"max_tokens_per_day": 5}}, "unknown key 'budget.max_tokens"),
            ({"loop_detection": 5}, "'loop_detection' must be a mapping"),
            (
                {"loop_detection": {"max_same_tool_call": 1}},
                "'loop_detection.max_same_tool_call' must be a whole number from 2 to 100",
            ),
            ({"loop_detection": {"max_same_tool_call": 101}}, "from 2 to 100"),
            ({"loop_detection": {"max_same_tool_call": False}}, "from 2 to 100"),
            ({"loop_detection": {"max_same": 3}}, "unknown key 'loop_detection."),
        ],
    )
    def test_every_mistake_is_named(self, doc: dict, expected: str):
        _gov, errors = _parse(doc)
        assert any(expected in e for e in errors), errors
        assert all(e.startswith("workpilot.policy.yaml: ") for e in errors)

    def test_an_empty_section_is_no_section(self):
        gov, errors = _parse({"schedule": None, "files": {}, "budget": {}})
        assert errors == [] and not gov.active

    @pytest.mark.parametrize(
        ("zone", "offset"),
        [("UTC", 0), ("UTC+02:00", 120), ("UTC-05:30", -330)],
    )
    def test_a_fixed_offset_needs_no_zone_data(self, zone: str, offset: int):
        gov, errors = _parse(
            {"schedule": {"timezone": zone, "allowed_hours": ["09:00-10:00"]}}
        )
        assert errors == []
        local = gov.local(datetime(2026, 6, 1, 12, 0, tzinfo=UTC))
        assert local.utcoffset() == timedelta(minutes=offset)

    def test_the_whole_day_is_a_window(self):
        gov, errors = _parse(
            {"schedule": {"timezone": "UTC", "allowed_hours": ["00:00-24:00"]}}
        )
        assert errors == []
        assert gov.windows == [Window(0, 1440)]
        assert gov.is_open(datetime(2026, 6, 1, 23, 59, tzinfo=UTC))


class TestTheSchedule:
    def _gov(self, hours: list[str], days: list[str] | None = None) -> Governance:
        schedule: dict = {"timezone": "Europe/Paris", "allowed_hours": hours}
        if days is not None:
            schedule["days"] = days
        gov, errors = _parse({"schedule": schedule})
        assert errors == []
        return gov

    def test_it_is_judged_in_the_zone_the_file_names(self):
        gov = self._gov(["09:00-11:00"])
        assert gov.is_open(MONDAY_10_PARIS)  # 10:00 in Paris, 08:00 UTC
        assert not gov.is_open(MONDAY_10_PARIS - timedelta(hours=2))  # 08:00 Paris

    def test_a_time_without_zone_is_utc(self):
        gov = self._gov(["09:00-11:00"])
        assert gov.is_open(MONDAY_10_PARIS.replace(tzinfo=None))

    def test_a_day_off_is_closed(self):
        gov = self._gov(["09:00-11:00"], days=["tue"])
        assert not gov.is_open(MONDAY_10_PARIS)
        assert gov.is_open(MONDAY_10_PARIS + timedelta(days=1))

    def test_an_overnight_window_belongs_to_the_day_it_starts(self):
        gov = self._gov(["22:00-06:00"], days=["mon"])
        monday_23 = MONDAY_10_PARIS + timedelta(hours=13)
        tuesday_03 = MONDAY_10_PARIS + timedelta(hours=17)
        tuesday_07 = MONDAY_10_PARIS + timedelta(hours=21)
        sunday_23 = monday_23 - timedelta(days=1)
        monday_03 = tuesday_03 - timedelta(days=1)
        assert gov.is_open(monday_23)
        assert gov.is_open(tuesday_03)
        assert not gov.is_open(tuesday_07)
        assert not gov.is_open(sunday_23)
        assert not gov.is_open(monday_03)
        assert not gov.is_open(MONDAY_10_PARIS)

    def test_the_refusal_says_where_and_when(self):
        gov = self._gov(["09:00-11:00"], days=["mon", "tue"])
        assert schedule_refusal(gov, MONDAY_10_PARIS) is None
        assert schedule_refusal(None) is None
        reason = schedule_refusal(gov, MONDAY_10_PARIS + timedelta(hours=5))
        assert reason is not None
        assert "09:00-11:00 Europe/Paris" in reason
        assert "mon, tue" in reason
        assert "Mon 15:00" in reason

    def test_the_panel_sees_the_schedule(self):
        report = self._gov(["09:00-11:00"]).to_dict(MONDAY_10_PARIS)
        assert report["schedule"] == {
            "timezone": "Europe/Paris",
            "allowedHours": ["09:00-11:00"],
            "days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            "openNow": True,
            "localTime": "2026-06-01T10:00:00+02:00",
        }


class TestTheFiles:
    def test_they_become_rules(self):
        gov, _ = _parse(
            {
                "files": {
                    "forbidden": ["**/migrations/**"],
                    "requires_review": ["infra/**"],
                }
            }
        )
        rules = {r.id: r for r in gov.file_rules()}
        assert rules["files.forbidden:**/migrations/**"].action == GuardrailAction.DENY
        review = rules["files.requires_review:infra/**"]
        assert review.action == GuardrailAction.REQUIRE_APPROVAL
        assert review.path_glob is not None and review.path_glob.match("infra/main.tf")
        assert review.source == "repository:x"


class TestTheLoader:
    def test_the_repository_policy_carries_the_sections(self, project: Path):
        _repo_policy(
            project,
            {
                "version": 1,
                "schedule": {"timezone": "UTC", "allowed_hours": ["00:00-24:00"]},
                "files": {
                    "forbidden": [".env*", ".env*"],
                    "requires_review": ["infra/**"],
                },
                "budget": {"max_tokens_per_hour": 2000},
            },
        )
        policy = load_policy(project)
        assert policy.errors == []
        assert policy.governance is not None
        assert policy.governance.max_tokens_per_hour == 2000
        assert [r.id for r in policy.rules] == [
            "files.forbidden:.env*",
            "files.requires_review:infra/**",
        ]
        assert policy.sources[0].rules == 2
        assert policy.to_dict()["governance"]["budget"] == {
            "maxTokensPerHour": 2000,
            "maxTokensPerTask": None,
        }

    def test_it_is_read_from_the_main_checkout_not_the_worktree(self, project: Path):
        _repo_policy(project, {"files": {"forbidden": ["secret/**"]}})
        worktree = project / ".workpilot" / "worktrees" / "tasks" / "001-x"
        worktree.mkdir(parents=True)
        # The agent's copy, which it could edit, says nothing.
        (worktree / "workpilot.policy.yaml").write_text("rules: []\n", encoding="utf-8")
        assert _denied(
            _hook(project, "Write", {"file_path": "secret/a", "content": ""}, worktree)
        )

    def test_an_invalid_section_refuses_the_whole_policy(self, project: Path):
        _repo_policy(project, {"budget": {"max_tokens_per_hour": -1}})
        policy = load_policy(project)
        assert policy.governance is None
        assert any("max_tokens_per_hour" in e for e in policy.errors)

    def test_the_sections_belong_to_the_versioned_file_only(self, project: Path):
        folder = project / ".workpilot"
        folder.mkdir()
        (folder / "guardrails.json").write_text(
            json.dumps(
                {"version": 1, "rules": [], "budget": {"max_tokens_per_hour": 5000}}
            ),
            encoding="utf-8",
        )
        policy = load_policy(project)
        assert any("only read from workpilot.policy.yaml" in e for e in policy.errors)

    @pytest.mark.parametrize(
        ("doc", "expected"),
        [
            ({"rules": [], "schedul": {}}, "unknown key 'schedul'"),
            ({"rules": [], "version": 2}, "'version' must be 1"),
            ({"rules": [], "version": True}, "'version' must be 1"),
        ],
    )
    def test_a_typo_at_the_top_is_an_error(
        self, project: Path, doc: dict, expected: str
    ):
        _repo_policy(project, doc)
        assert any(expected in e for e in load_policy(project).errors)


class TestTheHook:
    def test_outside_the_hours_no_write_or_command_runs(self, project: Path):
        _repo_policy(
            project,
            {"schedule": {"timezone": "UTC", "allowed_hours": [_closed_window()]}},
        )
        verdict = _hook(project, "Write", {"file_path": "a.py", "content": ""})
        assert _denied(verdict)
        assert (
            "Outside the hours"
            in verdict["hookSpecificOutput"]["permissionDecisionReason"]
        )
        assert _denied(_hook(project, "Bash", {"command": "ls"}))
        assert _hook(project, "Read", {"file_path": "a.py"}) == {}
        decisions = [e["decision"] for e in policy_audit.read_events(project)]
        assert decisions == ["outside_hours", "outside_hours"]

    def test_inside_the_hours_without_rules_nothing_is_refused(self, project: Path):
        _repo_policy(
            project, {"schedule": {"timezone": "UTC", "allowed_hours": ["00:00-24:00"]}}
        )
        assert _hook(project, "Write", {"file_path": "a.py", "content": ""}) == {}

    def test_an_invalid_policy_is_refused_and_recorded(self, project: Path):
        _repo_policy(project, {"budget": {"max_tokens_per_hour": "x"}})
        assert _denied(_hook(project, "Edit", {"file_path": "a.py"}))
        assert _hook(project, "Read", {"file_path": "a.py"}) == {}
        [event] = policy_audit.read_events(project)
        assert event["decision"] == "invalid_policy"
        assert "max_tokens_per_hour" in event["reason"]

    def test_a_forbidden_file_is_refused_and_recorded(self, project: Path):
        _repo_policy(project, {"files": {"forbidden": ["**/migrations/**"]}})
        worktree = project / ".workpilot" / "worktrees" / "tasks" / "007-db"
        worktree.mkdir(parents=True)
        verdict = _hook(
            project,
            "Write",
            {"file_path": str(worktree / "db" / "migrations" / "1.sql"), "content": ""},
            worktree,
        )
        assert _denied(verdict)
        [event] = policy_audit.read_events(project)
        assert event["decision"] == "deny"
        assert event["rules"] == ["files.forbidden:**/migrations/**"]
        assert event["target"] == "db/migrations/1.sql"
        assert event["targetKind"] == "file"
        assert event["task"] == "007-db"
        assert event["tool"] == "Write"

    def test_a_file_under_review_waits_then_goes_through_once(self, project: Path):
        _repo_policy(project, {"files": {"requires_review": ["infra/**"]}})
        call = {"file_path": "infra/main.tf", "content": "x"}
        assert _denied(_hook(project, "Write", call))
        [request] = ledger.activity(project)["pending"]
        ledger.answer(project, request["id"], approved=True)
        assert _hook(project, "Write", call) == {}
        assert [e["decision"] for e in policy_audit.read_events(project)] == [
            "approved",
            "review",
        ]

    def test_a_warning_is_recorded_too(self, project: Path):
        _repo_policy(
            project,
            {"rules": [{"id": "w", "action": "warn", "when": {"path_prefix": "src/"}}]},
        )
        assert _hook(project, "Write", {"file_path": "src/a.py", "content": ""}) == {}
        [event] = policy_audit.read_events(project)
        assert event["decision"] == "warn" and event["rules"] == ["w"]


class TestTheRunner:
    def _run(self, monkeypatch, capsys, *args: str) -> dict:
        from runners import guardrails_runner

        monkeypatch.setattr("sys.argv", ["guardrails_runner.py", *args])
        guardrails_runner.main()
        line = next(
            ln
            for ln in capsys.readouterr().out.splitlines()
            if ln.startswith("GUARDRAILS_")
        )
        return json.loads(line.partition(":")[2])

    def test_the_panel_reads_the_policy_its_state_and_its_decisions(
        self, project: Path, monkeypatch, capsys
    ):
        _repo_policy(
            project,
            {
                "schedule": {"timezone": "UTC", "allowed_hours": ["00:00-24:00"]},
                "files": {"forbidden": ["secret/**"]},
                "budget": {"max_tokens_per_hour": 5000},
            },
        )
        _hook(project, "Write", {"file_path": "secret/a", "content": ""})
        report = self._run(
            monkeypatch, capsys, "governance", "--project-path", str(project)
        )
        assert report["governance"]["schedule"]["openNow"] is True
        assert report["governance"]["files"]["forbidden"] == ["secret/**"]
        assert report["errors"] == []
        assert [s["layer"] for s in report["sources"]] == ["repository"]
        assert report["tokensLastHour"] == 0
        assert [e["decision"] for e in report["events"]] == ["deny"]
        assert report["metrics"] == {"blocked24h": 1, "breakerTrips7d": 0}

    def test_without_a_policy_the_panel_says_so(
        self, project: Path, monkeypatch, capsys
    ):
        report = self._run(
            monkeypatch, capsys, "governance", "--project-path", str(project)
        )
        assert report["governance"] is None and report["events"] == []

    def test_the_export_reads_the_whole_trail(self, project: Path, monkeypatch, capsys):
        for decision in ("deny", "review", "warn"):
            policy_audit.record(project, decision=decision)
        report = self._run(
            monkeypatch, capsys, "audit", "--project-path", str(project), "--limit", "2"
        )
        assert [e["decision"] for e in report["events"]] == ["warn", "review"]


def test_files_reviewers_name_server_roles_and_nothing_else():
    """``files.reviewers`` (lot 4): role names only, checked like every key."""
    governance, errors = parse_governance(
        {
            "files": {
                "requires_review": ["infra/**"],
                "reviewers": ["security", "security", "lead_2"],
            }
        },
        "p",
    )
    assert errors == []
    assert governance.reviewers == ["security", "lead_2"]
    assert governance.to_dict()["files"]["reviewers"] == ["security", "lead_2"]

    _, errors = parse_governance({"files": {"reviewers": "security"}}, "p")
    assert errors == ["p: 'files.reviewers' must be a list of at most 20 role names"]
    _, errors = parse_governance({"files": {"reviewers": ["x"] * 21}}, "p")
    assert len(errors) == 1
    _, errors = parse_governance({"files": {"reviewers": ["Admin", "../x", 3]}}, "p")
    assert len(errors) == 3
    assert "is not a role name" in errors[0]
