"""Copilot keeps working when GitHub refuses the internal token exchange.

``copilot_internal/v2/token`` now answers 403 ("For more on scraping GitHub…")
to tokens from OAuth apps GitHub does not reserve it for, the GitHub CLI's
included. The client then failed every call with "Copilot auth error: Copilot
token exchange failed (403)", while api.githubcopilot.com accepts that GitHub
token directly as Bearer auth.
"""

import asyncio
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
sys.path.insert(0, str(BACKEND))


class _Response:
    def __init__(self, status: int, payload=None, body: str = ""):
        self.status = status
        self._payload = payload
        self._body = body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def json(self):
        return self._payload

    async def text(self):
        return self._body


class _Session:
    def __init__(self, response: _Response):
        self._response = response
        self.requested: list[str] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def get(self, url, headers=None):
        self.requested.append(url)
        return self._response


def _token_for(monkeypatch, response: _Response) -> str:
    import aiohttp
    from core.agent_clients.copilot import CopilotAgentClient

    session = _Session(response)
    monkeypatch.setattr(aiohttp, "ClientSession", lambda *a, **k: session)
    client = CopilotAgentClient(model="gpt-4o", github_token="gho_example")
    token = asyncio.run(client._get_copilot_token())
    assert session.requested == [client._token_exchange_url]
    return token


SCRAPING_403 = (
    "403 Forbidden. For more on scraping GitHub and how it may affect your "
    "rights, please review our Terms of Service"
)


@pytest.mark.parametrize("status", [403, 404])
def test_a_refused_exchange_uses_the_github_token_directly(monkeypatch, status):
    token = _token_for(monkeypatch, _Response(status, body=SCRAPING_403))

    assert token == "gho_example"


def test_a_granted_exchange_still_uses_the_session_token(monkeypatch):
    token = _token_for(
        monkeypatch,
        _Response(200, payload={"token": "tid=session", "expires_at": 4102444800}),
    )

    assert token == "tid=session"


def test_any_other_refusal_is_still_an_error(monkeypatch):
    with pytest.raises(ValueError, match=r"token exchange failed \(401\)"):
        _token_for(monkeypatch, _Response(401, body="Bad credentials"))
