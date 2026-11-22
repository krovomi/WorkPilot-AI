"""Read one number from Amazon CloudWatch, signed by hand (#366).

`GetMetricData` over the Query protocol (a form POST, an XML answer), with
one expression: a Metrics Insights query (`SELECT AVG(...) FROM ...`) or
metric math (`SEARCH(...)`). Each result's newest value over the last five
minutes is summed, like a Prometheus vector.

The request is signed with Signature Version 4 (`sign`), from the key of the
project's CI/CD settings, without the AWS SDK. The answer is parsed with
`defusedxml`: it comes from the network. The host is always
`monitoring.<region>.amazonaws.com`, the region checked by its pattern.
"""

from __future__ import annotations

import hashlib
import hmac
import math
import urllib.request
from datetime import datetime, timedelta
from urllib.parse import quote, urlencode, urlsplit
from xml.etree.ElementTree import Element

from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException

from .net import MAX_BODY_BYTES, Fetch

SERVICE = "monitoring"
LOOKBACK = timedelta(minutes=5)
PERIOD_SECONDS = 60
_NS = "{http://monitoring.amazonaws.com/doc/2010-08-01/}"


def _hmac(key: bytes, text: str) -> bytes:
    return hmac.new(key, text.encode("utf-8"), hashlib.sha256).digest()


def signing_key(secret: str, date: str, region: str, service: str) -> bytes:
    key = _hmac(f"AWS4{secret}".encode(), date)
    for part in (region, service, "aws4_request"):
        key = _hmac(key, part)
    return key


def _canonical_query(query: str) -> str:
    pairs = []
    for item in query.split("&") if query else []:
        name, _, value = item.partition("=")
        pairs.append((quote(name, safe="-_.~"), quote(value, safe="-_.~")))
    return "&".join(f"{n}={v}" for n, v in sorted(pairs))


def sign(
    request: urllib.request.Request,
    body: bytes,
    region: str,
    service: str,
    credentials: tuple[str, str, str],
    now: datetime,
) -> None:
    """Add `X-Amz-Date`, the session token if any, and `Authorization`."""
    key_id, secret, session_token = credentials
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    date = stamp[:8]
    parts = urlsplit(request.full_url)
    request.add_header("X-Amz-Date", stamp)
    if session_token:
        request.add_header("X-Amz-Security-Token", session_token)
    headers = {k.lower(): " ".join(str(v).split()) for k, v in request.header_items()}
    headers["host"] = parts.netloc
    names = sorted(headers)
    signed = ";".join(names)
    canonical = "\n".join(
        [
            request.get_method(),
            quote(parts.path or "/", safe="/-_.~"),
            _canonical_query(parts.query),
            "".join(f"{name}:{headers[name]}\n" for name in names),
            signed,
            hashlib.sha256(body).hexdigest(),
        ]
    )
    scope = f"{date}/{region}/{service}/aws4_request"
    to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            stamp,
            scope,
            hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        ]
    )
    signature = hmac.new(
        signing_key(secret, date, region, service),
        to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    request.add_header(
        "Authorization",
        f"AWS4-HMAC-SHA256 Credential={key_id}/{scope}, "
        f"SignedHeaders={signed}, Signature={signature}",
    )


def _iso(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _newest_values(root: Element) -> list[float] | None:
    results = root.find(f"{_NS}GetMetricDataResult/{_NS}MetricDataResults")
    if results is None:
        return None
    newest: list[float] = []
    for member in results.findall(f"{_NS}member"):
        first = member.find(f"{_NS}Values/{_NS}member")
        if first is not None and first.text:
            newest.append(float(first.text))
    return newest


def cloudwatch_value(
    region: str,
    credentials: tuple[str, str, str],
    expression: str,
    fetch: Fetch,
    now: datetime,
) -> float | None:
    body = urlencode(
        {
            "Action": "GetMetricData",
            "Version": "2010-08-01",
            "StartTime": _iso(now - LOOKBACK),
            "EndTime": _iso(now),
            "ScanBy": "TimestampDescending",
            "MetricDataQueries.member.1.Id": "q",
            "MetricDataQueries.member.1.Expression": expression,
            "MetricDataQueries.member.1.Period": str(PERIOD_SECONDS),
        }
    ).encode()
    request = urllib.request.Request(
        f"https://{SERVICE}.{region}.amazonaws.com/",
        data=body,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"},
    )
    sign(request, body, region, SERVICE, credentials, now)
    request.add_header("User-Agent", "WorkPilot")
    try:
        status, raw = fetch(request)
    except (OSError, ValueError):
        return None
    if status != 200 or not raw or len(raw) > MAX_BODY_BYTES:
        return None
    try:
        values = _newest_values(ElementTree.fromstring(raw))
    except (ElementTree.ParseError, DefusedXmlException, ValueError):
        return None
    if not values or any(math.isnan(v) or math.isinf(v) for v in values):
        return None
    return sum(values)
