"""FigmaConnector against an in-process Figma API (httpx MockTransport).

The Design-to-Code service and runner use this connector to read a Figma file,
export a node as an image and post a comment back. Each test checks the
request Figma receives (path, query, token, body) and what the connector makes
of the answer.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Callable

import httpx
import pytest

from src.connectors.figma_connector import (
    FIGMA_API_BASE,
    FigmaConnector,
    FigmaDesignToken,
    FigmaExportResult,
)

TOKEN = "figd_test"
PNG = b"\x89PNG\r\n\x1a\nfake"


class FakeFigma(list):
    """The requests Figma received, in order, plus the scripted answers."""

    __hash__ = object.__hash__

    def __eq__(self, other: object) -> bool:
        return self is other  # one fake server is only ever itself

    def __init__(self) -> None:
        super().__init__()
        self.routes: dict[
            tuple[str, str], Callable[[httpx.Request], httpx.Response]
        ] = {}


@pytest.fixture
def figma(monkeypatch) -> FakeFigma:
    """Route every httpx.AsyncClient to the fake's routes."""
    seen = FakeFigma()
    routes = seen.routes

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        key = (request.method, str(request.url.copy_with(query=None)))
        if key not in routes:
            return httpx.Response(404, json={"err": "not found"})
        return routes[key](request)

    real_client = httpx.AsyncClient

    def client_with_transport(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client_with_transport)
    return seen


def _route(figma, method: str, url: str, response: httpx.Response | dict) -> None:
    reply = response if isinstance(response, httpx.Response) else None
    figma.routes[(method, url)] = lambda _req: (
        reply or httpx.Response(200, json=response)
    )


@pytest.fixture
def connector() -> FigmaConnector:
    return FigmaConnector(access_token=TOKEN)


class TestConfiguration:
    def test_token_from_the_environment(self, monkeypatch):
        monkeypatch.setenv("FIGMA_ACCESS_TOKEN", "from-env")

        assert FigmaConnector().is_configured()
        assert FigmaConnector().access_token == "from-env"

    def test_no_token_is_not_configured(self, monkeypatch, caplog):
        monkeypatch.delenv("FIGMA_ACCESS_TOKEN", raising=False)

        assert not FigmaConnector().is_configured()
        assert "No Figma access token" in caplog.text


class TestReads:
    async def test_get_file_sends_the_token(self, figma, connector):
        _route(figma, "GET", f"{FIGMA_API_BASE}/files/KEY", {"name": "Shop"})

        assert await connector.get_file("KEY") == {"name": "Shop"}
        assert figma[-1].headers["X-Figma-Token"] == TOKEN

    async def test_get_file_nodes_joins_the_ids(self, figma, connector):
        _route(figma, "GET", f"{FIGMA_API_BASE}/files/KEY/nodes", {"nodes": {}})

        assert await connector.get_file_nodes("KEY", ["1:2", "3:4"]) == {"nodes": {}}
        assert figma[-1].url.params["ids"] == "1:2,3:4"

    async def test_an_http_error_is_raised(self, figma, connector):
        _route(
            figma,
            "GET",
            f"{FIGMA_API_BASE}/files/KEY/styles",
            httpx.Response(403, json={"err": "forbidden"}),
        )

        with pytest.raises(httpx.HTTPStatusError):
            await connector.get_file_styles("KEY")

    async def test_components_and_comments(self, figma, connector):
        _route(
            figma,
            "GET",
            f"{FIGMA_API_BASE}/files/KEY/components",
            {"meta": {"components": [{"name": "Button"}]}},
        )
        _route(
            figma,
            "GET",
            f"{FIGMA_API_BASE}/files/KEY/comments",
            {"comments": [{"message": "ok"}]},
        )

        assert await connector.get_file_components("KEY") == [{"name": "Button"}]
        assert await connector.get_comments("KEY") == [{"message": "ok"}]


