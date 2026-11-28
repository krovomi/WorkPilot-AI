"""Metric sources of the watch: Prometheus, Datadog, New Relic, CloudWatch (#366)."""

from __future__ import annotations

import json
import urllib.request
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlsplit

import pytest
from deploy_watch import cloudwatch
from deploy_watch.cloudwatch import cloudwatch_value, sign, signing_key
from deploy_watch.net import MAX_BODY_BYTES
from deploy_watch.sources import MetricSource, source_from_env

NOW = datetime(2026, 11, 15, 10, 0, tzinfo=UTC)
DD = "https://api.datadoghq.com/api/v1/query"
NR = "https://api.newrelic.com/graphql"
CW = "https://monitoring.eu-west-3.amazonaws.com/"
DD_ENV = {
    "CICD_MONITOR_SOURCE": "datadog",
    "CICD_MONITOR_DATADOG_API_KEY": "dd-api-0000",
    "CICD_MONITOR_DATADOG_APP_KEY": "dd-app-0000",
}
NR_ENV = {
    "CICD_MONITOR_SOURCE": "newrelic",
    "CICD_MONITOR_NEWRELIC_ACCOUNT_ID": "1234567",
    "CICD_MONITOR_NEWRELIC_API_KEY": "NRAK-test-0000",
}
CW_ENV = {
    "CICD_MONITOR_SOURCE": "cloudwatch",
    "CICD_MONITOR_AWS_REGION": "eu-west-3",
    "CICD_MONITOR_AWS_ACCESS_KEY_ID": "AKIDEXAMPLE",
    "CICD_MONITOR_AWS_SECRET_ACCESS_KEY": "aws-secret-0000",
}


def _source(env: dict) -> MetricSource:
    problems: list[str] = []
    source = source_from_env(env, problems)
    assert source is not None, problems
    assert problems == []
    return source


class TestSourceFromEnv:
    def test_prometheus_by_default(self):
        source = _source(
            {
                "CICD_MONITOR_PROMETHEUS_URL": "http://127.0.0.1:9090/",
                "CICD_MONITOR_PROMETHEUS_TOKEN": "tok-0000",
            }
        )
        assert (source.kind, source.url, source.label) == (
            "prometheus",
            "http://127.0.0.1:9090",
            "Prometheus",
        )
        assert source.local
        assert source_from_env({}, []) is None

    def test_vendor_hosts_are_fixed(self):
        datadog = _source({**DD_ENV, "CICD_MONITOR_DATADOG_SITE": "datadoghq.eu"})
        assert datadog.url == "https://api.datadoghq.eu"
        assert _source(DD_ENV).url == "https://api.datadoghq.com"
        assert _source({**NR_ENV, "CICD_MONITOR_NEWRELIC_REGION": "EU"}).url == (
            "https://api.eu.newrelic.com/graphql"
        )
        assert _source(CW_ENV).url == CW
        for env in (DD_ENV, NR_ENV, CW_ENV):
            assert not _source(env).local

    def test_secrets_stay_out_of_repr(self):
        text = repr(_source({**CW_ENV, "CICD_MONITOR_AWS_SESSION_TOKEN": "sess-0000"}))
        assert "aws-secret-0000" not in text and "sess-0000" not in text
        assert "dd-api-0000" not in repr(_source(DD_ENV))

    @pytest.mark.parametrize(
        ("env", "problem"),
        [
            ({"CICD_MONITOR_SOURCE": "splunk"}, "CICD_MONITOR_SOURCE"),
            ({"CICD_MONITOR_PROMETHEUS_URL": "file:///etc"}, "PROMETHEUS_URL"),
            (
                {**DD_ENV, "CICD_MONITOR_DATADOG_SITE": "evil.example"},
                "CICD_MONITOR_DATADOG_SITE",
            ),
            ({**DD_ENV, "CICD_MONITOR_DATADOG_APP_KEY": ""}, "Datadog"),
            ({**NR_ENV, "CICD_MONITOR_NEWRELIC_REGION": "mars"}, "REGION"),
            ({**NR_ENV, "CICD_MONITOR_NEWRELIC_ACCOUNT_ID": "12a"}, "New Relic"),
            ({**CW_ENV, "CICD_MONITOR_AWS_REGION": "evil.example/"}, "AWS_REGION"),
            ({**CW_ENV, "CICD_MONITOR_AWS_SECRET_ACCESS_KEY": ""}, "CloudWatch"),
        ],
    )
    def test_refusals_are_named(self, env, problem):
        problems: list[str] = []
        assert source_from_env(env, problems) is None
        assert len(problems) == 1 and problem in problems[0]


class TestDatadog:
    def test_newest_point_of_each_series_summed(self, fake_fetch):
        answer = {
            "status": "ok",
            "series": [
                {"pointlist": [[1, 0.5], [2, 1.5], [3, None]]},
                {"pointlist": [[1, 2]]},
                {"pointlist": []},
                {"pointlist": [["bad"]]},
                "junk",
            ],
        }
        fetch = fake_fetch({DD: (200, answer)})
        assert _source(DD_ENV).value("sum:errors{*}", fetch, NOW) == 3.5
        request = fetch.requests[0]
        query = parse_qs(urlsplit(request.full_url).query)
        assert query["query"] == ["sum:errors{*}"]
        assert int(query["to"][0]) - int(query["from"][0]) == 300
        assert request.get_header("Dd-api-key") == "dd-api-0000"
        assert request.get_header("Dd-application-key") == "dd-app-0000"

    @pytest.mark.parametrize(
        "answer",
        [
            (200, {"status": "error", "series": []}),
            (200, {"series": "x"}),
            (200, {"series": []}),
            (200, {"series": [{"pointlist": [[1, "x"]]}]}),
            (200, {"series": [{"pointlist": [[1, float("inf")]]}]}),
            (200, [1]),
            (403, {"series": []}),
            (200, b"\xff"),
            (200, b"x" * (MAX_BODY_BYTES + 1)),
            OSError("down"),
        ],
    )
    def test_nothing_usable(self, fake_fetch, answer):
        assert _source(DD_ENV).value("q", fake_fetch({DD: answer}), NOW) is None


