"""Slack / Teams webhooks (`integrations/team_bot.py`), posted to a local server."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from integrations import team_bot


@pytest.fixture
def webhook():
    received: list[dict] = []
    status = {"code": 200}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):  # noqa: N802
            length = int(self.headers["content-length"])
            received.append(
                {
                    "content_type": self.headers["content-type"],
                    "body": json.loads(self.rfile.read(length)),
                }
            )
            self.send_response(status["code"])
            self.send_header("content-length", "0")
            self.end_headers()

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}/hook", received, status
    finally:
        httpd.shutdown()
        httpd.server_close()


PAYLOAD = team_bot.NotificationPayload(
    event="cost_alert",
    title="Budget at 90 %",
    summary="Projected spend crosses the threshold.",
    fields={"spent": 9, "budget": "10 $"},
    severity="warning",
)


def test_slack_body_is_an_attachment_with_short_fields():
    body = team_bot.build_body("slack", PAYLOAD)
    attachment = body["attachments"][0]
    assert body["text"] == "Budget at 90 %"
    assert attachment["color"] == "#f5a623"
    assert attachment["footer"] == "WorkPilot AI · cost_alert"
    assert attachment["fields"] == [
        {"title": "spent", "value": "9", "short": True},
        {"title": "budget", "value": "10 $", "short": True},
    ]


def test_teams_body_is_a_message_card():
    body = team_bot.build_body("teams", PAYLOAD)
    assert body["@type"] == "MessageCard"
    assert body["themeColor"] == "f5a623"
    assert body["sections"] == [
        {
            "facts": [
                {"name": "spent", "value": "9"},
                {"name": "budget", "value": "10 $"},
            ]
        }
    ]
    bare = team_bot.NotificationPayload(event="custom", title="t", summary="s")
    assert team_bot.build_body("teams", bare)["sections"] == []


def test_unknown_kind_is_refused():
    with pytest.raises(ValueError, match="unknown bot kind"):
        team_bot.build_body("discord", PAYLOAD)  # type: ignore[arg-type]


def test_payload_to_dict_keeps_every_field():
    assert team_bot.NotificationPayload("custom", "t", "s").to_dict() == {
        "event": "custom",
        "title": "t",
        "summary": "s",
        "fields": {},
        "severity": "info",
    }


@pytest.mark.parametrize("kind", ["slack", "teams"])
def test_delivered_notification_is_true(webhook, kind):
    url, received, _status = webhook
    assert (
        team_bot.send_notification(team_bot.TeamBotConfig(kind, url), PAYLOAD) is True
    )
    assert received[0]["content_type"] == "application/json"
    assert received[0]["body"] == team_bot.build_body(kind, PAYLOAD)


def test_refused_delivery_is_false(webhook, caplog):
    url, _received, status = webhook
    status["code"] = 500
    caplog.set_level("WARNING", logger=team_bot.logger.name)
    assert (
        team_bot.send_notification(team_bot.TeamBotConfig("slack", url), PAYLOAD)
        is False
    )
    assert "delivery failed" in caplog.text


def test_disabled_or_empty_url_sends_nothing(webhook):
    url, received, _status = webhook
    assert (
        team_bot.send_notification(
            team_bot.TeamBotConfig("slack", url, enabled=False), PAYLOAD
        )
        is False
    )
    assert (
        team_bot.send_notification(team_bot.TeamBotConfig("slack", ""), PAYLOAD)
        is False
    )
    assert received == []


@pytest.mark.parametrize(
    "url", ["file:///etc/passwd", "not a url", "ftp://example.invalid/x"]
)
def test_other_schemes_are_refused_without_raising(url, caplog):
    caplog.set_level("WARNING", logger=team_bot.logger.name)
    assert (
        team_bot.send_notification(team_bot.TeamBotConfig("slack", url), PAYLOAD)
        is False
    )
    assert "invalid webhook scheme" in caplog.text
