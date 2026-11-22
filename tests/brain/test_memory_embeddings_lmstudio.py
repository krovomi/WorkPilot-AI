"""LM Studio as well as Ollama for the memory conflicts' embeddings pass (#352).

When Ollama has no embeddings model (or is not there), a model LM Studio
already lists on its OpenAI-compatible server finds the same pairs. These
tests hold, against fake servers on the loopback (no real model):

* the order: the provider the settings name, else Ollama, else LM Studio,
  else lexical only; a named provider that is down is not replaced;
* LM Studio is asked on ``/v1/models`` and ``/v1/embeddings``, and a model it
  does not list is never asked for (nothing is downloaded nor loaded by name);
* the same endpoint rules as Ollama: ``offline_policy.local_endpoint``
  (loopback only), no redirect, a malformed answer is lexical only;
* the cache is keyed by provider and model;
* the settings: a provider choice (``BRAIN_CONFLICT_EMBEDDINGS_PROVIDER``,
  ``conflictEmbeddingsProvider``), and the route that says what was found.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from brain import api as brain_api
from brain.home import write_config
from brain.lifecycle import arbitration, embeddings
from brain.notes import Note, write_note

BASE = "knowledge/projects/shop/memory"
OURS = "Always run the migrations before the tests."
THEIRS = "Never apply schema changes ahead of the test suite."
DEAD = "http://127.0.0.1:9"


def _topic(text: str) -> list[float]:
    low = text.lower()
    if "migration" in low or "schema" in low:
        return [1.0, 0.05, 0.0]
    return [0.0, 0.0, 1.0]


class FakeServer:
    """A local server: Ollama's API (``ollama``) or LM Studio's (``lm-studio``)."""

    def __init__(self, kind: str, models: list[str]) -> None:
        self.kind = kind
        self.models = models
        self.paths: list[str] = []
        self.embedded: list[str] = []
        self.answer: object | None = None
        self.reverse = False
        self.redirect = False
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, payload: object, status: int = 200) -> None:
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                outer.paths.append(f"GET {self.path}")
                if outer.redirect:
                    self.send_response(302)
                    self.send_header("Location", "http://example.com/v1/models")
                    self.end_headers()
                    return
                if outer.kind == "ollama" and self.path == "/api/tags":
                    self._send({"models": [{"name": n} for n in outer.models]})
                elif outer.kind == "lm-studio" and self.path == "/v1/models":
                    self._send(
                        {
                            "object": "list",
                            "data": [
                                {"id": n, "object": "model", "owned_by": "me"}
                                for n in outer.models
                            ],
                        }
                    )
                else:
                    self._send({"error": "not found"}, 404)

            def do_POST(self):
                outer.paths.append(f"POST {self.path}")
                length = int(self.headers.get("Content-Length") or 0)
                request = json.loads(self.rfile.read(length).decode("utf-8"))
                texts = request["input"]
                outer.embedded.extend(texts)
                if outer.answer is not None:
                    self._send(outer.answer)
                elif outer.kind == "ollama" and self.path == "/api/embed":
                    self._send({"embeddings": [_topic(t) for t in texts]})
                elif outer.kind == "lm-studio" and self.path == "/v1/embeddings":
                    if request["model"] not in outer.models:
                        self._send({"error": "model not found"}, 404)
                        return
                    data = [
                        {"object": "embedding", "embedding": _topic(t), "index": i}
                        for i, t in enumerate(texts)
                    ]
                    self._send(
                        {
                            "object": "list",
                            "data": data[::-1] if outer.reverse else data,
                            "model": request["model"],
                        }
                    )
                else:
                    self._send({"error": "not found"}, 404)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


LMS_MODEL = "text-embedding-nomic-embed-text-v1.5"


@pytest.fixture(autouse=True)
def _settings(monkeypatch):
    for variable in (
        embeddings.SWITCH_ENV,
        embeddings.MODEL_ENV,
        embeddings.PROVIDER_ENV,
        "BRAIN_CONFLICT_STALE_DAYS",
    ):
        monkeypatch.delenv(variable, raising=False)
    monkeypatch.setenv("OLLAMA_BASE_URL", DEAD)
    monkeypatch.setenv("LMSTUDIO_BASE_URL", DEAD)


@pytest.fixture
def lmstudio(monkeypatch):
    fake = FakeServer("lm-studio", [LMS_MODEL, "qwen2.5-7b-instruct"])
    # As LM Studio shows it: the OpenAI path is stripped by `local_endpoint`.
    monkeypatch.setenv("LMSTUDIO_BASE_URL", f"{fake.url}/v1")
    yield fake
    fake.close()


@pytest.fixture
def ollama(monkeypatch):
    fake = FakeServer("ollama", ["nomic-embed-text:latest", "llama3:8b"])
    monkeypatch.setenv("OLLAMA_BASE_URL", fake.url)
    yield fake
    fake.close()


def put(root: Path, name: str, body: str) -> str:
    rel = f"{BASE}/gotchas/{name}.md"
    write_note(root, Note(path=Path(rel), meta={"project": "shop"}, body=body))
    return rel


def queue(root: Path) -> list[dict]:
    path = root / arbitration.QUEUE_FILE
    return json.loads(path.read_text(encoding="utf-8"))["open"] if path.exists() else []


def found() -> tuple[str, str] | None:
    hit = embeddings.find()
    return (hit.provider, hit.model) if hit else None


# --------------------------------------------------------------------------- #
# Through a sync's review
# --------------------------------------------------------------------------- #


def test_without_ollama_lm_studio_finds_the_pair(tmp_path, lmstudio):
    ours = put(tmp_path, "ours", OURS)
    theirs = put(tmp_path, "theirs", THEIRS)

    summary = arbitration.review_pull(tmp_path, [theirs], [])

    assert summary == {"checked": 1, "auto": 0, "queued": 1}
    [item] = queue(tmp_path)
    assert item["found_by"] == "embeddings"
    assert {item["a"]["path"], item["b"]["path"]} == {ours, theirs}
    assert lmstudio.paths == ["GET /v1/models", "POST /v1/embeddings"]
    assert sorted(lmstudio.embedded) == sorted([OURS, THEIRS])


def test_an_answer_out_of_order_is_read_by_its_index(tmp_path, lmstudio):
    lmstudio.reverse = True
    embedder = embeddings.open_embedder(tmp_path)
    one, two = embedder.vectors([OURS, "Keep the changelog in French."])
    assert one == pytest.approx(_topic(OURS))
    assert two == pytest.approx([0.0, 0.0, 1.0])


@pytest.mark.parametrize(
    "answer",
    [
        {"data": "nope"},
        {"data": [1, 2]},
        {"data": [{"embedding": [1.0], "index": 0}]},  # one vector for two texts
        {"embeddings": [[1.0], [1.0]]},  # Ollama's shape, not LM Studio's
        [],
    ],
)
def test_a_malformed_answer_is_lexical_only(tmp_path, lmstudio, answer):
    lmstudio.answer = answer
    put(tmp_path, "ours", OURS)
    theirs = put(tmp_path, "theirs", THEIRS)

    assert arbitration.review_pull(tmp_path, [theirs], [])["queued"] == 0


def test_entries_without_an_index_are_read_in_order(tmp_path, lmstudio):
    lmstudio.answer = {"data": [{"embedding": [1.0, 0.0]}, {"embedding": [0.0, 1.0]}]}
    embedder = embeddings.open_embedder(tmp_path)
    assert embedder.vectors(["a", "b"]) == [[1.0, 0.0], [0.0, 1.0]]


# --------------------------------------------------------------------------- #
# Which server, which model
# --------------------------------------------------------------------------- #


def test_ollama_comes_first(ollama, lmstudio):
    assert found() == ("ollama", "nomic-embed-text:latest")
    assert lmstudio.paths == []


def test_lm_studio_when_ollama_has_no_embedding_model(ollama, lmstudio):
    ollama.models = ["llama3:8b"]
    assert found() == ("lm-studio", LMS_MODEL)


def test_neither_is_lexical_only(lmstudio, tmp_path):
    lmstudio.models = ["qwen2.5-7b-instruct"]
    assert found() is None
    assert embeddings.open_embedder(tmp_path) is None


def test_a_named_provider_is_the_only_one_asked(ollama, lmstudio, monkeypatch):
    monkeypatch.setenv(embeddings.PROVIDER_ENV, "LMStudio")
    assert found() == ("lm-studio", LMS_MODEL)
    assert ollama.paths == []

    monkeypatch.setenv(embeddings.PROVIDER_ENV, "ollama")
    ollama.close()
    assert found() is None  # not replaced by LM Studio
    assert "POST /v1/embeddings" not in lmstudio.paths


def test_the_provider_from_the_settings_and_the_variable_wins(
    ollama, lmstudio, monkeypatch
):
    write_config(**{embeddings.CONFIG_PROVIDER: "lm-studio"})
    assert embeddings.configured_provider() == "lm-studio"
    assert found() == ("lm-studio", LMS_MODEL)
    monkeypatch.setenv(embeddings.PROVIDER_ENV, "ollama")
    assert found() == ("ollama", "nomic-embed-text:latest")
    # A name that is no local server counts as automatic.
    monkeypatch.setenv(embeddings.PROVIDER_ENV, "openai")
    assert embeddings.configured_provider() == ""
    write_config(**{embeddings.CONFIG_PROVIDER: None})


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("", ""),
        (" Ollama ", "ollama"),
        ("lm-studio", "lm-studio"),
        ("lmstudio", "lm-studio"),
        ("llama-cpp", None),
        ("openai", None),
    ],
)
def test_valid_provider(name, expected):
    assert embeddings.valid_provider(name) == expected


def test_a_named_model_is_looked_for_on_each_server(ollama, lmstudio, monkeypatch):
    monkeypatch.setenv(embeddings.MODEL_ENV, LMS_MODEL)
    assert found() == ("lm-studio", LMS_MODEL)
    # A model no server lists is never asked for: nothing is loaded by name.
    monkeypatch.setenv(embeddings.MODEL_ENV, "text-embedding-bge-m3@q8_0")
    assert found() is None
    assert not any(p.startswith("POST") for p in lmstudio.paths + ollama.paths)


def test_lm_studio_s_listing():
    listing = {
        "data": [
            {"id": "qwen2.5-7b-instruct"},
            {"id": "text-embedding-bge-m3"},
            {"id": LMS_MODEL},
            {"id": "remote-embed", "remote_host": "example.com"},
            {"id": "text-embedding-x-cloud"},
            {"object": "model"},
        ]
    }
    assert embeddings.pick_model(listing, provider="lm-studio") == (
        "text-embedding-bge-m3"
    )
    assert embeddings.pick_model(listing, LMS_MODEL, "lm-studio") == LMS_MODEL
    # Ollama's `:latest` rule is Ollama's.
    assert (
        embeddings.pick_model({"data": [{"id": "e5:latest"}]}, "e5", "lm-studio")
        is None
    )
    assert embeddings.pick_model({"models": []}, provider="lm-studio") is None


def test_a_remote_lm_studio_is_never_asked(monkeypatch, lmstudio):
    monkeypatch.setenv("LMSTUDIO_BASE_URL", "http://192.0.2.10:1234")
    assert found() is None
    assert lmstudio.paths == []


def test_a_redirect_is_not_followed(lmstudio):
    lmstudio.redirect = True
    assert found() is None


# --------------------------------------------------------------------------- #
# The cache
# --------------------------------------------------------------------------- #


def test_the_cache_is_keyed_by_provider_and_model(tmp_path):
    a = embeddings.Embedder(tmp_path, DEAD, "nomic-embed-text", "ollama")
    b = embeddings.Embedder(tmp_path, DEAD, "nomic-embed-text", "lm-studio")
    c = embeddings.Embedder(tmp_path, DEAD, "bge-m3", "lm-studio")
    assert len({a._key(OURS), b._key(OURS), c._key(OURS)}) == 3


def test_a_vector_from_ollama_is_not_reused_for_lm_studio(
    tmp_path, ollama, lmstudio, monkeypatch
):
    lmstudio.models = ["nomic-embed-text:latest"]
    first = embeddings.open_embedder(tmp_path)
    assert first.provider == "ollama"
    first.vectors([OURS])
    first.save()

    monkeypatch.setenv(embeddings.PROVIDER_ENV, "lm-studio")
    second = embeddings.open_embedder(tmp_path)
    assert second.provider == "lm-studio"
    second.vectors([OURS])
    assert lmstudio.embedded == [OURS]


# --------------------------------------------------------------------------- #
# Settings screen
# --------------------------------------------------------------------------- #


@pytest.fixture
def client(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setenv("WORKPILOT_BRAIN_CONFIG", str(tmp_path / "brain.json"))
    app = FastAPI()
    app.include_router(brain_api.router)
    return TestClient(app)


def post(client, body: dict) -> dict:
    return client.post("/api/brain/settings", json={"connect": False, **body}).json()


def test_the_provider_is_saved_and_shown(client, tmp_path):
    reply = post(client, {"conflict_embeddings_provider": " LMStudio "})
    assert reply["success"] is True
    view = reply["settings"]["conflictEmbeddings"]
    assert view["provider"] == "lm-studio" and view["providerLocked"] is False
    saved = json.loads((tmp_path / "brain.json").read_text(encoding="utf-8"))
    assert saved["conflictEmbeddingsProvider"] == "lm-studio"

    reply = post(client, {"conflict_embeddings_provider": ""})
    assert reply["settings"]["conflictEmbeddings"]["provider"] == ""
    saved = json.loads((tmp_path / "brain.json").read_text(encoding="utf-8"))
    assert "conflictEmbeddingsProvider" not in saved


def test_a_provider_that_is_no_local_server_is_refused(client):
    reply = post(client, {"conflict_embeddings_provider": "openai"})
    assert reply["success"] is False and reply["code"] == "invalid-provider"


def test_the_provider_variable_locks_its_setting(client, monkeypatch):
    monkeypatch.setenv(embeddings.PROVIDER_ENV, "ollama")
    reply = post(client, {"conflict_embeddings_provider": "lm-studio"})
    assert reply["success"] is False and reply["code"] == "env-locked"
    view = client.get("/api/brain/settings").json()["settings"]["conflictEmbeddings"]
    assert view["provider"] == "ollama" and view["providerLocked"] is True


def test_the_route_says_what_was_found(client, lmstudio, monkeypatch):
    reply = client.get("/api/brain/settings/embeddings").json()
    assert reply == {
        "success": True,
        "found": {"provider": "lm-studio", "model": LMS_MODEL},
    }

    lmstudio.models = []
    assert client.get("/api/brain/settings/embeddings").json()["found"] is None

    monkeypatch.setenv(embeddings.SWITCH_ENV, "off")
    lmstudio.paths.clear()
    assert client.get("/api/brain/settings/embeddings").json()["found"] is None
    assert lmstudio.paths == []  # off: nothing is asked


def test_the_route_is_refused_in_server_mode(client, monkeypatch):
    monkeypatch.setattr(brain_api, "_refused", lambda: True)
    reply = client.get("/api/brain/settings/embeddings").json()
    assert reply["success"] is False and reply["reason"] == "server-mode"


def test_an_lm_studio_model_name_is_valid():
    assert embeddings.valid_model("text-embedding-nomic-embed-text-v1.5@q8_0")
    assert embeddings.valid_model("nomic-ai/nomic-embed-text-v1.5-GGUF")
    assert not embeddings.valid_model("../../etc")
    assert not embeddings.valid_model("@x")
