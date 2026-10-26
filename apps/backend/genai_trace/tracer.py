"""The process's tracer: on when an OTLP endpoint is set, off otherwise.

The switch is the one the Claude SDK already reads,
``AUTO_CLAUDE_OTEL_ENDPOINT`` (``core.client._add_otel_env``): one endpoint,
every provider. Spans go over OTLP ``http/protobuf`` to ``<endpoint>/v1/traces``,
which Jaeger, Langfuse and Phoenix all accept; a collector that needs a key
reads it from the standard ``OTEL_EXPORTER_OTLP_HEADERS``.

Off is the default and costs nothing: no SDK import, no thread, and every call
of :mod:`genai_trace.session` returns at once. Tracing is observability, so
nothing here ever raises into a build.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

ENDPOINT_ENV = "AUTO_CLAUDE_OTEL_ENDPOINT"
SERVICE_NAME = "workpilot"

_lock = threading.Lock()
_tracer: Any = None
_resolved = False


def traces_url(endpoint: str | None) -> str | None:
    """``<endpoint>/v1/traces`` for an http(s) endpoint, else None."""
    if not endpoint:
        return None
    endpoint = endpoint.strip()
    parts = urlsplit(endpoint)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    if parts.username or parts.password:
        # A key belongs in OTEL_EXPORTER_OTLP_HEADERS, not in a URL that logs print.
        return None
    return endpoint.rstrip("/") + "/v1/traces"


def get_tracer() -> Any:
    """The tracer, or None when tracing is off or cannot start."""
    global _tracer, _resolved
    if _resolved:
        return _tracer
    with _lock:
        if _resolved:
            return _tracer
        _tracer = _build(traces_url(os.environ.get(ENDPOINT_ENV)))
        _resolved = True
        return _tracer


def _build(url: str | None) -> Any:
    if url is None:
        if os.environ.get(ENDPOINT_ENV):
            logger.warning(
                "[genai_trace] %s is not an http(s) URL without credentials: "
                "WorkPilot's own spans are off",
                ENDPOINT_ENV,
            )
        return None
    try:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:
        logger.warning(
            "[genai_trace] opentelemetry-sdk is not installed: spans are off"
        )
        return None
    provider = TracerProvider(resource=Resource.create({"service.name": SERVICE_NAME}))
    # Short Kanban sessions: export every second, and flush at exit
    # (TracerProvider shuts down with the interpreter).
    provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=url), schedule_delay_millis=1000)
    )
    return provider.get_tracer("workpilot.genai_trace")


def use_tracer_for_tests(tracer: Any) -> None:
    """Install a tracer (an in-memory exporter's) or None; tests only."""
    global _tracer, _resolved
    with _lock:
        _tracer = tracer
        _resolved = True


def reset() -> None:
    """Forget the tracer, so the next call reads the environment again."""
    global _tracer, _resolved
    with _lock:
        _tracer = None
        _resolved = False
