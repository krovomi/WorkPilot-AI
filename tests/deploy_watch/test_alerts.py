"""Alerts of a bad watch: Slack, PagerDuty, e-mail (#366)."""

from __future__ import annotations

import json
import smtplib

import pytest
from deploy_watch import alerts
from deploy_watch.alerts import alert_text, send_alerts

SLACK = "https://hooks.slack.com/services/T000/B000/test0000"
PD = "https://events.pagerduty.com/v2/enqueue"
PD_KEY = "a" * 32
REVERT = "https://github.com/acme/shop/pull/99"
LAST_GOOD = "https://ci.example/job/deploy/41/"


def _state(**over) -> dict:
    state = {
        "run_id": "1763200000000",
        "verdict": "critical",
        "rollback": "failed",
        "plan": {"target_url": LAST_GOOD},
        "revert_pr": {"status": "opened", "url": REVERT},
        "migrations": ["db/migrate/20261115_add.rb"],
        "incident": {
            "summary": {
                "health": {"checks": 3, "failed": 2},
                "metrics": [
                    {
                        "name": "<!channel> errors",
                        "baseline": 0.01,
                        "worst": 0.2,
                        "worst_change_pct": 1900,
                        "level": "critical",
                    },
                    {"name": "latency", "baseline": 1, "worst": 1, "level": "ok"},
                    "junk",
                ],
            }
        },
    }
    state.update(over)
    return state


class FakeSmtp:
    def __init__(self, starttls: bool = True, fail: bool = False):
        self.calls: list[tuple] = []
        self.starttls_supported = starttls
        self.fail = fail
        self.sent = None

    def factory(self, host, port, implicit_tls, context):
        self.calls.append(("open", host, port, implicit_tls))
        return self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def ehlo(self):
        self.calls.append(("ehlo",))

    def has_extn(self, name):
        return self.starttls_supported and name == "starttls"

    def starttls(self, context):
        self.calls.append(("starttls",))

    def login(self, user, password):
        self.calls.append(("login", user))

    def send_message(self, message):
        if self.fail:
            raise smtplib.SMTPRecipientsRefused({})
        self.sent = message


EMAIL_ENV = {
    "CICD_ALERT_SMTP_HOST": "smtp.example.com",
    "CICD_ALERT_EMAIL_FROM": "ci@example.com",
    "CICD_ALERT_EMAIL_TO": "oncall@example.com, lead@example.com",
    "CICD_ALERT_SMTP_USER": "ci",
    "CICD_ALERT_SMTP_PASSWORD": "smtp-test-0000",
}


class TestText:
    def test_critical_in_english(self):
        title, lines = alert_text(_state(), "Shop", "en")
        assert title == "Deployment critical: Shop"
        text = "\n".join(lines)
        assert "two critical samples in a row" in text
        assert "roll back by hand now" in text
        assert f"Last good run: {LAST_GOOD}" in text
        assert f"Revert PR: {REVERT}" in text
        assert "db/migrate/20261115_add.rb" in text
        assert "failed 2 of 3 times" in text
        assert "<!channel> errors: 0.01 before, 0.2 at worst (1900 %)." in text
        assert "latency" not in text

    def test_warning_in_french(self):
        state = _state(
            verdict="warning",
            rollback=None,
            revert_pr={"status": "failed", "url": ""},
            migrations=None,
            incident={"summary": {"metrics": [{"name": "x", "level": "warning"}]}},
        )
        title, lines = alert_text(state, "Boutique", "fr")
        assert title == "Déploiement dégradé : Boutique"
        assert lines[1] == "La PR de revert n'a pas pu être ouverte."
        assert lines[2] == "x : ? avant, ? au pire (? %)."

    def test_unsafe_links_are_left_out(self):
        state = _state(
            plan={"target_url": "javascript:alert(1)"},
            revert_pr={"status": "exists", "url": "http://evil.example"},
            rollback="started",
            incident=None,
        )
        _title, lines = alert_text(state, "Shop", "de")
        assert lines == [
            "Run 1763200000000: two critical samples in a row after the deployment.",
            "The rollback started.",
            "Database migrations in the change: db/migrate/20261115_add.rb.",
        ]


