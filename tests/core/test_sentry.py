"""Error reports of the backend (`core.sentry`), with the real Sentry SDK.

Only the transport is a stand-in: it keeps the envelopes the SDK would send,
so a test reads what would have left the machine. What matters is when
reporting is on (a DSN, and a packaged app or SENTRY_DEV) and that no
username in a path reaches Sentry.
"""

from __future__ import annotations

import json
import logging
import sys

import pytest
import sentry_sdk
from core import sentry
from sentry_sdk.transport import Transport

DSN = "https://public0000@o0.ingest.example.test/1"  # pragma: allowlist secret
HOME_PATH = "/home/dana/projects/shop/app.py"
REAL_INIT = sentry_sdk.init


class Kept(Transport):
    def __init__(self, options=None) -> None:
        super().__init__(options)
        self.events: list[dict] = []

    def capture_envelope(self, envelope) -> None:
        for item in envelope.items:
            if item.type == "event":
                self.events.append(json.loads(item.get_bytes()))


@pytest.fixture
def reports(monkeypatch):
    """Sentry as the app starts it, with every envelope kept here."""
    for name in (
        "SENTRY_DSN",
        "SENTRY_DEV",
        "SENTRY_ENVIRONMENT",
        "SENTRY_TRACES_SAMPLE_RATE",
        "WORKPILOT_PACKAGED_APP",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(sentry, "_sentry_initialized", False)
    monkeypatch.setattr(sentry, "_sentry_enabled", False)
    transport = Kept()
    started: list[dict] = []

    def init(**options):
        started.append(options)
        return REAL_INIT(transport=transport, **options)

    monkeypatch.setattr(sentry_sdk, "init", init)
    yield transport, started
    sentry_sdk.get_global_scope().set_client(None)
    sentry_sdk.get_isolation_scope().clear()


def enable(monkeypatch, **env: str) -> None:
    monkeypatch.setenv("SENTRY_DSN", DSN)
    for name, value in env.items():
        monkeypatch.setenv(name, value)


class TestWhenReportingIsOn:
    def test_without_a_dsn_nothing_is_reported(self, reports):
        assert sentry.init_sentry() is False
        assert sentry.is_initialized() is True
        assert sentry.is_enabled() is False
        assert reports[1] == []

    def test_a_dsn_alone_in_development_reports_nothing(self, reports, monkeypatch):
        monkeypatch.setenv("SENTRY_DSN", DSN)

        assert sentry.init_sentry() is False
        assert reports[1] == []

    def test_the_packaged_app_reports_to_production(self, reports, monkeypatch):
        enable(monkeypatch, WORKPILOT_PACKAGED_APP="1")

        assert sentry.init_sentry(component="github-runner") is True

        [options] = reports[1]
        assert options["environment"] == "production"
        assert options["release"] == f"workpilot@{sentry._get_version()}"
        assert options["traces_sample_rate"] == sentry.PRODUCTION_TRACE_SAMPLE_RATE
        assert options["send_default_pii"] is False
        # A second call does not start the SDK again.
        assert sentry.init_sentry() is True
        assert len(reports[1]) == 1

    @pytest.mark.parametrize(
        ("rate", "used"), [("0.5", 0.5), ("7", 0.1), ("often", 0.1)]
    )
    def test_the_sample_rate_is_taken_only_between_0_and_1(
        self, reports, monkeypatch, rate, used
    ):
        enable(
            monkeypatch,
            SENTRY_DEV="true",
            SENTRY_TRACES_SAMPLE_RATE=rate,
            SENTRY_ENVIRONMENT="staging",
        )

        assert sentry.init_sentry() is True

        [options] = reports[1]
        assert options["traces_sample_rate"] == used
        assert options["environment"] == "staging"

    def test_force_enable_needs_no_packaged_app(self, reports, monkeypatch):
        monkeypatch.setenv("SENTRY_DSN", DSN)

        assert sentry.init_sentry(force_enable=True) is True
        assert reports[1][0]["environment"] == "development"

    def test_a_malformed_dsn_turns_reporting_off(self, reports, monkeypatch):
        enable(monkeypatch, SENTRY_DEV="1")
        monkeypatch.setenv("SENTRY_DSN", "not a dsn")
        # The SDK itself reads the DSN: no stand-in transport to skip that.
        monkeypatch.setattr(sentry_sdk, "init", REAL_INIT)

        assert sentry.init_sentry() is False
        assert sentry.is_enabled() is False

    def test_without_the_sdk_reporting_is_off(self, reports, monkeypatch):
        enable(monkeypatch, SENTRY_DEV="yes")
        monkeypatch.setitem(sys.modules, "sentry_sdk", None)

        assert sentry.init_sentry() is False


class TestWhatIsSent:
    @pytest.fixture
    def on(self, reports, monkeypatch):
        enable(monkeypatch, SENTRY_DEV="true")
        assert sentry.init_sentry() is True
        return reports[0]

    def test_an_exception_is_sent_without_the_username_in_its_paths(self, on):
        project_dir = HOME_PATH  # a local of the failing frame, as in a build

        sentry.set_tag("project", HOME_PATH)
        sentry.set_tag("attempt", 3)
        sentry.set_context("spec", {"dir": HOME_PATH, "steps": [HOME_PATH, 1]})
        try:
            raise FileNotFoundError(f"missing {project_dir}")
        except FileNotFoundError as error:
            sentry.capture_exception(error, file=HOME_PATH, count=2)
        sentry_sdk.flush()

        [event] = on.events
        text = json.dumps(event)
        assert "dana" not in text
        assert event["tags"]["project"] == "/home/***/projects/shop/app.py"
        assert event["tags"]["component"] == "backend"
        assert event["contexts"]["spec"]["steps"] == [
            "/home/***/projects/shop/app.py",
            1,
        ]
        assert event["extra"]["file"] == "/home/***/projects/shop/app.py"
        assert event["extra"]["count"] == 2
        [exception] = event["exception"]["values"]
        assert exception["value"] == "missing /home/***/projects/shop/app.py"
        frame = exception["stacktrace"]["frames"][-1]
        assert frame["vars"]["project_dir"] == "'/home/***/projects/shop/app.py'"

    def test_a_message_and_its_log_breadcrumbs_are_masked(self, on):
        logging.getLogger("workpilot.test").info("opened %s", HOME_PATH)
        sentry.capture_message(
            f"build stopped in {HOME_PATH}", level="warning", where={"p": HOME_PATH}
        )
        sentry_sdk.flush()

        [event] = on.events
        assert "dana" not in json.dumps(event)
        assert event["level"] == "warning"
        assert event["extra"]["where"] == {"p": "/home/***/projects/shop/app.py"}

    def test_an_error_log_line_becomes_a_masked_event(self, on):
        logging.getLogger("workpilot.test").error("cannot write %s", HOME_PATH)
        sentry_sdk.flush()

        [event] = on.events
        assert "dana" not in json.dumps(event)

    def test_a_failing_sdk_does_not_break_the_caller(self, on, monkeypatch):
        def broken(*args, **kwargs):
            raise RuntimeError("transport gone")

        monkeypatch.setattr(sentry_sdk, "capture_exception", broken)
        monkeypatch.setattr(sentry_sdk, "capture_message", broken)
        monkeypatch.setattr(sentry_sdk, "set_context", broken)
        monkeypatch.setattr(sentry_sdk, "set_tag", broken)

        sentry.capture_exception(ValueError("x"))
        sentry.capture_message("x")
        sentry.set_context("spec", {})
        sentry.set_tag("k", "v")
        sentry_sdk.flush()

        # Each failure is logged, and the log line itself is what reaches Sentry.
        assert [e["logentry"]["message"] for e in on.events] == [
            "[Sentry] Failed to capture exception: transport gone",
            "[Sentry] Failed to capture message: transport gone",
        ]


class TestWhileOff:
    def test_reporting_off_sends_nothing_and_logs_the_exception(self, reports, caplog):
        with caplog.at_level(logging.ERROR, logger=sentry.__name__):
            sentry.capture_exception(ValueError("boom"))
        sentry.capture_message("hello")
        sentry.set_context("spec", {"dir": HOME_PATH})
        sentry.set_tag("k", "v")

        assert "exception not captured: boom" in caplog.text
        assert reports[0].events == []

    def test_an_event_reaching_a_disabled_backend_is_dropped(self):
        assert sentry._before_send({"message": "x"}, {}) is None


class TestMasking:
    @pytest.mark.parametrize(
        ("raw", "masked"),
        [
            ("/Users/dana/src/a.py", "/Users/***/src/a.py"),
            ("C:\\Users\\dana\\src\\a.py", "C:\\Users\\***\\src\\a.py"),
            ("/home/dana", "/home/***"),
            ("/mnt/c/Users/dana/src", "/mnt/c/Users/***/src"),
            ("/srv/app/a.py", "/srv/app/a.py"),
            ("", ""),
        ],
    )
    def test_a_username_in_a_path_is_masked(self, raw, masked):
        assert sentry._mask_user_paths(raw) == masked

    def test_a_deep_structure_stops_being_walked(self):
        deep: object = HOME_PATH
        for _ in range(60):
            deep = [deep]

        masked = sentry._mask_object_paths({"a": deep, "n": None, "k": 1})

        assert masked["n"] is None and masked["k"] == 1
        assert "dana" in json.dumps(masked)  # beyond the depth limit, left as is

    def test_every_part_of_an_event_is_masked(self, monkeypatch):
        monkeypatch.setattr(sentry, "_sentry_enabled", True)
        event = {
            "exception": {
                "values": [
                    {
                        "value": HOME_PATH,
                        "stacktrace": {
                            "frames": [{"filename": HOME_PATH, "abs_path": HOME_PATH}]
                        },
                    }
                ]
            },
            "breadcrumbs": {
                "values": [{"message": HOME_PATH, "data": {"p": HOME_PATH}}]
            },
            "message": HOME_PATH,
            "user": {"id": "dana"},
        }

        sent = sentry._before_send(event, {})

        assert "dana" not in json.dumps(sent)
        assert sent["user"] == {}


class TestVersion:
    def test_the_version_is_the_frontends(self, tmp_path):
        package = tmp_path / "package.json"
        package.write_text('{"version": "1.5.1"}', encoding="utf-8")

        assert sentry._get_version(package) == "1.5.1"

    def test_a_missing_or_broken_package_json_reads_as_0_0_0(self, tmp_path):
        broken = tmp_path / "broken.json"
        broken.write_text("{", encoding="utf-8")

        assert sentry._get_version(tmp_path / "gone.json") == "0.0.0"
        assert sentry._get_version(broken) == "0.0.0"

    def test_the_shipped_package_json_is_read(self):
        assert sentry._get_version() != "0.0.0"
