"""GrepaiConnector and its HTTP client against a local grepai stand-in.

``scripts/quality_cli.py`` searches code through ``GrepaiConnector``; grepai
itself is a separate server, so a real HTTP server answers for it here.
"""

from __future__ import annotations

from src.connectors.base import GrepaiConnector
from src.connectors.grepai.client import GrepaiClient


def test_search_posts_the_query_and_returns_the_answer(fake_api):
    fake_api.answer("POST", "/search", {"results": [{"file": "a.py"}]})

    connector = GrepaiConnector(base_url=fake_api.url)

    assert connector.search_code("def login", top_k=3) == {
        "results": [{"file": "a.py"}]
    }
    assert fake_api.last("POST", "/search")["json"] == {
        "query": "def login",
        "top_k": 3,
    }


def test_enrich_item_attaches_the_results(fake_api):
    fake_api.answer("POST", "/search", {"results": ["hit"]})

    item = GrepaiConnector(base_url=fake_api.url).enrich_item({"name": "repo"})

    assert item == {"name": "repo", "grepai": {"results": ["hit"]}}
    assert fake_api.last("POST", "/search")["json"]["query"] == (
        "item:{'name': 'repo'}"
    )


def test_enrich_item_leaves_the_item_alone_on_an_error(fake_api):
    fake_api.answer("POST", "/search", {"detail": "down"}, status=503)

    item = GrepaiConnector(base_url=fake_api.url).enrich_item({"name": "repo"})

    assert item == {"name": "repo"}


def test_health(fake_api):
    fake_api.answer("GET", "/health", {"status": "ok"})

    assert GrepaiClient(base_url=fake_api.url).health() == {"status": "ok"}


def test_health_reports_an_unreachable_server(fake_api):
    client = GrepaiClient(base_url=fake_api.url)
    fake_api.answer("GET", "/health", {"status": "starting"}, status=500)

    assert "error" in client.health()
