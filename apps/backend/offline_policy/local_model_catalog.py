"""Discover models from running local services without proxying or redirects."""

import json
import time
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from offline_policy import local_endpoint
from ollama_model_detector import is_embedding_model


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Local model discovery does not follow redirects")


def detect_runtime(provider: str) -> dict:
    """Ask the running service, never mistake an installed binary for a server."""
    try:
        root = local_endpoint(provider)
        url = root + ("/api/tags" if provider == "ollama" else "/v1/models")
        opener = build_opener(ProxyHandler({}), _NoRedirect())
        with opener.open(url, timeout=3) as response:
            payload = json.load(response)
        entries = payload.get("models" if provider == "ollama" else "data", [])
        models = []
        for entry in entries:
            name = entry.get("name" if provider == "ollama" else "id")
            if (
                isinstance(name, str)
                and name
                and not is_embedding_model(name)
                and not name.lower().endswith((":cloud", "-cloud"))
                and not entry.get("remote_host")
                and not entry.get("remote_model")
            ):
                models.append({"name": name, "size": str(entry.get("size", ""))})
        return {"available": True, "models": models}
    except (OSError, ValueError, TypeError, AttributeError):
        return {"available": False, "models": []}


# What a running Ollama said about a model's tools, by (server, model): an
# answer is kept a while, a server that did not answer is asked again soon.
_TOOLS: dict[tuple[str, str], tuple[float, bool | None]] = {}
TOOLS_TTL_S = 600.0
TOOLS_RETRY_S = 60.0
# A composition waits on it: a server that is up answers at once.
TOOLS_TIMEOUT_S = 2.0


def ollama_tool_use(model: str) -> bool | None:
    """Whether the local Ollama says ``model`` calls tools; None when it does not say.

    Only Ollama's own ``capabilities`` list (``POST /api/show``) answers, never
    the model's name; an older server without the field, a server that is down,
    a non-loopback ``OLLAMA_BASE_URL`` or an unknown model is None.
    """
    if not model:
        return None
    try:
        root = local_endpoint("ollama")
    except ValueError:
        return None
    key = (root, model)
    now = time.monotonic()
    cached = _TOOLS.get(key)
    if cached and now - cached[0] < (
        TOOLS_TTL_S if cached[1] is not None else TOOLS_RETRY_S
    ):
        return cached[1]
    answer: bool | None = None
    try:
        request = Request(
            root + "/api/show",
            data=json.dumps({"model": model}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        opener = build_opener(ProxyHandler({}), _NoRedirect())
        with opener.open(request, timeout=TOOLS_TIMEOUT_S) as response:
            capabilities = json.load(response).get("capabilities")
        if isinstance(capabilities, list):
            answer = "tools" in capabilities
    except (OSError, ValueError, TypeError, AttributeError):
        answer = None
    _TOOLS[key] = (now, answer)
    return answer