class TestSend:
    def test_nothing_for_a_good_watch_or_no_channel(self, fake_fetch):
        assert (
            send_alerts(
                _state(verdict="ok"),
                {"CICD_ALERT_SLACK_WEBHOOK_URL": SLACK},
                project="p",
                language="en",
                offline=False,
            )
            == {}
        )
        assert (
            send_alerts(
                _state(),
                {},
                project="p",
                language="en",
                offline=False,
                fetch=fake_fetch(),
            )
            == {}
        )

    def test_slack(self, fake_fetch):
        fetch = fake_fetch({SLACK: (200, b"ok"), PD: (202, {"status": "success"})})
        env = {
            "CICD_ALERT_SLACK_WEBHOOK_URL": SLACK,
            "CICD_ALERT_PAGERDUTY_ROUTING_KEY": PD_KEY,
        }
        outcome = send_alerts(
            _state(), env, project="Shop", language="en", offline=False, fetch=fetch
        )
        assert outcome == {"slack": "sent", "pagerduty": "sent"}
        slack = json.loads(fetch.requests[0].data)
        assert slack["text"].startswith("*Deployment critical: Shop*\n")
        # The repository's metric name cannot ping the channel.
        assert "&lt;!channel&gt; errors" in slack["text"]
        assert "<!channel>" not in slack["text"]

    def test_pagerduty_event(self, fake_fetch):
        eu = "https://events.eu.pagerduty.com/v2/enqueue"
        fetch = fake_fetch({eu: (202, {})})
        env = {
            "CICD_ALERT_PAGERDUTY_ROUTING_KEY": PD_KEY,
            "CICD_ALERT_PAGERDUTY_REGION": "EU",
        }
        assert send_alerts(
            _state(), env, project="Shop", language="en", offline=False, fetch=fetch
        ) == {"pagerduty": "sent"}
        event = json.loads(fetch.requests[0].data)
        assert event["routing_key"] == PD_KEY
        assert event["dedup_key"] == "workpilot-deploy-1763200000000"
        assert event["payload"]["severity"] == "critical"
        assert event["payload"]["custom_details"]["rollback"] == "failed"
        assert event["links"] == [{"href": REVERT, "text": "Revert PR"}]
        no_link = fake_fetch({PD: (202, {})})
        send_alerts(
            _state(revert_pr=None),
            {"CICD_ALERT_PAGERDUTY_ROUTING_KEY": PD_KEY},
            project="Shop",
            language="en",
            offline=False,
            fetch=no_link,
        )
        assert "links" not in json.loads(no_link.requests[0].data)

    def test_pagerduty_pages_only_a_critical_verdict(self, fake_fetch):
        env = {"CICD_ALERT_PAGERDUTY_ROUTING_KEY": PD_KEY}
        assert (
            send_alerts(
                _state(verdict="warning"),
                env,
                project="p",
                language="en",
                offline=False,
                fetch=fake_fetch(),
            )
            == {}
        )

    @pytest.mark.parametrize(
        ("env", "expected"),
        [
            (
                {"CICD_ALERT_SLACK_WEBHOOK_URL": "ftp://hooks.example"},
                {"slack": "invalid"},
            ),
            (
                {"CICD_ALERT_SLACK_WEBHOOK_URL": "http://hooks.example"},
                {"slack": "invalid"},
            ),
            ({"CICD_ALERT_PAGERDUTY_ROUTING_KEY": "short"}, {"pagerduty": "invalid"}),
            (
                {
                    "CICD_ALERT_PAGERDUTY_ROUTING_KEY": PD_KEY,
                    "CICD_ALERT_PAGERDUTY_REGION": "mars",
                },
                {"pagerduty": "invalid"},
            ),
            ({"CICD_ALERT_SLACK_WEBHOOK_URL": SLACK}, {"slack": "failed"}),
        ],
    )
    def test_refused_or_failed(self, fake_fetch, env, expected):
        fetch = fake_fetch({SLACK: (500, b"")})
        assert (
            send_alerts(
                _state(), env, project="p", language="en", offline=False, fetch=fetch
            )
            == expected
        )

    def test_unreachable(self, fake_fetch):
        env = {"CICD_ALERT_SLACK_WEBHOOK_URL": SLACK}
        assert send_alerts(
            _state(),
            env,
            project="p",
            language="en",
            offline=False,
            fetch=fake_fetch({}),
        ) == {"slack": "failed"}

    def test_strict_offline(self, fake_fetch):
        local = "http://10.0.0.5/hooks/test0000"
        fetch = fake_fetch({local: (200, b"ok")})
        env = {
            "CICD_ALERT_SLACK_WEBHOOK_URL": SLACK,
            "CICD_ALERT_PAGERDUTY_ROUTING_KEY": PD_KEY,
            **EMAIL_ENV,
        }
        smtp = FakeSmtp()
        assert send_alerts(
            _state(),
            env,
            project="p",
            language="en",
            offline=True,
            fetch=fetch,
            smtp=smtp.factory,
        ) == {"slack": "offline", "pagerduty": "offline", "email": "offline"}
        assert fetch.requests == [] and smtp.calls == []
        local_env = {
            "CICD_ALERT_SLACK_WEBHOOK_URL": local,
            **EMAIL_ENV,
            "CICD_ALERT_SMTP_HOST": "127.0.0.1",
        }
        assert send_alerts(
            _state(),
            local_env,
            project="p",
            language="en",
            offline=True,
            fetch=fetch,
            smtp=smtp.factory,
        ) == {"slack": "sent", "email": "sent"}


