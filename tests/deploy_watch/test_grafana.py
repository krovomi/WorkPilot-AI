"""Grafana as a metric source (#366, lot 4), against a fake Grafana."""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest
from deploy_watch.sources import MetricSource, source_from_env

GRAFANA = "https://grafana.example"
NOW = datetime(2026, 11, 15, 10, 0, tzinfo=UTC)
ENV = {
    "CICD_MONITOR_SOURCE": "grafana",
    "CICD_MONITOR_GRAFANA_URL": f"{GRAFANA}/",
    "CICD_MONITOR_GRAFANA_TOKEN": "glsa-test-0000",
    "CICD_MONITOR_GRAFANA_DATASOURCE_UID": "prom-main",
}


def _frames(*columns: list) -> dict:
    return {
        "results": {
            "A": {
                "frames": [
                    {"schema": {}, "data": {"values": [[1, 2], column]}}
                    for column in columns
                ]
            }
        }
    }


def _source(env: dict | None = None) -> MetricSource:
    problems: list[str] = []
    source = source_from_env(env or ENV, problems)
    assert source is not None, problems
    return source


class TestGrafana:
    def test_newest_value_of_each_frame_summed(self, fake_fetch):
        fetch = fake_fetch(
            {f"{GRAFANA}/api/ds/query": (200, _frames([0.1, 0.2], [1.0, None]))}
        )
        source = _source()
        assert (source.label, source.account, source.local) == (
            "Grafana",
            "prom-main",
            False,
        )
        assert source.value("sum(rate(errors[5m]))", fetch, NOW) == pytest.approx(1.2)
        request = fetch.requests[0]
        assert request.get_method() == "POST"
        assert request.get_header("Authorization") == "Bearer glsa-test-0000"
        body = json.loads(request.data)
        assert body["queries"][0] == {
            "refId": "A",
            "datasource": {"uid": "prom-main"},
            "expr": "sum(rate(errors[5m]))",
            "instant": True,
        }
        assert body["to"] == str(int(NOW.timestamp() * 1000))
        assert "glsa-test-0000" not in repr(source)

    def test_the_token_stays_off_plain_http(self, fake_fetch):
        plain = {**ENV, "CICD_MONITOR_GRAFANA_URL": "http://grafana.example"}
        fetch = fake_fetch({"http://grafana.example/api/ds/query": (200, _frames([3]))})
        assert _source(plain).value("x", fetch, NOW) == 3
        assert fetch.requests[0].get_header("Authorization") is None

    def test_a_local_grafana_is_read_offline(self):
        local = {**ENV, "CICD_MONITOR_GRAFANA_URL": "http://127.0.0.1:3000"}
        assert _source(local).local is True

    @pytest.mark.parametrize(
        "answer",
        [
            (500, b""),
            (200, b"not json"),
            (200, {"results": {}}),
            (200, {"results": {"A": {"error": "bad query", "frames": []}}}),
            (200, {"results": {"A": {"frames": "nope"}}}),
            (200, {"results": {"A": {"frames": []}}}),
            (200, {"results": {"A": {"frames": [{"data": {"values": []}}]}}}),
            (200, {"results": {"A": {"frames": [{"data": {"values": [5]}}]}}}),
            (200, _frames([None])),
            (200, _frames(["NaN"])),
            (200, b"x" * (1024 * 1024 + 1)),
            OSError("down"),
        ],
    )
    def test_nothing_usable(self, fake_fetch, answer):
        fetch = fake_fetch({f"{GRAFANA}/api/ds/query": answer})
        assert _source().value("x", fetch, NOW) is None

    @pytest.mark.parametrize(
        ("change", "problem"),
        [
            ({"CICD_MONITOR_GRAFANA_URL": "ftp://grafana"}, "CICD_MONITOR_GRAFANA_URL"),
            ({"CICD_MONITOR_GRAFANA_DATASOURCE_UID": "../x"}, "DATASOURCE_UID"),
            ({"CICD_MONITOR_GRAFANA_DATASOURCE_UID": ""}, "DATASOURCE_UID"),
        ],
    )
    def test_refusals_are_named(self, change, problem):
        problems: list[str] = []
        assert source_from_env({**ENV, **change}, problems) is None
        assert problem in problems[0]
