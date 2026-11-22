"""Settings, thresholds and verdicts of the deployment watch (#366)."""

from __future__ import annotations

from pathlib import Path

import pytest
from deploy_watch.config import (
    CONFIG_FILE,
    MAX_METRICS,
    Kind,
    MetricRule,
    Worse,
    is_local_host,
    load_settings,
    valid_url,
)
from deploy_watch.evaluate import (
    HealthResult,
    Level,
    MetricCheck,
    compare,
    sample_level,
    verdict,
)


def _write(project: Path, text: str) -> None:
    path = project / CONFIG_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _rule(**over) -> MetricRule:
    base = {
        "name": "errors",
        "kind": Kind.ERROR_RATE,
        "query": "q",
        "warning_pct": 50.0,
        "critical_pct": 100.0,
        "worse": Worse.UP,
        "min_absolute": 0.0,
    }
    base.update(over)
    return MetricRule(**base)


class TestUrls:
    def test_valid_url(self):
        assert valid_url("https://example.com/health")
        assert valid_url("http://10.0.0.2:9090")
        assert not valid_url("ftp://example.com")
        assert not valid_url("https://user:pw@example.com")
        assert not valid_url("https:///nohost")
        assert not valid_url("https://exa mple.com")
        assert not valid_url("http://[::1")

    def test_local_hosts(self):
        assert is_local_host("http://localhost:9090")
        assert is_local_host("http://127.0.0.1")
        assert is_local_host("http://[::1]:9090")
        assert is_local_host("http://192.168.1.4")
        assert not is_local_host("https://prometheus.example.com")
        assert not is_local_host("http://8.8.8.8")


class TestLoadSettings:
    def test_nothing_configured(self, tmp_path):
        settings = load_settings(tmp_path, {})
        assert not settings.configured
        assert settings.problems == ()
        assert settings.window_minutes == 15

    def test_endpoints_from_settings_only(self, tmp_path):
        _write(
            tmp_path,
            "health_url: https://evil.example\nprometheus_url: https://evil.example\n",
        )
        settings = load_settings(
            tmp_path,
            {
                "CICD_MONITOR_HEALTH_URL": "https://app.example/health",
                "CICD_MONITOR_PROMETHEUS_URL": "https://prom.example/",
                "CICD_MONITOR_PROMETHEUS_TOKEN": "tok-0000",
                "CICD_AUTO_ROLLBACK": "true",
            },
        )
        assert settings.health_url == "https://app.example/health"
        assert settings.source is not None
        assert (settings.source.kind, settings.source.url) == (
            "prometheus",
            "https://prom.example",
        )
        assert settings.auto_rollback is True
        assert "tok-0000" not in repr(settings)
        assert settings.configured

    def test_bad_urls_are_dropped(self, tmp_path):
        settings = load_settings(
            tmp_path,
            {
                "CICD_MONITOR_HEALTH_URL": "file:///etc/passwd",
                "CICD_MONITOR_PROMETHEUS_URL": "javascript:x",
            },
        )
        assert settings.health_url == ""
        assert settings.source is None
        assert len(settings.problems) == 2

    def test_metrics_and_durations(self, tmp_path):
        _write(
            tmp_path,
            """
window_minutes: 1000
deploy_wait_minutes: 2
stabilization_seconds: true
interval_seconds: 5
metrics:
  - name: errors
    kind: error_rate
    query: sum(rate(http_errors[5m]))
  - name: errors
    kind: error_rate
    query: duplicate
  - name: orders
    query: sum(rate(orders[5m]))
    worse: down
    warning: -10
    critical: -20
    min_absolute: 1
  - name: p95
    kind: latency
    query: histogram_quantile(0.95, x)
    warning: 80
    critical: 60
  - name: bad
    kind: nope
    query: x
  - name: noquery
  - name: weird
    query: x
    worse: sideways
  - name: long
    query: "%s"
  - name: canary
    query: stable
    canary_query: " canary "
  - name: badcanary
    query: stable
    canary_query: 3
  - not a mapping
"""
            % ("x" * 2001),
        )
        settings = load_settings(
            tmp_path,
            {
                "CICD_MONITOR_PROMETHEUS_URL": "http://localhost:9090",
                "CICD_MONITOR_WINDOW_MINUTES": "30",
            },
        )
        assert settings.window_minutes == 30
        assert settings.deploy_wait_minutes == 2
        assert settings.stabilization_seconds == 120
        assert settings.interval_seconds == 10
        assert [m.name for m in settings.metrics] == ["errors", "orders", "canary"]
        assert settings.metrics[2].canary_query == "canary"
        assert settings.metrics[0].canary_query == ""
        orders = settings.metrics[1]
        assert orders.kind is Kind.CUSTOM
        assert orders.worse is Worse.DOWN
        assert (orders.warning_pct, orders.critical_pct, orders.min_absolute) == (
            10,
            20,
            1,
        )
        errors = settings.metrics[0]
        assert errors.min_absolute == 0.005
        assert len(settings.problems) == 7

    def test_env_duration_clamped_and_yaml_window_used(self, tmp_path):
        _write(tmp_path, "window_minutes: 20\n")
        settings = load_settings(tmp_path, {"CICD_MONITOR_DEPLOY_WAIT_MINUTES": "999"})
        assert settings.window_minutes == 20
        assert settings.deploy_wait_minutes == 120

    def test_too_many_metrics(self, tmp_path):
        lines = "\n".join(
            f"  - {{name: m{i}, query: q{i}}}" for i in range(MAX_METRICS + 3)
        )
        _write(tmp_path, f"metrics:\n{lines}\n")
        settings = load_settings(tmp_path, {})
        assert len(settings.metrics) == MAX_METRICS
        assert any("only the first" in p for p in settings.problems)

    @pytest.mark.parametrize(
        ("text", "problem"),
        [
            ("metrics: [", "not valid YAML"),
            ("- a\n- b\n", "not a mapping"),
            ("metrics: nope\n", "metrics: not a list"),
        ],
    )
    def test_bad_files(self, tmp_path, text, problem):
        _write(tmp_path, text)
        assert any(problem in p for p in load_settings(tmp_path, {}).problems)

    def test_empty_file(self, tmp_path):
        _write(tmp_path, "")
        assert load_settings(tmp_path, {}).problems == ()

    def test_large_file_and_symlink_refused(self, tmp_path):
        _write(tmp_path, "#" * (70 * 1024))
        assert any("too large" in p for p in load_settings(tmp_path, {}).problems)
        other = tmp_path / "elsewhere.yaml"
        other.write_text("window_minutes: 3\n", encoding="utf-8")
        (tmp_path / CONFIG_FILE).unlink()
        (tmp_path / CONFIG_FILE).symlink_to(other)
        assert load_settings(tmp_path, {}).window_minutes == 15

    def test_undecodable_file(self, tmp_path):
        path = tmp_path / CONFIG_FILE
        path.parent.mkdir(parents=True)
        path.write_bytes(b"\xff\xfe\x00bad")
        assert any("not valid YAML" in p for p in load_settings(tmp_path, {}).problems)


