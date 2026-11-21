"""Server mode: what the generic OpenID Connect sign-in accepts from its settings
and from the provider's discovery document, before any token is read.

The provider is never reached: its discovery endpoint is an ``httpx`` mock
transport, and the settings are environment variables, as an operator sets them.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

import httpx
import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402
from server.auth import oidc_generic  # noqa: E402
from server.auth.oidc import OidcError  # noqa: E402

ISSUER = "https://id.example.test/realms/team"

DOCUMENT = {
    "issuer": ISSUER,
    "authorization_endpoint": f"{ISSUER}/protocol/openid-connect/auth",
    "token_endpoint": f"{ISSUER}/protocol/openid-connect/token",
    "jwks_uri": f"{ISSUER}/protocol/openid-connect/certs",
    "id_token_signing_alg_values_supported": ["RS256", "HS256", "none", "ES256"],
}


@pytest.fixture(autouse=True)
def _settings(monkeypatch):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_OIDC_ISSUER", ISSUER + "/")
    monkeypatch.setenv("WORKPILOT_OIDC_CLIENT_ID", "workpilot-desktop")
    server_config.reset_settings_cache()
    oidc_generic.reset_cache()
    yield
    server_config.reset_settings_cache()
    oidc_generic.reset_cache()


# --- the settings ------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "issuer", "expected"),
    [
        (f"{ISSUER}/", True, ISSUER),
        ("https://idp.example.test/authorize?prompt=login", True, ""),
        ("http://localhost:8080/realms/dev", True, "http://localhost:8080/realms/dev"),
        ("http://127.0.0.1/x", False, "http://127.0.0.1/x"),
        ("http://idp.example.test/realms/team", True, ""),
        ("https://user:pw@idp.example.test", True, ""),
        ("https://idp.example.test/#frag", False, ""),
        ("https://idp.example.test/?tenant=1", True, ""),
        ("https://[::1", True, ""),
        ("https://", True, ""),
        ("ftp://idp.example.test", True, ""),
        ("", True, ""),
        ("https://idp.example.test/" + "a" * 2000, True, ""),
    ],
)
def test_an_issuer_or_endpoint_is_an_https_url(value, issuer, expected):
    if value.startswith("https://idp.example.test/authorize"):
        # An endpoint keeps its query; an issuer never has one.
        assert server_config.oidc_url(value) == value
    assert server_config.oidc_url(value, issuer=issuer) == expected


def test_the_settings_are_read_and_cleaned(monkeypatch):
    settings = server_config.get_settings()
    assert settings.oidc_enabled and settings.oidc_issuer == ISSUER
    assert settings.oidc_name == "SSO"
    assert settings.oidc_scopes == "openid profile email"
    assert settings.self_approval == "when-alone"

    monkeypatch.setenv("WORKPILOT_OIDC_NAME", "  Okta   Workforce  ")
    monkeypatch.setenv("WORKPILOT_OIDC_SCOPES", 'email openid bad"scope groups')
    monkeypatch.setenv("WORKPILOT_SELF_APPROVAL", " Deny ")
    server_config.reset_settings_cache()
    settings = server_config.get_settings()
    assert settings.oidc_name == "Okta Workforce"
    assert settings.oidc_scopes == "openid email groups"
    assert settings.self_approval == "deny"

    monkeypatch.setenv("WORKPILOT_OIDC_NAME", "Key\x07cloak" + "x" * 60)
    monkeypatch.setenv("WORKPILOT_OIDC_ISSUER", "http://idp.example.test")
    server_config.reset_settings_cache()
    settings = server_config.get_settings()
    assert settings.oidc_name == "SSO"
    assert settings.oidc_issuer == "" and not settings.oidc_enabled


def test_an_unknown_self_approval_rule_falls_back_to_the_default(monkeypatch, caplog):
    monkeypatch.setenv("WORKPILOT_SELF_APPROVAL", "sometimes")
    server_config.reset_settings_cache()
    with caplog.at_level(logging.WARNING):
        assert server_config.get_settings().self_approval == "when-alone"
    assert "WORKPILOT_SELF_APPROVAL" in caplog.text


# --- the discovery document ----------------------------------------------------


def _serve(monkeypatch, handler) -> list[httpx.Request]:
    seen: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    real = httpx.Client

    def client(**kwargs):
        return real(transport=httpx.MockTransport(respond), **kwargs)

    monkeypatch.setattr(oidc_generic.httpx, "Client", client)
    return seen


def test_the_document_is_read_from_the_issuer_and_checked(monkeypatch):
    seen = _serve(monkeypatch, lambda r: httpx.Response(200, json=DOCUMENT))
    found = oidc_generic.discover()
    assert str(seen[0].url) == f"{ISSUER}/.well-known/openid-configuration"
    assert found["authorization_endpoint"] == DOCUMENT["authorization_endpoint"]
    # Never "none" nor a shared-secret HMAC.
    assert found["algorithms"] == ["ES256", "RS256"]


def test_the_document_is_kept_for_an_hour(monkeypatch):
    seen = _serve(monkeypatch, lambda r: httpx.Response(200, json=DOCUMENT))
    clock = [1000.0]
    monkeypatch.setattr(oidc_generic.time, "monotonic", lambda: clock[0])
    built: list[str] = []

    class Keys:
        def __init__(self, uri, cache_keys):
            built.append(uri)

    monkeypatch.setattr(oidc_generic.pyjwt, "PyJWKClient", Keys)
    oidc_generic.discover()
    oidc_generic.discover()
    assert len(seen) == 1
    clock[0] += oidc_generic.DISCOVERY_TTL_SECONDS + 1
    oidc_generic.discover()
    assert len(seen) == 2
    # The same key set is not downloaded anew for a re-read document.
    assert built == [DOCUMENT["jwks_uri"]]


@pytest.mark.parametrize(
    ("response", "detail"),
    [
        (httpx.Response(404), "no usable discovery document"),
        (
            httpx.Response(200, content=b"x" * (oidc_generic.MAX_DISCOVERY_BYTES + 1)),
            "no usable discovery document",
        ),
        (httpx.Response(200, content=b"{not json"), "no usable discovery document"),
        (httpx.Response(200, json=["a", "list"]), "no usable discovery document"),
        (
            httpx.Response(200, json={**DOCUMENT, "issuer": "https://evil.test"}),
            "names another issuer",
        ),
        (httpx.Response(200, json={**DOCUMENT, "issuer": 3}), "names another issuer"),
        (
            httpx.Response(
                200, json={**DOCUMENT, "token_endpoint": "http://idp.example.test/t"}
            ),
            "no usable token_endpoint",
        ),
        (
            httpx.Response(
                200, json={k: v for k, v in DOCUMENT.items() if k != "jwks_uri"}
            ),
            "no usable jwks_uri",
        ),
        (
            httpx.Response(
                200,
                json={**DOCUMENT, "id_token_signing_alg_values_supported": ["HS256"]},
            ),
            "no accepted algorithm",
        ),
    ],
)
def test_an_unusable_document_is_refused(monkeypatch, response, detail):
    _serve(monkeypatch, lambda r: response)
    with pytest.raises(OidcError, match=detail):
        oidc_generic.discover()


def test_a_document_without_algorithms_means_rs256(monkeypatch):
    document = {
        k: v
        for k, v in DOCUMENT.items()
        if k != "id_token_signing_alg_values_supported"
    }
    _serve(monkeypatch, lambda r: httpx.Response(200, content=json.dumps(document)))
    assert oidc_generic.discover()["algorithms"] == ["RS256"]


def test_an_unreachable_provider_is_named_by_its_error_only(monkeypatch):
    def refuse(request):
        raise httpx.ConnectError("secret-host-detail", request=request)

    _serve(monkeypatch, refuse)
    with pytest.raises(OidcError) as error:
        oidc_generic.discover()
    assert str(error.value) == "The identity provider cannot be reached: ConnectError"


def test_nothing_is_read_when_sso_is_off(monkeypatch):
    monkeypatch.delenv("WORKPILOT_OIDC_CLIENT_ID")
    server_config.reset_settings_cache()
    seen = _serve(monkeypatch, lambda r: httpx.Response(200, json=DOCUMENT))
    with pytest.raises(OidcError, match="not configured"):
        oidc_generic.discover()
    assert seen == []
