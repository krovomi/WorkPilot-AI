"""Fixtures for the Windsurf client tests: a local language-server stand-in."""

from __future__ import annotations

import pytest
from integrations.windsurf_proxy import grpc_client
from integrations.windsurf_proxy.auth import WindsurfCredentials

from tests.integrations.windsurf_proxy.connect_fake import ConnectServer, start


@pytest.fixture
def connect_server():
    state = ConnectServer()
    httpd = start(state)
    try:
        yield state
    finally:
        httpd.shutdown()
        httpd.server_close()


@pytest.fixture
def credentials(connect_server: ConnectServer) -> WindsurfCredentials:
    return WindsurfCredentials(
        csrf_token="c5rf-test-0000",
        port=connect_server.port,
        api_key="sk-test-0000",
        version="1.13.200",
    )


@pytest.fixture(autouse=True)
def _fresh_panel(monkeypatch: pytest.MonkeyPatch):
    """The panel flag and its lock are module state: reset them per test."""
    monkeypatch.setattr(grpc_client, "_panel_initialized", False)
    monkeypatch.setattr(grpc_client, "_panel_init_lock", None)
