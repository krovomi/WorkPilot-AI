"""A queued memory conflict on the project's channels (#352), over real HTTP.

The port `brain.lifecycle.announce` calls, installed by the notifications:
opt-in per project, never under the strict offline policy, only through
`channels.post_json` and its SSRF guard. Delivery is to a local server, as in
``test_notification_channels.py``: the guard refuses loopback, so the test
name resolves to a public address when the guard asks and to the local
server when the connection is opened.
"""

from __future__ import annotations

import json
import socket
import subprocess
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from brain.lifecycle import announce, arbitration, identity
from brain.notes import Note, write_note
from services.notifications import channels
from services.notifications.memory_conflicts import (
    NOTIFY_ENV,
    ChannelAnnouncer,
    render,
)

HOST = "hooks.example.test"
PUBLIC = "93.184.216.34"
BASE = "knowledge/projects/shop/memory"
_CHANNEL_KEYS = (
    "TEAMS_NOTIFICATIONS_ENABLED",
    "SLACK_NOTIFICATIONS_ENABLED",
    "DISCORD_NOTIFICATIONS_ENABLED",
    "GOOGLE_CHAT_NOTIFICATIONS_ENABLED",
    "NOTIFY_WEBHOOK_ENABLED",
    "TEAMS_WEBHOOK_URL",
    "SLACK_WEBHOOK_URL",
    "DISCORD_WEBHOOK_URL",
    "GOOGLE_CHAT_WEBHOOK_URL",
    "NOTIFY_WEBHOOK_URL",
)


class _Receiver(BaseHTTPRequestHandler):
    received: list[tuple[str, dict]] = []

    def do_POST(self):  # noqa: N802 - http.server's name
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        _Receiver.received.append((self.path, json.loads(body or b"{}")))
        self.send_response(500 if self.path == "/broken" else 204)
        self.end_headers()

    def log_message(self, *args):
        pass


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in (NOTIFY_ENV, "APP_LANGUAGE", *_CHANNEL_KEYS):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(identity, "person", lambda root: {"name": "", "email": ""})


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


def _project(tmp_path: Path, **env: str) -> Path:
    project = tmp_path / "shop"
    (project / ".workpilot").mkdir(parents=True, exist_ok=True)
    lines = [f"{key}={value}" for key, value in env.items()]
    (project / ".workpilot" / ".env").write_text("\n".join(lines), encoding="utf-8")
    return project


def _notice(**over) -> dict:
    side = {"title": "Migrations first", "text": "Always migrate.", "withheld": False}
    return {
        "id": "p1",
        "kind": "gotcha",
        "signal": "negation",
        "escalated": False,
        "a": {**side, "authors": ["Alice Martin"]},
        "b": {**side, "title": "No migrations", "authors": []},
        **over,
    }


# --------------------------------------------------------------------------- #
# Opt-in
# --------------------------------------------------------------------------- #


def test_the_notifications_install_the_channels_as_the_sender():
    assert isinstance(announce.installed(), ChannelAnnouncer)


def test_off_unless_the_project_asks(tmp_path, receiver):
    slack = {"SLACK_NOTIFICATIONS_ENABLED": "true", "SLACK_WEBHOOK_URL": receiver}
    assert not ChannelAnnouncer().enabled(_project(tmp_path, **slack))
    project = _project(tmp_path, **slack, **{NOTIFY_ENV: "true"})
    assert ChannelAnnouncer().enabled(project)


def test_the_process_environment_wins(tmp_path, monkeypatch, receiver):
    project = _project(
        tmp_path,
        SLACK_NOTIFICATIONS_ENABLED="true",
        SLACK_WEBHOOK_URL=receiver,
        **{NOTIFY_ENV: "true"},
    )
    monkeypatch.setenv(NOTIFY_ENV, "false")
    assert not ChannelAnnouncer().enabled(project)


def test_asked_for_but_without_a_channel_is_off(tmp_path):
    assert not ChannelAnnouncer().enabled(_project(tmp_path, **{NOTIFY_ENV: "true"}))


@pytest.mark.parametrize("policy", ['{"airgapStrict": true}', "not json"])
def test_never_under_the_strict_offline_policy(tmp_path, receiver, policy):
    project = _project(
        tmp_path,
        SLACK_NOTIFICATIONS_ENABLED="true",
        SLACK_WEBHOOK_URL=receiver,
        **{NOTIFY_ENV: "true"},
    )
    (project / ".workpilot" / "offline-mode.json").write_text(policy, encoding="utf-8")
    assert not ChannelAnnouncer().enabled(project)


# --------------------------------------------------------------------------- #
# What is said
# --------------------------------------------------------------------------- #


