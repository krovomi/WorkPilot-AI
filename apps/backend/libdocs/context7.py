"""The Context7 client — the download side of `libdocs`.

Context7 is already declared as an MCP server for the coder, the researcher and
the reviewers, and that stays: an agent that hits an unfamiliar API mid-session
should be able to ask for more. But an MCP tool only fires when the model
decides to call it, and the case this package exists for is precisely the one
where the model does not know it should: it recognises the library name, writes
the API it remembers, and the docs are never consulted. So the same service is
reached a second way — over its REST API, before the session starts, from
Python that does not need convincing.

Two consequences of that choice are deliberate:

* **No API call is spent deciding what to download.** The libraries come from
  `detect.py`, which reads manifests and counts imports. Asking a model which
  libraries it does not know would be paying tokens for an answer it is, by
  construction, badly placed to give.
* **A failure here is never fatal.** Quota exhausted, offline, library not
  indexed — the build proceeds and the MCP tools remain available in-session.
  Downloading docs up front is an optimisation over asking mid-session, not a
  precondition for building.

Endpoints and parameter names mirror `@upstash/context7-mcp` (`/v2/libs/search`
and `/v2/context`, `Authorization: Bearer`), so both paths reach the same index
with the same library ids.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

__all__ = [
    "DEFAULT_BASE_URL",
    "DEFAULT_TIMEOUT",
    "Context7Client",
    "Context7Error",
    "Context7RateLimited",
    "Library",
    "api_key_from_env",
    "pick_version",
]

DEFAULT_BASE_URL = "https://context7.com/api"
DEFAULT_TIMEOUT = 30

# Mirrors CONTEXT7_API_URL in the MCP server, so a self-hosted or proxied index
# is configured once and both paths follow it.
_BASE_URL_ENV = "CONTEXT7_API_URL"
_API_KEY_ENV = "CONTEXT7_API_KEY"


class Context7Error(RuntimeError):
    """Context7 could not answer. Callers degrade, they do not abort."""


class Context7RateLimited(Context7Error):
    """Quota or rate limit. `retry_after` is seconds, when the API said so."""

    def __init__(self, message: str, retry_after: int | None = None):
        super().__init__(message)
        self.retry_after = retry_after


@dataclass(frozen=True)
class Library:
    """One entry of the Context7 index."""

    id: str
    title: str = ""
    description: str = ""
    trust_score: float = 0.0
    snippets: int = 0
    state: str = ""
    versions: tuple[str, ...] = field(default_factory=tuple)

    @property
    def finalized(self) -> bool:
        """Whether the index finished parsing this library.

        A library still being ingested answers `/v2/context` with a placeholder
        rather than documentation, so it is worth knowing before spending the
        second call on it.
        """
        return self.state.lower() == "finalized"

    @classmethod
    def from_payload(cls, payload: dict) -> Library:
        versions = payload.get("versions") or []
        return cls(
            id=str(payload.get("id", "")),
            title=str(payload.get("title", "")),
            description=str(payload.get("description", "")),
            trust_score=_as_float(payload.get("trustScore")),
            snippets=int(_as_float(payload.get("totalSnippets"))),
            state=str(payload.get("state", "")),
            versions=tuple(str(v) for v in versions if v),
        )


def _as_float(value: object) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0


def api_key_from_env(env: dict | None = None) -> str:
    """The Context7 API key, or an empty string.

    Anonymous access works and is rate limited per IP, which is fine for a
    developer trying the feature and hopeless for a machine running builds all
    day. The key is read rather than required so the first case still works.
    """
    source = os.environ if env is None else env
    return str(source.get(_API_KEY_ENV, "") or "").strip()


def pick_version(library: Library, declared: str) -> str:
    """The indexed version closest to what the project declares, or "".

    Only the major is matched. A project pinning `^15.1.0` and an index holding
    `v15.2.3` are the same documentation for anything a coder is about to
    write; matching the full constraint would mean parsing five ecosystems'
    range syntaxes to reject a version that answers the question.
    """
    if not declared or not library.versions:
        return ""
    major = _major(declared)
    if not major:
        return ""
    candidates = [v for v in library.versions if _major(v) == major]
    if not candidates:
        return ""
    return max(candidates, key=_version_key)


def _major(raw: str) -> str:
    digits = ""
    for char in str(raw):
        if char.isdigit():
            digits += char
        elif digits:
            break
    return digits


def _version_key(raw: str) -> tuple:
    parts = []
    for chunk in str(raw).lstrip("vV").split("."):
        number = ""
        for char in chunk:
            if char.isdigit():
                number += char
            else:
                break
        parts.append(int(number) if number else 0)
    return tuple(parts)


class Context7Client:
    """Search the index, then fetch documentation for one library.

    `session` exists for the tests: the network is the one part of this package
    that cannot be exercised in CI, so it is the one part that is injected.
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: int = DEFAULT_TIMEOUT,
        session=None,
    ):
        self.api_key = api_key if api_key is not None else api_key_from_env()
        self.base_url = (
            base_url or os.environ.get(_BASE_URL_ENV) or DEFAULT_BASE_URL
        ).rstrip("/")
        self.timeout = timeout
        self._session = session

    # -- transport ---------------------------------------------------------

    def _get(self, path: str, params: dict) -> object:
        session = self._session
        if session is None:
            try:
                import requests
            except ImportError as exc:  # pragma: no cover - requests is declared
                raise Context7Error(f"requests is not installed: {exc}") from exc
            session = requests
        headers = {
            "Accept": "application/json, text/plain",
            "X-Context7-Source": "workpilot",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        try:
            response = session.get(
                f"{self.base_url}{path}",
                params=params,
                headers=headers,
                timeout=self.timeout,
            )
        except Exception as exc:  # noqa: BLE001 - any transport failure degrades
            raise Context7Error(f"request failed: {exc}") from exc
        self._raise_for_status(response)
        return response

    @staticmethod
    def _raise_for_status(response) -> None:
        status = int(getattr(response, "status_code", 0) or 0)
        if status == 429:
            retry_after = getattr(response, "headers", {}) or {}
            raise Context7RateLimited(
                "Context7 rate limit reached; set CONTEXT7_API_KEY for a higher quota",
                _as_int(retry_after.get("Retry-After")),
            )
        if status and status >= 400:
            raise Context7Error(
                f"Context7 returned HTTP {status}: {_message(response)}"
            )

    # -- calls -------------------------------------------------------------

    def search(self, library_name: str, query: str, *, limit: int = 5) -> list[Library]:
        """Index entries matching a library name, best first."""
        response = self._get(
            "/v2/libs/search", {"libraryName": library_name, "query": query}
        )
        payload = _json(response)
        if not isinstance(payload, dict):
            raise Context7Error("search returned an unexpected payload")
        _raise_on_error_body(payload)
        results = payload.get("results")
        if not isinstance(results, list):
            return []
        libraries = [
            Library.from_payload(item) for item in results if isinstance(item, dict)
        ]
        return [lib for lib in libraries if lib.id][:limit]

    def docs(self, library_id: str, query: str) -> str:
        """Documentation for one library id, as text.

        The API answers a quota failure with a 200 and a JSON error body, so the
        body is inspected rather than the status alone — a build that wrote
        `{"error": "Quota Exceeded"}` into the cache as documentation would
        serve it to the coder for a fortnight.
        """
        response = self._get("/v2/context", {"libraryId": library_id, "query": query})
        text = str(getattr(response, "text", "") or "")
        if not text.strip():
            raise Context7Error(f"no documentation returned for {library_id}")
        payload = _maybe_json(text)
        if isinstance(payload, dict):
            _raise_on_error_body(payload)
        return text

    def resolve(self, library_name: str, query: str) -> Library | None:
        """The single best index entry for a name, or None.

        Preference order: an id whose last segment is the name being looked up,
        then trust score, then how much documentation the entry actually holds.
        The exact-name rule matters more than it looks — searching "react"
        returns component libraries whose description is mostly the word React.
        """
        candidates = self.search(library_name, query)
        if not candidates:
            return None
        wanted = _normalise(library_name)

        def rank(library: Library) -> tuple:
            segments = [_normalise(part) for part in library.id.strip("/").split("/")]
            exact = wanted in segments or _normalise(library.title) == wanted
            return (exact, library.finalized, library.trust_score, library.snippets)

        return max(candidates, key=rank)


def _normalise(raw: str) -> str:
    return "".join(ch for ch in str(raw).lower() if ch.isalnum())


def _as_int(value: object) -> int | None:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None


def _json(response) -> object:
    text = str(getattr(response, "text", "") or "")
    payload = _maybe_json(text)
    if payload is None:
        raise Context7Error("Context7 returned a non-JSON payload")
    return payload


def _maybe_json(text: str) -> object | None:
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def _message(response) -> str:
    payload = _maybe_json(str(getattr(response, "text", "") or ""))
    if isinstance(payload, dict):
        return str(payload.get("message") or payload.get("error") or "")[:200]
    return str(getattr(response, "text", "") or "")[:200]


def _raise_on_error_body(payload: dict) -> None:
    error = payload.get("error")
    if not error:
        return
    message = str(payload.get("message") or error)
    if "quota" in message.lower() or "rate" in message.lower():
        raise Context7RateLimited(message)
    raise Context7Error(message)
