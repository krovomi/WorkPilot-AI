"""Discover models from running local services without proxying or redirects."""

import json
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener

from core.offline_policy import local_endpoint
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
