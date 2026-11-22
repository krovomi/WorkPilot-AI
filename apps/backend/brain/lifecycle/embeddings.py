"""Two notes on one subject in different words: a local model's reading (#352).

The detector (`contradictions.py`) asks for words in common: "always run the
migrations before the tests" against "never apply schema changes ahead of the
test suite" says the opposite with almost none, and goes unflagged. An
embeddings model reads them as one subject. This module asks one **already on
the machine** for the vectors, and `contradictions.compare_meaning` keeps the
pairs that also disagree.

**Optional, never a download.** No Python dependency is added: the model is
one a local server already has — Ollama (pulled, listed by ``/api/tags``,
asked on ``/api/embed``) or LM Studio (listed by its OpenAI-compatible
``/v1/models``, asked on ``/v1/embeddings``). The provider named in the
settings, else Ollama, else LM Studio (`PROVIDERS`); none, no embedding model,
a server down or slow: the pass is skipped and the detector is what it was,
lexical only, with no error. Nothing is ever pulled; a model named in the
settings that no server asked has turns the pass off rather than fetching it.

**The machine, never the network.** The endpoint is
`offline_policy.local_endpoint` (``OLLAMA_BASE_URL``, ``LMSTUDIO_BASE_URL``),
which refuses anything but a loopback address, and the requests ignore proxies
and follow no redirect. A local model is what the strict offline policy routes
to, so the pass runs under it too. Each call has a timeout.

**Bounded.** At most `MAX_EMBEDDED` notes are sent per review; a vector is
kept per provider, model and note statement hash in
``.workpilot-brain/embeddings.json`` (this machine's, ignored by git), at most
`MAX_CACHED` of them, so the next pull only sends what changed.

**A note is data.** What is sent is the note's statement, expurgated
(`memories.redact`) and cut to `MAX_CHARS`; what comes back is read as numbers
and nothing else.

Settings (`brain.json`, the variable winning): ``BRAIN_CONFLICT_EMBEDDINGS``
(``off`` turns it off), ``BRAIN_CONFLICT_EMBEDDINGS_PROVIDER`` (``ollama`` or
``lm-studio``; empty: Ollama, else LM Studio) and
``BRAIN_CONFLICT_EMBEDDINGS_MODEL`` (empty: the first embedding model the
server has, in `PREFERRED` order).
"""

from __future__ import annotations

import base64
import hashlib
import http.client
import json
import logging
import math
import os
import re
from array import array
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from foundation.file_utils import write_json_atomic
from offline_policy import local_endpoint
from ollama_model_detector import is_embedding_model

from ..home import read_config
from ..memories import redact
from ..notes import inside

logger = logging.getLogger(__name__)

__all__ = [
    "CACHE_FILE",
    "MAX_EMBEDDED",
    "MODEL_ENV",
    "PROVIDERS",
    "PROVIDER_ENV",
    "SWITCH_ENV",
    "Embedder",
    "Found",
    "configured_model",
    "configured_provider",
    "enabled",
    "find",
    "open_embedder",
    "pick_model",
    "similarity",
    "valid_model",
    "valid_provider",
]

SWITCH_ENV = "BRAIN_CONFLICT_EMBEDDINGS"
MODEL_ENV = "BRAIN_CONFLICT_EMBEDDINGS_MODEL"
PROVIDER_ENV = "BRAIN_CONFLICT_EMBEDDINGS_PROVIDER"
CONFIG_SWITCH = "conflictEmbeddings"
CONFIG_MODEL = "conflictEmbeddingsModel"
CONFIG_PROVIDER = "conflictEmbeddingsProvider"
PROVIDERS = ("ollama", "lm-studio")
"""The local servers asked, in this order when the settings name none
(`offline_policy.local_endpoint` names)."""
CACHE_FILE = ".workpilot-brain/embeddings.json"

MAX_EMBEDDED = 200
"""Notes sent to the model in one review; a cached vector does not count."""
MAX_CACHED = 2000
MAX_CHARS = 2000
MAX_DIM = 8192
MAX_RESPONSE = 8 * 1024 * 1024
BATCH = 16
TAGS_TIMEOUT_S = 2.0
EMBED_TIMEOUT_S = 10.0
PREFERRED = (
    "bge-m3",
    "multilingual-e5",
    "nomic-embed-text",
    "mxbai-embed-large",
    "snowflake-arctic-embed",
)
"""Multilingual first: the notes are in English and French."""

_OFF = ("0", "false", "no", "off")
_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$")
_ALIASES = {"lmstudio": "lm-studio"}


@dataclass(frozen=True)
class _Runtime:
    """How one local server lists its models and embeds a batch."""

    models_path: str
    listing: str
    name_field: str
    embed_path: str


_RUNTIMES = {
    "ollama": _Runtime("/api/tags", "models", "name", "/api/embed"),
    "lm-studio": _Runtime("/v1/models", "data", "id", "/v1/embeddings"),
}
_FAILURES = (OSError, ValueError, TypeError, http.client.HTTPException)


