"""Search the official Ollama library, never a guessed or third-party model ID.

Ollama has no public registry-wide search API. Its public library and tag pages
are the authority here; if those pages are unavailable we fail closed instead
of falling back to unverified names.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser
from urllib.parse import unquote

import httpx

ORIGIN = "https://ollama.com"
MODEL_LINK = re.compile(
    r"^/library/([a-zA-Z0-9][a-zA-Z0-9._-]*(?::[a-zA-Z0-9][a-zA-Z0-9._-]*)?)$"
)


class _LibraryLinks(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.models: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        href = dict(attrs).get("href") or ""
        match = MODEL_LINK.fullmatch(unquote(href))
        if match and match[1] not in self.models:
            self.models.append(match[1])


def search_models(query: str) -> list[dict[str, str]]:
    query = query.strip().lower()
    if len(query) > 80 or (
        query and not re.fullmatch(r"[a-z0-9][a-z0-9._-]*(?::[a-z0-9._-]*)?", query)
    ):
        raise ValueError("Invalid model search")
    family, separator, _ = query.partition(":")
    url = f"{ORIGIN}/library/{family}/tags" if separator else f"{ORIGIN}/library"
    response = httpx.get(
        url,
        params=None if separator else {"q": query},
        timeout=8.0,
        follow_redirects=False,
    )
    response.raise_for_status()
    parser = _LibraryLinks()
    parser.feed(response.text)
    results = []
    for model in parser.models:
        if "cloud" in model.lower():
            continue
        if separator:
            if not model.lower().startswith(query) or model.split(":")[0] != family:
                continue
        elif ":" in model or query not in model.lower():
            continue
        results.append({"value": model, "source": f"{ORIGIN}/library/{model}"})
    return results[:60]
