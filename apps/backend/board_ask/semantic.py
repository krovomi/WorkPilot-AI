"""Tickets ranked by meaning: an embeddings model, local first.

A question asked in French finds a ticket written in Spanish when an
embeddings model reads both: the vectors of two texts that say the same thing
are close, whatever their words. This module asks one for the question and
the tickets, and ranks the tickets by how close they are (cosine).

**Which model.** In this order, and only the first one found:

1. a local server's, already on the machine: the one the brain's conflict
   pass uses (`brain.lifecycle.embeddings.find`: Ollama, then LM Studio, a
   multilingual model such as ``bge-m3`` first, never pulled);
2. with ``auto`` only, the embeddings API of the provider the person chose
   (``SELECTED_LLM_PROVIDER``), with the key the app gave this process:
   OpenAI (or an OpenAI-compatible ``OPENAI_BASE_URL``), Mistral, Google,
   Hugging Face (`CLOUDS`). Never under the project's strict offline policy
   (`offline_policy.airgap_status`), never for a provider that has none
   (Claude, for one): the panel then ranks by keywords and its model alone.

``local`` stops after 1, ``off`` asks nothing (`MODES`).

**Bounded.** At most `MAX_DOCUMENTS` tickets of `MAX_TEXT_CHARS` each; the
model is asked for `TIME_BUDGET_S` at most, by batches. A vector is kept per
provider, model and text hash in the app's own folder (``cache_dir``, never a
project), at most `MAX_CACHED` of them, so the next question only sends the
tickets that changed: a large board is read over a few questions, and the
answer says how much of it was (`Ranking.indexed`).

**A ticket is data.** What is sent is its text with secrets masked
(`foundation.log_redaction.redact_text`, and the brain's own redaction for a
local model); what comes back is read as numbers and nothing else. A cloud
endpoint is ``https`` (``http`` only on the loopback), followed to no
redirect, answered within a timeout and a size cap; the key travels in the
``Authorization`` header and in no message.
"""

from __future__ import annotations

import base64
import hashlib
import http.client
import ipaddress
import json
import logging
import math
import os
import re
import time
from array import array
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from brain.lifecycle.embeddings import Embedder, find, similarity
from foundation.file_utils import write_json_atomic
from foundation.log_redaction import redact_text
from offline_policy import airgap_status

logger = logging.getLogger(__name__)

__all__ = [
    "CLOUDS",
    "MODES",
    "CloudEmbedder",
    "Ranking",
    "Source",
    "rank",
    "rank_many",
    "resolve",
]

MODES = ("auto", "local", "off")
MAX_DOCUMENTS = 1500
MAX_TEXT_CHARS = 2000
MAX_QUERY_CHARS = 1000
MAX_QUERIES = 16
MAX_ID_CHARS = 200
MAX_CACHED = 4000
MAX_DIM = 8192
MAX_RESPONSE = 16 * 1024 * 1024
CLOUD_BATCH = 64
LOCAL_CHUNK = 48
CLOUD_TIMEOUT_S = 20.0
TIME_BUDGET_S = 30.0
CACHE_FILE = "board-ask-vectors.json"
MODEL_ENV = "BOARD_ASK_EMBEDDINGS_MODEL"
_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$")
_FAILURES = (OSError, ValueError, TypeError, KeyError, http.client.HTTPException)
HF_URL = (
    "https://router.huggingface.co/hf-inference/models/{model}"
    "/pipeline/feature-extraction"
)


@dataclass(frozen=True)
class Cloud:
    """One provider's embeddings API."""

    key_env: str
    default_base: str
    model: str
    base_env: str | None = None
    style: str = "openai"


CLOUDS: dict[str, Cloud] = {
    "openai": Cloud(
        "OPENAI_API_KEY",
        "https://api.openai.com/v1",
        "text-embedding-3-small",
        base_env="OPENAI_BASE_URL",
    ),
    "mistral": Cloud(
        "MISTRAL_API_KEY",
        "https://api.mistral.ai/v1",
        "mistral-embed",
        base_env="MISTRAL_BASE_URL",
    ),
    "google": Cloud(
        "GOOGLE_API_KEY",
        "https://generativelanguage.googleapis.com/v1beta/openai",
        "gemini-embedding-001",
    ),
    "huggingface": Cloud(
        "HUGGINGFACE_API_KEY",
        "",
        "intfloat/multilingual-e5-large",
        style="huggingface",
    ),
}
_ALIASES = {"gemini": "google", "hf": "huggingface", "hugging-face": "huggingface"}


