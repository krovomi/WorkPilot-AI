"""The password reset email and the lifetime of a reset link.

The link is in the email's text and, escaped, in its HTML part; a send that
fails is an :class:`EmailError` that never carries the link into the log.
"""

from __future__ import annotations

import smtplib
from datetime import UTC, datetime, timedelta

import pytest
from server import config as server_config

LINK = "https://wp.example.test/reset-password?token=abc<&>def"


@pytest.fixture(autouse=True)
def _settings(monkeypatch):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", "x" * 48)
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


def _smtp(monkeypatch) -> None:
    monkeypatch.setenv("WORKPILOT_SMTP_HOST", "smtp.example.test")
    monkeypatch.setenv("WORKPILOT_SMTP_FROM", "WorkPilot <noreply@example.test>")
    server_config.reset_settings_cache()


def test_the_message_carries_the_link_in_both_languages():
    from server.services.email import _build_password_reset_message

    msg = _build_password_reset_message(
        server_config.get_settings(), "alice@example.test", LINK, 45
    )
    assert msg["To"] == "alice@example.test"
    text = msg.get_body(preferencelist=("plain",)).get_content()
    html = msg.get_body(preferencelist=("html",)).get_content()
    assert LINK in text
    assert "45 minutes" in text
    assert "Mot de passe oublié" in text and "Forgot password?" in text
    assert "token=abc&lt;&amp;&gt;def" in html
    assert "<&>" not in html


async def test_no_smtp_is_an_email_error():
    from server.services.email import EmailError, send_password_reset_email

    with pytest.raises(EmailError, match="SMTP is not configured"):
        await send_password_reset_email("alice@example.test", LINK, 60)


async def test_a_send_that_fails_never_logs_the_link(monkeypatch, caplog):
    from server.services import email

    _smtp(monkeypatch)

    def refuse(*_args) -> None:
        raise smtplib.SMTPException("relay refused")

    monkeypatch.setattr(email, "_send_sync", refuse)
    with pytest.raises(email.EmailError):
        await email.send_password_reset_email("alice@example.test", LINK, 60)
    assert "token=" not in caplog.text


async def test_a_sent_email_is_logged_by_address_only(monkeypatch, caplog):
    import logging

    from server.services import email

    _smtp(monkeypatch)
    sent = []
    monkeypatch.setattr(email, "_send_sync", lambda _s, msg: sent.append(msg))
    with caplog.at_level(logging.INFO):
        await email.send_password_reset_email("alice@example.test", LINK, 60)
    assert len(sent) == 1
    assert "alice@example.test" in caplog.text
    assert "token=" not in caplog.text


@pytest.mark.parametrize(
    ("setting", "minutes"), [("1", 5), ("90", 90), ("99999", 1440)]
)
def test_the_lifetime_stays_within_bounds(monkeypatch, setting, minutes):
    from server.auth.password_reset import ttl

    monkeypatch.setenv("WORKPILOT_PASSWORD_RESET_TTL_MINUTES", setting)
    server_config.reset_settings_cache()
    assert ttl() == timedelta(minutes=minutes)


def test_a_naive_time_reads_as_utc():
    from server.auth.password_reset import _aware

    naive = datetime(2026, 11, 22, 10, 0)
    assert _aware(naive) == naive.replace(tzinfo=UTC)
    aware = datetime(2026, 11, 22, 10, 0, tzinfo=UTC)
    assert _aware(aware) is aware
