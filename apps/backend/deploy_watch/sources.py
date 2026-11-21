"""Where the watch reads its metrics: Prometheus, Datadog, New Relic, CloudWatch (#366).

The project's CI/CD settings pick one source (`CICD_MONITOR_SOURCE`) and hold
its credentials; `.workpilot/deploy-monitors.yaml` only writes each metric's
query in that source's language (PromQL, a Datadog query, NRQL, a CloudWatch
Metrics Insights query or metric math). A repository therefore never chooses
where a key goes: Prometheus is the URL of the settings, the others are their
vendor's own API host (a Datadog site or a New Relic region from a closed
list, a CloudWatch region by its pattern).

Every source answers one number per query: Prometheus sums a vector; Datadog
and CloudWatch take each series' newest point over the last five minutes and
sum them; New Relic sums the numbers of the NRQL result. No answer, a bad one
or a non-finite value: None, which the watch counts as "not measured".
"""

from __future__ import annotations

import json
import math
import re
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from urllib.parse import urlencode

from .cloudwatch import cloudwatch_value
from .collectors import MAX_BODY_BYTES, Fetch, prometheus_value
from .config import is_local_host, valid_url

LOOKBACK = timedelta(minutes=5)
SOURCES = ("prometheus", "datadog", "newrelic", "cloudwatch")
DATADOG_SITES = frozenset(
    {
        "datadoghq.com",
        "us3.datadoghq.com",
        "us5.datadoghq.com",
        "datadoghq.eu",
        "ap1.datadoghq.com",
        "ap2.datadoghq.com",
        "ddog-gov.com",
    }
)
NEWRELIC_HOSTS = {
    "us": "https://api.newrelic.com/graphql",
    "eu": "https://api.eu.newrelic.com/graphql",
}
AWS_REGION = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d{1,2}$")
_ACCOUNT = re.compile(r"^[0-9]{1,12}$")
# Keys of an NRQL row that are not a measurement.
_NRQL_TIME_KEYS = frozenset({"beginTimeSeconds", "endTimeSeconds", "timestamp"})
_NRQL = (
    "query($account: Int!, $nrql: Nrql!) "
    "{ actor { account(id: $account) { nrql(query: $nrql) { results } } } }"
)
_LABELS = {
    "prometheus": "Prometheus",
    "datadog": "Datadog",
    "newrelic": "New Relic",
    "cloudwatch": "CloudWatch",
}


@dataclass(frozen=True)
class MetricSource:
    """One source and what it needs; the secrets never show in a repr."""

    kind: str
    # Where the queries go: the settings' Prometheus URL, or the vendor's API.
    url: str
    # Datadog site, New Relic account id, CloudWatch region.
    account: str = ""
    key: str = field(default="", repr=False)
    second_key: str = field(default="", repr=False)
    session_token: str = field(default="", repr=False)

    @property
    def label(self) -> str:
        return _LABELS[self.kind]

    @property
    def local(self) -> bool:
        """Read without leaving the site: only a Prometheus can be."""
        return self.kind == "prometheus" and is_local_host(self.url)

    def value(self, query: str, fetch: Fetch, now: datetime) -> float | None:
        if self.kind == "prometheus":
            return prometheus_value(self.url, self.key, query, fetch)
        if self.kind == "datadog":
            return _datadog(self, query, fetch, now)
        if self.kind == "newrelic":
            return _newrelic(self, query, fetch)
        return cloudwatch_value(
            self.account,
            (self.key, self.second_key, self.session_token),
            query,
            fetch,
            now,
        )


def _finite_sum(values: list[object]) -> float | None:
    try:
        numbers = [float(v) for v in values]  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if not numbers or any(math.isnan(n) or math.isinf(n) for n in numbers):
        return None
    return sum(numbers)


def _read_json(fetch: Fetch, request: urllib.request.Request) -> object:
    try:
        status, body = fetch(request)
    except (OSError, ValueError):
        return None
    if status != 200 or len(body) > MAX_BODY_BYTES:
        return None
    try:
        return json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


def _datadog(
    source: MetricSource, query: str, fetch: Fetch, now: datetime
) -> float | None:
    """`GET /api/v1/query`: each series' newest point, summed."""
    params = urlencode(
        {
            "from": int((now - LOOKBACK).timestamp()),
            "to": int(now.timestamp()),
            "query": query,
        }
    )
    request = urllib.request.Request(
        f"{source.url}/api/v1/query?{params}",
        method="GET",
        headers={
            "Accept": "application/json",
            "User-Agent": "WorkPilot",
            "DD-API-KEY": source.key,
            "DD-APPLICATION-KEY": source.second_key,
        },
    )
    doc = _read_json(fetch, request)
    series = doc.get("series") if isinstance(doc, dict) else None
    if doc is None or not isinstance(series, list) or doc.get("status") == "error":
        return None
    newest: list[object] = []
    for item in series:
        points = item.get("pointlist") if isinstance(item, dict) else None
        values = [
            p[1]
            for p in points or []
            if isinstance(p, list) and len(p) == 2 and p[1] is not None
        ]
        if values:
            newest.append(values[-1])
    return _finite_sum(newest)


