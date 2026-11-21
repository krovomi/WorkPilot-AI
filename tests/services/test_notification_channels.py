"""Notifications as they go out: payload shapes, the URL guard, real delivery.

Delivery is real HTTP to a local server. The guard refuses loopback, so the
test name `hooks.example.test` resolves to a public address when the guard
asks (no port), and to the local server when the connection is opened (with
a port). Proxies are cleared, so the request goes straight to that server.
"""

from __future__ import annotations

import json
import socket
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from services.notifications import channels
from services.notifications import service as service_module
from services.notifications.api import router
from services.notifications.channels import (
    WEBHOOK_REJECTIONS,
    WebhookRejected,
    build_discord_payload,
    build_google_chat_payload,
    build_text_payload,
    post_json,
    rejection_text,
    send_to_channel,
    validate_webhook_url,
)
from services.notifications.models import (
    ChannelConfig,
    NotificationChannel,
    PRReadyNotification,
)
from services.notifications.service import NotificationService

HOST = "hooks.example.test"
PUBLIC = "93.184.216.34"


class _Receiver(BaseHTTPRequestHandler):
    received: list[tuple[str, dict]] = []

    def do_POST(self):  # noqa: N802 - http.server's name
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        _Receiver.received.append((self.path, json.loads(body or b"{}")))
        if self.path == "/moved":
            self.send_response(302)
            self.send_header("Location", "http://169.254.169.254/latest")
        elif self.path == "/broken":
            self.send_response(500)
        else:
            self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


@pytest.fixture
def receiver(monkeypatch):
    for name in ("http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("no_proxy", "*")
    monkeypatch.setattr(
        channels,
        "_NO_REDIRECT_OPENER",
        urllib.request.build_opener(
            urllib.request.ProxyHandler({}), channels._NoRedirectHandler()
        ),
    )
    server = HTTPServer(("127.0.0.1", 0), _Receiver)
    port = server.server_address[1]
    real = socket.getaddrinfo

    def resolve(host, port_arg, *args, **kwargs):
        if host == HOST:
            if port_arg is None:
                return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (PUBLIC, 0))]
            return real("127.0.0.1", port_arg, *args, **kwargs)
        return real(host, port_arg, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    _Receiver.received = []
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://{HOST}:{port}"
    server.shutdown()
    server.server_close()


def _answers(monkeypatch, *infos):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: list(infos))


# ── Delivery ─────────────────────────────────────────────────────────────


def test_a_payload_is_posted_as_json(receiver):
    assert post_json(f"{receiver}/ok", {"text": "hi"}) == (True, 204, None)
    assert _Receiver.received == [("/ok", {"text": "hi"})]


def test_a_redirect_is_not_followed(receiver):
    ok, code, error = post_json(f"{receiver}/moved", {})

    assert (ok, code, error) == (False, 302, "HTTP 302")
    assert [path for path, _ in _Receiver.received] == ["/moved"]


def test_a_server_error_gives_its_code_only(receiver):
    assert post_json(f"{receiver}/broken", {}) == (False, 500, "HTTP 500")


def test_a_host_that_does_not_answer_is_unreachable(receiver, monkeypatch):
    closed = socket.socket()
    closed.bind(("127.0.0.1", 0))
    port = closed.getsockname()[1]
    closed.close()

    ok, code, error = post_json(f"http://{HOST}:{port}/", {})

    assert (ok, code, error) == (False, None, "Webhook host could not be reached")


def test_a_payload_that_is_not_json_fails_without_its_text(receiver):
    ok, code, error = post_json(f"{receiver}/ok", {"value": object()})

    assert (ok, code) == (False, None)
    assert "object" not in error
    assert _Receiver.received == []