def enabled() -> bool:
    """``BRAIN_CONFLICT_EMBEDDINGS`` when set, else the switch in Settings, else on."""
    raw = os.environ.get(SWITCH_ENV, "").strip().lower()
    if raw:
        return raw not in _OFF
    return read_config().get(CONFIG_SWITCH, True) is not False


def valid_model(name: str) -> bool:
    """A local model name (``nomic-embed-text``, ``bge-m3:567m``,
    ``text-embedding-nomic-embed-text-v1.5@q8_0``), or empty."""
    return not name or bool(_MODEL.match(name))


def _setting(variable: str, key: str) -> str:
    raw = os.environ.get(variable, "").strip()
    if not raw:
        value = read_config().get(key)
        raw = value.strip() if isinstance(value, str) else ""
    return raw


def configured_model() -> str:
    """The model the person named, ``""`` for the first one the server has."""
    raw = _setting(MODEL_ENV, CONFIG_MODEL)
    return raw if valid_model(raw) else ""


def valid_provider(name: str) -> str | None:
    """*name* as one of `PROVIDERS` (``lmstudio`` is ``lm-studio``), ``""``
    for automatic, ``None`` when it names no local server this pass asks."""
    value = str(name or "").strip().lower()
    value = _ALIASES.get(value, value)
    return value if not value or value in PROVIDERS else None


def configured_provider() -> str:
    """The local server the person named, ``""`` for Ollama then LM Studio.

    A value that names none counts as automatic: it never sends a note
    anywhere but to a loopback server `offline_policy` accepts.
    """
    return valid_provider(_setting(PROVIDER_ENV, CONFIG_PROVIDER)) or ""


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("a local model is not followed elsewhere")


def _call(url: str, payload: dict[str, Any] | None, timeout: float) -> Any:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="GET" if data is None else "POST",
    )
    opener = build_opener(ProxyHandler({}), _NoRedirect())
    with opener.open(request, timeout=timeout) as response:
        raw = response.read(MAX_RESPONSE + 1)
    if len(raw) > MAX_RESPONSE:
        raise ValueError("answer too large")
    return json.loads(raw.decode("utf-8"))


def pick_model(tags: Any, wanted: str = "", provider: str = "ollama") -> str | None:
    """The embedding model to use among those a server lists (Ollama's
    ``/api/tags``, LM Studio's ``/v1/models``).

    *wanted* when the server has it (on Ollama, ``x`` matches ``x:latest``);
    otherwise the first embedding model, `PREFERRED` ones first. A cloud model
    is never picked: its text would leave the machine.
    """
    runtime = _RUNTIMES[provider]
    models = tags.get(runtime.listing) if isinstance(tags, dict) else None
    names = []
    for entry in models if isinstance(models, list) else []:
        name = entry.get(runtime.name_field) if isinstance(entry, dict) else None
        if (
            isinstance(name, str)
            and valid_model(name)
            and name
            and not name.lower().endswith((":cloud", "-cloud"))
            and not entry.get("remote_host")
        ):
            names.append(name)
    if wanted:
        for name in names:
            if name == wanted or (
                provider == "ollama"
                and ":" not in wanted
                and name == f"{wanted}:latest"
            ):
                return name
        return None

    def rank(name: str) -> tuple[int, str]:
        low = name.lower()
        hits = [i for i, p in enumerate(PREFERRED) if p in low]
        return (hits[0] if hits else len(PREFERRED), low)

    candidates = sorted((n for n in names if is_embedding_model(n)), key=rank)
    return candidates[0] if candidates else None


def _pack(vector: list[float]) -> str:
    return base64.b64encode(array("f", vector).tobytes()).decode("ascii")


def _unpack(value: Any) -> list[float] | None:
    if not isinstance(value, str) or len(value) > MAX_DIM * 8:
        return None
    try:
        raw = base64.b64decode(value, validate=True)
    except ValueError:
        return None
    if not raw or len(raw) % 4:
        return None
    vector = array("f")
    vector.frombytes(raw)
    return list(vector)


def _vector(value: Any) -> list[float] | None:
    """A vector as the model sent it, or ``None`` when it is not one."""
    if not isinstance(value, list) or not 0 < len(value) <= MAX_DIM:
        return None
    out = []
    for x in value:
        if isinstance(x, bool) or not isinstance(x, (int, float)):
            return None
        if not math.isfinite(x):
            return None
        out.append(float(x))
    return out


def similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity; 0 for vectors of different sizes or a zero one."""
    if len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


def _embedded(provider: str, answer: Any, size: int) -> list[Any]:
    """The vectors of one batch, in the order asked, or ``ValueError``.

    Ollama answers ``{"embeddings": [[...], ...]}``; LM Studio, as the OpenAI
    API, ``{"data": [{"embedding": [...], "index": 0}, ...]}``.
    """
    if not isinstance(answer, dict):
        raise ValueError("unexpected answer")
    if provider == "ollama":
        found = answer.get("embeddings")
    else:
        data = answer.get("data")
        if not isinstance(data, list) or not all(isinstance(d, dict) for d in data):
            raise ValueError("unexpected answer")
        indexes = [d.get("index") for d in data]
        if sorted(i for i in indexes if type(i) is int) == list(range(len(data))):
            data = sorted(data, key=lambda d: d["index"])
        found = [d.get("embedding") for d in data]
    if not isinstance(found, list) or len(found) != size:
        raise ValueError("unexpected answer")
    return found


class Embedder:
    """One review's access to the local model: its budget and the cache."""

    def __init__(
        self, root: Path, endpoint: str, model: str, provider: str = "ollama"
    ) -> None:
        self.endpoint = endpoint
        self.model = model
        self.provider = provider
        self.budget = MAX_EMBEDDED
        self.down = False
        self.sent = 0
        self._changed = False
        try:
            self._path: Path | None = inside(root, CACHE_FILE)
        except ValueError:
            self._path = None
        self._cache = self._read()

    def _read(self) -> dict[str, str]:
        if self._path is None:
            return {}
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        vectors = data.get("vectors") if isinstance(data, dict) else None
        if not isinstance(vectors, dict):
            return {}
        return {
            k: v
            for k, v in vectors.items()
            if isinstance(k, str) and isinstance(v, str)
        }

    def _key(self, text: str) -> str:
        digest = hashlib.sha256(
            f"{self.provider}\0{self.model}\0{text}".encode()
        ).hexdigest()
        return digest[:40]

    def vectors(self, texts: list[str]) -> list[list[float] | None]:
        """A vector per text: cached, asked of the model, or ``None``.

        ``None`` for a text past the budget, or once the model failed to
        answer: the rest of the review goes on without it.
        """
        prepared = [redact(t)[:MAX_CHARS] for t in texts]
        out: list[list[float] | None] = []
        missing: dict[str, str] = {}
        for text in prepared:
            key = self._key(text)
            cached = _unpack(self._cache.get(key))
            if cached is not None:
                self._cache[key] = self._cache.pop(key)  # recently used
            elif key not in missing and not self.down and self.budget > 0:
                missing[key] = text
                self.budget -= 1
            out.append(cached)
        self._ask(missing)
        return [
            v if v is not None else _unpack(self._cache.get(self._key(t)))
            for v, t in zip(out, prepared, strict=True)
        ]

    def _ask(self, missing: dict[str, str]) -> None:
        keys = list(missing)
        for start in range(0, len(keys), BATCH):
            chunk = keys[start : start + BATCH]
            try:
                answer = _call(
                    f"{self.endpoint}{_RUNTIMES[self.provider].embed_path}",
                    {"model": self.model, "input": [missing[k] for k in chunk]},
                    EMBED_TIMEOUT_S,
                )
                found = _embedded(self.provider, answer, len(chunk))
                vectors = [_vector(v) for v in found]
            except _FAILURES as exc:
                logger.info("brain: local embeddings skipped: %s", type(exc).__name__)
                self.down = True
                return
            for key, vector in zip(chunk, vectors, strict=True):
                if vector is not None:
                    self._cache[key] = _pack(vector)
                    self._changed = True
            self.sent += len(chunk)

    def save(self) -> None:
        """Write the cache back, the most recently used `MAX_CACHED` vectors."""
        if not self._changed or self._path is None:
            return
        kept = dict(list(self._cache.items())[-MAX_CACHED:])
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            write_json_atomic(self._path, {"version": 1, "vectors": kept}, indent=0)
        except OSError as exc:
            logger.info("brain: embeddings cache not saved: %s", exc)


@dataclass(frozen=True)
class Found:
    """The local server and model a review would ask."""

    provider: str
    endpoint: str
    model: str


def find() -> Found | None:
    """The first local server with an embedding model: the one the settings
    name, else Ollama, else LM Studio; ``None`` for lexical detection only.

    Only listed, never pulled nor loaded by name: a model the settings name
    is looked for on each server asked, and none that has it is none.
    """
    named = configured_provider()
    wanted = configured_model()
    for provider in (named,) if named else PROVIDERS:
        try:
            endpoint = local_endpoint(provider)
        except ValueError:
            continue
        try:
            listing = _call(
                f"{endpoint}{_RUNTIMES[provider].models_path}", None, TAGS_TIMEOUT_S
            )
        except _FAILURES:
            continue
        model = pick_model(listing, wanted, provider)
        if model:
            return Found(provider, endpoint, model)
    return None


def open_embedder(root: Path) -> Embedder | None:
    """The local model for this review, or ``None``: lexical detection only."""
    if not enabled():
        return None
    found = find()
    if found is None:
        return None
    return Embedder(root, found.endpoint, found.model, found.provider)