@dataclass(frozen=True)
class Source:
    """The model a ranking came from, as the panel names it."""

    kind: str  # "local" | "cloud"
    provider: str
    model: str

    def to_dict(self) -> dict[str, str]:
        return {"kind": self.kind, "provider": self.provider, "model": self.model}


class VectorSource(Protocol):
    """What `rank` needs of an embedder: vectors, and saving them."""

    def vectors(self, texts: list[str]) -> list[list[float] | None]:
        """One vector per text, or None for a text that could not be read."""

    def save(self) -> None:
        """Keep the vectors computed so far for the next question."""


@dataclass
class Ranking:
    """The tickets by closeness to the question, and how much was read."""

    source: Source
    scores: list[dict[str, Any]] = field(default_factory=list)
    indexed: int = 0
    total: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source.to_dict(),
            "scores": self.scores,
            "indexed": self.indexed,
            "total": self.total,
        }


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


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def endpoint_base(raw: str) -> str | None:
    """*raw* as an API base URL, or ``None``: ``https``, or ``http`` on the
    loopback; no user name or password in it; no query nor fragment."""
    value = (raw or "").strip().rstrip("/")
    try:
        parts = urlsplit(value)
        _ = parts.port  # raises on a port that is not a number
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    if not host or parts.username or parts.password or parts.query or parts.fragment:
        return None
    if parts.scheme == "https" or (parts.scheme == "http" and _is_loopback(host)):
        return value
    return None


def valid_model(name: str) -> bool:
    return bool(_MODEL.match(name or ""))


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("an embeddings API is not followed elsewhere")


def _post(url: str, payload: dict[str, Any], key: str, timeout: float) -> Any:
    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    with build_opener(_NoRedirect()).open(request, timeout=timeout) as response:
        raw = response.read(MAX_RESPONSE + 1)
    if len(raw) > MAX_RESPONSE:
        raise ValueError("answer too large")
    return json.loads(raw.decode("utf-8"))


def _openai_vectors(answer: Any, size: int) -> list[Any]:
    """``{"data": [{"embedding": [...], "index": 0}, ...]}``, in the order asked."""
    data = answer.get("data") if isinstance(answer, dict) else None
    if not isinstance(data, list) or not all(isinstance(d, dict) for d in data):
        raise ValueError("unexpected answer")
    indexes = [d.get("index") for d in data]
    if sorted(i for i in indexes if type(i) is int) == list(range(len(data))):
        data = sorted(data, key=lambda d: d["index"])
    found = [d.get("embedding") for d in data]
    if len(found) != size:
        raise ValueError("unexpected answer")
    return found


def _hf_vectors(answer: Any, size: int) -> list[Any]:
    """A list of vectors, one per text."""
    if not isinstance(answer, list) or len(answer) != size:
        raise ValueError("unexpected answer")
    return answer


