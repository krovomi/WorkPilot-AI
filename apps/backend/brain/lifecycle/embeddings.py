"""Two notes on one subject in different words: a local model's reading (#352).

The detector (`contradictions.py`) asks for words in common: "always run the
migrations before the tests" against "never apply schema changes ahead of the
test suite" says the opposite with almost none, and goes unflagged. An
embeddings model reads them as one subject. This module asks one **already on
the machine** for the vectors, and `contradictions.compare_meaning` keeps the
pairs that also disagree.

**Optional, never a download.** No Python dependency is added: the model is
one Ollama has already pulled, asked on its ``/api/embed``. No Ollama, no
embedding model in its tags, a server down or slow: the pass is skipped and
the detector is what it was, lexical only, with no error. Nothing is ever
pulled; a model named in the settings that Ollama does not have turns the pass
off rather than fetching it.

**The machine, never the network.** The endpoint is
`offline_policy.local_endpoint` (``OLLAMA_BASE_URL``), which refuses anything
but a loopback address, and the requests ignore proxies and follow no
redirect. A local model is what the strict offline policy routes to, so the
pass runs under it too. Each call has a timeout.

**Bounded.** At most `MAX_EMBEDDED` notes are sent per review; a vector is
kept per model and note statement hash in ``.workpilot-brain/embeddings.json``
(this machine's, ignored by git), at most `MAX_CACHED` of them, so the next
pull only sends what changed.

**A note is data.** What is sent is the note's statement, expurgated
(`memories.redact`) and cut to `MAX_CHARS`; what comes back is read as numbers
and nothing else.

Settings (`brain.json`, the variable winning): ``BRAIN_CONFLICT_EMBEDDINGS``
(``off`` turns it off) and ``BRAIN_CONFLICT_EMBEDDINGS_MODEL`` (empty: the
first embedding model Ollama has, in `PREFERRED` order).
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
    "SWITCH_ENV",
    "Embedder",
    "configured_model",
    "enabled",
    "open_embedder",
    "pick_model",
    "similarity",
    "valid_model",
]

SWITCH_ENV = "BRAIN_CONFLICT_EMBEDDINGS"
MODEL_ENV = "BRAIN_CONFLICT_EMBEDDINGS_MODEL"
CONFIG_SWITCH = "conflictEmbeddings"
CONFIG_MODEL = "conflictEmbeddingsModel"
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
_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$")
_FAILURES = (OSError, ValueError, TypeError, http.client.HTTPException)


def enabled() -> bool:
    """``BRAIN_CONFLICT_EMBEDDINGS`` when set, else the switch in Settings, else on."""
    raw = os.environ.get(SWITCH_ENV, "").strip().lower()
    if raw:
        return raw not in _OFF
    return read_config().get(CONFIG_SWITCH, True) is not False


def valid_model(name: str) -> bool:
    """An Ollama model name (``nomic-embed-text``, ``bge-m3:567m``), or empty."""
    return not name or bool(_MODEL.match(name))


def configured_model() -> str:
    """The model the person named, ``""`` for the first one Ollama has."""
    raw = os.environ.get(MODEL_ENV, "").strip()
    if not raw:
        value = read_config().get(CONFIG_MODEL)
        raw = value.strip() if isinstance(value, str) else ""
    return raw if valid_model(raw) else ""


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


def pick_model(tags: Any, wanted: str = "") -> str | None:
    """The embedding model to use among those an ``/api/tags`` answer lists.

    *wanted* when Ollama has it (``x`` matches ``x:latest``); otherwise the
    first embedding model, `PREFERRED` ones first. A cloud model is never
    picked: its text would leave the machine.
    """
    models = tags.get("models") if isinstance(tags, dict) else None
    names = []
    for entry in models if isinstance(models, list) else []:
        name = entry.get("name") if isinstance(entry, dict) else None
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
            if name == wanted or (":" not in wanted and name == f"{wanted}:latest"):
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


class Embedder:
    """One review's access to the local model: its budget and the cache."""

    def __init__(self, root: Path, endpoint: str, model: str) -> None:
        self.endpoint = endpoint
        self.model = model
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
        digest = hashlib.sha256(f"{self.model}\0{text}".encode()).hexdigest()
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
                    f"{self.endpoint}/api/embed",
                    {"model": self.model, "input": [missing[k] for k in chunk]},
                    EMBED_TIMEOUT_S,
                )
                found = answer.get("embeddings") if isinstance(answer, dict) else None
                if not isinstance(found, list) or len(found) != len(chunk):
                    raise ValueError("unexpected answer")
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


def open_embedder(root: Path) -> Embedder | None:
    """The local model for this review, or ``None``: lexical detection only."""
    if not enabled():
        return None
    try:
        endpoint = local_endpoint("ollama")
    except ValueError:
        return None
    try:
        tags = _call(f"{endpoint}/api/tags", None, TAGS_TIMEOUT_S)
    except _FAILURES:
        return None
    model = pick_model(tags, configured_model())
    return Embedder(root, endpoint, model) if model else None