def _nrql(results: object) -> dict:
    return {"data": {"actor": {"account": {"nrql": {"results": results}}}}}


class TestNewRelic:
    def test_numbers_of_the_result_summed(self, fake_fetch):
        rows = [
            {"count": 4, "beginTimeSeconds": 1700, "facet": "web"},
            {"percentile.duration": {"95": 0.5}, "flag": True},
            "junk",
        ]
        fetch = fake_fetch({NR: (200, _nrql(rows))})
        assert _source(NR_ENV).value("SELECT count(*) FROM X", fetch, NOW) == 4.5
        request = fetch.requests[0]
        assert request.get_method() == "POST"
        assert request.get_header("Api-key") == "NRAK-test-0000"
        body = json.loads(request.data)
        assert body["variables"] == {
            "account": 1234567,
            "nrql": "SELECT count(*) FROM X",
        }
        # The query is a GraphQL variable, never spliced into the document.
        assert "SELECT" not in body["query"]

    @pytest.mark.parametrize(
        "answer",
        [
            (200, {"errors": [{"message": "bad"}]}),
            (200, {"data": None}),
            (200, _nrql("x")),
            (200, _nrql([])),
            (200, _nrql([{"facet": "only text"}])),
            (500, _nrql([{"count": 1}])),
        ],
    )
    def test_nothing_usable(self, fake_fetch, answer):
        assert _source(NR_ENV).value("q", fake_fetch({NR: answer}), NOW) is None


def _cw_xml(*members: str) -> bytes:
    body = "".join(members)
    return (
        '<GetMetricDataResponse xmlns="http://monitoring.amazonaws.com/doc/2010-08-01/">'
        f"<GetMetricDataResult><MetricDataResults>{body}</MetricDataResults>"
        "</GetMetricDataResult></GetMetricDataResponse>"
    ).encode()


def _member(*values: str) -> str:
    items = "".join(f"<member>{v}</member>" for v in values)
    return f"<member><Id>q</Id><Values>{items}</Values></member>"


class TestSigV4:
    """Against the published Signature Version 4 examples."""

    def test_signing_key(self):
        key = signing_key(
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam"
        )
        assert key.hex() == (
            "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d"
        )

    def test_get_vanilla(self):
        request = urllib.request.Request("https://example.amazonaws.com/", method="GET")
        sign(
            request,
            b"",
            "us-east-1",
            "service",
            ("AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", ""),
            datetime(2015, 8, 30, 12, 36, tzinfo=UTC),
        )
        assert request.get_header("Authorization") == (
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/"
            "aws4_request, SignedHeaders=host;x-amz-date, Signature="
            "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        )
        assert request.get_header("X-amz-date") == "20150830T123600Z"

    def test_query_and_session_token_are_signed(self):
        request = urllib.request.Request("https://example.amazonaws.com/?b=2&a=1 x")
        sign(request, b"", "us-east-1", "service", ("AK", "secret", "sess-0000"), NOW)
        assert request.get_header("X-amz-security-token") == "sess-0000"
        assert "SignedHeaders=host;x-amz-date;x-amz-security-token," in (
            request.get_header("Authorization")
        )
        assert cloudwatch._canonical_query("b=2&a=1 x") == "a=1%20x&b=2"


class TestCloudWatch:
    def test_newest_value_of_each_result(self, fake_fetch):
        fetch = fake_fetch(
            {CW: (200, _cw_xml(_member("2.5", "9"), _member("1"), _member()))}
        )
        assert _source(CW_ENV).value("SELECT AVG(Latency) FROM X", fetch, NOW) == 3.5
        request = fetch.requests[0]
        form = parse_qs(request.data.decode())
        assert form["Action"] == ["GetMetricData"]
        assert form["MetricDataQueries.member.1.Expression"] == [
            "SELECT AVG(Latency) FROM X"
        ]
        assert form["ScanBy"] == ["TimestampDescending"]
        assert form["StartTime"] == ["2026-11-15T09:55:00Z"]
        assert request.get_header("Authorization").startswith(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261115/eu-west-3/monitoring/"
        )
        assert "aws-secret-0000" not in str(request.header_items())

    @pytest.mark.parametrize(
        "answer",
        [
            (200, _cw_xml()),
            (200, _cw_xml(_member())),
            (200, _cw_xml(_member("NaN"))),
            (200, _cw_xml(_member("x"))),
            (200, b"<Other/>"),
            (200, b"<not xml"),
            (
                200,
                b'<!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>',
            ),
            (200, b""),
            (400, _cw_xml(_member("1"))),
            OSError("down"),
        ],
    )
    def test_nothing_usable(self, fake_fetch, answer):
        creds = ("AK", "secret", "")
        assert (
            cloudwatch_value("eu-west-3", creds, "q", fake_fetch({CW: answer}), NOW)
            is None
        )