def test_the_message_names_the_pair_and_where_to_settle_it():
    text = render("shop", [_notice()])
    assert text.splitlines() == [
        "⚖️ shop: 1 memory conflict(s) to settle",
        "• Two gotcha notes disagree (do / do not)",
        "  A: “Migrations first” Always migrate. (by Alice Martin)",
        "  B: “No migrations” Always migrate.",
        "Settle them in WorkPilot: Context → Lifecycle.",
    ]


def test_in_french_escalated_withheld_and_more_than_three(monkeypatch):
    monkeypatch.setenv("APP_LANGUAGE", "fr")
    withheld = {"title": "", "text": "", "withheld": True, "authors": []}
    notices = [
        _notice(escalated=True, b=withheld, kind="odd", signal="odd"),
        *[_notice() for _ in range(4)],
    ]
    text = render("shop", notices)
    assert text.startswith("⚖️ shop : 5 conflit(s) de mémoire à trancher")
    assert (
        "• Deux notes (mémoire) se contredisent (modifiée sur deux machines), "
        "de nouveau après une décision : un mainteneur tranche"
    ) in text
    assert "  B : (texte retenu : il se lit comme des instructions)" in text
    assert "…et 2 de plus." in text
    assert text.count("• Deux notes") == 3


# --------------------------------------------------------------------------- #
# Delivery
# --------------------------------------------------------------------------- #


def test_each_channel_gets_its_own_shape(tmp_path, receiver):
    project = _project(
        tmp_path,
        SLACK_NOTIFICATIONS_ENABLED="true",
        SLACK_WEBHOOK_URL=f"{receiver}/slack",
        DISCORD_NOTIFICATIONS_ENABLED="true",
        DISCORD_WEBHOOK_URL=f"{receiver}/discord",
        NOTIFY_WEBHOOK_ENABLED="true",
        NOTIFY_WEBHOOK_URL=f"{receiver}/hook",
    )
    assert ChannelAnnouncer().send(project, "shop", [_notice()])
    got = dict(_Receiver.received)
    assert got["/slack"]["text"].startswith("⚖️ shop")
    assert got["/discord"]["allowed_mentions"] == {"parse": []}
    assert got["/hook"]["event"] == "memory_conflict"
    assert got["/hook"]["project"] == "shop"
    assert got["/hook"]["conflicts"][0]["a"]["authors"] == ["Alice Martin"]


def test_one_channel_that_takes_it_is_enough(tmp_path, receiver):
    project = _project(
        tmp_path,
        SLACK_NOTIFICATIONS_ENABLED="true",
        SLACK_WEBHOOK_URL=f"{receiver}/broken",
        NOTIFY_WEBHOOK_ENABLED="true",
        NOTIFY_WEBHOOK_URL=f"{receiver}/hook",
    )
    assert ChannelAnnouncer().send(project, "shop", [_notice()])
    only_broken = _project(
        tmp_path / "other",
        SLACK_NOTIFICATIONS_ENABLED="true",
        SLACK_WEBHOOK_URL=f"{receiver}/broken",
    )
    assert not ChannelAnnouncer().send(only_broken, "shop", [_notice()])


def test_a_private_address_is_never_reached(tmp_path, monkeypatch):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.1", 0))],
    )
    project = _project(
        tmp_path,
        NOTIFY_WEBHOOK_ENABLED="true",
        NOTIFY_WEBHOOK_URL="http://intranet.example/hook",
    )
    opened = []
    monkeypatch.setattr(channels._NO_REDIRECT_OPENER, "open", opened.append)
    assert not ChannelAnnouncer().send(project, "shop", [_notice()])
    assert opened == []


# --------------------------------------------------------------------------- #
# From a sync to the channel, once
# --------------------------------------------------------------------------- #


def test_a_pair_a_sync_queued_reaches_the_channel_once(tmp_path, receiver):
    vault = tmp_path / "vault"
    subprocess.run(["git", "init", "-q", str(vault)], check=True)
    project = _project(
        tmp_path,
        NOTIFY_WEBHOOK_ENABLED="true",
        NOTIFY_WEBHOOK_URL=f"{receiver}/hook",
        **{NOTIFY_ENV: "true"},
    )
    announce.register_project(vault, project)
    for name, body in (
        ("always", "Always run the migrations before the tests."),
        ("never", "Never run the migrations before the tests. <!channel>"),
    ):
        write_note(
            vault,
            Note(
                path=Path(f"{BASE}/gotchas/{name}.md"),
                meta={"project": "shop", "title": name},
                body=body,
            ),
        )
    arbitration.review_pull(vault, [f"{BASE}/gotchas/never.md"], [])

    assert announce.sweep(vault) == 1
    assert announce.sweep(vault) == 0
    [(path, payload)] = _Receiver.received
    assert path == "/hook" and payload["project"] == "shop"
    assert "<!channel>" not in json.dumps(payload, ensure_ascii=False)
    assert "‹!channel›" in payload["conflicts"][0]["b"]["text"]
