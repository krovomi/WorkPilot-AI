"""Grafana as a metric source of the deployment watch (#366, lot 4).

A team that reads its metrics in Grafana names, in the CI/CD settings, the
Grafana URL, a service account token and the uid of the data source to ask.
Each query of `.workpilot/deploy-monitors.yaml` goes to `POST /api/ds/query`
as that data source's expression (`expr`: PromQL for a Prometheus or Mimir
source, LogQL for Loki), over the last five minutes. The answer is a list of
data frames: the newest value of each frame's last field, summed, like the
other sources.

The URL is the settings', checked like Prometheus': the token goes only over
https or to the machine, no redirect is followed, the answer is bounded.
"""

from __future__ import annotations

import json
import re
import urllib.request
from datetime import datetime, timedelta

from .collectors import MAX_BODY_BYTES, Fetch, _token_allowed

LOOKBACK = timedelta(minutes=5)
DATASOURCE_UID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
_REF = "A"


def _newest(frame: object) -> object | None:
    data = frame.get("data") if isinstance(frame, dict) else None
    values = data.get("values") if isinstance(data, dict) else None
    if not isinstance(values, list) or not values or not isinstance(values[-1], list):
        return None
    points = [v for v in values[-1] if v is not None]
    return points[-1] if points else None


def grafana_value(
    base_url: str, token: str, uid: str, query: str, fetch: Fetch, now: datetime
) -> list[object] | None:
    """The newest value of each frame of the answer; None when there is no answer."""
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "WorkPilot",
    }
    if token and _token_allowed(base_url):
        headers["Authorization"] = f"Bearer {token}"
    body = {
        "queries": [
            {"refId": _REF, "datasource": {"uid": uid}, "expr": query, "instant": True}
        ],
        "from": str(int((now - LOOKBACK).timestamp() * 1000)),
        "to": str(int(now.timestamp() * 1000)),
    }
    request = urllib.request.Request(
        f"{base_url}/api/ds/query",
        data=json.dumps(body).encode(),
        method="POST",
        headers=headers,
    )
    try:
        status, raw = fetch(request)
    except (OSError, ValueError):
        return None
    if status != 200 or len(raw) > MAX_BODY_BYTES:
        return None
    try:
        result = json.loads(raw.decode("utf-8"))["results"][_REF]
    except (ValueError, UnicodeDecodeError, KeyError, TypeError):
        return None
    frames = result.get("frames") if isinstance(result, dict) else None
    if not isinstance(frames, list) or result.get("error"):
        return None
    return [value for value in map(_newest, frames) if value is not None]