def test_a_blocked_url_never_reaches_the_network(monkeypatch):
    _answers(monkeypatch, (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.1", 0)))

    assert post_json("https://intranet.example/hook", {}) == (
        False,
        None,
        WEBHOOK_REJECTIONS["private"],
    )


def test_send_to_channel_reports_both_outcomes(receiver):
    notif = PRReadyNotification(task_title="Ship it", pr_url="https://pr.example/1")

    sent = send_to_channel(NotificationChannel.SLACK, f"{receiver}/ok", notif)
    failed = send_to_channel(NotificationChannel.DISCORD, f"{receiver}/broken", notif)

    assert (sent.success, sent.status_code) == (True, 204)
    assert (failed.success, failed.error) == (False, "HTTP 500")
    assert "blocks" in _Receiver.received[0][1]
    assert "embeds" in _Receiver.received[1][1]


# ── The URL guard ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("url", "reason"),
    [
        ("", "empty"),
        ("http://[::1", "unparseable"),
        ("ftp://files.example/x", "scheme"),
        ("https:///path-only", "no_host"),
    ],
)
def test_a_url_is_refused_before_any_lookup(url, reason):
    with pytest.raises(WebhookRejected) as refused:
        validate_webhook_url(url)

    assert refused.value.reason == reason
    assert rejection_text(refused.value) == WEBHOOK_REJECTIONS[reason]


def test_a_host_that_does_not_resolve_is_refused(monkeypatch):
    def fail(*args, **kwargs):
        raise socket.gaierror("no such host")

    monkeypatch.setattr(socket, "getaddrinfo", fail)

    with pytest.raises(WebhookRejected) as refused:
        validate_webhook_url("https://nowhere.example")

    assert refused.value.reason == "unresolvable"


def test_a_host_with_no_address_is_refused(monkeypatch):
    _answers(monkeypatch)

    with pytest.raises(WebhookRejected) as refused:
        validate_webhook_url("https://empty.example")

    assert refused.value.reason == "no_address"


def test_an_unreadable_address_is_refused(monkeypatch):
    _answers(monkeypatch, (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("not-ip", 0)))

    with pytest.raises(WebhookRejected) as refused:
        validate_webhook_url("https://odd.example")

    assert refused.value.reason == "bad_address"


def test_an_ipv6_link_local_with_a_scope_is_refused(monkeypatch):
    _answers(
        monkeypatch,
        (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("fe80::1%eth0", 0, 0, 2)),
    )

    with pytest.raises(WebhookRejected) as refused:
        validate_webhook_url("https://v6.example")

    assert refused.value.reason == "private"


def test_a_public_ipv6_address_is_accepted(monkeypatch):
    _answers(
        monkeypatch,
        (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:4700::1111", 0, 0, 0)),
    )

    validate_webhook_url("https://v6.example")


def test_a_rejection_without_a_reason_reads_as_blocked():
    assert rejection_text(ValueError("raw detail")) == WEBHOOK_REJECTIONS["blocked"]
    assert str(WebhookRejected("custom")) == "custom"


# ── Payloads ─────────────────────────────────────────────────────────────


def test_a_bare_discord_embed_has_no_link_and_no_fields():
    embed = build_discord_payload(PRReadyNotification(task_title="T"))["embeds"][0]

    assert "url" not in embed
    assert embed["fields"] == []


def test_a_discord_embed_carries_the_description():
    notif = PRReadyNotification(task_title="T", task_description="Why")

    embed = build_discord_payload(notif)["embeds"][0]

    assert embed["description"].endswith("\n\nWhy")


def test_a_bare_google_chat_card_has_only_the_task():
    card = build_google_chat_payload(PRReadyNotification(task_title="T"))

    widgets = card["cardsV2"][0]["card"]["sections"][0]["widgets"]
    assert widgets == [
        {"decoratedText": {"topLabel": "Task", "text": "T", "wrapText": True}}
    ]


def test_a_full_google_chat_card_has_description_facts_and_button():
    notif = PRReadyNotification(
        task_title="T",
        task_description="Why",
        branch="feat/x",
        pr_url="https://pr.example/1",
    )

    widgets = build_google_chat_payload(notif)["cardsV2"][0]["card"]["sections"][0][
        "widgets"
    ]

    assert widgets[1]["decoratedText"]["text"] == "Why"
    assert widgets[2]["decoratedText"] == {"topLabel": "Branch", "text": "feat/x"}
    assert widgets[3]["buttonList"]["buttons"][0]["onClick"]["openLink"]["url"] == (
        "https://pr.example/1"
    )


@pytest.mark.parametrize(
    ("channel", "expected"),
    [
        (NotificationChannel.SLACK, {"text": "m"}),
        (NotificationChannel.DISCORD, {"content": "m"}),
        (NotificationChannel.GOOGLE_CHAT, {"text": "m"}),
        (NotificationChannel.WEBHOOK, {"event": "test", "message": "m"}),
    ],
)
def test_a_plain_message_in_each_channel_format(channel, expected):
    assert build_text_payload(channel, "m") == expected


def test_a_plain_message_for_teams_is_an_adaptive_card():
    payload = build_text_payload(NotificationChannel.TEAMS, "m")

    body = payload["attachments"][0]["content"]["body"]
    assert body == [{"type": "TextBlock", "text": "m", "wrap": True}]


def test_a_long_discord_message_is_cut_to_its_limit():
    payload = build_text_payload(NotificationChannel.DISCORD, "x" * 2500)

    assert len(payload["content"]) == 2000


# ── The service ──────────────────────────────────────────────────────────


def test_a_channel_that_raises_is_reported_and_the_others_still_go(monkeypatch):
    service = NotificationService(
        [
            ChannelConfig(NotificationChannel.DISCORD, "https://d.example"),
            ChannelConfig(NotificationChannel.SLACK, "https://s.example"),
        ]
    )
    calls = []

    def send(channel, url, notif):
        calls.append(channel)
        if channel is NotificationChannel.DISCORD:
            raise TypeError("title is not text")
        return channels.ChannelResult(channel=channel, success=True)

    monkeypatch.setattr(service_module, "send_to_channel", send)

    results = service.send_pr_ready(PRReadyNotification(task_title="T"))

    assert calls == [NotificationChannel.DISCORD, NotificationChannel.SLACK]
    assert (results[0].success, results[0].error) == (False, "title is not text")
    assert results[1].success


def test_an_env_file_that_cannot_be_read_gives_nothing(tmp_path):
    folder = tmp_path / ".workpilot" / ".env"
    folder.mkdir(parents=True)

    assert service_module.project_env_vars(tmp_path) == {}
    assert service_module.project_env_vars(None) == {}


def test_a_line_with_an_empty_key_is_skipped(tmp_path):
    env = tmp_path / ".env"
    env.write_text("=orphan\nKEY='v'\n", encoding="utf-8")

    assert service_module._parse_env_file(env) == {"KEY": "v"}


# ── The test route ───────────────────────────────────────────────────────


@pytest.fixture
def api() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_the_test_route_refuses_an_unknown_channel(api):
    answer = api.post("/api/notifications/test", json={"channel": "fax", "url": "x"})

    assert answer.json() == {"success": False, "error": "Unknown channel: fax"}


def test_the_test_route_names_the_rule_a_url_broke(api):
    answer = api.post(
        "/api/notifications/test", json={"channel": "slack", "url": "ftp://x"}
    )

    assert answer.json() == {"success": False, "error": WEBHOOK_REJECTIONS["scheme"]}


def test_the_test_route_sends_the_message_in_the_app_language(
    api, receiver, monkeypatch
):
    monkeypatch.setenv("APP_LANGUAGE", "fr")

    answer = api.post(
        "/api/notifications/test",
        json={"channel": "webhook", "url": f" {receiver}/ok "},
    )

    assert answer.json() == {"success": True, "status_code": 204, "error": None}
    assert _Receiver.received[0][1]["message"].startswith(
        "✅ WorkPilot AI — notification de test"
    )


def test_the_test_route_defaults_to_the_generic_webhook_in_english(
    api, receiver, monkeypatch
):
    monkeypatch.setenv("APP_LANGUAGE", "de")

    answer = api.post("/api/notifications/test", json={"url": f"{receiver}/ok"})

    assert answer.json()["success"] is True
    assert _Receiver.received[0][1] == {
        "event": "test",
        "message": "✅ WorkPilot AI — test notification. Your channel is configured correctly!",
    }
