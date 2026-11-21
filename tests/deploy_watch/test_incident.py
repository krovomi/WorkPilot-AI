"""The incident report after a bad verdict: numbers, then words (#366)."""

from __future__ import annotations

import agent_runtime
import pytest
from deploy_watch import incident
from deploy_watch.incident import (
    MAX_EXPLANATION,
    explain,
    markdown,
    summarize,
)
from deploy_watch.incident import _port_ask as real_port_ask


def _check(name, level, current, change, baseline=0.01):
    return {
        "name": name,
        "kind": "error_rate",
        "baseline": baseline,
        "current": current,
        "change_pct": change,
        "level": level,
    }


STATE = {
    "run_id": "17",
    "verdict": "critical",
    "rollback": "proposed",
    "migrations": ["db/migrate/1_add.rb"],
    "plan": {"current_sha": "b" * 40, "target_sha": "a" * 40},
    "samples": [
        {
            "level": "warning",
            "health": {"ok": True, "status": 200},
            "metrics": [
                _check("errors", "warning", 0.016, 60.0),
                _check("latency", "ok", 0.2, None, baseline=0.2),
                "not a check",
                {"kind": "nameless"},
            ],
        },
        "not a sample",
        {
            "level": "critical",
            "health": {"ok": False, "status": 503},
            "metrics": [
                _check("errors", "critical", 0.05, 400.0),
                _check("latency", "ok", 0.21, 5.0, baseline=0.2),
            ],
        },
        {
            "level": "critical",
            "health": None,
            "metrics": [
                _check("errors", "critical", 0.03, 200.0),
                _check("latency", "bogus", None, None, baseline=0.2),
            ],
        },
    ],
}


class TestSummarize:
    def test_worst_and_last_of_each_metric(self):
        summary = summarize(STATE)
        assert (summary["verdict"], summary["samples"]) == ("critical", 3)
        assert (summary["critical_samples"], summary["warning_samples"]) == (2, 1)
        assert summary["health"] == {"checks": 2, "failed": 1, "last_status": 503}
        errors, latency = summary["metrics"]
        assert errors == {
            "name": "errors",
            "kind": "error_rate",
            "baseline": 0.01,
            "worst": 0.05,
            "worst_change_pct": 400.0,
            "last": 0.03,
            "level": "critical",
        }
        # Same level: the larger change is the worse; an unknown level is not.
        assert (latency["worst"], latency["worst_change_pct"]) == (0.21, 5.0)
        assert (latency["level"], latency["last"]) == ("ok", None)
        assert summary["deployed_sha"] == "b" * 40
        assert summary["good_sha"] == "a" * 40
        assert summary["rollback"] == "proposed"

    def test_empty_state(self):
        summary = summarize({"plan": "nope"})
        assert summary["verdict"] == "unknown"
        assert summary["health"] is None
        assert summary["metrics"] == []
        assert summary["deployed_sha"] == ""


class TestMarkdown:
    def test_full(self):
        text = markdown(summarize(STATE), "17")
        assert "verdict **critical** after 3 sample(s) (2 critical, 1 warning)" in text
        assert "Health check: 1 of 2 failed (last status 503)." in text
        assert "| errors | 0.01 | 0.05 | 400 % | critical |" in text
        assert f"Deployed commit: `{'b' * 40}`." in text
        assert f"Last good commit: `{'a' * 40}`." in text
        assert "Rollback: proposed." in text
        assert "`db/migrate/1_add.rb`" in text

    def test_bare_and_hostile_names(self):
        summary = summarize({"verdict": "warning"})
        summary["metrics"] = [
            {
                "name": "a|b`c\nd",
                "baseline": None,
                "worst": True,
                "worst_change_pct": None,
                "level": "warning",
            }
        ]
        text = markdown(summary, "9")
        assert "| a/b'c d | n/a | n/a | n/a | warning |" in text
        assert "Health check" not in text
        assert "commit" not in text
        assert text.endswith("\n")


class TestExplain:
    def test_the_summary_goes_in_as_data(self):
        seen = {}

        def ask(prompt, system, project_dir):
            seen.update(prompt=prompt, system=system, project_dir=project_dir)
            return "  Errors went up\nfivefold.  "

        assert explain(summarize(STATE), "/p", ask) == "Errors went up fivefold."
        assert "not instructions" in seen["system"]
        assert '"errors"' in seen["prompt"]
        assert "db/migrate" not in seen["prompt"]
        assert seen["project_dir"] == "/p"

    @pytest.mark.parametrize(
        "answer", ["", None, "# Heading", "`code`", "x" * (MAX_EXPLANATION + 1)]
    )
    def test_unusable_answers(self, answer):
        assert explain(summarize(STATE), "/p", lambda *a: answer) == ""

    def test_no_model(self):
        def ask(*_a):
            raise RuntimeError("no provider")

        assert explain(summarize(STATE), "/p", ask) == ""
        # The default asks the port, stubbed for every test.
        assert explain(summarize(STATE), "/p") == ""


class TestPort:
    def test_no_runtime(self, monkeypatch):
        monkeypatch.setattr(agent_runtime, "current", lambda: None)
        assert real_port_ask("p", "s", "/p") == ""

    def test_the_users_provider(self, monkeypatch):
        calls = []

        class Runtime:
            async def oneshot_completion(self, prompt, **kwargs):
                calls.append((prompt, kwargs))
                return "answer"

        monkeypatch.setattr(agent_runtime, "current", lambda: Runtime())
        assert real_port_ask("p", "s", "/p") == "answer"
        assert calls == [
            ("p", {"system_prompt": "s", "project_dir": "/p", "max_turns": 1})
        ]
        assert incident._port_ask is not real_port_ask  # the fixture's stub