class TestCompare:
    def test_unknown_without_values(self):
        assert compare(_rule(), None, 1.0).level is Level.UNKNOWN
        assert compare(_rule(), 1.0, None).level is Level.UNKNOWN

    def test_levels(self):
        assert compare(_rule(), 1.0, 1.2).level is Level.OK
        warning = compare(_rule(), 1.0, 1.6)
        assert (warning.level, warning.change_pct) == (Level.WARNING, 60.0)
        assert compare(_rule(), 1.0, 2.0).level is Level.CRITICAL
        assert compare(_rule(), 1.0, 0.5).level is Level.OK

    def test_throughput_drops(self):
        rule = _rule(
            name="rps",
            kind=Kind.THROUGHPUT,
            worse=Worse.DOWN,
            warning_pct=15,
            critical_pct=30,
        )
        assert compare(rule, 100.0, 80.0).level is Level.WARNING
        assert compare(rule, 100.0, 60.0).level is Level.CRITICAL
        assert compare(rule, 100.0, 140.0).level is Level.OK

    def test_noise_floor_and_zero_baseline(self):
        rule = _rule(min_absolute=0.005)
        assert compare(rule, 0.0, 0.004).level is Level.OK
        assert compare(rule, 0.0, 0.004).change_pct is None
        zero = compare(rule, 0.0, 0.02)
        assert (zero.level, zero.change_pct) == (Level.CRITICAL, None)
        assert compare(rule, 0.0, 0.0).level is Level.OK

    def test_to_dict(self):
        assert compare(_rule(), 1.0, 2.0).to_dict()["level"] == "critical"
        assert HealthResult(ok=True, status=200).to_dict() == {
            "ok": True,
            "status": 200,
            "error": "",
        }


def _check(level: Level) -> MetricCheck:
    return MetricCheck("m", "custom", 1.0, 1.0, 0.0, level)


class TestSampleAndVerdict:
    def test_sample_level(self):
        assert sample_level([], HealthResult(ok=False)) is Level.CRITICAL
        assert sample_level([_check(Level.CRITICAL)], None) is Level.CRITICAL
        assert (
            sample_level([_check(Level.WARNING)], HealthResult(ok=True))
            is Level.WARNING
        )
        assert sample_level([], HealthResult(ok=True)) is Level.OK
        assert sample_level([_check(Level.OK)], None) is Level.OK
        assert sample_level([_check(Level.UNKNOWN)], None) is Level.UNKNOWN

    def test_verdict_needs_two_critical_samples_in_a_row(self):
        assert verdict([Level.CRITICAL, Level.OK, Level.CRITICAL]) is Level.WARNING
        assert verdict([Level.OK, Level.CRITICAL, Level.CRITICAL]) is Level.CRITICAL
        assert verdict([Level.OK, Level.OK]) is Level.OK
        assert verdict([Level.UNKNOWN]) is Level.UNKNOWN
        assert verdict([]) is Level.UNKNOWN