def _nrql_numbers(row: object) -> list[object]:
    if not isinstance(row, dict):
        return []
    numbers: list[object] = []
    for key, value in row.items():
        if key in _NRQL_TIME_KEYS:
            continue
        # `percentile(duration, 95)` answers {"percentile.duration": {"95": 0.4}}.
        for leaf in value.values() if isinstance(value, dict) else [value]:
            if isinstance(leaf, int | float) and not isinstance(leaf, bool):
                numbers.append(leaf)
    return numbers


def _newrelic(source: MetricSource, query: str, fetch: Fetch) -> float | None:
    """NerdGraph's `nrql` field: the numbers of the result, summed."""
    body = json.dumps(
        {"query": _NRQL, "variables": {"account": int(source.account), "nrql": query}}
    ).encode()
    request = urllib.request.Request(
        source.url,
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "WorkPilot",
            "API-Key": source.key,
        },
    )
    doc = _read_json(fetch, request)
    if not isinstance(doc, dict) or doc.get("errors"):
        return None
    try:
        results = doc["data"]["actor"]["account"]["nrql"]["results"]
    except (KeyError, TypeError):
        return None
    if not isinstance(results, list):
        return None
    return _finite_sum([n for row in results for n in _nrql_numbers(row)])


def _prometheus(env: dict, problems: list[str]) -> MetricSource | None:
    url = str(env.get("CICD_MONITOR_PROMETHEUS_URL") or "").strip().rstrip("/")
    if not url:
        return None
    if not valid_url(url):
        problems.append("CICD_MONITOR_PROMETHEUS_URL: not an http(s) URL")
        return None
    return MetricSource(
        "prometheus", url, key=str(env.get("CICD_MONITOR_PROMETHEUS_TOKEN") or "")
    )


def _datadog_source(env: dict, problems: list[str]) -> MetricSource | None:
    site = str(env.get("CICD_MONITOR_DATADOG_SITE") or "datadoghq.com").strip()
    api_key = str(env.get("CICD_MONITOR_DATADOG_API_KEY") or "")
    app_key = str(env.get("CICD_MONITOR_DATADOG_APP_KEY") or "")
    if site not in DATADOG_SITES:
        problems.append("CICD_MONITOR_DATADOG_SITE: not a Datadog site")
        return None
    if not (api_key and app_key):
        problems.append("Datadog: the API key and the application key are required")
        return None
    return MetricSource(
        "datadog", f"https://api.{site}", site, key=api_key, second_key=app_key
    )


def _newrelic_source(env: dict, problems: list[str]) -> MetricSource | None:
    region = str(env.get("CICD_MONITOR_NEWRELIC_REGION") or "us").strip().lower()
    account = str(env.get("CICD_MONITOR_NEWRELIC_ACCOUNT_ID") or "").strip()
    api_key = str(env.get("CICD_MONITOR_NEWRELIC_API_KEY") or "")
    if region not in NEWRELIC_HOSTS:
        problems.append("CICD_MONITOR_NEWRELIC_REGION: us or eu")
        return None
    if not (_ACCOUNT.match(account) and api_key):
        problems.append("New Relic: the account id and the user API key are required")
        return None
    return MetricSource("newrelic", NEWRELIC_HOSTS[region], account, key=api_key)


def _cloudwatch_source(env: dict, problems: list[str]) -> MetricSource | None:
    region = str(env.get("CICD_MONITOR_AWS_REGION") or "").strip()
    key_id = str(env.get("CICD_MONITOR_AWS_ACCESS_KEY_ID") or "").strip()
    secret = str(env.get("CICD_MONITOR_AWS_SECRET_ACCESS_KEY") or "")
    if not AWS_REGION.match(region):
        problems.append("CICD_MONITOR_AWS_REGION: not an AWS region")
        return None
    if not (key_id and secret):
        problems.append("CloudWatch: the access key id and its secret are required")
        return None
    return MetricSource(
        "cloudwatch",
        f"https://monitoring.{region}.amazonaws.com/",
        region,
        key=key_id,
        second_key=secret,
        session_token=str(env.get("CICD_MONITOR_AWS_SESSION_TOKEN") or ""),
    )


_BUILDERS = {
    "prometheus": _prometheus,
    "datadog": _datadog_source,
    "newrelic": _newrelic_source,
    "cloudwatch": _cloudwatch_source,
}


def source_from_env(env: dict, problems: list[str]) -> MetricSource | None:
    """The source the CI/CD settings name (Prometheus when they name none)."""
    kind = str(env.get("CICD_MONITOR_SOURCE") or "prometheus").strip().lower()
    if kind not in _BUILDERS:
        problems.append("CICD_MONITOR_SOURCE: unknown metric source")
        return None
    return _BUILDERS[kind](env, problems)
