"""Live rebalancing: a run that goes wrong gets another provider or a bigger model.

A rate-limited or failing provider hands the work to the next provider of the
session; an agent that fails or loops goes one tier up; never past the limit,
over the budget, or with rebalancing switched off. Every decision is logged.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mission_control import api as mc_api
from mission_control import orchestrator as mc_orchestrator
from mission_control.model_pick import pick
from mission_control.rebalance import (
    LOOP_REPEATS,
    MAX_REBALANCES,
    Rebalance,
    capable,
    detect_loop,
    plan_rebalance,
    reason_of,
    tier_of,
)
from models_registry import tier_pick

BASE = "/api/mission-control"


def _plan(**fields) -> Rebalance:
    base = {
        "role": "coder",
        "provider": "anthropic",
        "model": tier_pick("anthropic", "fast").model_id,
        "reason": "failed",
        "providers": ["anthropic", "openai"],
        "tried": set(),
        "count": 0,
        "over_budget": False,
        "alternate_profile": False,
    }
    return plan_rebalance(**{**base, **fields})


class TestDetectLoop:
    PASSAGE = "The build failed, so I will run the build again.\n"

    def test_a_passage_repeated_at_the_end_is_a_loop(self):
        text = "Let me look at the error first. " + self.PASSAGE * LOOP_REPEATS
        assert detect_loop(text)

    def test_the_last_chunk_may_end_mid_passage(self):
        text = self.PASSAGE * (LOOP_REPEATS + 1) + self.PASSAGE[:17]
        assert detect_loop(text)

    def test_a_ruler_is_layout_not_a_loop(self):
        assert not detect_loop("-" * 4_000)

    def test_ordinary_text_and_short_text_are_not_loops(self):
        prose = " ".join(f"step {i} changes file_{i}.py" for i in range(200))
        assert not detect_loop(prose)
        assert not detect_loop(self.PASSAGE)


class TestReason:
    def test_a_loop_wins(self):
        assert reason_of("429", rate_limited=True, loop=True) == "loop"

    @pytest.mark.parametrize(
        ("error", "flag", "expected"),
        [
            ("", True, "rate_limited"),
            ("HTTP 429 Too Many Requests", False, "rate_limited"),
            ("insufficient_quota", False, "rate_limited"),
            ("401 Unauthorized", False, "provider_failed"),
            ("ConnectionRefusedError", False, "provider_failed"),
            ("model_not_found", False, "provider_failed"),
            ("No response from the provider", False, "failed"),
        ],
    )
    def test_the_error_is_classified_on_a_closed_list(self, error, flag, expected):
        assert reason_of(error, rate_limited=flag, loop=False) == expected


class TestTierAndCapability:
    def test_tier_of_a_model(self):
        fast = tier_pick("anthropic", "fast").model_id
        assert tier_of("anthropic", fast, "coder") == "fast"
        assert tier_of("ollama", "anything", "coder") == "local"
        assert tier_of("anthropic", "unknown-model", "tester") == "fast"
        assert tier_of("anthropic", "unknown-model", "nobody") == "standard"

    def test_a_coding_role_refuses_a_model_without_tools(self, model_cache):
        model_cache(
            {
                "openai": [
                    {"id": tier_pick("openai", "fast").model_id, "tool_call": False}
                ]
            }
        )
        no_tools = pick("openai", "fast")
        assert not capable(no_tools, "coder")
        assert capable(no_tools, "documenter")
        assert capable(no_tools, "custom")

    def test_a_window_too_small_is_refused(self):
        from dataclasses import replace

        assert not capable(
            replace(pick("openai", "fast"), context_window=100), "custom"
        )


class TestPlan:
    def test_limits_come_first(self):
        assert _plan(count=MAX_REBALANCES).to_dict() == {
            "action": "none",
            "reason": "failed",
            "provider": "",
            "model": "",
            "model_label": "",
            "skipped": "limit",
        }
        assert _plan(over_budget=True).skipped == "over_budget"

    def test_a_claude_rate_limit_tries_another_profile(self):
        model = tier_pick("anthropic", "standard").model_id
        decision = _plan(reason="rate_limited", model=model, alternate_profile=True)
        assert (decision.action, decision.provider, decision.model) == (
            "retry_profile",
            "anthropic",
            model,
        )

    def test_a_rate_limit_goes_to_the_next_provider_that_runs_agents(self):
        decision = _plan(reason="rate_limited", providers=["claude", "meta", "openai"])
        assert (decision.action, decision.provider, decision.model) == (
            "reroute",
            "openai",
            tier_pick("openai", "fast").model_id,
        )

    def test_a_provider_already_tried_is_skipped(self):
        decision = _plan(
            reason="provider_failed",
            providers=["anthropic", "openai", "google"],
            tried={"openai"},
        )
        assert decision.provider == "google"

    def test_no_other_provider_is_said(self):
        decision = _plan(reason="provider_failed", providers=["anthropic"])
        assert (decision.action, decision.skipped) == ("none", "no_alternative")

    def test_a_local_model_reroutes_to_standard_work(self):
        decision = _plan(
            reason="provider_failed",
            provider="ollama",
            model="qwen3-coder",
            providers=["ollama", "anthropic"],
        )
        assert decision.model == tier_pick("anthropic", "standard").model_id

    def test_an_incapable_provider_is_not_a_reroute(self, model_cache):
        model_cache(
            {
                "openai": [
                    {"id": tier_pick("openai", "fast").model_id, "tool_call": False}
                ]
            }
        )
        assert _plan(reason="rate_limited").skipped == "no_alternative"

    def test_a_failure_goes_one_tier_up(self):
        decision = _plan(reason="loop")
        assert (decision.action, decision.provider, decision.model) == (
            "escalate",
            "anthropic",
            tier_pick("anthropic", "standard").model_id,
        )

    def test_a_flagship_that_fails_goes_to_another_provider(self):
        decision = _plan(model=tier_pick("anthropic", "flagship").model_id)
        assert (decision.action, decision.provider) == ("reroute", "openai")

    def test_a_cli_model_has_nothing_above_it(self):
        decision = _plan(provider="opencode", model="", providers=["opencode"])
        assert decision.skipped == "no_alternative"

    def test_an_upper_tier_without_tools_is_not_an_escalation(self, model_cache):
        model_cache(
            {
                "anthropic": [
                    {
                        "id": tier_pick("anthropic", "standard").model_id,
                        "tool_call": False,
                    }
                ]
            }
        )
        assert _plan(providers=["anthropic"]).skipped == "no_alternative"


@pytest.fixture
def client(monkeypatch) -> TestClient:
    monkeypatch.setattr(mc_orchestrator, "_mission_control", None)
    app = FastAPI()
    app.include_router(mc_api.router)
    http = TestClient(app)
    http.post(f"{BASE}/session/start", json={})
    return http


def _agent(client: TestClient, **fields) -> dict:
    body = {
        "name": "Coder",
        "role": "coder",
        "provider": "anthropic",
        "model": tier_pick("anthropic", "fast").model_id,
    }
    return client.post(f"{BASE}/agents", json={**body, **fields}).json()["agent"]


def _events(client: TestClient, kind: str) -> list[dict]:
    events = client.get(f"{BASE}/events?limit=200").json()["events"]
    return [e["data"] for e in events if e["type"] == kind]


def _session(client: TestClient) -> dict:
    return client.get(f"{BASE}/session").json()["session"]


class TestSessionPlan:
    def test_a_crew_sets_providers_and_budget(self, client):
        plan = client.post(
            f"{BASE}/session/plan",
            json={"providers": ["Claude", "openai", "anthropic", " "], "budget_usd": 2},
        ).json()["plan"]
        assert plan == {
            "providers": ["anthropic", "openai"],
            "budget_usd": 2.0,
            "budget_tokens": None,
            "auto_rebalance": True,
        }
        switched = client.post(
            f"{BASE}/session/plan", json={"auto_rebalance": False}
        ).json()["plan"]
        assert switched["providers"] == ["anthropic", "openai"]
        assert switched["auto_rebalance"] is False

    @pytest.mark.parametrize(
        "body",
        [
            {"providers": ["x"] * 9},
            {"providers": ["a" * 65]},
            {"providers": ["a"], "budget_usd": 0},
            {"providers": ["a"], "budget_tokens": -1},
        ],
    )
    def test_a_hostile_plan_is_refused(self, client, body):
        assert client.post(f"{BASE}/session/plan", json=body).status_code == 422

    def test_spending_up_to_the_budget_is_over_it(self, client):
        agent = _agent(client)
        client.post(f"{BASE}/session/plan", json={"providers": ["a"], "budget_usd": 1})
        assert _session(client)["over_budget"] is False
        client.post(
            f"{BASE}/agents/{agent['id']}/update",
            json={"input_tokens": 10, "output_tokens": 5, "cost_usd": 1.0},
        )
        assert _session(client)["over_budget"] is True
        client.post(
            f"{BASE}/session/plan", json={"providers": ["a"], "budget_tokens": 16}
        )
        assert _session(client)["over_budget"] is False
        client.post(
            f"{BASE}/session/plan", json={"providers": ["a"], "budget_tokens": 15}
        )
        assert _session(client)["over_budget"] is True

    def test_a_composed_agent_says_so(self, client):
        agent = _agent(client, origin="auto", estimated_tokens=1200)
        assert (agent["origin"], agent["estimated_tokens"]) == ("auto", 1200)
        assert _agent(client)["origin"] == "manual"
        refused = client.post(
            f"{BASE}/agents", json={"name": "x", "origin": "server"}
        ).status_code
        assert refused == 422


class TestRebalanceAgent:
    def test_an_unknown_agent_is_404(self, client):
        assert (
            client.post(f"{BASE}/agents/nobody/rebalance", json={}).status_code == 404
        )

    def test_a_failure_escalates_and_is_logged(self, client):
        agent = _agent(client)
        client.post(f"{BASE}/agents/{agent['id']}/start", json={"task": "fix it"})

        body = client.post(
            f"{BASE}/agents/{agent['id']}/rebalance", json={"error": "boom"}
        ).json()

        upper = tier_pick("anthropic", "standard")
        assert body["rebalance"]["action"] == "escalate"
        assert (body["agent"]["model"], body["agent"]["rebalances"]) == (
            upper.model_id,
            1,
        )
        assert _events(client, "agent_rebalanced") == [
            {
                "agent_id": agent["id"],
                "reason": "failed",
                "action": "escalate",
                "from": agent["model"],
                "to": upper.label,
                "provider": "anthropic",
            }
        ]
        assert _session(client)["rebalance_count"] == 1
        tree = client.get(f"{BASE}/agents/{agent['id']}/decision-tree").json()["tree"]
        assert "Rebalanced" in [n["label"] for n in tree["nodes"].values()]

        # The same task again keeps the tree and the count; a new one resets them.
        client.post(
            f"{BASE}/agents/{agent['id']}/start", json={"task": "", "rebalanced": True}
        )
        again = client.get(f"{BASE}/agents/{agent['id']}").json()["agent"]
        assert again["rebalances"] == 1
        tree = client.get(f"{BASE}/agents/{agent['id']}/decision-tree").json()["tree"]
        assert tree["node_count"] > 1
        client.post(f"{BASE}/agents/{agent['id']}/start", json={"task": "new"})
        fresh = client.get(f"{BASE}/agents/{agent['id']}").json()["agent"]
        assert fresh["rebalances"] == 0

    def test_a_rate_limit_reroutes_to_an_agent_provider_of_the_session(self, client):
        first = _agent(client)
        _agent(client, provider="")
        _agent(client, provider="anthropic")
        _agent(client, provider="openai")
        mc = mc_orchestrator.get_mission_control()

        decision = client.post(
            f"{BASE}/agents/{first['id']}/rebalance", json={"rate_limited": True}
        ).json()["rebalance"]

        assert (decision["action"], decision["provider"]) == ("reroute", "openai")
        assert mc.get_agent(first["id"]).tried_providers == ["anthropic"]
        # Back on a provider already tried, it is not listed twice.
        mc.get_agent(first["id"]).provider = "anthropic"
        mc.get_agent(first["id"]).tried_providers = ["anthropic"]
        skipped = client.post(
            f"{BASE}/agents/{first['id']}/rebalance", json={"rate_limited": True}
        ).json()["rebalance"]
        assert skipped["action"] == "reroute"
        assert mc.get_agent(first["id"]).tried_providers == ["anthropic"]

    def test_a_retry_on_another_profile_stays_on_the_provider(self, client):
        agent = _agent(client)
        mc = mc_orchestrator.get_mission_control()
        decision = client.post(
            f"{BASE}/agents/{agent['id']}/rebalance",
            json={"error": "rate limit", "alternate_profile": True},
        ).json()["rebalance"]
        assert decision["action"] == "retry_profile"
        assert mc.get_agent(agent["id"]).tried_providers == []

    def test_switched_off_or_over_budget_nothing_moves(self, client):
        agent = _agent(client)
        client.post(f"{BASE}/session/plan", json={"auto_rebalance": False})
        off = client.post(f"{BASE}/agents/{agent['id']}/rebalance", json={}).json()
        assert (off["rebalance"]["skipped"], off["agent"]["model"]) == (
            "disabled",
            agent["model"],
        )
        client.post(
            f"{BASE}/session/plan",
            json={"providers": ["anthropic"], "budget_usd": 1, "auto_rebalance": True},
        )
        client.post(
            f"{BASE}/agents/{agent['id']}/update",
            json={"input_tokens": 1, "cost_usd": 2.0},
        )
        over = client.post(f"{BASE}/agents/{agent['id']}/rebalance", json={}).json()
        assert over["rebalance"]["skipped"] == "over_budget"
        assert [e["skipped"] for e in _events(client, "agent_rebalance_skipped")] == [
            "disabled",
            "over_budget",
        ]

    def test_a_looping_answer_is_flagged_once_then_escalated(self, client):
        agent = _agent(client)
        client.post(f"{BASE}/agents/{agent['id']}/start", json={"task": "go"})
        loop = TestDetectLoop.PASSAGE * (LOOP_REPEATS + 1)

        flagged = client.post(
            f"{BASE}/agents/{agent['id']}/update", json={"output_delta": loop}
        ).json()["agent"]
        client.post(f"{BASE}/agents/{agent['id']}/update", json={"output_delta": loop})

        assert flagged["loop_detected"] is True
        assert len(_events(client, "agent_loop_detected")) == 1
        decision = client.post(
            f"{BASE}/agents/{agent['id']}/rebalance", json={}
        ).json()["rebalance"]
        assert (decision["reason"], decision["action"]) == ("loop", "escalate")
        client.post(
            f"{BASE}/agents/{agent['id']}/start", json={"task": "", "rebalanced": True}
        )
        restarted = client.get(f"{BASE}/agents/{agent['id']}").json()["agent"]
        assert restarted["loop_detected"] is False

    def test_a_rebalance_text_over_the_limit_is_refused(self, client):
        agent = _agent(client)
        refused = client.post(
            f"{BASE}/agents/{agent['id']}/rebalance", json={"error": "x" * 2_001}
        )
        assert refused.status_code == 422
