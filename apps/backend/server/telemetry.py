"""One OpenTelemetry span per request the server answers.

On with the rest of WorkPilot's spans: when ``AUTO_CLAUDE_OTEL_ENDPOINT``
names an OTLP collector (``genai_trace/tracer.py``), each request becomes a
``SERVER`` span named after its route's template (``GET /projects/{project_id}``),
with its method, scheme, route and status, under the same ``workpilot``
service as the agents' spans. Off, the middleware passes every request through
untouched.

A span carries no path, query, header, body, person or organization: a route
template and a status say how the server behaves without saying who used it.
"""

from __future__ import annotations

from typing import Any

from genai_trace.tracer import get_tracer

Scope = dict[str, Any]


class RequestSpans:
    """ASGI middleware: a span around each HTTP request."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Any, send: Any) -> None:
        tracer = get_tracer() if scope.get("type") == "http" else None
        if tracer is None:
            await self.app(scope, receive, send)
            return
        from opentelemetry import trace

        method = scope.get("method", "GET")
        status: dict[str, int] = {}

        async def sending(message: dict) -> None:
            if message.get("type") == "http.response.start":
                status["code"] = int(message.get("status", 0))
            await send(message)

        with tracer.start_as_current_span(
            f"HTTP {method}", kind=trace.SpanKind.SERVER
        ) as span:
            span.set_attribute("http.request.method", method)
            span.set_attribute("url.scheme", scope.get("scheme", "http"))
            try:
                await self.app(scope, receive, sending)
            except BaseException as error:
                span.set_attribute("error.type", type(error).__name__)
                raise
            finally:
                route = getattr(scope.get("route"), "path", None)
                if route:
                    span.set_attribute("http.route", route)
                    span.update_name(f"{method} {route}")
                code = status.get("code")
                if code:
                    span.set_attribute("http.response.status_code", code)
                    if code >= 500:
                        span.set_attribute("error.type", str(code))
