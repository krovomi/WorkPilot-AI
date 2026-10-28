"""An MCP Apps server built with the Python SDK, for the client tests.

``weather`` is bound to a ``ui://`` view; ``refresh`` is the app's only
(``visibility: ["app"]``) and must never reach the agent.
"""

from __future__ import annotations

from mcp.server.apps import Apps, ResourceCsp
from mcp.server.mcpserver import MCPServer

HTML = "<!doctype html><html><body><p id=t>view</p><script>parent.postMessage({},'*')</script></body></html>"

apps = Apps()


@apps.tool(
    resource_uri="ui://weather/view.html", description="The weather, with a view"
)
def weather(city: str) -> str:
    return f"sunny in {city}"


@apps.tool(
    resource_uri="ui://weather/view.html",
    visibility=["app"],
    description="Refresh the view",
)
def refresh() -> str:
    return "refreshed"


apps.add_html_resource(
    "ui://weather/view.html",
    HTML,
    csp=ResourceCsp(connect_domains=["https://api.weather.example"]),
    prefers_border=True,
)

server = MCPServer("weather", extensions=[apps])

if __name__ == "__main__":
    server.run()
