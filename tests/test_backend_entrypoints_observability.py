"""Both long-running backend entry points start the same way: log redaction
(docs/rules/security.md, S1), then Sentry. The API and the WebSocket server
are where a desktop user's errors happen, and they reported none."""

from __future__ import annotations

from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"


@pytest.mark.parametrize(
    ("entry", "component"),
    [("provider_api.py", "api"), ("websocket_server.py", "websocket")],
)
def test_entry_point_installs_redaction_then_sentry(entry, component):
    source = (BACKEND / entry).read_text(encoding="utf-8")

    redaction = source.index("install_global_redaction()")
    sentry = source.index(f'init_sentry(component="{component}")')
    assert redaction < sentry


def test_the_packaged_app_marker_enables_sentry(monkeypatch):
    sentry_sdk = pytest.importorskip("sentry_sdk")
    from core import sentry

    calls = []
    monkeypatch.setattr(sentry_sdk, "init", lambda **kw: calls.append(kw))
    monkeypatch.setattr(sentry_sdk, "set_tag", lambda *a: None)
    monkeypatch.setattr(sentry, "_sentry_initialized", False)
    monkeypatch.setattr(sentry, "_sentry_enabled", False)
    monkeypatch.setenv("SENTRY_DSN", "https://key@example.invalid/1")
    monkeypatch.delenv("SENTRY_DEV", raising=False)
    monkeypatch.setenv("WORKPILOT_PACKAGED_APP", "1")

    assert sentry.init_sentry(component="api") is True
    assert calls and calls[0]["environment"] == "production"