class TestExport:
    async def test_a_node_is_downloaded_as_base64(self, figma, connector):
        cdn = "https://cdn.figma.test/img/1.png"
        _route(figma, "GET", f"{FIGMA_API_BASE}/images/KEY", {"images": {"1:2": cdn}})
        _route(figma, "GET", cdn, httpx.Response(200, content=PNG))

        result = await connector.export_node_image("KEY", "1:2", format="jpg", scale=3)

        assert result == FigmaExportResult(
            node_id="1:2",
            image_url=cdn,
            image_data=base64.b64encode(PNG).decode("utf-8"),
            format="jpg",
            scale=3,
        )
        params = figma[0].url.params
        assert (params["ids"], params["format"], params["scale"]) == ("1:2", "jpg", "3")

    async def test_no_image_url_is_an_error(self, figma, connector):
        _route(figma, "GET", f"{FIGMA_API_BASE}/images/KEY", {"images": {}})

        with pytest.raises(ValueError, match="No image URL returned for node 1:2"):
            await connector.export_node_image("KEY", "1:2")

    async def test_several_nodes_keep_their_order(self, figma, connector):
        _route(
            figma,
            "GET",
            f"{FIGMA_API_BASE}/images/KEY",
            {"images": {"a": "https://cdn/a.png"}},
        )

        results = await connector.export_multiple_nodes("KEY", ["a", "b"])

        assert [(r.node_id, r.image_url) for r in results] == [
            ("a", "https://cdn/a.png"),
            ("b", ""),
        ]
        assert figma[-1].url.params["ids"] == "a,b"


class TestDesignTokens:
    async def test_each_style_type_maps_to_a_category(self, figma, connector):
        _route(
            figma,
            "GET",
            f"{FIGMA_API_BASE}/files/KEY/styles",
            {
                "meta": {
                    "styles": [
                        {
                            "style_type": "FILL",
                            "name": "Color/Primary/500",
                            "key": "k1",
                        },
                        {"style_type": "TEXT", "name": "Heading XL", "key": "k2"},
                        {"style_type": "EFFECT", "name": "Shadow_Soft", "key": "k3"},
                        {"style_type": "GRID", "name": "/Grid 8/", "key": "k4"},
                        {"style_type": "OTHER", "name": "Ignored", "key": "k5"},
                    ]
                }
            },
        )
        _route(
            figma,
            "GET",
            f"{FIGMA_API_BASE}/files/KEY",
            {"styles": {"k1": {"name": "Primary 500"}, "k3": {}}},
        )

        tokens = await connector.extract_design_tokens("KEY")

        assert tokens == [
            FigmaDesignToken("color-primary-500", "figma:Primary 500", "color", "k1"),
            FigmaDesignToken("heading-xl", "", "typography", "k2"),
            FigmaDesignToken("shadow-soft", "figma:shadow-soft", "effect", "k3"),
            FigmaDesignToken("grid-8", "", "spacing", "k4"),
        ]

    async def test_unresolved_values_still_return_the_tokens(self, figma, connector):
        _route(
            figma,
            "GET",
            f"{FIGMA_API_BASE}/files/KEY/styles",
            {"meta": {"styles": [{"style_type": "FILL", "name": "Red", "key": "r"}]}},
        )
        _route(
            figma, "GET", f"{FIGMA_API_BASE}/files/KEY", httpx.Response(500, text="x")
        )

        tokens = await connector.extract_design_tokens("KEY")

        assert [(t.name, t.value) for t in tokens] == [("red", "")]

    async def test_a_failing_style_list_gives_no_tokens(self, figma, connector):
        _route(
            figma,
            "GET",
            f"{FIGMA_API_BASE}/files/KEY/styles",
            httpx.Response(401, text="no"),
        )

        assert await connector.extract_design_tokens("KEY") == []

    async def test_a_file_without_styles_skips_resolution(self, figma, connector):
        _route(figma, "GET", f"{FIGMA_API_BASE}/files/KEY/styles", {"meta": {}})

        assert await connector.extract_design_tokens("KEY") == []
        assert len(figma) == 1


class TestComments:
    async def test_a_comment_on_a_node(self, figma, connector):
        _route(figma, "POST", f"{FIGMA_API_BASE}/files/KEY/comments", {"id": "c1"})

        assert await connector.post_comment("KEY", "Code ready", node_id="1:2") == {
            "id": "c1"
        }
        assert json.loads(figma[-1].content) == {
            "message": "Code ready",
            "client_meta": {"node_id": "1:2"},
        }

    async def test_a_comment_on_the_file(self, figma, connector):
        _route(figma, "POST", f"{FIGMA_API_BASE}/files/KEY/comments", {"id": "c2"})

        await connector.post_comment("KEY", "Done")

        assert json.loads(figma[-1].content) == {"message": "Done"}


class TestParseUrl:
    @pytest.mark.parametrize(
        ("url", "expected"),
        [
            (
                "https://www.figma.com/design/AbC123/Shop?node-id=12%3A34&t=x",
                {"file_key": "AbC123", "node_id": "12:34"},
            ),
            ("https://www.figma.com/file/XyZ9/Title", {"file_key": "XyZ9"}),
            ("https://example.com/not-figma", None),
        ],
    )
    def test_parse(self, url, expected):
        assert FigmaConnector.parse_figma_url(url) == expected