class TestEmail:
    def _send(self, smtp: FakeSmtp, **env) -> dict:
        return send_alerts(
            _state(),
            {**EMAIL_ENV, **env},
            project="Shop",
            language="en",
            offline=False,
            smtp=smtp.factory,
        )

    def test_starttls_then_login(self):
        smtp = FakeSmtp()
        assert self._send(smtp) == {"email": "sent"}
        assert smtp.calls == [
            ("open", "smtp.example.com", 587, False),
            ("ehlo",),
            ("starttls",),
            ("ehlo",),
            ("login", "ci"),
        ]
        assert smtp.sent["Subject"] == "Deployment critical: Shop"
        assert smtp.sent["To"] == "oncall@example.com, lead@example.com"
        assert "two critical samples" in smtp.sent.get_content()

    def test_implicit_tls_without_login(self):
        smtp = FakeSmtp()
        assert self._send(
            smtp, CICD_ALERT_SMTP_PORT="465", CICD_ALERT_SMTP_PASSWORD=""
        ) == {"email": "sent"}
        assert smtp.calls == [("open", "smtp.example.com", 465, True)]

    def test_no_clear_text_over_the_network(self):
        smtp = FakeSmtp(starttls=False)
        assert self._send(smtp) == {"email": "failed"}
        assert ("login", "ci") not in smtp.calls and smtp.sent is None
        local = FakeSmtp(starttls=False)
        assert self._send(local, CICD_ALERT_SMTP_HOST="localhost") == {"email": "sent"}

    def test_refused_by_the_server(self):
        assert self._send(FakeSmtp(fail=True)) == {"email": "failed"}

    @pytest.mark.parametrize(
        "env",
        [
            {"CICD_ALERT_EMAIL_TO": "not an address"},
            {"CICD_ALERT_EMAIL_TO": ",".join(f"a{i}@example.com" for i in range(11))},
            {"CICD_ALERT_EMAIL_TO": " , "},
            {"CICD_ALERT_EMAIL_FROM": "ci@example.com\nBcc: x@evil.example"},
            {"CICD_ALERT_SMTP_HOST": "smtp.example.com/x"},
            {"CICD_ALERT_SMTP_HOST": ""},
            {"CICD_ALERT_SMTP_PORT": "99999"},
            {"CICD_ALERT_SMTP_PORT": "smtp"},
        ],
    )
    def test_invalid(self, env):
        smtp = FakeSmtp()
        assert self._send(smtp, **env) == {"email": "invalid"}
        assert smtp.calls == []


class TestDefaultSmtp:
    def test_plain_and_implicit_tls(self, monkeypatch):
        opened = []
        monkeypatch.setattr(
            smtplib, "SMTP", lambda *a, **k: opened.append(("SMTP", a, k))
        )
        monkeypatch.setattr(
            smtplib,
            "SMTP_SSL",
            lambda *a, **k: opened.append(("SMTP_SSL", a, k["context"])),
        )
        context = object()
        alerts._default_smtp("h", 587, False, context)  # type: ignore[arg-type]
        alerts._default_smtp("h", 465, True, context)  # type: ignore[arg-type]
        assert opened[0] == ("SMTP", ("h", 587), {"timeout": alerts.SMTP_TIMEOUT})
        assert opened[1] == ("SMTP_SSL", ("h", 465), context)
