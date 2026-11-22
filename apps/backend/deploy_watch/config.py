"""What to watch after a deployment, and how long (#366).

Two sources, kept apart on purpose:

* the project's CI/CD settings (environment of the runner, from the encrypted
  `.workpilot/.env`): the health check URL, the metric source and its
  credentials (`sources`), the alert channels (`alerts`), the automatic
  rollback switch. A repository cannot choose where a token goes or
  turn a rollback on by committing a file;
* `.workpilot/deploy-monitors.yaml`, which a team may commit: the window, the
  pauses and the metrics (a query in the source's language, a kind,
  thresholds, a `canary_query` for canary analysis), and what follows
  a bad verdict (`revert_pr`, `explain_incident`). Bounded and validated; a bad
  entry is dropped and named in `problems`. A revert PR goes to the forge the
  project already pushes to, with its own credentials: the file only says yes.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING

import yaml

from .net import valid_url

if TYPE_CHECKING:
    from .sources import MetricSource

CONFIG_FILE = Path(".workpilot") / "deploy-monitors.yaml"
MAX_CONFIG_BYTES = 64 * 1024
MAX_METRICS = 20
MAX_QUERY = 2000
MAX_NAME = 60

DEFAULT_WINDOW_MINUTES = 15
DEFAULT_DEPLOY_WAIT_MINUTES = 5
DEFAULT_STABILIZATION_SECONDS = 120
DEFAULT_INTERVAL_SECONDS = 60

# (lowest, highest) accepted for each duration of the YAML file.
_BOUNDS = {
    "window_minutes": (1, 240),
    "deploy_wait_minutes": (0, 120),
    "stabilization_seconds": (0, 1800),
    "interval_seconds": (10, 900),
}


class Kind(StrEnum):
    ERROR_RATE = "error_rate"
    LATENCY = "latency"
    THROUGHPUT = "throughput"
    CUSTOM = "custom"


class Worse(StrEnum):
    """Which way a metric goes when things get worse."""

    UP = "up"
    DOWN = "down"


# Kind -> (warning %, critical %, direction, smallest absolute change that counts).
# Defaults of the issue: error rate +100 %, p95 latency +50 %, throughput -30 %.
DEFAULTS: dict[Kind, tuple[float, float, Worse, float]] = {
    Kind.ERROR_RATE: (50.0, 100.0, Worse.UP, 0.005),
    Kind.LATENCY: (25.0, 50.0, Worse.UP, 0.0),
    Kind.THROUGHPUT: (15.0, 30.0, Worse.DOWN, 0.0),
    Kind.CUSTOM: (25.0, 50.0, Worse.UP, 0.0),
}


@dataclass(frozen=True)
class MetricRule:
    name: str
    kind: Kind
    query: str
    warning_pct: float
    critical_pct: float
    worse: Worse
    min_absolute: float = 0.0
    # Canary analysis: the same metric on the canary only. Each sample then
    # compares the canary with the stable fleet (`query`) at that moment.
    canary_query: str = ""


@dataclass(frozen=True)
class WatchSettings:
    health_url: str = ""
    # Prometheus, Datadog, New Relic or CloudWatch, with its credentials.
    source: MetricSource | None = None
    auto_rollback: bool = False
    window_minutes: int = DEFAULT_WINDOW_MINUTES
    deploy_wait_minutes: int = DEFAULT_DEPLOY_WAIT_MINUTES
    stabilization_seconds: int = DEFAULT_STABILIZATION_SECONDS
    interval_seconds: int = DEFAULT_INTERVAL_SECONDS
    metrics: tuple[MetricRule, ...] = ()
    problems: tuple[str, ...] = ()
    # After a critical verdict: open a PR that reverts the deployed commit.
    revert_pr: bool = False
    # After a warning or critical verdict: a short explanation by the model.
    explain_incident: bool = True

    @property
    def configured(self) -> bool:
        """Something to watch: a health check, or a metric source with metrics."""
        return bool(self.health_url or (self.source and self.metrics))


def _number(value: object, default: float) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return default
    return float(value)


def _metric(raw: object, problems: list[str]) -> MetricRule | None:
    if not isinstance(raw, dict):
        problems.append("metric: not a mapping")
        return None
    name = str(raw.get("name") or "").strip()[:MAX_NAME]
    query = raw.get("query")
    try:
        kind = Kind(str(raw.get("kind") or "custom"))
    except ValueError:
        problems.append(f"{name or 'metric'}: unknown kind")
        return None
    if not name or not isinstance(query, str) or not query.strip():
        problems.append(f"{name or 'metric'}: name and query are required")
        return None
    if len(query) > MAX_QUERY:
        problems.append(f"{name}: query too long")
        return None
    canary = raw.get("canary_query")
    if canary is not None and (
        not isinstance(canary, str) or not canary.strip() or len(canary) > MAX_QUERY
    ):
        problems.append(f"{name}: canary_query must be a query")
        return None
    warning, critical, worse, floor = DEFAULTS[kind]
    if raw.get("worse") is not None:
        try:
            worse = Worse(str(raw["worse"]))
        except ValueError:
            problems.append(f"{name}: worse must be up or down")
            return None
    warning = abs(_number(raw.get("warning"), warning))
    critical = abs(_number(raw.get("critical"), critical))
    if warning > critical:
        problems.append(f"{name}: warning above critical")
        return None
    return MetricRule(
        name=name,
        kind=kind,
        query=query.strip(),
        warning_pct=warning,
        critical_pct=critical,
        worse=worse,
        min_absolute=abs(_number(raw.get("min_absolute"), floor)),
        canary_query=canary.strip() if canary else "",
    )


def read_monitor_file(project_dir: Path) -> tuple[dict, list[str]]:
    """The YAML file as a mapping, and what was wrong with it."""
    path = Path(project_dir) / CONFIG_FILE
    if path.is_symlink() or not path.is_file():
        return {}, []
    if path.stat().st_size > MAX_CONFIG_BYTES:
        return {}, [f"{CONFIG_FILE.as_posix()}: file too large"]
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (yaml.YAMLError, UnicodeDecodeError):
        return {}, [f"{CONFIG_FILE.as_posix()}: not valid YAML"]
    if data is None:
        return {}, []
    if not isinstance(data, dict):
        return {}, [f"{CONFIG_FILE.as_posix()}: not a mapping"]
    return data, []


def _duration(data: dict, env: dict, key: str, env_key: str, default: int) -> int:
    low, high = _BOUNDS[key]
    value: object = data.get(key, default)
    raw_env = str(env.get(env_key) or "").strip()
    if raw_env.isdigit():
        value = int(raw_env)
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    return min(max(value, low), high)


def _flag(data: dict, key: str, default: bool, problems: list[str]) -> bool:
    value = data.get(key, default)
    if isinstance(value, bool):
        return value
    problems.append(f"{key}: not true or false")
    return default


def load_settings(project_dir: Path, env: dict) -> WatchSettings:
    # Imported here: `sources` reads this module's URL checks.
    from .sources import source_from_env

    data, problems = read_monitor_file(project_dir)
    health = str(env.get("CICD_MONITOR_HEALTH_URL") or "").strip()
    if health and not valid_url(health):
        problems.append("CICD_MONITOR_HEALTH_URL: not an http(s) URL")
        health = ""
    source = source_from_env(env, problems)
    raw_metrics = data.get("metrics") or []
    if not isinstance(raw_metrics, list):
        problems.append("metrics: not a list")
        raw_metrics = []
    if len(raw_metrics) > MAX_METRICS:
        problems.append(f"metrics: only the first {MAX_METRICS} are read")
    metrics: list[MetricRule] = []
    revert_pr = _flag(data, "revert_pr", False, problems)
    explain_incident = _flag(data, "explain_incident", True, problems)
    for raw in raw_metrics[:MAX_METRICS]:
        rule = _metric(raw, problems)
        if rule and all(m.name != rule.name for m in metrics):
            metrics.append(rule)
    return WatchSettings(
        health_url=health,
        source=source,
        auto_rollback=str(env.get("CICD_AUTO_ROLLBACK") or "") == "true",
        window_minutes=_duration(
            data,
            env,
            "window_minutes",
            "CICD_MONITOR_WINDOW_MINUTES",
            DEFAULT_WINDOW_MINUTES,
        ),
        deploy_wait_minutes=_duration(
            data,
            env,
            "deploy_wait_minutes",
            "CICD_MONITOR_DEPLOY_WAIT_MINUTES",
            DEFAULT_DEPLOY_WAIT_MINUTES,
        ),
        stabilization_seconds=_duration(
            data, env, "stabilization_seconds", "", DEFAULT_STABILIZATION_SECONDS
        ),
        interval_seconds=_duration(
            data, env, "interval_seconds", "", DEFAULT_INTERVAL_SECONDS
        ),
        metrics=tuple(metrics),
        problems=tuple(problems),
        revert_pr=revert_pr,
        explain_incident=explain_incident,
    )