class CloudEmbedder:
    """The chosen provider's embeddings API, with the app's vector cache."""

    def __init__(
        self,
        cache_dir: Path,
        provider: str,
        cloud: Cloud,
        key: str,
        base: str,
        model: str,
    ) -> None:
        self.provider = provider
        self.cloud = cloud
        self.model = model
        self.down = False
        self.sent = 0
        self._key_value = key
        self._base = base
        self._path = cache_dir / CACHE_FILE
        self._changed = False
        self._cache = self._read()

    def _read(self) -> dict[str, str]:
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

    def _hash(self, text: str) -> str:
        digest = hashlib.sha256(
            f"{self.provider}\0{self.model}\0{text}".encode()
        ).hexdigest()
        return digest[:40]

    def _url(self) -> str:
        if self.cloud.style == "huggingface":
            return HF_URL.format(model=self.model)
        return f"{self._base}/embeddings"

    def _payload(self, texts: list[str]) -> dict[str, Any]:
        if self.cloud.style == "huggingface":
            return {"inputs": texts, "normalize": True, "truncate": True}
        return {"model": self.model, "input": texts}

    def vectors(self, texts: list[str]) -> list[list[float] | None]:
        """A vector per text: cached, asked of the API, or ``None`` once it failed."""
        prepared = [redact_text(t)[:MAX_TEXT_CHARS] for t in texts]
        missing: dict[str, str] = {}
        for text in prepared:
            key = self._hash(text)
            if key in self._cache:
                self._cache[key] = self._cache.pop(key)  # recently used
            elif not self.down:
                missing[key] = text
        keys = list(missing)
        for start in range(0, len(keys), CLOUD_BATCH):
            chunk = keys[start : start + CLOUD_BATCH]
            try:
                answer = _post(
                    self._url(),
                    self._payload([missing[k] for k in chunk]),
                    self._key_value,
                    CLOUD_TIMEOUT_S,
                )
                read = (
                    _hf_vectors
                    if self.cloud.style == "huggingface"
                    else _openai_vectors
                )
                found = [_vector(v) for v in read(answer, len(chunk))]
            except _FAILURES as exc:
                logger.info(
                    "board ask: %s embeddings skipped: %s",
                    self.provider,
                    type(exc).__name__,
                )
                self.down = True
                break
            for key, vector in zip(chunk, found, strict=True):
                if vector is not None:
                    self._cache[key] = _pack(vector)
                    self._changed = True
            self.sent += len(chunk)
        return [_unpack(self._cache.get(self._hash(t))) for t in prepared]

    def save(self) -> None:
        """Write the cache back, the most recently used `MAX_CACHED` vectors."""
        if not self._changed:
            return
        kept = dict(list(self._cache.items())[-MAX_CACHED:])
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            write_json_atomic(self._path, {"version": 1, "vectors": kept}, indent=0)
        except OSError as exc:
            logger.info("board ask: embeddings cache not saved: %s", exc)


def _provider(env: Mapping[str, str]) -> str:
    raw = str(env.get("SELECTED_LLM_PROVIDER", "")).strip().lower()
    return _ALIASES.get(raw, raw)


def _cloud(
    cache_dir: Path, env: Mapping[str, str]
) -> tuple[Source, CloudEmbedder] | None:
    provider = _provider(env)
    cloud = CLOUDS.get(provider)
    if cloud is None:
        return None
    key = str(env.get(cloud.key_env, "")).strip()
    if not key:
        return None
    base = ""
    if cloud.style == "openai":
        raw = str(env.get(cloud.base_env, "")).strip() if cloud.base_env else ""
        base = endpoint_base(raw or cloud.default_base) or ""
        if not base:
            return None
    wanted = str(env.get(MODEL_ENV, "")).strip()
    model = wanted if valid_model(wanted) else cloud.model
    embedder = CloudEmbedder(cache_dir, provider, cloud, key, base, model)
    return Source("cloud", provider, model), embedder


def resolve(
    mode: str,
    cache_dir: Path,
    project_dir: Path | None,
    env: Mapping[str, str] | None = None,
) -> tuple[Source, VectorSource] | None:
    """The model to rank with, or ``None``: keywords and the chat model only."""
    if mode not in MODES or mode == "off":
        return None
    found = find()
    if found is not None:
        embedder = Embedder(cache_dir, found.endpoint, found.model, found.provider)
        embedder.budget = MAX_DOCUMENTS + 1
        return Source("local", found.provider, found.model), embedder
    if mode != "auto":
        return None
    paths = [project_dir] if project_dir else []
    if airgap_status(*paths).get("airgapStrict"):
        return None
    return _cloud(cache_dir, os.environ if env is None else env)


def _role(model: str, role: str, text: str) -> str:
    """The E5 family reads a question and a passage told apart."""
    return f"{role}: {text}" if "e5" in model.lower() else text


