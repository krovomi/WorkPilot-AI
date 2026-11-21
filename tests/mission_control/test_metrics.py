"""Mission Control metrics: what sessions did, and the estimates they calibrate.

A session that ran an agent leaves one line when it ends; the lines answer the
issue's four measures (auto-compose share, tokens of auto against manual
sessions, rebalancings per session, budget overruns) and, once a role has
enough history, scale that role's token estimate in the next composition.
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mission_control import api as mc_api
from mission_control import metrics
from mission_control import orchestrator as mc_orchestrator
from mission_control.agent_slot import AgentRole, AgentSlot
from mission_control.composition import suggest_composition
from mission_control.session_plan import SessionPlan, session_entry
from mission_control.signals import CompositionSignals

BASE = "/api/mission-control"


def _session(origin="auto", **fields) -> dict:
    return {
        "origin": origin,
        "actual_tokens": 1000,
        "estimated_tokens": 500,
        "rebalances": 0,
        **fields,
    }


def _slot(origin="manual", tokens=0, estimated=0, role=AgentRole.CODER) -> AgentSlot:
    slot = AgentSlot(role=role, provider="anthropic", origin=origin)
    slot.estimated_tokens = estimated
    slot.tokens.add(tokens, 0, tokens / 1_000_000)
    return slot


class TestLedger:
    def test_missing_unreadable_or_odd_ledgers_read_empty(self):
        assert metrics.load() == []
        path = metrics.ledger_path()
        path.parent.mkdir(parents=True)
        path.write_text("{not json", encoding="utf-8")
        assert metrics.load() == []
        path.write_text("[]", encoding="utf-8")
        assert metrics.load() == []
        path.write_text(json.dumps({"sessions": "x"}), encoding="utf-8")
        assert metrics.load() == []
        path.write_text(
            json.dumps({"sessions": [{"origin": "server"}, 3, {"origin": "auto"}]}),
            encoding="utf-8",
        )
        assert metrics.load() == [{"origin": "auto"}]

    def test_the_ledger_lives_in_the_data_dir(self, monkeypatch, tmp_path):
        monkeypatch.delenv("WORKPILOT_DATA_DIR")
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("USERPROFILE", str(tmp_path))
        assert metrics.ledger_path() == (
            tmp_path / ".workpilot" / "mission-control" / "metrics.json"
        )

    def test_entries_are_appended_and_capped(self, monkeypatch):
        monkeypatch.setattr(metrics, "MAX_ENTRIES", 2)
        for n in range(3):
            metrics.record_session(_session(rebalances=n))
        kept = metrics.load()
        assert [e["rebalances"] for e in kept] == [1, 2]
        assert all("at" in e for e in kept)

    def test_a_linked_ledger_is_neither_read_nor_written(self, monkeypatch):
        metrics.record_session(_session())
        # A link is refused by its kind, whatever it points at: Windows runners
        # cannot always create one, so the check itself is what is stood in.
        with monkeypatch.context() as linked:
            linked.setattr(metrics.Path, "is_symlink", lambda self: True)
            assert metrics.load() == []
            metrics.record_session(_session(origin="manual"))
        assert [e["origin"] for e in metrics.load()] == ["auto"]

    def test_a_ledger_that_cannot_be_written_does_not_stop_a_session(self, monkeypatch):
        def fail(*_args):
            raise OSError("read-only")

        monkeypatch.setattr(metrics, "update_json", fail)
        metrics.record_session(_session())
        assert metrics.load() == []


class TestSummary:
    def test_nothing_recorded(self):
        assert metrics.summary() == {
            "sessions": 0,
            "auto_share": None,
            "avg_tokens_auto": None,
            "avg_tokens_manual": None,
            "delta_tokens": None,
            "estimate_ratio": None,
            "rebalances_per_session": None,
            "budget_sessions": 0,
            "overrun_rate": None,
        }

    def test_the_four_measures(self):
        sessions = [
            _session("auto", actual_tokens=1200, estimated_tokens=1000, rebalances=2),
            _session("mixed", actual_tokens=800, estimated_tokens=0, budget_usd=1.0),
            _session(
                "manual",
                actual_tokens=2000,
                budget_tokens=10,
                over_budget=True,
                rebalances=1,
            ),
            _session("manual", actual_tokens=1000),
        ]
        assert metrics.summary(sessions) == {
            "sessions": 4,
            "auto_share": 0.5,
            "avg_tokens_auto": 1000.0,
            "avg_tokens_manual": 1500.0,
            "delta_tokens": -500.0,
            "estimate_ratio": 1.2,
            "rebalances_per_session": 0.75,
            "budget_sessions": 2,
            "overrun_rate": 0.5,
        }


class TestRoleFactors:
    def test_a_role_needs_history_and_stays_within_bounds(self):
        rows = [
            {"role": "coder", "estimated": 100, "actual": 150},
            {"role": "reviewer", "estimated": 100, "actual": 900},
            {"role": "tester", "estimated": 100, "actual": 50},
        ]
        sessions = [{"roles": rows} for _ in range(3)]
        sessions.append(
            {"roles": [{"role": "documenter", "estimated": 1, "actual": 1}]}
        )
        sessions.append({"roles": "x"})
        sessions.append({"roles": [3, {"role": "coder", "estimated": 0, "actual": 9}]})
        sessions.append({"roles": [{"role": 7, "estimated": 1, "actual": 1}]})
        assert metrics.role_factors(sessions) == {
            "coder": 1.5,
            "reviewer": 4.0,
            "tester": 0.5,
        }

    def test_read_from_the_ledger(self):
        for _ in range(3):
            metrics.record_session(
                _session(roles=[{"role": "coder", "estimated": 10, "actual": 20}])
            )
        assert metrics.role_factors() == {"coder": 2.0}


class TestSessionEntry:
    def test_a_session_that_spent_nothing_leaves_nothing(self):
        assert session_entry([_slot()], SessionPlan(), 0) is None

    def test_a_mixed_session(self):
        slots = [
            _slot("auto", tokens=300, estimated=200),
            _slot("auto", tokens=0, estimated=100, role=AgentRole.REVIEWER),
            _slot("manual", tokens=700),
        ]
        plan = SessionPlan(budget_usd=0.0005)
        entry = session_entry(slots, plan, 3)
        assert entry == {
            "origin": "mixed",
            "agents": 3,
            "estimated_tokens": 300,
            "actual_tokens": 1000,
            "cost_usd": 0.001,
            "budget_usd": 0.0005,
            "budget_tokens": None,
            "over_budget": True,
            "rebalances": 3,
            "roles": [{"role": "coder", "estimated": 200, "actual": 300}],
        }


@pytest.fixture
def client(monkeypatch) -> TestClient:
    monkeypatch.setattr(mc_orchestrator, "_mission_control", None)
    app = FastAPI()
    app.include_router(mc_api.router)
    return TestClient(app)


def _spend(client: TestClient, **agent) -> None:
    body = {"name": "A", "role": "coder", "provider": "anthropic", **agent}
    created = client.post(f"{BASE}/agents", json=body).json()["agent"]
    client.post(
        f"{BASE}/agents/{created['id']}/update",
        json={"input_tokens": 400, "output_tokens": 100, "cost_usd": 0.01},
    )


class TestSessionsLeaveTheirLine:
    def test_stop_records_once_and_metrics_read_it(self, client):
        client.post(f"{BASE}/session/start", json={})
        _spend(client, origin="auto", estimated_tokens=250)
        client.post(f"{BASE}/session/stop")
        client.post(f"{BASE}/session/stop")

        assert [e["origin"] for e in metrics.load()] == ["auto"]
        summary = client.get(f"{BASE}/metrics").json()["metrics"]
        assert (summary["sessions"], summary["auto_share"]) == (1, 1.0)
        assert summary["estimate_ratio"] == 2.0

    def test_a_new_session_over_an_open_one_records_it(self, client):
        client.post(f"{BASE}/session/start", json={})
        _spend(client)
        client.post(f"{BASE}/session/start", json={})
        assert [e["origin"] for e in metrics.load()] == ["manual"]
        session = client.get(f"{BASE}/session").json()["session"]
        assert (session["rebalance_count"], session["plan"]["providers"]) == (0, [])

    def test_the_composition_is_calibrated_by_the_ledger(self, client):
        for _ in range(3):
            metrics.record_session(
                _session(roles=[{"role": "coder", "estimated": 10, "actual": 20}])
            )
        body = {"prompt": "add a login page with tests", "providers": ["anthropic"]}
        result = client.post(f"{BASE}/composition", json=body).json()["composition"]
        assert result["calibrated"] == ["coder"]


class TestCalibration:
    SIGNALS = CompositionSignals(words=20, kind="feature", kind_confident=True)

    def _coder(self, result) -> dict:
        return next(a for a in result["full"]["agents"] if a["role"] == "coder")

    def test_a_role_factor_scales_its_estimate(self):
        plain = suggest_composition(self.SIGNALS, ["anthropic"])
        scaled = suggest_composition(
            self.SIGNALS, ["anthropic"], calibration={"coder": 2.0, "planner": 3.0}
        )
        assert plain["calibrated"] == []
        assert scaled["calibrated"] == ["coder"]
        assert self._coder(scaled)["input_tokens"] == pytest.approx(
            2 * self._coder(plain)["input_tokens"], abs=2
        )
        assert (
            self._coder(scaled)["output_tokens"]
            == 2 * (self._coder(plain)["output_tokens"])
        )