def rank_many(
    source: Source,
    embedder: VectorSource,
    queries: list[str],
    documents: list[dict[str, str]],
    *,
    budget_s: float = TIME_BUDGET_S,
    clock: Any = time.monotonic,
) -> list[Ranking | None] | None:
    """A ranking of the documents per query, best first, or ``None`` when the
    model gave no vector for any query (a query without one gets ``None``).

    The documents are read once, by chunks, until *budget_s* has passed:
    those not read yet (nor cached) are left out of the scores, and
    `Ranking.indexed` says how many were.
    """
    deadline = clock() + budget_s
    asked = embedder.vectors(
        [_role(source.model, "query", q[:MAX_QUERY_CHARS]) for q in queries]
    )
    if all(v is None for v in asked):
        return None
    docs = documents[:MAX_DOCUMENTS]
    texts = [_role(source.model, "passage", d["text"][:MAX_TEXT_CHARS]) for d in docs]
    vectors: list[list[float] | None] = []
    for start in range(0, len(texts), LOCAL_CHUNK):
        if clock() >= deadline:
            vectors.extend([None] * (len(texts) - start))
            break
        vectors.extend(embedder.vectors(texts[start : start + LOCAL_CHUNK]))
    embedder.save()
    read = [
        (doc, vector)
        for doc, vector in zip(docs, vectors, strict=True)
        if vector is not None
    ]
    rankings: list[Ranking | None] = []
    for question in asked:
        if question is None:
            rankings.append(None)
            continue
        scores = [
            {"id": doc["id"], "score": round(similarity(question, vector), 4)}
            for doc, vector in read
        ]
        scores.sort(key=lambda s: -s["score"])
        rankings.append(Ranking(source, scores, indexed=len(read), total=len(docs)))
    return rankings


def rank(
    source: Source,
    embedder: VectorSource,
    query: str,
    documents: list[dict[str, str]],
    *,
    budget_s: float = TIME_BUDGET_S,
    clock: Any = time.monotonic,
) -> Ranking | None:
    """The documents by closeness to *query*, best first (`rank_many` of one)."""
    rankings = rank_many(
        source, embedder, [query], documents, budget_s=budget_s, clock=clock
    )
    return rankings[0] if rankings else None


def parse_request(raw: Any) -> dict[str, Any]:
    """The runner's input, checked, or ``ValueError``."""
    if not isinstance(raw, dict):
        raise ValueError("input is not an object")
    mode = raw.get("mode", "auto")
    if mode not in MODES:
        raise ValueError("unknown mode")
    cache_dir = raw.get("cache_dir")
    if not isinstance(cache_dir, str) or not Path(cache_dir).is_absolute():
        raise ValueError("cache_dir must be an absolute path")
    project_dir = raw.get("project_dir")
    if project_dir is not None and (
        not isinstance(project_dir, str) or not Path(project_dir).is_absolute()
    ):
        raise ValueError("project_dir must be an absolute path")
    many = "queries" in raw
    asked = raw.get("queries") if many else [raw.get("query")]
    if not isinstance(asked, list) or not 0 < len(asked) <= MAX_QUERIES:
        raise ValueError("queries must be a bounded list")
    if not all(isinstance(q, str) and q.strip() for q in asked):
        raise ValueError("query must be text")
    documents = raw.get("documents")
    if not isinstance(documents, list) or len(documents) > MAX_DOCUMENTS:
        raise ValueError("documents must be a bounded list")
    docs = []
    for doc in documents:
        if not isinstance(doc, dict):
            raise ValueError("a document is not an object")
        ident, text = doc.get("id"), doc.get("text")
        if not isinstance(ident, str) or not ident or len(ident) > MAX_ID_CHARS:
            raise ValueError("a document id is invalid")
        if not isinstance(text, str):
            raise ValueError("a document text is invalid")
        docs.append({"id": ident, "text": text[:MAX_TEXT_CHARS]})
    return {
        "mode": mode,
        "cache_dir": Path(cache_dir).resolve(),
        "project_dir": Path(project_dir).resolve() if project_dir else None,
        "queries": [q.strip()[:MAX_QUERY_CHARS] for q in asked],
        "many": many,
        "documents": docs,
    }
